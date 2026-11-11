# Technical architecture

## Product boundary

The first release is a batch policy-testing application. A venue supplies tokenized activity. PlayMind validates the data, calculates signals, builds behavioral twins, runs controlled policy simulations, and returns evidence reports.

The first release does not execute trades, manage funds, or match identity across venues.

## Current production-shaped topology

```text
Browser
  |
  v
Next.js web application and API route handlers
  |-- Authentication and workspace authorization
  |-- Dataset intake and report views
  |-- Experiment orchestration
  |
  +--> Neon PostgreSQL
  |      Workspace, users, datasets, events, signals, twins,
  |      policies, experiments, reports, audit events
  |
  +--> Object storage (next gate for large uploads)
  |      Encrypted raw uploads and generated report artifacts
  |
  +--> Job worker (next gate for asynchronous customer processing)
         Validation, signal calculation, twin builds, simulations, reports
                  |
                  v
           Analytics engine
           DuckDB or Polars batch processing
```

## Implemented application layer

The repository keeps the dependency-free Node.js synthetic engine and adds a Next.js App Router application around it. Neon Managed Auth provides the session boundary. Neon PostgreSQL stores workspace, dataset, event, onboarding, venue, experiment, report, and audit records.

Current modules:

- `src/synthetic/generate.mjs` creates deterministic synthetic events.
- `src/engine/validate.mjs` validates event shape and data quality.
- `src/engine/signals.mjs` calculates trader signals.
- `src/engine/twin.mjs` builds and simulates behavioral twins.
- `src/engine/policy.mjs` runs policy comparisons.
- `src/engine/report.mjs` creates JSON and HTML evidence reports.
- `src/app/` contains the web pages and API route handlers.
- `src/lib/ingestion.ts` rejects direct identity headers and validates tokenized CSV events.
- `src/lib/venue.ts` exposes a read-only Polymarket public-market adapter.
- `src/lib/auth/` and `src/proxy.ts` enforce the authentication boundary.

## Domain flow

```text
Dataset upload
  -> schema validation
  -> data-quality report
  -> signal run
  -> twin build
  -> policy experiment
  -> evidence report
  -> reviewer approval
  -> audit record
```

## Production service boundaries

### Identity and workspace service

Owns users, roles, workspace membership, and tenant authorization.

### Dataset service

Owns upload metadata, file checksums, schema versions, validation status, raw-file references, and data-quality reports.

The first path stores validated event rows in Neon. Object storage and signed large-file uploads remain required before a customer-scale launch.

### Event and signal service

Owns normalized events, signal definitions, feature versions, coverage, and missingness.

### Twin service

Owns twin metadata, model versions, random seeds, training windows, validation windows, and simulated behavior.

### Policy service

Owns policy definitions, experiment inputs, simulation jobs, results, and review status.

### Report service

Owns report assembly, report versions, exports, and approval history.

### Audit service

Owns append-only records for sensitive actions.

## Model principles

- Start with transparent aggregate behavior models.
- Store seeds and versions.
- Use held-out periods for validation.
- Report model error and coverage.
- Keep causal language out of observational replay.
- Keep synthetic results outside customer evidence.

## Security model

- Every domain record carries a workspace scope.
- Every request checks workspace membership and role.
- Raw uploads receive stricter permissions than reports.
- Direct PII receives rejection before analytical processing.
- Audit events record actor, action, target, timestamp, and request correlation ID.
- Production secrets enter through environment or secret-management systems.

## Deployment path

1. Local Node.js demo.
2. Local Next.js application with Neon Auth and Neon PostgreSQL.
3. Vercel project with production environment variables.
4. Hosted health, sign-in, protected-route, upload, and read-only venue checks.
5. Object storage, signed uploads, asynchronous jobs, and production retention controls.
6. Security review and approved design-partner data contract.
7. Production pilot deployment.
