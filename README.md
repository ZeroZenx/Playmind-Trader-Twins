# PlayMind Trader Twins

PlayMind Trader Twins is a pilot foundation for testing responsible-trading policies on behavioral twins built from tokenized trader activity.

Current delivery status:

- Phase 0 complete
- Refined implementation prompt complete
- Product backlog complete
- Technical architecture complete
- PostgreSQL schema applied to the hosted Neon project
- Synthetic demo complete
- Next.js production web and API layer built
- Neon Auth session boundary built
- Tokenized CSV customer-data intake built
- Jan-Mar 2026 holdout model tested
- Read-only Polymarket public-market adapter built
- Vercel production deployment configuration built; deployment waits on team access approval and final environment setup

See `docs/IMPLEMENTATION_STATUS.md` for the evidence, remaining gates, and deployment checklist.

## Run the synthetic demo

```bash
npm run demo
```

The command builds evidence report v2 from a SYNTHETIC behavioral population. It generates the events, fits twins, runs held-out validation, runs a policy sweep, and writes the results. It takes about a minute; `npm run demo -- --traders 30 --holdout-replicates 10 --sweep-replicates 8` is quicker. It writes these files to `demo/output/`:

- `synthetic-events.json`
- `report-v2.json`
- `report-v2.html` (self-contained, with inline SVG charts and no scripts)

`demo/output/` is gitignored, because the report contains held-out validation results, which stay in local output.

## Run checks

```bash
npm run check
npm test
npx tsc --noEmit
npm run build
# Or run the full release gate
npm run verify:release
```

The demo uses deterministic synthetic data. It does not connect to a venue, place orders, use customer data, or provide trading advice.

## Check twin parameter recovery

```bash
npm run twin:recovery
```

Fits twin-0.2.1 (`docs/MODEL_CARD.md`) to a SYNTHETIC population with known parameters and prints a short summary. The full results go to `analysis/output/twin-recovery/`, which is gitignored. Recovery numbers stay in that local output.

## Check the simulator

```bash
npm run twin:simulation
```

Simulates a SYNTHETIC population with `simulateTwinV2` (`docs/MODEL_CARD.md`, ADR-012), on the generator's true parameters and on fitted twins, and checks how often each trader's training behavior falls inside its simulated band. The full results go to `analysis/output/twin-simulation/`, which is gitignored. Calibration numbers stay in that local output.

## Sweep policies and response assumptions

```bash
npm run policy:sweep
# A quick, smaller run:
npm run policy:sweep -- --traders 100 --replicates 50 --policies cooldown
```

Runs cooldowns, deposit limits, stake limits, and session loss limits on fitted twins of a SYNTHETIC population (`docs/MODEL_CARD.md`, ADR-013). Each policy is compared with no policy on common random numbers, across its settings and across named assumptions about how traders respond. With no intervention data, every response is an assumption, and the output says which assumption drives each result. These are simulations under stated assumptions, not causal claims. The full run takes a while and prints its runtime. Results go to `analysis/output/policy-sweep/`, which is gitignored. Policy result numbers stay in that local output.

## Run the web application

Set `DATABASE_URL`, `NEON_AUTH_BASE_URL`, and `NEON_AUTH_COOKIE_SECRET` in the local environment, then run:

```bash
npm run dev
```

The app uses Neon Managed Auth and Postgres. Production data intake accepts tokenized CSV files through private object storage and a durable ingestion worker. Direct identity fields receive an automatic rejection. Malware scanning and customer-specific retention approval remain deployment gates.

The holdout analysis uses the main [Polymarket users dataset](https://huggingface.co/datasets/vgregoire/polymarket-users), the dataset [documentation](https://www.vincentgregoire.com/polymarket-users-data), and the official [Polymarket Gamma API documentation](https://gamma-api.polymarket.com/docs). The separate raw-trades dataset was not used.

## Project documents

- `docs/PHASE-0.md` records decisions, assumptions, risks, and scope.
- `docs/IMPLEMENTATION-PROMPT.md` contains the refined coding-agent prompt.
- `docs/PRODUCT-BACKLOG.md` contains the prioritized delivery backlog.
- `docs/ARCHITECTURE.md` describes the proposed production architecture.
- `docs/DATA-DICTIONARY.md` defines the event and database model.
- `docs/PILOT_SUCCESS_PLAN.md` defines the first customer test.
- `docs/SECURITY_AND_PRIVACY.md` defines the data boundary and controls.
- `docs/THREAT_MODEL.md` records the first security threats.
- `docs/MODEL_CARD.md` records intended model use and limits.
- `docs/API.md` defines the initial service contract.
- `docs/OPERATIONS_RUNBOOK.md` defines local and production operations.
- `docs/DECISIONS.md` records architecture decisions.
- `docs/RISK_REGISTER.md` records delivery risks.
- `db/schema.sql` contains the PostgreSQL schema.
- `db/migrations/` contains numbered, additive SQL migrations, applied in order after `db/schema.sql`. Change the schema with a new migration, never by editing `db/schema.sql`.
