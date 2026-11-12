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
