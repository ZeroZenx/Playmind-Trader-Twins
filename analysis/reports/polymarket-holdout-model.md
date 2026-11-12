# Polymarket loss-chasing holdout model

This evaluation trains on 2024-01-01 through 2025-12-31 and scores 2026-01-01 through 2026-03-29. The Jan-Mar 2026 trade partitions remain outside training.

## Result

- Retail-like wallets with a frozen in-sample baseline: 161,894
- Training episodes: 11,628,536, sampled for fitting: 500,000
- Holdout loss episodes: 2,096,291
- Holdout positive rate: 7.69%

The holdout evaluation of the logistic model and the prior-chase-rate baseline exists; its results are kept in local output (`analysis/output/polymarket-holdout-model-summary.json`, gitignored).

The baseline provides a persistence check. The model only earns a predictive claim if its holdout metrics improve on the prior-chase-rate baseline and beat the holdout prevalence by a meaningful margin.

## Frozen definition

The target marks a loss episode when next-day stake reaches at least 1.25x the wallet's 2024-2025 median active-day baseline and exceeds baseline by at least $10. The retail screen stays fixed at 30 fills, 5 active days, maker share below 80%, and no more than 50 fills per active day.

Features use only earlier episodes for the same wallet. The holdout score updates wallet history after each observed episode, matching an online scoring workflow.

## Files

- `analysis/polymarket_holdout_model.py`
- `analysis/output/polymarket-holdout-model-summary.json`
- `analysis/output/polymarket-holdout-episode-predictions.parquet`

## Limits

- Mark-to-market PnL does not equal realized PnL.
- Public wallet behavior does not reveal intent.
- The model predicts a next-day stake pattern. It does not diagnose a person or authorize an intervention.
- The screen excludes wallets without a frozen in-sample baseline, so results do not describe every 2026 wallet.
