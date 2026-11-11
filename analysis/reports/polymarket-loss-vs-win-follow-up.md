# Polymarket loss versus win follow-up

This follow-up uses the 159,666 wallets eligible for the first loss-chasing pass.

## Result

Paired wallets with observed loss and win days: 159,530 of 159,666.
Mean wallet-normalized next-day stake after losses: 114.027x baseline.
Mean wallet-normalized next-day stake after wins: 61.469x baseline.
Mean within-wallet loss-minus-win difference: 52.557x, with a bootstrap 95% interval of 38.926x to 68.225x.
Mean raw next-day stake after losses: $120.72; after wins: $146.59; difference: $-25.87, with a bootstrap 95% interval of $-28.83 to $-23.22.
Median wallet-normalized ratios are 0.600x after losses and 0.632x after wins. The mean normalized ratios are outlier-sensitive.
The typical wallet and raw-dollar average both point to a small post-loss reduction; the positive normalized mean comes from extreme wallet-level ratios.

## What wallets do after losses

- chase: 70,164 wallets (43.94%)
- leave: 13,167 wallets (8.25%)
- no_observed_win: 136 wallets (0.09%)
- shrink: 73,118 wallets (45.79%)
- stop: 3,081 wallets (1.93%)

Categories use a 10% tolerance around the wallet's own mean normalized stake. Stop means zero next-day activity after every observed loss day and positive next-day activity after at least one observed win day. No observed win day stays separate from zero stake.

## First-pass 1,050 wallets

The 1,050-wallet extract uses the original repeated-chasing definition: at least three eligible loss episodes, at least 50% chasing episodes, and median post-loss ratio at least 1.25x.

## Sources and limits

- Dataset: https://huggingface.co/datasets/vgregoire/polymarket-users
- Documentation: https://www.vincentgregoire.com/polymarket-users-data/
- PnL label convention: https://www.vincentgregoire.com/polymarket-users-data/datasets/pnl_change/
- Trade schema: https://www.vincentgregoire.com/polymarket-users-data/datasets/trades/
- PnL methodology: https://www.vincentgregoire.com/polymarket-users-data/methodology/

The PnL measure is mark-to-market, not realized PnL. The 2026 trade holdout stayed untouched. The retail screen remains a heuristic and does not include a full counterparty-concentration filter.
