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
