# Model card

Two models and two simulators live in `src/engine/`:

- **twin-0.3.0** (`estimate.mjs`): a behavioral twin per trader, a small set of interpretable parameters with uncertainty. twin-0.2.1 on behavior-0.3.0 observations (outcome timing, ADR-018), plus a settlement-lag distribution when trades carry `settled_at`. twin-0.2.1 was twin-0.2.0 plus `latencySpread` and `depositSpread`.
- **simulator-0.3.0** (`simulate.mjs`, `simulateTwinV2`): simulates twin-0.3.0 twins trade by trade, so a twin reacts to its own losses, and, with a settlement lag, only once they have settled. Described under Simulation.
- **policy-0.2.0** (`policy-sim.mjs`, `comparePolicyV2`, `runPolicySweep`): runs responsible-trading policies on simulator-0.2.0, with every trader response a named, swept assumption. Described under Policy simulation.
- **holdout-0.1.0** (`holdout.mjs`, `runHoldoutValidation`): held-out validation. It fits twins on each trader's earlier data, simulates the later period, and compares the result with what happened, against baseline-0.1 and a naive model. Described under Held-out validation.
- **Transparent behavioral baseline** (`twin.mjs`, model version 0.1.0, reported as baseline-0.1): aggregate summaries and a seeded simulator whose stakes don't depend on outcomes. It is kept for comparison and described at the end.

## Intended use

The twin represents how one tokenized trader reacts to what just happened: how they stake after a loss or a win, how quickly they come back, when they stop, and whether they deposit again. Its only use is to simulate traders for responsible-trading policy tests. Policy results are simulations under stated assumptions, never causal claims.

## Prohibited use

- Individual trading advice.
- Trade execution. PlayMind never contacts traders, places trades, or holds funds.
- Credit, insurance, employment, or eligibility decisions.
- Identity matching.
- Claims of causal policy impact without valid evaluation.

## twin-0.3.0

twin-0.3.0 fits every twin-0.2.1 parameter on behavior-0.3.0 observations and adds `settlementLagMinutes` and `settlementLagSpread` (ADR-018). Without `settled_at` and `placed_at` every other parameter equals twin-0.2.1's, and the two new ones are not estimable. Two rules changed with outcome timing: base stakes include trades placed before any outcome was known, and the stop sample's affordability rule uses the outcome known after each trade. twin-0.2.1 fitted every twin-0.2.0 parameter as before and added `latencySpread` and `depositSpread`. Parameters are stored as rows, so the version change needs no migration.

**Outcome timing.** When trades carry `settled_at`, every outcome-driven parameter reads what the trader could know: chase and escalation from the first trade placed after an outcome settled, latencies from the settlement time, and stop hazards from the running result of settled outcomes. On SYNTHETIC traders whose outcomes settle after their next trade, this recovers chase and the stop gradient; the behavior-0.2.0 assumption pulls chase toward 1 and flattens the gradient (`test/settlement-recovery.test.mjs`). Without `settled_at` the assumption applies, and readiness reports it untested. Settlement lags are right-censored by the extract end.

### Inputs

`estimateTwins(events, { dataLabel, behaviorOptions })` reads the analytical event schema (`docs/DATA-DICTIONARY.md`) through the behavior-0.3.0 observations from `buildBehaviorObservations`. It never reads market or contract fields, so the twin works without them.

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

**Raw estimate.** Each trader's own estimate and its sampling variance, from the behavior-0.3.0 observations. Multipliers, stakes, latencies, deposits, and payouts are estimated on the log scale, because the behavior is multiplicative and every noise term is lognormal. A trader's sampling variance uses a moderated spread: their own sample variance averaged with the pooled within-trader variance of all traders, which counts as 5 extra observations. That keeps one or two values from producing a falsely tight interval.

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

Recovery on SYNTHETIC traders with known parameters (`test/twin-recovery.test.mjs`, `npm run twin:recovery`) checks that estimates track the truth, that 90% intervals cover the truth about as often as they should, that short histories are pulled toward the prior, and that missing inputs give not-estimable parameters. The results are written only to gitignored local output. Synthetic recovery shows the estimator works when the model is right. It says nothing about whether real traders behave like the model. Held-out validation on later data is described under Held-out validation.

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

## Simulation (simulator-0.3.0)

simulator-0.3.0 is simulator-0.2.0 plus settlement mode (ADR-018). A twin with its own settlement-lag estimate settles each trade after a drawn lag: the stake is debited at placement and the payout credited at settlement, the trader reacts only to settled outcomes, and each outcome that settles before the next attempt moves it to the latency for that outcome after the settlement. A twin without one runs exactly as in simulator-0.2.0, and the new random streams are never drawn.

`simulateTwinV2(fit, options)` in `src/engine/simulate.mjs` simulates twins trade by trade, so a simulated trader reacts to what just happened. ADR-012 in `docs/DECISIONS.md` gives the reasons for each choice. Results are simulations under stated assumptions, never causal claims, and never a forecast for a real trader.

### Inputs

- An `estimateTwins` fit with model version twin-0.3.0. Parameters come only from that fit: each parameter's stored `posterior`, or its population-prior `fallback`. The fit's data label, behavior options (session gap, refuel window, bucket edges, low-balance multiple, losing-streak length), and each twin's stop basis and stored loss quantiles carry through. No market or contract field is read.
- Options: `seed`, `replicates` (200 by default), `uncertainty` (on by default), the horizon (`horizonDays`, 28 by default, or `sessions`, a count per trader), `start` (by default, the end of the training window), `startingBalances` (each trader's last observed `balance_after`, from `lastObservedBalances(events)`), and `maxTradesPerSession` (200).

### Method

Each replicate of each trader is one run, seeded from the seed, the trader token, and the replicate number. At its start, the run draws every parameter once from its posterior: exp(N(mean, sd)) for the log-scale normals, Beta(a, b) for probabilities, and `sessionGapMinutes` + scale / Gamma(shape) for the mean idle time. It never draws from interval endpoints. Draws are independent across parameters, because only the marginal posteriors are stored. If a drawn `winRate` + `pushRate` exceeds 1, both are rescaled to sum to 1, and the trader's result counts how often that happened. With uncertainty off, every run uses the stored estimates (the posterior centers), so the bands show process noise only.

The first session starts at a uniform time within 24 hours of the start. Each later session starts `sessionGapMinutes` + Exponential(`meanIdleMinutes` − `sessionGapMinutes`) after the previous session's last event. Each stake is `baseStake` × `chaseCoefficient` (if the previous trade, in any session, was a realized loss) × `escalationPerLoss`^(k − 1) (after the k-th consecutive loss in this session, k ≥ 2) × exp(N(0, `stakeDispersion`)), rounded to cents. A trade wins with `winRate` (result = stake × exp(N(log `payoutMultiple`, `payoutSpread`))), pushes with `pushRate` (result 0), and otherwise loses: result = stake × a ratio drawn from the trader's five stored loss quantiles of result ÷ stake, interpolated linearly with p10 and p90 held in the tails, or the whole stake when the trader had no losses. The next trade follows after a lognormal latency with the after-loss or after-win median (after-win after a push) and `latencySpread`, clamped to between 2 seconds and `sessionGapMinutes`.

After each trade, the running session result (net of deposits) is bucketed with `drawdownBucket` against the run's `baseStake`, and the session ends with probability `stopHazard` for that bucket. Then the broke rule ends it if the next stake is larger than the balance; stakes are never capped. A safety cap ends a session at `maxTradesPerSession` trades. Hazard stops, forced stops, and cap stops are counted separately. A session starts with a deposit of `depositSize` × exp(N(0, `depositSpread`)), raised to cover the first stake if short, when the balance is below `lowBalanceStakeMultiple` × `baseStake` or below the first stake. With balances in training, a trade that takes the balance from at or above that threshold to below it triggers a refuel with `refuelProbability`. Without them, the refuel trigger is `losingStreakLength` consecutive losses, with `refuelAfterLosingStreak` as its probability, labelled `losingStreak (proxy)`. The starting balance is the supplied last observed balance, or 0.

Each kind of decision (parameters, outcomes, stake noise, latency, stops, refuel, deposits, idle time) draws from its own random stream, a fixed number of times per event. A policy that changes one decision therefore leaves every other decision's draws where they were, so policy and no-policy runs can be compared on common random numbers. Policies act through one hook (before a session, before a stake, before a deposit, after a trade), which `simulateTwinV2` never calls; the policy layer below uses it.

Parameter statuses decide where each run's values come from. `estimated` and `prior_only` parameters draw from `posterior`. A `not_estimable` parameter with a `fallback` draws from the population prior, and the trader's assumptions list it as "population prior, not this trader". A `not_estimable` parameter with no fallback switches its mechanism off, and the result says so. If the stake, outcome, latency, stop, or session mechanism can't be simulated, the trader isn't simulable and gets `{ simulable: false, reasons }`. A trader with no realized outcome at all is never simulable, even when fallbacks exist, because every outcome-driven parameter would be the population's.

### Outputs

Per run, the harm metrics are the deepest session drawdown (in currency and in base stakes), chase episodes (trades after a realized loss with a stake of at least 1.25 × the run's `baseStake`), the same count after wins as a noise floor, deposits within `refuelWindowMinutes` after a realized loss, total net loss (the negative sum of results), and forced stops. The activity metrics are trades, total stake, sessions, active UTC days, and deposits. Per-session rates and stop and deposit accounting are reported too (`SIMULATION_METRICS`). Each trader gets the median, 10th, and 90th percentiles of every metric across replicates. The population sums each replicate across traders first (drawdowns are averaged) and then takes percentiles. Every result carries the fit's data label, the model and simulator versions, the seed, the replicate count, and an assumptions list: parameter sources, the starting-balance rule, the stop basis, the refuel trigger, the loss-ratio source, and the generator rules used where the twin has no estimate. `metricsFromEvents` computes the event-observable metrics from analytical events with the same definitions, so observed and simulated values compare like with like. `simulateBaseline` runs the old simulator, labelled baseline-0.1.

### Validation

`test/simulate.test.mjs` checks determinism, common random numbers, exact behavior with point-mass parameters, wider bands with uncertainty (wider still for short histories), archetype directions, and the not-simulable and no-balance paths. `test/simulation-calibration.test.mjs` and `npm run twin:simulation` simulate SYNTHETIC traders for their training session counts, on the generator's true parameters and on fitted twins, and count how often each trader's observed training value falls inside its simulated band. The results stay in test thresholds and gitignored local output. The fitted check is in-sample. The out-of-sample check is described under Held-out validation.

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

## Policy simulation (policy-0.2.0)

`comparePolicyV2(fit, { policy, assumptions }, options)` and `runPolicySweep(fit, sweep, options)` in `src/engine/policy-sim.mjs` run responsible-trading policies on simulator-0.2.0 twins and compare each with the same twins under no policy. ADR-013 in `docs/DECISIONS.md` gives the reasons for each choice. There is no intervention data, so every way a trader responds to a policy is an assumption, named, given a default, swept across a range, and shown with every result. Results are simulations under stated assumptions. They are never causal claims, and never a recommendation to act on any trader.

### Inputs

- An `estimateTwins` fit (twin-0.3.0), with simulator-0.3.0's options (seed, replicates, uncertainty, start, starting balances), except that the horizon must be in days.
- A policy, validated by `validatePolicyV2`, with thresholds in currency:
  - `cooldown`: `durationMinutes`, `lossStreak` (default 3), and optionally `drawdownThreshold`.
  - `deposit_limit`: `dailyLimit` per UTC day.
  - `stake_limit`: `maxStake`.
  - `session_loss_limit`: `lossLimit`.
- Response assumptions, validated by `validateResponseAssumptions`. Each has a default and a default range:
  - Cooldown: a rebound multiplier on stakes after the trader returns, the probability of leaving for the day, and the reference point (`carry` or `reset`).
  - Stake limit: the probability of resubmitting at the cap rather than skipping.
  - Deposit limit: the share of a blocked deposit made on a later day.
  - Session loss limit: the probability of a new session within the hour.
- For a sweep: the policies, their settings (defaults in the module), the design (one assumption at a time, or the full grid), and the primary harm and activity metrics.

### Method

A policy acts only through the simulator's hook. It can delay or move a session's start, cap or skip a stake, cut a deposit, and end or pause a session after a trade. It can never overrule the trader's own decision to stop. Each run builds its own policy instance. All of the policy's randomness, including the response draws, comes from a separate policy stream, a fixed number of draws per policy event, so cells with different assumption values share the same draws.

Every comparison is paired. For each trader and replicate, the policy run and the no-policy run use the same seed, the same parameter draws, and the same random streams for outcomes, stake noise, latency, stopping, refuel, deposits, and idle time. The no-policy run is computed once and reused for every cell. Draws are aligned attempt by attempt: a placed, capped, or skipped attempt uses the same outcome, stop, and latency draws it would have used without the policy. A capped stake keeps its own outcome, with the payout or loss applied to the capped stake. Until the policy first acts, the two runs are identical. After that, they differ only through what the policy and the assumed responses change, plus the noise those changes move around.

The cooldown fires the first time the session reaches its losing streak or drawdown threshold, not again while the condition holds. If the trader would have continued, they either leave for the day (no new session until after the next UTC midnight, then their normal idle time) or come back when the cooldown ends. With `carry` the session continues from where it was. With `reset` the trader returns in a new session, flat and with no losing run. A stake over the cap is resubmitted at the cap or skipped. A deposit that would take the day past its limit is cut, and a share of the cut amount lands at the start of the trader's first session on a later UTC day. A session that reaches its loss limit ends after that trade. The next one starts within an hour (after the session gap) or after the normal idle time.

For each harm metric the result is a harm reduction, 1 − policy ÷ baseline. For each activity metric it is activity retained, policy ÷ baseline. Paired differences come in natural units. Per trader, the ratio is computed in each replicate and summarized by its median and 10th and 90th percentiles. For the population, each replicate is summed across traders first (drawdowns are averaged), then the ratio is taken, then the percentiles. A zero baseline gives no ratio, never 0 or 1.

The default trade-off chart plots total net loss reduction against total stake retained. Under a negative edge, net loss falls roughly in proportion to stake, so a policy that only cuts activity sits on the line harm reduction = 1 − activity retained. The distance above that line (`beyondActivityCut`) separates a policy that cuts losses more than play. For each policy, the sweep compares how far the primary harm reduction moves across the policy settings with how far it moves across each assumption's range. It then names the largest in a plain sentence.

### Outputs

Every result carries the fit's data label, the model, simulator, and policy versions, the seed, the replicate count, the horizon, the claim, simulator-0.2.0's assumptions, and the policy layer's assumptions. Each cell carries the validated policy config and every response assumption with its value and whether it is the default. Each cell also carries:

- population and per-trader harm reduction, activity retained, and paired differences for every harm and activity metric;
- the primary pair, with `beyondActivityCut`;
- accounting of what the policy did, such as triggers, pauses, leaves, skips, and blocked, carried, and deferred deposits.

A sweep adds, for each policy, a chart (one series per value of each swept assumption, with points over the settings and bands) and a driver statement. Traders keep their labels (all-cause stops, proxy refuel, no money model, not simulable). Each trader's parameter estimates are listed, so a report can group traders by archetype or parameter range rather than by token. `npm run policy:sweep` writes the default sweep on a SYNTHETIC population to gitignored `analysis/output/policy-sweep/` and prints its runtime.

### Validation

`test/policy-sim.test.mjs` checks the following:

- Config validation.
- A hook that changes nothing, and a policy that never fires, both give exactly the no-policy run.
- A policy run matches its baseline until the policy first acts.
- Each policy does what it says.
- A cooldown that only delays never raises trades, stake, or chase episodes in any paired run.
- A high rebound can raise harm.
- The reference-point finding.
- Population aggregation.
- Determinism.
- The money-off path.
- Labels.

`test/policy-sweep.test.mjs` runs the shared sweep module and the script at a small scale. These tests check that the mechanics implement the stated assumptions on SYNTHETIC twins. They don't check that real traders respond that way.

### Limitations

- There is no intervention data. Every response to a policy is an assumption, and so is every range it is swept across. A result that moves more with an assumption than with the policy setting is driven by what we assumed, and the driver statement says so.
- The default sweep varies one assumption at a time, with the others at their defaults. It misses interactions between assumptions (for example, a reset reference point combined with a rebound). The grid design covers them at a higher cost.
- The paired bands reflect the twin's parameter uncertainty and process noise. They don't reflect uncertainty about the responses, which only the sweep shows.
- Realized net loss over a horizon is mostly luck, and paired runs share outcome draws only until they diverge. Net-loss bands are wide, and narrow populations need many replicates.
- Session drawdown is measured from the trader's reference point. Under `reset` it restarts at the return by definition, and under `carry` a pause longer than the session gap would look like two sessions in event data.
- Thresholds are the same currency amount for every trader, one policy runs at a time, and responses are the same for every trader. No trader adapts over the horizon.
- Without balance fields, stopping is all-cause and double-counted in low-balance states, and policies that act on low balances inherit that. Without a money model, a deposit limit is not applicable.
- Policy results from a CUSTOMER fit are customer-derived data and stay out of the repo.

## Held-out validation (holdout-0.1.0)

`runHoldoutValidation(events, options)` in `src/engine/holdout.mjs` asks whether a twin fitted on a trader's earlier data predicts how that trader behaves later, and whether it does so better than simpler models. ADR-014 in `docs/DECISIONS.md` gives the reasons for each choice. The results are evidence about a model on stated data. They are not an accuracy headline and not a causal claim, and their numbers stay in test thresholds and gitignored local output.

### Inputs

- Events in the analytical event schema, and a data label: SYNTHETIC, OBSERVATIONAL, or CUSTOMER. Balance fields and market fields are optional, as everywhere else.
- `behaviorOptions` (session gap, refuel window, bucket edges), the split settings, the seed, and the replicate count.
- On SYNTHETIC data only, a truth reference: twins on the generator's known parameters (`truth-twins.mjs`).
- `npm run twin:holdout` runs it on a SYNTHETIC behavioral population twice. The first run has balance fields. The second has none, so stops are all-cause and refuel is the losing-streak proxy, which is the path closest to what we expect from Sporttrade. Results go to gitignored `analysis/output/twin-holdout/`, and the script prints a short summary and its runtime.
- `runObservationalHoldout` is the entry point for public data under the OBSERVATIONAL label. Loading the Polymarket data into the event schema is not wired yet.

### Method

Each trader's history is split by time, never at random. The active period runs from the trader's first to last trade, deposit, or withdrawal. The cut is the start of the first session that begins at or after 75% of the way through that period, so no session is split. Everything before the cut is training data and everything from the cut on is test data. Because the period ends at the trader's last event, every trader is active through their whole test window. The twin is therefore not tested on churn, that is, on whether a trader stops coming back. A trader with too few training sessions, test sessions, test trades, or test days gets no result, only a reason.

The twins are fitted once, with `estimateTwins` on every trader's training data. Each trader is then simulated from their cut for the length of their test window, starting from their last observed balance. Three models are simulated: the twin with its parameter uncertainty, the old baseline-0.1 simulator, and, on synthetic data, twins on the true parameters with uncertainty off. baseline-0.1 has its own event shape and a fixed start date, so an adapter maps its events to the event schema and shifts them to the trader's cut. The fourth model, the naive model, simply repeats each trader's training values without reacting to the last outcome. For stake after a loss and after a win, it predicts the trader's overall training stake for both.

Every side goes through the same event-level definitions: the observed test data, the naive model's training data, and every simulated run. Every stake is scaled by the twin fit's base stake, on every side. Only quantities real data shows are compared. Forced stops and the reason a session ended are simulator decisions, so they are left out.

The compared quantities are:

- stake after a loss and stake after a win, each relative to the base stake, and their difference;
- session length in trades and in minutes;
- the time between trades within a session;
- deposits within the refuel window after a loss;
- idle time between sessions, as a diagnostic only.

For each quantity the validation reports three things:

- **Distribution.** The observed 10th, 25th, 50th, 75th, and 90th percentiles of the pooled test data, each against a band from the simulated replicates. The distance between the observed and simulated distributions is the two-sample Kolmogorov-Smirnov statistic D. No p-value is reported, because the simulated sample pools many replicates.
- **Calibration.** The share of traders whose observed test value falls inside their own simulated 10th-90th percentile band.
- **Point error.** Each model's median absolute error per trader. A simulated model's point is its median across replicates; the naive model's is its training value.

The twin beats a comparator on a quantity when it has both the smaller point error and the smaller D. Overall, it beats the comparator when it wins on a majority of the quantities. The twin earns a claim only when it beats both baseline-0.1 and the naive model. Pass/fail tolerances for calibration and D are fixed in the module and can be overridden. Any quantity where the twin loses is listed as a finding.

### Limitations

- **Churn.** Not tested: every trader is active through their test window by construction.
- **Common shocks.** Cuts differ by trader, so one trader's training period can overlap another's test period in time. Shocks common to all traders are not held out.
- **Short histories.** These traders are excluded rather than validated. A test window of less than a day is excluded too, because the simulator starts its first session at a random time within a day of its start.
- **Stationary synthetic data.** The synthetic population doesn't change over time. That makes repeating the training values a strong baseline, and it says nothing about drift in real data.
- **Known shape differences.** On synthetic data, the simulator's idle time between sessions has a different shape from the generator's, and deposits after a loss differ with it. These mismatches are expected even with true parameters, and they are reported rather than tuned away.
- **Real data.** Without balance fields, stopping is all-cause and refuel is a proxy, as in the simulator.
- **Policies.** Held-out validation checks behavior without policies. It says nothing about how traders respond to a policy, for which there is no data.
- **Customer data.** Results on CUSTOMER data are customer-derived and stay out of the repo.

## Transparent behavioral baseline (baseline-0.1)

The baseline represents selected aggregate behavior from tokenized trader activity: session activity, trade frequency, stake distribution, deposit behavior, market mix, and response to configured policy friction. Its stakes don't depend on outcomes, so it can't react to losses or to a policy. `simulateTwin` is unchanged and kept for comparison; `simulateBaseline` runs it with its output labelled baseline-0.1. Held-out validation compares it with the twin through an adapter.

Limitations: missing outcomes reduce coverage, small samples produce unstable estimates. `validateTwin` compares simulated totals with the same window the profile was built from. It is labelled a same-window mechanics check, not validation.
