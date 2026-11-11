# Phase 0: Product and delivery foundation

## Objective

Build a production-shaped pilot for one prediction-market venue. The pilot accepts tokenized batch activity, calculates transparent behavioral signals, builds reproducible trader twins, tests one responsible-trading policy, and produces an evidence report.

## Source material

- `PlayMind Trader Twins - Visual Brief.pdf`
- Roosevelt Institute: https://rooseveltinstitute.org/blog/since-kalshis-launch-ordinary-users-have-lost-half-a-billion-dollars/
- Connecticut Governor's Office: https://portal.ct.gov/governor/news/press-releases/2026/09-2026/governor-lamont-announces-new-actions-against-illegal-prediction-markets-offering-sports-wagers/

The visual brief supplies business context. External claims, pricing, customer status, market size, and regulatory statements need source review before investor or customer use.

## Confirmed working scope

- One venue pilot.
- Batch data first.
- Tokenized trader identifiers.
- No direct PII in analytical data.
- Transparent baseline signals.
- Reproducible trader twins.
- One policy test path.
- One evidence report.
- Synthetic data for local development.

## Explicit non-goals

- Trade execution.
- Customer fund management.
- Personal trading advice.
- Real-time order routing.
- Cross-venue identity matching.
- A multi-venue hub.
- Production customer data in this repository.
- Causal claims from synthetic or observational replay.

## Decisions

1. The first product is a policy-testing and evidence platform, not a trading platform.
2. The first engineering deliverable uses a deterministic Node.js demo so the repository runs without external services.
3. The production target separates web, analytics, storage, database, and job-processing boundaries.
4. Missing realized outcomes stay unavailable and never become zero.
5. Synthetic output receives a visible `SYNTHETIC DEMO ONLY` label.
6. The future broker hub stays in the backlog behind a paying venue and a broker design partner.

## Open decisions

- First design partner and final data fields.
- Customer data-use agreement.
- Identity-token ownership and key custody.
- Production identity provider.
- Production object storage provider.
- Model validation thresholds.
- Retention period.
- Legal review of policy simulations and identity matching.

## Risks

| Risk | Effect | Response |
| --- | --- | --- |
| No approved customer data | No customer evidence | Build synthetic demo and secure a data-for-access pilot |
| Weak data coverage | Misleading signals | Show coverage, missingness, and unavailable outcomes in every report |
| Model overclaiming | Customer and regulatory trust loss | Use transparent models, held-out checks, and explicit limitations |
| Identity matching restrictions | Hub delay | Keep the first release venue-scoped |
| Data leakage | Severe privacy impact | Enforce tenant scope, tokenized IDs, access logs, and PII rejection |
| Scope expansion | Slow pilot | Gate hub, live integrations, and advanced models behind pilot evidence |

## Phase 0 acceptance

- Product objective written.
- Scope and non-goals written.
- Assumptions and open decisions written.
- Initial risks written.
- Implementation prompt written.
- Product backlog written.
- Architecture written.
- Schema written.
- Synthetic demo runnable.
