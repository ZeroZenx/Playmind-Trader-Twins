# Polymarket loss-chasing rough read

Prepared from the public `vgregoire/polymarket-users` dataset.

## Executive read

The analysis uses 159,666 retail-like wallets with at least 3 eligible loss episodes and 11,628,536 loss episodes in total.
The primary wallet-level chasing share is 0.66% among wallets with at least 3 eligible loss episodes and 0.17% across all screened retail-like wallets.
The episode-level rate is 5.61%. Only 18.98% of post-loss episodes show any next-day stake; among those active episodes, the median ratio is 1.00x.
Among active post-loss episodes, 29.56% meet the chasing threshold. This reflects a small upper tail, not a typical next-day increase.

## Scope and definitions

- Discovery period: 2024-01-01 through 2025-12-31 UTC.
- Holdout period: 2026-01-01 through 2026-03-29 UTC. The analysis did not read 2026 trade data.
- Loss day: negative `pnl_change` after shifting the dataset's +1-day right-boundary label back by one UTC day.
- Post-loss window: the following UTC calendar day.
- Baseline: each wallet's median active-day stake after excluding loss and post-loss days.
- Stake: `price * quantity`, assigned once to each participating maker and taker wallet.

## Retail-like filter

The filter keeps wallets with at least 30 fills and 5 active days, maker share below 80%, and no more than 50 fills per active day. These thresholds act as a heuristic, not a verified bot label. Counterparty concentration is a follow-up sensitivity check, not a primary cutoff in this rough read.
The filter produced 614,855 retail-like wallets from 1,775,223 wallets with activity in the downloaded partitions.

## Caveats

- The PnL label is mark-to-market, not realized PnL.
- The overall ratio includes inactive next-day episodes, which produce a zero stake. The active-episode ratio is reported separately.
- The non-loss control median also includes inactive days, so a clean active-only control comparison belongs in the next pass.
- Public wallet behavior does not represent a verified retail population.
- The retail filter uses in-sample 2024-2025 behavior and must remain frozen before holdout testing.
- This first pass tests association. It does not prove causality or predictive performance.

## Sources

- Dataset: https://huggingface.co/datasets/vgregoire/polymarket-users
- Documentation: https://www.vincentgregoire.com/polymarket-users-data/
- PnL and time convention: https://www.vincentgregoire.com/polymarket-users-data/datasets/pnl_change/
- Trade schema: https://www.vincentgregoire.com/polymarket-users-data/datasets/trades/
- Methodology: https://www.vincentgregoire.com/polymarket-users-data/methodology/

## Reproducibility

Run `./.venv/bin/python analysis/polymarket_loss_chasing.py` from the repository root.
