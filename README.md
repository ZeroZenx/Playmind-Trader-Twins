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
- Vercel production deployment pending team-access approval and final environment setup

See `docs/IMPLEMENTATION_STATUS.md` for the evidence, remaining gates, and deployment checklist.

## Run the synthetic demo

```bash
npm run demo
```

The command writes these files to `demo/output/`:

- `synthetic-events.json`
- `synthetic-report.json`
- `synthetic-report.html`

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

## Run the web application

Set `DATABASE_URL`, `NEON_AUTH_BASE_URL`, and `NEON_AUTH_COOKIE_SECRET` in the local environment, then run:

```bash
npm run dev
```

The app uses Neon Managed Auth and Postgres. Production data intake accepts tokenized CSV files. Direct identity fields receive an automatic rejection. Large-file object storage, background job queues, and customer-specific retention controls remain deployment gates.

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
