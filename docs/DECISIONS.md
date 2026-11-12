# Architecture decisions

## ADR-001: Venue-scoped first release

Decision: Start with one venue.

Reason: A venue-specific policy test needs less identity, governance, and integration complexity than a cross-venue hub.

## ADR-002: Batch data first

Decision: Start with file or controlled batch intake.

Reason: Batch intake supports data-quality review, reproducible runs, and a faster design-partner pilot.

## ADR-003: Transparent baseline first

Decision: Start with transparent behavioral summaries and seeded simulation.

Reason: Customer review needs traceable calculations before advanced modeling.

## ADR-004: No direct PII in analytics

Decision: Reject direct PII fields.

Reason: The first product needs a clear privacy boundary and tokenized records.

## ADR-005: Synthetic demo before customer data

Decision: Build a full local demo with synthetic events.

Reason: Engineering progress must continue while data access and legal review remain open.

## ADR-006: Next.js and Neon for the first hosted slice

Decision: Use Next.js route handlers on Vercel with Neon PostgreSQL and Neon Managed Auth.

Reason: One application boundary keeps the first pilot small. Neon supplies hosted relational storage and the authentication boundary. Long-running validation and report jobs remain a separate follow-up service.

## ADR-007: Read-only venue adapter

Decision: Add public Polymarket market metadata reads without private credentials, order placement, or custody.

Reason: The pilot tests evidence workflows. Execution adds financial, legal, and operational risk before customer value is proven.

Source: [Polymarket Gamma API documentation](https://gamma-api.polymarket.com/docs).

## ADR-008: Holdout model remains separate from product scoring

Decision: Keep the Jan-Mar 2026 model evaluation in the analysis package and outside production customer scoring until independent review.

Reason: The public-data result is observational and uses a mark-to-market proxy. Production use needs customer validation, model governance, and documented intervention rules.

## ADR-009: Stake response and within-session escalation use separate trades

Decision: In `behavior-0.2.0`, signal 1 (post-outcome stake response) and signal 6 (escalation within session) never use the same post-loss trade.

- Signal 1 takes the first trade after a realized loss. If that loss is the second or later loss of a losing run, and the next trade is in the same session, the trade belongs to signal 6 instead.
- Signal 6 starts from the second loss in a run. It measures stake growth per additional consecutive loss, relative to the stake on the trade after the first loss. The value is exp of the least-squares slope through the origin of log(stake after loss m ÷ stake after loss 1) on (m − 1).

Reason: The v0.2 simulator multiplies the two: next stake = base stake × chase multiplier × escalation. Suppose signal 1 also used trades deep inside losing runs. Then an escalating trader's chase multiplier would already contain escalation, and the simulator would count it twice. With separate trades, chase is the response to one loss, and escalation is the extra growth per additional loss in the same session.

Consequences:

- A losing run ends at a session boundary, which matches the simulator's "consecutive losses this session" rule. The first trade of a new session after a loss counts toward signal 1, even if the previous session ended on a long losing run.
- Traders with long losing runs have fewer signal-1 episodes. The trades excluded from signal 1 are counted in `postOutcomeStake.excluded.escalationPosition`.
- Re-entry latency (signal 2) is not split this way, because the simulator draws latency from the last outcome only.

## ADR-010: Behavioral synthetic generator rules the estimator must account for

Decision: `behavioral-synthetic-0.1.0` (`src/synthetic/behavioral-generate.mjs`) simulates SYNTHETIC traders with parameters defined against `behavior-0.2.0`. Full rules are in `docs/BEHAVIORAL-SYNTHETIC.md`. These choices affect how twin-0.2.0 should estimate parameters and how recovery tests should compare estimates with the truth:

1. Every noise term is lognormal with median 1. Money and time parameters are medians. Chase and escalation multiply the stake, so estimate them on the log scale: `postOutcomeStake.lossMinusWin.logRatioDifference` for chase, `escalation.logSlope` for escalation.
2. Running out of money ends the session; the stake is never capped at the balance. Stakes stay undistorted, but observed stop rates include these forced stops, mostly in the down buckets. The truth file records forced stops by bucket, separately from hazard stops. *Corrected in Prompt 3:* this ADR used to say a recovery test could compare a stop-rate estimate with hazard plus forced stops. Those counts come from the same trades the estimator sees, so hazard plus forced stops per trade is a sample proportion, not a parameter, and coverage measured against it means nothing. It is a descriptive check only. twin-0.2.0 estimates the voluntary hazard and is checked against `stopHazard` (ADR-011).
3. The generator's drawdown buckets and low-balance threshold use the trader's `baseStake`. The signals use the observed median stake. For chasers and shrinkers the two differ, so bucketed stop rates and low-balance triggers don't line up exactly.
4. Refuel deposits always land inside the refuel window and inside the session. A new session starts at least max(`sessionGapMinutes`, `refuelWindowMinutes`) + 1 minute after the previous session's last event, so a session-start deposit is never counted as a refuel. Signal 5 therefore counts the generator's refuels, except in the rare case where a later trigger's refuel falls within 60 minutes of an earlier trigger that didn't refuel.
5. Within-session latency is clamped to between 2 seconds and `sessionGapMinutes`, so the signals see exactly the generator's sessions. The latency parameters match `reentryLatency.withinSession`, not `anySession`. The observed session rate is below `sessionsPerDay`, because idle time = `minIdle` + Exponential(1440 / `sessionsPerDay` minutes) is measured from the end of the previous session.
6. Blanked outcomes are missing completely at random, after simulation. The trader reacted to the true outcome, so a blanked loss still drives the next stake's chase term. The signals see a missing outcome, which breaks the losing run there.
7. The archetypes and the population have a negative edge of about 9% of stake per trade, so balances run low and deposits recur. This is a modelling convenience, not a claim about any venue.

Reason: The generator exists to test parameter recovery. Each parameter should leave its footprint in one signal, and the generator and the signals should agree on sessions, outcomes, and balances. Where something leaks from one parameter into another signal (forced stops into stop rates, `baseStake` against median-stake edges), the leak is recorded in the truth file rather than hidden.

Consequences:

- Recovery tests should compare like with like: within-session latency with the latency parameters, and a voluntary stop-hazard estimate with `stopHazard`. Hazard plus forced stops per trade is a descriptive check only (corrected in Prompt 3).
- Signals are tested for direction only in Prompt 2. Exact recovery, with intervals and shrinkage, is Prompt 3's job.
- The population distributions are modelling assumptions, loosely informed by the OBSERVATIONAL Polymarket follow-up. They are not a calibration.

## ADR-011: twin-0.2.0 parameter estimation

Decision: `estimateTwins` in `src/engine/estimate.mjs` (model version `twin-0.2.0`) fits a small set of interpretable behavioral parameters per trader, each with a point estimate, a 90% interval, a sample size n, a shrinkage weight, and a status. Method and field needs are in `docs/MODEL_CARD.md`. These are the choices behind it.

1. **Inputs.** The estimator reads only `buildBehaviorObservations` (behavior-0.2.0), so it reuses the signal definitions instead of copying them. It never reads market or contract fields. The caller must pass a data label (SYNTHETIC, OBSERVATIONAL, or CUSTOMER), and every output carries it.
2. **Parameters are defined the way the Prompt 4 simulator will use them.** Next stake = `baseStake` × `chaseCoefficient` (after a realized loss) × `escalationPerLoss`^(k − 1) (after the k-th consecutive loss in a session) × lognormal noise with SD `stakeDispersion`. `baseStake` comes from trades with neither term: the trader's first trade, and trades after a realized win or push.
3. **Priors are fitted on the same dataset.** Each parameter's population prior is fitted by the method of moments to every trader's raw estimate in the dataset being fitted, with the sampling noise taken out (DerSimonian-Laird for normal and beta priors, a moment match for the idle-time prior). Every trader's data therefore informs both its own estimate and, as one of many, the prior. That is standard empirical Bayes. It needs enough traders: with fewer than 3 traders with observations there is no prior, estimates are unpooled (weight 1), and traders without observations are not estimable. Priors are stored once per dataset and model version (`twin_population_priors`), and a new dataset gets new priors. A prior fitted on customer data is customer-derived data and stays out of the repo. The prior's own estimation error is ignored, so intervals are slightly too narrow when few traders inform a prior.
4. **How intervals are computed.** All are equal-tailed 90% intervals of the posterior. Normal-normal (log scale): posterior mean ± 1.645 posterior SD, exponentiated. Beta-binomial: the 5th and 95th percentiles of the Beta posterior, by bisection on the regularized incomplete beta function. Inverse-gamma (idle time): the 5th and 95th percentiles of the posterior, from gamma quantiles, plus `sessionGapMinutes`. A trader's own sampling variance uses a moderated spread: the trader's sample variance averaged with the pooled within-trader variance, which counts as 5 observations. One or two noisy values then can't produce a falsely tight interval.
5. **Escalation is clustered by run through its shared reference stake.** Signal-6 points from one losing run all divide by the same stake (the one after the run's first loss), so they share its noise. The variance of the slope is σ² Σ_runs (Σx² + (Σx)²) / (Σx²)², with σ the trader's estimated `stakeDispersion`. We also tried a cluster-robust sandwich (CR1) and a jackknife over runs. Both ran too small on synthetic recovery, because a few long losing runs carry most of the leverage, so intervals built on them were too narrow.
6. **Latency truncation.** A within-session latency can't exceed `sessionGapMinutes`, because a longer gap starts a new session; the generator clamps at the gap. The mean of log latency is biased low for slow traders, so the raw estimate is the median log latency, with spread from the MAD and sampling variance (π/2) σ² / n. Neither moves while fewer than half the latencies reach the gap. A trader whose median latency is near the gap is underestimated.
7. **Voluntary versus all-cause stopHazard.** Prompt 4's simulator has its own broke rule, so twin-0.2.0 estimates the voluntary hazard. With balance fields on every trade, a trade is left out of the stop sample when the chance that the next stake exceeds the money available for it (balance after the trade, plus any deposit before the next trade) is at least 5%. The next stake is baseStake × the chase and escalation terms the trade implies, with lognormal noise `stakeDispersion`. The number of trades and stops left out is reported (`stopSample`). The rule depends only on the state before the stop decision, so it doesn't bias the hazard. The recovery test checks that it removes nearly all the forced stops recorded in the truth file. Without balance fields, the two causes can't be separated. The rate is all-cause, flagged `includesForcedStops`, and with the simulator's own broke rule it double-counts running out of money, so simulated stopping is overstated in low-balance states. Prompt 4 must label runs that use an all-cause hazard.
8. **Bucket edges and the low-balance threshold use the estimated baseStake**, not the observed median stake. That is what the generator does, and what the simulator will do. Running results are re-bucketed from the observations with `drawdownBucket`.
9. **Stop propensity.** Bucket hazards move together, and how often a trader reaches a bucket depends on the hazards themselves: a trader who quits early when a little down rarely reaches a large drawdown. Independent per-bucket priors were therefore fitted mostly to traders who don't quit, and were too low for down_large, worst for traders with no down_large trades at all. Each bucket's beta prior is now centered at the bucket rate × the trader's stop propensity, estimated from the trader's stops in the other three buckets (indirect standardization: observed over expected stops, shrunk toward 1 with a gamma prior fitted by the method of moments). Bucket rates are refitted against propensity-weighted exposure, which corrects for who reaches each bucket. The prior keeps the bucket's full fitted spread, so the propensity only moves its center. The update is still beta-binomial per bucket.
10. **Beta prior centers are the pooled proportion.** Re-weighting the center by 1 / (sampling variance + τ²), as the normal prior does, was tried and made stop and refuel coverage worse, because trial counts there depend on the parameter.
11. **Refuel needs balance fields.** `refuelProbability` uses signal 5's low-balance trigger with threshold `lowBalanceStakeMultiple` × the estimated `baseStake`. Without balances it is not estimable, and there is no prior to fall back on when no trader has balances. `refuelAfterLosingStreak` is reported separately as a labelled proxy (`proxyFor: refuelProbability`). It uses a different trigger, so it is not the same quantity. When balances are missing, Prompt 4 should switch its refuel trigger to the losing-streak rule and use `refuelAfterLosingStreak` as that trigger's probability. It must never apply the proxy to the low-balance trigger, and reports must say refuel behavior is proxied. Refuel trigger counts also depend on the refuel rate (a refuel restarts the low-balance cycle), which pulls the prior toward frequent refuelers.
12. **Idle time.** The mean idle time between sessions (last event to next first event) is fitted as `sessionGapMinutes` plus an exponential excess with an inverse-gamma prior. The excess is positive by definition, so the offset needs no generator constant. One-session traders get the prior. On a fixed window, long gaps near the end are cut off, so a real-data estimate is biased low.
13. **Statuses.** `estimated`; `prior_only` (inputs present, no observations for this trader: weight 0, the trader's prior); `not_estimable` (inputs missing, with a reason). A not-estimable parameter carries the population prior as `fallback` only when other traders in the same dataset had the inputs. Otherwise `fallback` is null.

Reason: The twin has to be an econometric model a reviewer can check by hand: a few named parameters, each fitted by a standard, one-paragraph formula, with honest uncertainty, and with short histories pulled toward the population rather than taken at face value. Recovery on SYNTHETIC traders with known parameters (`test/twin-recovery.test.mjs`) checks correlation, interval coverage, shrinkage, and the not-estimable paths. Its numbers stay in test thresholds and in the gitignored output of `npm run twin:recovery`.

Consequences:

- A missing realized outcome breaks a losing run in the signals, so a later trade can enter the chase sample with an escalated stake. With many missing outcomes, chase is biased in the direction of the trader's escalation.
- Synthetic population shapes matter for coverage. A population that is uniform with no tails (the generator's flat-bucket hazard) is over-covered when intervals are dominated by the prior.
- Prompt 4 should draw each run's parameters from the stored posterior (`posterior` on every parameter), not from the interval endpoints.
- The schema stores twin-0.2.0 parameters through the additive migration `db/migrations/0001_twin_v02_parameters.sql`.

## ADR-012: State-dependent simulator (simulator-0.2.0) and twin-0.2.1

Decision: `simulateTwinV2` in `src/engine/simulate.mjs` (simulator version `simulator-0.2.0`) simulates twin-0.2.1 twins trade by trade, with many seeded replicates per trader, and returns the median and the 10th and 90th percentiles of harm and activity metrics per trader and for the population. It implements the parameter definitions of ADR-011 point 2 exactly. `simulateTwin` is unchanged and kept as baseline-0.1 (`simulateBaseline` labels its output). Method and limits are in `docs/MODEL_CARD.md`. These are the choices behind it.

1. **Posterior draws, independent across parameters.** Parameters come only from the `estimateTwins` fit. Each run draws every parameter once, at its start, from the stored `posterior`: exp(N(mean, sd)) for log-scale normals, Beta(a, b) for probabilities, `offsetMinutes` + scale / Gamma(shape) for the idle time, with seeded samplers in `stats.mjs`. It never draws from interval endpoints. Only marginal posteriors are stored, so the draws are independent. The stop-hazard buckets were fitted with a shared stop propensity (ADR-011 point 9), so independent bucket draws ignore that correlation; this is a stated limit. If a drawn `winRate` + `pushRate` exceeds 1, both are rescaled to sum to 1 and the run is counted. With uncertainty off, runs use the stored estimates (the posterior centers).
2. **Statuses and simulability.** `estimated` and `prior_only` draw from `posterior`. `not_estimable` with a `fallback` draws from the fallback, recorded as "population prior, not this trader". `not_estimable` without one switches the mechanism off, and the result says which and why; nothing is filled with zero or a default. The base rule is that a trader can't be simulated without `baseStake`, `winRate`, and the latencies. We apply it to their whole mechanisms (stake: `baseStake`, `stakeDispersion`; outcomes: `winRate`, `pushRate`, `payoutMultiple`, `payoutSpread`; latency: both latencies and `latencySpread`) and add stops (every `stopHazard` bucket) and sessions (`meanIdleMinutes`), because without them a session or a horizon can't end. These share inputs with the named parameters, so in practice they differ only in tiny datasets with no prior. Chase, escalation, deposits, and refuel can be switched off. A trader with no realized outcome at all is not simulable even when fallbacks exist, because every outcome-driven parameter would be the population's, not the trader's.
3. **Stop basis.** With balance fields in training the hazard is voluntary, and the simulator's broke rule adds forced stops. Without them the hazard is all-cause and already includes running out of money. The broke rule can't be dropped, because a simulated balance can't go negative, so stopping is double-counted in low-balance states. We simulate anyway and label the runs `stopBasis: 'all-cause'`, with the double count in the trader's assumptions.
4. **Refuel proxy switch (ADR-011 point 11).** When `refuelProbability` is not estimable, the refuel trigger becomes `losingStreakLength` consecutive realized losses (signal 5's losing-streak rule: across sessions, reset by a win, a push, or a deposit), with `refuelAfterLosingStreak` as its probability, labelled `refuelTrigger: 'losingStreak (proxy)'`. The proxy is never applied to the low-balance trigger. `refuelProbability`'s population fallback is not used in this case: it would replace this trader's own proxy evidence with other traders' low-balance behavior. If the proxy can't be simulated either, refuel is off.
5. **Starting balance.** The trader's last observed `balance_after`, when the caller supplies it in `startingBalances` (`lastObservedBalances(events)` computes it). An `estimateTwins` fit stores parameters, not balances, so the balance comes in as an option rather than as a new field on the fit. Without it the trader starts at 0 with the session-start deposit rule. The rule used is in the trader's assumptions, including when training had balances but none was supplied.
6. **Empirical loss ratios.** A loss's result is the stake times a ratio drawn from the trader's stored loss quantiles of result ÷ stake (`payoutDistribution.resultPerStake.losses`). Only five quantiles are stored, so the draw interpolates linearly between them and holds p10 and p90 in the tails. A trader with no observed losses loses the whole stake (ratio −1), recorded as an assumption. The synthetic generator always loses the whole stake; real exchange data may not.
7. **Idle-time shape.** Idle time between sessions is `sessionGapMinutes` + Exponential(`meanIdleMinutes` − `sessionGapMinutes`), the estimator's model (ADR-011 point 12), at least one second above the gap so the signals see the same sessions. The generator uses minIdle + Exponential: the same mean, a different shape. Idle time moves timing only, so the reproduce check compares per-session and per-trade metrics, and uses refuel deposits rather than deposits after a loss, which a short simulated idle time can add to.
8. **Separate random streams for common random numbers.** Each kind of decision has its own stream, seeded from the run seed `stableSeed(seed:traderToken:replicate)`: outcomes (4 draws per trade), stake noise (2 per intended stake), latency (2 per trade, drawn even when the session ends), stops (1 per trade), refuel (2 per trigger), deposits (2 per intended deposit), and idle time (2 per session). Every parameter has its own sub-stream. A policy that changes one decision therefore never shifts another decision's draws, and Prompt 5 can compare policy and no-policy runs on common random numbers. `reseedStreams` re-seeds one stream for the check. A replicate doesn't depend on which other traders are simulated.
9. **Generator rules where the twin has no estimate** (`docs/BEHAVIORAL-SYNTHETIC.md`): the first session starts at a uniform time within 24 hours of the start; the session-start deposit rule (a balance below `lowBalanceStakeMultiple` × `baseStake` or below the first stake), raised to cover the first stake if short, with the first trade 1 to 5 minutes later; the refuel deposit lands between the trigger trade and the next trade, or 1 minute to min(`sessionGapMinutes`, `refuelWindowMinutes`) after it when the session ends; the broke rule ends a session instead of capping the stake; latency is rounded to whole seconds and clamped to [2 s, `sessionGapMinutes`]; stakes and wins are at least 1 cent; and the `maxTradesPerSession` cap (200). `GENERATOR_RULES` holds the constants, and a test checks them against the generator's.
10. **Why twin-0.2.1 adds `latencySpread` and `depositSpread`.** twin-0.2.0 had no latency noise and no deposit noise, and the simulator needs both. Zero noise would be a default, and the generator's values aren't estimates. Both use normal-normal shrinkage on log SD, with statuses, n, weights, intervals, posteriors, and fallbacks like every other parameter. `depositSpread` is fitted like `stakeDispersion`, on the log deposit amounts. `latencySpread` has to be robust to truncation at `sessionGapMinutes`, so it is MAD-based: each side's within-session log latencies (after a loss, after a win) are centered at that side's median observation (the lower middle one for an even count), which is left out, and the spread is 1.4826 × the median absolute deviation of the rest, pooled over both sides, with Var(log SD) = 1.3605 / n. It doesn't move while the gap stays above each side's upper quartile. We checked the alternatives by simulation: the plain MAD (with the median's zero deviation) is biased low on the log scale at the sample sizes most traders have, by an amount that depends on whether each side's count is odd or even; the median-pairwise-difference (Shamos) spread is unbiased and more efficient, but latencies cut off at the gap pull it down. Both spreads are in the recovery output. `latencySpread`'s coverage is asserted; `depositSpread`'s isn't, because it sits near the upper edge of the band, with many prior-only intervals (traders with fewer than 2 deposits).
11. **One hook for Prompt 5.** `intervention(point, proposal, state)` is called before a stake, before a deposit, and after a trade. simulator-0.2.0 always uses `NO_INTERVENTION` (the call is skipped) and implements no policy.
12. **Metrics.** A chase episode is a stake of at least 1.25 × the run's drawn `baseStake` on the trade after a realized loss. Stake noise alone crosses that line, so the same count after wins is reported as the noise floor. Deposits after a loss count every deposit within `refuelWindowMinutes` after a realized loss. Population bands sum each replicate across traders first (drawdowns are averaged), then take percentiles; percentiles of per-trader percentiles would not be a population distribution. `metricsFromEvents` computes the event-observable metrics from analytical events through `buildBehaviorObservations`, and a test checks it against the simulator's own counts on the same runs.
13. **The reproduce check.** `src/synthetic/truth-twins.mjs` builds twins from the generator's truth as point masses (`{ family: 'point' }`, a family `estimateTwins` never produces), with `meanIdleMinutes` = minIdle + 1440 / `sessionsPerDay`. Each trader is simulated for its training session count with uncertainty off, and we count the traders whose observed training value (from the events, or from the truth file for forced stops and refuel deposits) falls inside the simulated 10th-90th percentile band. The same check on fitted twins with uncertainty on is in-sample. Thresholds are stated in `test/simulation-calibration.test.mjs`; the numbers stay in test thresholds and gitignored output.

Reason: The twin has to react to what just happened and to a policy, which an outcome-independent simulator can't do. Every mechanism maps to one named twin parameter with its own uncertainty, every assumption the twin can't estimate is listed with the result, and the randomness is arranged so a policy comparison isolates the policy.

Consequences:

- Simulated runs from a CUSTOMER fit are customer-derived data and stay out of the repo, like the fit.
- Bands carry parameter uncertainty only as far as the marginal posteriors do; correlated uncertainty (stop propensity, base stake with dispersion) is not represented.
- The calibration check shows the simulator implements the model on SYNTHETIC data. Whether the model fits real traders is Prompt 6's held-out validation.
- Prompt 5 adds policies through the hook and must keep each policy's effects to the decisions it changes, so common random numbers still hold.
