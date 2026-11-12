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
2. Running out of money ends the session; the stake is never capped at the balance. Stakes stay undistorted, but observed stop rates include these forced stops, mostly in the down buckets. The truth file records forced stops by bucket, separately from hazard stops, so a recovery test can compare a stop-rate estimate with hazard plus forced stops, not with `stopHazard` alone.
3. The generator's drawdown buckets and low-balance threshold use the trader's `baseStake`. The signals use the observed median stake. For chasers and shrinkers the two differ, so bucketed stop rates and low-balance triggers don't line up exactly.
4. Refuel deposits always land inside the refuel window and inside the session. A new session starts at least max(`sessionGapMinutes`, `refuelWindowMinutes`) + 1 minute after the previous session's last event, so a session-start deposit is never counted as a refuel. Signal 5 therefore counts the generator's refuels, except in the rare case where a later trigger's refuel falls within 60 minutes of an earlier trigger that didn't refuel.
5. Within-session latency is clamped to between 2 seconds and `sessionGapMinutes`, so the signals see exactly the generator's sessions. The latency parameters match `reentryLatency.withinSession`, not `anySession`. The observed session rate is below `sessionsPerDay`, because idle time = `minIdle` + Exponential(1440 / `sessionsPerDay` minutes) is measured from the end of the previous session.
6. Blanked outcomes are missing completely at random, after simulation. The trader reacted to the true outcome, so a blanked loss still drives the next stake's chase term. The signals see a missing outcome, which breaks the losing run there.
7. The archetypes and the population have a negative edge of about 9% of stake per trade, so balances run low and deposits recur. This is a modelling convenience, not a claim about any venue.

Reason: The generator exists to test parameter recovery. Each parameter should leave its footprint in one signal, and the generator and the signals should agree on sessions, outcomes, and balances. Where something leaks from one parameter into another signal (forced stops into stop rates, `baseStake` against median-stake edges), the leak is recorded in the truth file rather than hidden.

Consequences:

- Recovery tests should compare like with like: within-session latency with the latency parameters, and observed stop rates with hazard plus forced stops.
- Signals are tested for direction only in Prompt 2. Exact recovery, with intervals and shrinkage, is Prompt 3's job.
- The population distributions are modelling assumptions, loosely informed by the OBSERVATIONAL Polymarket follow-up. They are not a calibration.
