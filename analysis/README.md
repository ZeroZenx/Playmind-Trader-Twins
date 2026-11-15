# Polymarket loss-chasing analysis

## Question

Does a retail-like Polymarket wallet increase stake during the 24 hours after a losing day, relative to the wallet's own baseline?

## Data boundary

- Discovery period: 2024-01-01 through 2025-12-31 UTC.
- Holdout period: 2026-01-01 through 2026-03-29 UTC.
- The analysis downloads only the main dataset's 2024-2025 `trades` partitions and the daily PnL partitions needed to label 2024-2025 loss days.
- The 2026 trade partitions remain untouched.
- The separate 163GB raw-trades dataset remains untouched.

## Reproduce

```bash
./.venv/bin/python analysis/polymarket_loss_chasing.py
```

The script writes intermediate Parquet files and JSON summaries under `analysis/output/`. Generated data stays outside version control through `.gitignore`. The decision-ready Markdown readout appears at `analysis/reports/polymarket-loss-chasing-rough-read.md`.

## Metric

- Loss day: negative `pnl_change`, shifted one calendar day backward because the dataset uses a right-boundary label.
- Post-loss window: the next UTC calendar day.
- Stake: `price * quantity`, assigned to both participating wallet addresses.
- Baseline: wallet-specific median active-day stake after excluding loss days and post-loss days.
- Chasing episode: post-loss stake at least 1.25x baseline and at least $10 above baseline.
- Consistent chasing wallet: at least three eligible loss episodes, at least 50% chasing episodes, and median post-loss ratio at least 1.25x.

## Retail-like heuristic

Keep wallets with:

- At least 30 fills.
- At least 5 active days.
- Maker share below 80%.
- No more than 50 fills per active day.

These thresholds remove wallets with high maker intensity or high fill intensity. They form a heuristic, not a verified identity label. Counterparty concentration remains a limitation and a later sensitivity check. All thresholds use only 2024-2025 behavior and must remain frozen before the 2026 holdout test.

## Loss versus win follow-up

Run `./.venv/bin/python analysis/polymarket_loss_vs_win.py` after the first pass. The follow-up reuses the first-pass 159,666-wallet eligible population and compares each wallet's average next-day stake after loss days with average next-day stake after win days. It writes:

- `analysis/output/loss-vs-win-summary.json`
- `analysis/output/loss-win-wallet-comparison.parquet`
- `analysis/output/consistent-chasing-wallets.csv`
- `analysis/reports/polymarket-loss-vs-win-follow-up.md`

The behavior categories use a 10% tolerance around each wallet's mean normalized stake: chase, shrink, leave, stop, or no observed win day. The follow-up uses the first-pass baseline, so comparisons stay aligned with the original loss-chasing metric.

## Holdout model

Download only the main dataset's Jan-Mar 2026 partitions:

```bash
./.venv/bin/python analysis/download_holdout.py --kind both --workers 6
```

Run the frozen model test:

```bash
POLARS_MAX_THREADS=4 ./.venv/bin/python analysis/polymarket_holdout_model.py
```

The model trains on 2024-2025 loss episodes and evaluates Jan 1 through Mar 29, 2026. It uses a frozen 2024-2025 wallet baseline and a transparent logistic model. The holdout evaluation exists and its results are kept in local output (`analysis/output/`, gitignored). It concerns a public-data behavioral proxy, not a causal or clinical claim.

The download script targets [vgregoire/polymarket-users](https://huggingface.co/datasets/vgregoire/polymarket-users) only. It does not target the separate raw-trades dataset.

## Twin test on Polymarket orders (OBSERVATIONAL)

This runs the trader twin (estimation, held-out validation, policy sweep) on real Polymarket wallets through the same `npm run intake` path that customer data uses. Everything it writes is labeled OBSERVATIONAL and stays in gitignored folders (`.data/`, `data/`).

```bash
./.venv/bin/python analysis/download_holdout.py --kind trades --workers 6   # ~18 GB, 88 day files
curl -L "https://huggingface.co/datasets/vgregoire/polymarket-users/resolve/main/markets.parquet?download=true" \
  -o .data/polymarket-meta/markets.parquet
POLARS_MAX_THREADS=6 ./.venv/bin/python analysis/polymarket_twin_extract.py
npm run intake -- run --config data/polymarket/mapping.json --label OBSERVATIONAL
npm run intake -- run --config data/polymarket/mapping-no-settlement.json --label OBSERVATIONAL
```

`analysis/polymarket_twin_extract.py` (version 0.2.0) is a converter. It applies the retail screen from the loss-chasing analysis (computed on orders inside the window) and takes a deterministic sample of 2,000 wallets, capped at 700,000 orders, with the same seed and caps as before. Then it filters each day's trades to the sampled wallets one file at a time, with no join across days, and writes two raw tables under `data/polymarket/raw/`: `fills.csv` (one row per wallet side of a fill) and `markets.csv` (market close times). Its docstring defines the screen, the sample, and the columns.

Everything the twin needs from those tables is derived by intake (ADR-017), from the mapping configs the converter writes next to them:

- **Orders.** Fills that share a transaction, token, role, and side are one order (`order-id`). Stakes and results sum.
- **Stake and result.** `contract-resolution`: the stake is the amount at risk, and the result is the hold-to-resolution P&L. It stays unavailable when the market had not resolved by the dataset end.
- **Outcome time.** `mapping.json` derives `settled_at` from the market's close time (`market-settlement`). `mapping-no-settlement.json` leaves it out, so every outcome is assumed known before the next trade (the behavior-0.2.0 assumption).

What this data still can't give the twin:

- **Decision time.** There is no order-creation time, so a maker order's time is when it filled. `placed_at` is assumed.
- **Deposits and balances.** The dataset has no deposits, withdrawals, or balances. Stop hazards are all-cause and refuel is not estimable.

Intake readiness reports the outcome-timing share (ADR-018): of resolved trades, how many settled before the wallet's next trade, overall and by category. `readiness.md` also says which derivation methods worked and what had to be assumed.
