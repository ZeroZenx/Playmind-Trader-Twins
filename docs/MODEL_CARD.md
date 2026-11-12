# Model card

Two models live in `src/engine/`:

- **twin-0.2.0** (`estimate.mjs`): a behavioral twin per trader, a small set of interpretable parameters with uncertainty. This card describes it.
- **Transparent behavioral baseline** (`twin.mjs`, model version 0.1.0, reported as baseline-0.1): aggregate summaries and a seeded simulator. It is described at the end, and Prompt 4 replaces its simulator.

## Intended use

The twin represents how one tokenized trader reacts to what just happened: how they stake after a loss or a win, how quickly they come back, when they stop, and whether they deposit again. Its only use is to simulate traders for responsible-trading policy tests. Policy results are simulations under stated assumptions, never causal claims.

## Prohibited use

- Individual trading advice.
- Trade execution. PlayMind never contacts traders, places trades, or holds funds.
- Credit, insurance, employment, or eligibility decisions.
- Identity matching.
- Claims of causal policy impact without valid evaluation.

## twin-0.2.0

### Inputs

`estimateTwins(events, { dataLabel, behaviorOptions })` reads the analytical event schema (`docs/DATA-DICTIONARY.md`) through the behavior-0.2.0 observations from `buildBehaviorObservations`. It never reads market or contract fields, so the twin works without them.

- `dataLabel` is required: SYNTHETIC, OBSERVATIONAL (public data), or CUSTOMER. It is carried into the fit, the priors, and every twin.
- Needed for everything: `trader_token`, `occurred_at`, and the event type (`trade`, `deposit`, `withdrawal`).
- `stake_amount` and `realized_result` drive most parameters. A missing `realized_result` stays unavailable; it is never treated as zero or inferred from a balance change.
- `balance_before` and `balance_after` on every trade unlock the refuel probability and the voluntary stop hazard.
- `deposit_amount` (or deposit balances) gives deposit size.

### Parameters and the fields they need

All amounts are in the event currency. "Outcomes" means `stake_amount` and `realized_result`.

| Parameter | Meaning | Needs | Method |
| --- | --- | --- | --- |
| `baseStake` | Median stake with no chase or escalation term (first trade, and trades after a win or push) | Outcomes | Normal-normal, log scale |
| `stakeDispersion` | Log-scale SD of those stakes: the noise on every stake | Outcomes | Normal-normal on log SD |
| `chaseCoefficient` | Stake multiplier on the trade after a loss: exp(mean signal-1 log ratio after a loss minus after a win) | Outcomes | Normal-normal, log scale |
| `escalationPerLoss` | Extra multiplier per additional consecutive loss in a session: exp(signal-6 log slope) | Outcomes | Normal-normal, log scale |
| `reentryLatencyAfterLoss`, `reentryLatencyAfterWin` | Median minutes to the next trade in the same session | `realized_result` | Normal-normal on the median log latency |
| `stopHazard` (`up`, `flat`, `down_small`, `down_large`) | Chance the session ends after a trade, by drawdown bucket with edges in units of the estimated `baseStake` | Outcomes; balances for the voluntary hazard | Beta-binomial per bucket |
| `refuelProbability` | Chance of a deposit within the refuel window after the balance drops below `lowBalanceStakeMultiple` × `baseStake` | Outcomes, balances | Beta-binomial |
| `refuelAfterLosingStreak` | Proxy: chance of a deposit within the window after `losingStreakLength` consecutive losses | `realized_result` | Beta-binomial |
| `depositSize` | Median deposit | Deposit amounts | Normal-normal, log scale |
| `winRate`, `pushRate` | Share of trades with a result that won, or pushed | `realized_result` | Beta-binomial |
| `payoutMultiple`, `payoutSpread` | Median and log-scale SD of result ÷ stake on wins | Outcomes | Normal-normal |
| `meanIdleMinutes` | Mean minutes from one session's last event to the next session's first | Timestamps | Inverse-gamma |

`TWIN_PARAMETER_DEFINITIONS` in the module lists the same in machine-readable form. Each twin also has an empirical distribution of result ÷ stake for wins and losses (`payoutDistribution`), the stop sample's accounting (`stopSample`), and an observed sessions-per-day rate (descriptive, no interval).

### Method

Every parameter goes through three steps. ADR-011 in `docs/DECISIONS.md` gives the reasons for each choice.

**Raw estimate.** Each trader's own estimate and its sampling variance, from the behavior-0.2.0 observations. Multipliers, stakes, latencies, deposits, and payouts are estimated on the log scale, because the behavior is multiplicative and every noise term is lognormal. A trader's sampling variance uses a moderated spread: their own sample variance averaged with the pooled within-trader variance of all traders, which counts as 5 extra observations. That keeps one or two values from producing a falsely tight interval.

**Population prior.** For each parameter, a prior is fitted to every trader's raw estimate in the same dataset by the method of moments, with each trader's sampling noise taken out. For log-scale parameters the prior is normal: its between-trader variance comes from the DerSimonian-Laird formula, floored above zero, and its center is the mean weighted by 1 / (sampling variance + between-trader variance). For probabilities the prior is a beta distribution fitted the same way, with the binomial variance as the sampling noise. For the idle time it is an inverse-gamma distribution whose mean and variance match the traders' mean idle times, net of exponential sampling noise. A prior needs at least 3 traders with observations.

**Shrinkage.** Each trader's estimate is the conjugate update of the prior with their data, so traders with little data stay near the prior and traders with more data move to their own value. The shrinkage weight is the share of the estimate that comes from the trader's own data:

- Normal-normal (log scale): weight = τ² / (τ² + se²); estimate = prior mean + weight × (raw − prior mean); posterior variance = weight × se².
- Beta-binomial: posterior Beta(a + k, b + n − k); weight = n / (a + b + n); the estimate is weight × k/n + (1 − weight) × the prior mean.
- Inverse-gamma: the excess idle time over `sessionGapMinutes` is treated as exponential. Posterior shape α + n and scale β + Σ excess; weight = n / (α − 1 + n).

The 90% interval is equal-tailed on the posterior: mean ± 1.645 SD on the log scale, exponentiated; the 5th and 95th percentiles of the beta posterior; the 5th and 95th percentiles of the inverse-gamma posterior plus `sessionGapMinutes`. Each parameter also stores the posterior itself, so the simulator can draw parameters from it.

Four parameters need more than the generic steps:

- **Escalation.** All points from one losing run divide by the same reference stake, so they aren't independent. The slope's variance is clustered by run through that shared stake, using the trader's estimated `stakeDispersion`.
- **Latencies.** A within-session gap can't exceed `sessionGapMinutes`, because a longer gap starts a new session. The raw estimate is the median log latency, with a MAD-based spread, so latencies at the gap don't bias it.
- **Stop hazard.** With balance fields on every trade, it is the voluntary hazard: a trade is left out when the trader probably couldn't afford the next stake (at least a 5% chance that the next stake, from the trader's own stake parameters, exceeds the money available). Without balances it is all-cause and flagged `includesForcedStops`. How often a trader reaches a bucket depends on their hazards, so each bucket's prior is centered on the bucket rate × the trader's stop propensity from their other three buckets.
- **Refuel.** The low-balance threshold is `lowBalanceStakeMultiple` × the estimated `baseStake`, not the median stake.

### Statuses

- `estimated`: the trader has observations for the parameter.
- `prior_only`: the inputs are present, but this trader has no observations (for example, no losing run of two or more in a session). Weight 0, and the estimate and interval are the trader's prior.
- `not_estimable`: an input is missing, with a `reason`. If other traders in the same dataset had the inputs, `fallback` holds the population prior. That is not an estimate for this trader, and anything that uses it must say so. If no trader had the inputs (for example, no balance fields anywhere), `fallback` is null.

Without balance fields, `refuelProbability` is not estimable and `stopHazard` is all-cause. Without realized outcomes, every parameter except `depositSize` and `meanIdleMinutes` is not estimable.

### Validation

Recovery on SYNTHETIC traders with known parameters (`test/twin-recovery.test.mjs`, `npm run twin:recovery`) checks that estimates track the truth, that 90% intervals cover the truth about as often as they should, that short histories are pulled toward the prior, and that missing inputs give not-estimable parameters. The results are written only to gitignored local output. Synthetic recovery shows the estimator works when the model is right. It says nothing about whether real traders behave like the model. Held-out validation on later data is Prompt 6.

### Limitations

- The twin is a model of reaction to the last outcome and the session's running result. It doesn't see markets, odds, time of day, or anything outside the event stream.
- Parameters are constant over the training window. Behavior that drifts is averaged.
- Priors are fitted on the same dataset. A small dataset gives a weak, noisy prior, and the prior's own uncertainty isn't carried into the intervals.
- Probabilities use beta priors and log-scale parameters use normal priors. A population with a very different shape (for example, uniform with no tails) gives intervals that cover more or less often than 90%.
- Sample sizes can depend on the parameter: quitters rarely reach deep drawdowns, and refuelers create more refuel triggers. The stop propensity corrects the first. The second pulls the refuel prior toward frequent refuelers.
- Without balance fields, stop hazards include stops from running out of money, and refuel is only available as the losing-streak proxy.
- Missing outcomes reduce n. A missing outcome inside a losing run can put an escalated stake into the chase sample.
- Latencies near `sessionGapMinutes` are underestimated. On a fixed window, idle times near the end of the data are cut off, so the idle-time estimate is biased low on real data.
- Observational replay doesn't prove causation, and synthetic data doesn't prove customer performance.
- Venue-specific behavior doesn't automatically transfer to another venue.

### Storage

`db/migrations/0001_twin_v02_parameters.sql` adds per-parameter rows (`trader_twin_parameters`: status, estimate, interval, n, shrinkage weight, raw value, prior value, reason, posterior), the data label, behavior version, and stop-hazard basis on `trader_twins`, and one population prior per dataset and model version (`twin_population_priors`). Store the model version, behavior version, data label, training window, and options with every fit.

## Transparent behavioral baseline (baseline-0.1)

The baseline represents selected aggregate behavior from tokenized trader activity: session activity, trade frequency, stake distribution, deposit behavior, market mix, and response to configured policy friction. Its stakes don't depend on outcomes, so it can't react to losses or to a policy. Prompt 4 keeps it as baseline-0.1 for comparison.

Limitations: missing outcomes reduce coverage, small samples produce unstable estimates, and its synthetic replay compares simulated totals with the same window the profile was built from, which is a mechanics check, not validation.
