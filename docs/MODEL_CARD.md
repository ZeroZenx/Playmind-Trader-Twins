# Model card

Two models and two simulators live in `src/engine/`:

- **twin-0.2.1** (`estimate.mjs`): a behavioral twin per trader, a small set of interpretable parameters with uncertainty. twin-0.2.0 plus `latencySpread` and `depositSpread`, which the simulator needs.
- **simulator-0.2.0** (`simulate.mjs`, `simulateTwinV2`): simulates twin-0.2.1 twins trade by trade, so a twin reacts to its own losses. Described under Simulation.
- **Transparent behavioral baseline** (`twin.mjs`, model version 0.1.0, reported as baseline-0.1): aggregate summaries and a seeded simulator whose stakes don't depend on outcomes. It is kept for comparison and described at the end.

## Intended use

The twin represents how one tokenized trader reacts to what just happened: how they stake after a loss or a win, how quickly they come back, when they stop, and whether they deposit again. Its only use is to simulate traders for responsible-trading policy tests. Policy results are simulations under stated assumptions, never causal claims.

## Prohibited use

- Individual trading advice.
- Trade execution. PlayMind never contacts traders, places trades, or holds funds.
- Credit, insurance, employment, or eligibility decisions.
- Identity matching.
- Claims of causal policy impact without valid evaluation.

## twin-0.2.1

twin-0.2.1 fits every twin-0.2.0 parameter exactly as before and adds two spreads: `latencySpread` and `depositSpread`. Parameters are stored as rows, so the version change needs no migration.

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
| `latencySpread` (0.2.1) | Log-scale SD of those latencies, pooled over both sides: the noise on both | `realized_result` | Normal-normal on log SD, from the MAD |
| `stopHazard` (`up`, `flat`, `down_small`, `down_large`) | Chance the session ends after a trade, by drawdown bucket with edges in units of the estimated `baseStake` | Outcomes; balances for the voluntary hazard | Beta-binomial per bucket |
| `refuelProbability` | Chance of a deposit within the refuel window after the balance drops below `lowBalanceStakeMultiple` × `baseStake` | Outcomes, balances | Beta-binomial |
| `refuelAfterLosingStreak` | Proxy: chance of a deposit within the window after `losingStreakLength` consecutive losses | `realized_result` | Beta-binomial |
| `depositSize` | Median deposit | Deposit amounts | Normal-normal, log scale |
| `depositSpread` (0.2.1) | Log-scale SD of deposits: the noise on every deposit | Deposit amounts | Normal-normal on log SD |
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

Four parameter groups need more than the generic steps:

- **Escalation.** All points from one losing run divide by the same reference stake, so they aren't independent. The slope's variance is clustered by run through that shared stake, using the trader's estimated `stakeDispersion`.
- **Latencies.** A within-session gap can't exceed `sessionGapMinutes`, because a longer gap starts a new session. The raw estimate is the median log latency, with a MAD-based spread, so latencies at the gap don't bias it. `latencySpread` uses the same idea: each side's log latencies are centered at that side's median observation, which is then left out (its zero deviation would bias a small sample low), and the spread is 1.4826 × the median absolute deviation of the rest, pooled over both sides. It doesn't move while the gap stays above each side's upper quartile. Its sampling variance on the log scale is 1.3605 / n, the MAD's for normal data.
- **Stop hazard.** With balance fields on every trade, it is the voluntary hazard: a trade is left out when the trader probably couldn't afford the next stake (at least a 5% chance that the next stake, from the trader's own stake parameters, exceeds the money available). Without balances it is all-cause and flagged `includesForcedStops`. How often a trader reaches a bucket depends on their hazards, so each bucket's prior is centered on the bucket rate × the trader's stop propensity from their other three buckets.
- **Refuel.** The low-balance threshold is `lowBalanceStakeMultiple` × the estimated `baseStake`, not the median stake.

### Statuses

- `estimated`: the trader has observations for the parameter.
- `prior_only`: the inputs are present, but this trader has no observations (for example, no losing run of two or more in a session). Weight 0, and the estimate and interval are the trader's prior.
- `not_estimable`: an input is missing, with a `reason`. If other traders in the same dataset had the inputs, `fallback` holds the population prior. That is not an estimate for this trader, and anything that uses it must say so. If no trader had the inputs (for example, no balance fields anywhere), `fallback` is null.

Without balance fields, `refuelProbability` is not estimable and `stopHazard` is all-cause. Without realized outcomes, every parameter except `depositSize`, `depositSpread`, and `meanIdleMinutes` is not estimable.

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

## Simulation (simulator-0.2.0)

`simulateTwinV2(fit, options)` in `src/engine/simulate.mjs` simulates twins trade by trade, so a simulated trader reacts to what just happened. ADR-012 in `docs/DECISIONS.md` gives the reasons for each choice. Results are simulations under stated assumptions, never causal claims, and never a forecast for a real trader.

### Inputs

- An `estimateTwins` fit with model version twin-0.2.1. Parameters come only from that fit: each parameter's stored `posterior`, or its population-prior `fallback`. The fit's data label, behavior options (session gap, refuel window, bucket edges, low-balance multiple, losing-streak length), and each twin's stop basis and stored loss quantiles carry through. No market or contract field is read.
- Options: `seed`, `replicates` (200 by default), `uncertainty` (on by default), the horizon (`horizonDays`, 28 by default, or `sessions`, a count per trader), `start` (by default, the end of the training window), `startingBalances` (each trader's last observed `balance_after`, from `lastObservedBalances(events)`), and `maxTradesPerSession` (200).

### Method

Each replicate of each trader is one run, seeded from the seed, the trader token, and the replicate number. At its start, the run draws every parameter once from its posterior: exp(N(mean, sd)) for the log-scale normals, Beta(a, b) for probabilities, and `sessionGapMinutes` + scale / Gamma(shape) for the mean idle time. It never draws from interval endpoints. Draws are independent across parameters, because only the marginal posteriors are stored. If a drawn `winRate` + `pushRate` exceeds 1, both are rescaled to sum to 1, and the trader's result counts how often that happened. With uncertainty off, every run uses the stored estimates (the posterior centers), so the bands show process noise only.

The first session starts at a uniform time within 24 hours of the start. Each later session starts `sessionGapMinutes` + Exponential(`meanIdleMinutes` − `sessionGapMinutes`) after the previous session's last event. Each stake is `baseStake` × `chaseCoefficient` (if the previous trade, in any session, was a realized loss) × `escalationPerLoss`^(k − 1) (after the k-th consecutive loss in this session, k ≥ 2) × exp(N(0, `stakeDispersion`)), rounded to cents. A trade wins with `winRate` (result = stake × exp(N(log `payoutMultiple`, `payoutSpread`))), pushes with `pushRate` (result 0), and otherwise loses: result = stake × a ratio drawn from the trader's five stored loss quantiles of result ÷ stake, interpolated linearly with p10 and p90 held in the tails, or the whole stake when the trader had no losses. The next trade follows after a lognormal latency with the after-loss or after-win median (after-win after a push) and `latencySpread`, clamped to between 2 seconds and `sessionGapMinutes`.

After each trade, the running session result (net of deposits) is bucketed with `drawdownBucket` against the run's `baseStake`, and the session ends with probability `stopHazard` for that bucket. Then the broke rule ends it if the next stake is larger than the balance; stakes are never capped. A safety cap ends a session at `maxTradesPerSession` trades. Hazard stops, forced stops, and cap stops are counted separately. A session starts with a deposit of `depositSize` × exp(N(0, `depositSpread`)), raised to cover the first stake if short, when the balance is below `lowBalanceStakeMultiple` × `baseStake` or below the first stake. With balances in training, a trade that takes the balance from at or above that threshold to below it triggers a refuel with `refuelProbability`. Without them, the refuel trigger is `losingStreakLength` consecutive losses, with `refuelAfterLosingStreak` as its probability, labelled `losingStreak (proxy)`. The starting balance is the supplied last observed balance, or 0.

Each kind of decision (parameters, outcomes, stake noise, latency, stops, refuel, deposits, idle time) draws from its own random stream, a fixed number of times per event. A policy that changes one decision therefore leaves every other decision's draws where they were, so Prompt 5 can compare policy and no-policy runs on common random numbers. There is one hook where those policies will act (before a stake, before a deposit, after a trade). In simulator-0.2.0 it does nothing.

Parameter statuses decide where each run's values come from. `estimated` and `prior_only` parameters draw from `posterior`. A `not_estimable` parameter with a `fallback` draws from the population prior, and the trader's assumptions list it as "population prior, not this trader". A `not_estimable` parameter with no fallback switches its mechanism off, and the result says so. If the stake, outcome, latency, stop, or session mechanism can't be simulated, the trader isn't simulable and gets `{ simulable: false, reasons }`. A trader with no realized outcome at all is never simulable, even when fallbacks exist, because every outcome-driven parameter would be the population's.

### Outputs

Per run, the harm metrics are the deepest session drawdown (in currency and in base stakes), chase episodes (trades after a realized loss with a stake of at least 1.25 × the run's `baseStake`), the same count after wins as a noise floor, deposits within `refuelWindowMinutes` after a realized loss, total net loss (the negative sum of results), and forced stops. The activity metrics are trades, total stake, sessions, active UTC days, and deposits. Per-session rates and stop and deposit accounting are reported too (`SIMULATION_METRICS`). Each trader gets the median, 10th, and 90th percentiles of every metric across replicates. The population sums each replicate across traders first (drawdowns are averaged) and then takes percentiles. Every result carries the fit's data label, the model and simulator versions, the seed, the replicate count, and an assumptions list: parameter sources, the starting-balance rule, the stop basis, the refuel trigger, the loss-ratio source, and the generator rules used where the twin has no estimate. `metricsFromEvents` computes the event-observable metrics from analytical events with the same definitions, so observed and simulated values compare like with like. `simulateBaseline` runs the old simulator, labelled baseline-0.1.

### Validation

`test/simulate.test.mjs` checks determinism, common random numbers, exact behavior with point-mass parameters, wider bands with uncertainty (wider still for short histories), archetype directions, and the not-simulable and no-balance paths. `test/simulation-calibration.test.mjs` and `npm run twin:simulation` simulate SYNTHETIC traders for their training session counts, on the generator's true parameters and on fitted twins, and count how often each trader's observed training value falls inside its simulated band. The results stay in test thresholds and gitignored local output. The fitted check is in-sample. Held-out validation is Prompt 6.

### Limitations

- Parameter draws ignore correlations between parameters. In particular, the stop-hazard buckets were fitted with a shared stop propensity, and independent bucket draws ignore it.
- Without balance fields the stop hazard is all-cause and already includes running out of money. The broke rule still applies, so stopping is double-counted in low-balance states. Those runs are labelled `stopBasis: 'all-cause'`.
- The losing-streak refuel proxy is a different trigger from low balance, not the same quantity.
- Idle time is the estimator's exponential above the session gap. Real idle times have time-of-day and day-of-week patterns the model doesn't see, and the synthetic generator uses a different shape with the same mean.
- Loss ratios come from five stored quantiles, so the tails beyond p10 and p90 are flat.
- Where the twin has no estimate, the simulator uses the generator's rules (first-session time, first-trade delay, deposit and refuel timing, the broke rule). Those are assumptions, not estimates.
- Parameters are constant over the horizon: no drift, no learning, no reaction to anything outside the event stream.
- Without a supplied starting balance, every trader starts at 0 with a session-start deposit.
- Reproducing synthetic traders shows the simulator implements the model. It says nothing about whether real traders behave like the model.
- Simulation results built from a CUSTOMER fit are customer-derived data and stay out of the repo.

## Transparent behavioral baseline (baseline-0.1)

The baseline represents selected aggregate behavior from tokenized trader activity: session activity, trade frequency, stake distribution, deposit behavior, market mix, and response to configured policy friction. Its stakes don't depend on outcomes, so it can't react to losses or to a policy. `simulateTwin` is unchanged and kept for comparison; `simulateBaseline` runs it with its output labelled baseline-0.1.

Limitations: missing outcomes reduce coverage, small samples produce unstable estimates, and its synthetic replay compares simulated totals with the same window the profile was built from, which is a mechanics check, not validation.
