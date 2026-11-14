# Implementation status

Updated 2026-11-14 (twin v0.2, Prompt 9).

Three groups: what is built, what has been validated on SYNTHETIC data only, and what is waiting on customer data. No accuracy headline appears here or anywhere in the repo: validation numbers live in gitignored local output (`analysis/output/`, `data/output/`, `demo/output/`). The plan is `docs/TWIN-V02-PLAN.md`. The steps for Sporttrade's file are in [SPORTTRADE_INTAKE.md](SPORTTRADE_INTAKE.md), and readiness is in [SPORTTRADE_READINESS.md](SPORTTRADE_READINESS.md).

## Built

### Twin v0.2 engine and tools

| Piece | Version | Entry point | Decision |
| --- | --- | --- | --- |
| State-dependent behavioral signals | behavior-0.2.0 | `src/engine/behavior.mjs` | ADR-009, [DATA-DICTIONARY.md](DATA-DICTIONARY.md) |
| Behavioral synthetic traders with known parameters | behavioral-synthetic-0.1.0 | `src/synthetic/behavioral-generate.mjs` | ADR-010, [BEHAVIORAL-SYNTHETIC.md](BEHAVIORAL-SYNTHETIC.md) |
| Parameter estimation with shrinkage | twin-0.2.1 | `src/engine/estimate.mjs`, `npm run twin:recovery` | ADR-011 |
| State-dependent simulator | simulator-0.2.0 | `src/engine/simulate.mjs`, `npm run twin:simulation` | ADR-012 |
| Policies with explicit response assumptions | policy-0.2.0 | `src/engine/policy-sim.mjs`, `npm run policy:sweep` | ADR-013 |
| Held-out validation against baseline-0.1 and a naive model | holdout-0.1.0 | `src/engine/holdout.mjs`, `npm run twin:holdout` | ADR-014, [MODEL_CARD.md](MODEL_CARD.md) |
| Evidence report v2 | report-0.2.0 | `src/engine/report-v2.mjs`, `npm run demo` | ADR-015 |
| Local intake for a raw venue export | intake-0.1.0 | `src/intake/`, `npm run intake` | ADR-016, [SPORTTRADE_INTAKE.md](SPORTTRADE_INTAKE.md) |

The intake pipeline runs end to end, on one command, from a raw ledger-shaped export with no market or balance fields to report v2. It tokenizes IDs with a salted HMAC, refuses PII columns, and writes only under `data/`. The upload path (`src/lib/ingestion.ts`) and intake reject the same PII headers, spaced variants included (ADR-016 point 5).

### Platform

| Area | Status | Remaining gate |
| --- | --- | --- |
| Web application (Next.js App Router, `src/app/`) | Built locally; production build passes | Vercel deployment and browser QA on the hosted URL |
| Hosted database (Neon, PostgreSQL schema applied) | Built | Backup, retention, and production monitoring |
| Authentication (Neon Managed Auth) | Built | Production trusted domain and cookie secret |
| Tokenized CSV upload | Built: SHA-256 provenance, required columns, duplicate and PII header rejection, row validation, ingestion jobs | Object storage, signed uploads, malware scanning, large-file queue, retention controls |
| API route handlers | Built locally | Hosted deployment, rate limits, observability |
| Read-only Polymarket public adapter | Built; execution disabled (ADR-007) | None planned: no order placement or custody |
| Public-data holdout model (OBSERVATIONAL) | Built and evaluated; results in local output only (ADR-008) | Independent validation and model governance review |
| Deployment | Pending: `vercel.json` and the release gate (`npm run verify:release`) are in place | Vercel team approval, environment variables, live health check |

## Validated on synthetic data only

Everything below was checked on SYNTHETIC populations from the behavioral generator, whose true parameters are known. None of it says anything yet about a real trader.

- **Parameter recovery** (ADR-011, `test/twin-recovery.test.mjs`). The estimator recovers known behavior, including the direction of the stake response after a loss for traders who scale back and for those who chase. Intervals cover the truth at about their stated level for most parameters (push rate and the stop hazard after a large loss run low), and low-history traders are shrunk toward the population. At a 2,000-trader scale, every parameter that doesn't depend on balances recovers the same with or without balance fields.
- **Without balance fields** (closest to what we expect from Sporttrade): the stop hazard becomes all-cause. It includes stops from running out of money, so it reads high after losses, more so after large ones, and its intervals cover the voluntary truth less often there. The refuel probability is not estimable, and the losing-streak proxy that replaces it is a different trigger that tracks the true refuel tendency only loosely. Both are labelled as such in every output.
- **Simulation calibration** (ADR-012). Simulated twins reproduce the generator's session shapes within stated tolerances. The known shape differences are reported, not tuned away.
- **Held-out validation** (ADR-014). The twin beats baseline-0.1 on every scored metric, on both data paths. Against the naive model (repeat each trader's training values), it beats both comparators and earns the claim on the 2,000-trader population with balance fields. It does not earn it without them: the stake-response metrics still beat both comparators, but session length, timing, and deposits after a loss do not beat the naive model. In the small 40-trader population the test suite uses, it doesn't beat the naive model on either path. These are findings. The tolerances were set before any result and have not been changed.
- **Policy sweep** (ADR-013). The trade-off between harm reduced and activity retained is computed with uncertainty bands, under response assumptions that are stated and swept. These are simulations, not causal effects.
- **Intake at scale.** A SYNTHETIC 2,000-trader ledger with no balances (about 700,000 rows) ran through `npm run intake -- run` end to end. Runtime and memory are in [SPORTTRADE_INTAKE.md](SPORTTRADE_INTAKE.md), step 6.

## Waiting on customer data

- **Sporttrade's export.** Every result above is about the model on synthetic data. The first CUSTOMER run follows [SPORTTRADE_READINESS.md](SPORTTRADE_READINESS.md).
- **Field coverage and the answers to the open questions** in [SPORTTRADE_INTAKE.md](SPORTTRADE_INTAKE.md): time zone, units, how realized P&L is recorded, balances, restrictions, account ID stability, voids, coverage, and format.
- **Balance fields.** Without them the stop hazard stays all-cause, refuel stays a proxy, and on synthetic data the twin doesn't beat the naive model on session shape. Whether Sporttrade can send balances decides which path we are on.
- **Held-out evidence on real traders.** Whether the twin beats both comparators on Sporttrade's data is unknown until it runs. That result stays in local output under the customer agreement.
- **Policy responses.** No intervention data exists, so how traders respond to a policy stays an assumption (ADR-013). Restriction and self-exclusion events are carried through intake but not read by any signal yet (ADR-016).
- **OBSERVATIONAL hook.** Held-out validation on Polymarket public data is a marked hook, not wired (ADR-014 point 16).

## Evidence rules

- Label every output SYNTHETIC, OBSERVATIONAL, or CUSTOMER.
- Policy results are simulations under stated assumptions, never causal claims.
- Validation is evidence about the model on stated data, never an accuracy claim. Its numbers stay in gitignored local output.
- The twin describes and simulates behavior. It does not infer intent, diagnose a person, or authorize an intervention.
- PlayMind never contacts traders, places trades, or holds funds.

Sources for the public data: [Polymarket users dataset](https://huggingface.co/datasets/vgregoire/polymarket-users), [dataset documentation](https://www.vincentgregoire.com/polymarket-users-data), [Polymarket Gamma API](https://gamma-api.polymarket.com/docs).
