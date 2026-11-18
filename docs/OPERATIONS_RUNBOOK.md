# Operations runbook

## Migration and worker operations

Run migrations with a direct, non-pooled `DATABASE_URL`:

```bash
npm run db:migrate
```

The runner records the baseline checksum and every numbered SQL migration in `schema_migrations`. It adopts an existing baseline schema before applying new migrations. A changed checksum stops the run.

Process one queued experiment locally or from a scheduled worker:

```bash
npm run worker:once
```

The worker claims one queued job, runs the shared analysis pipeline, stores model parameters and report results, and marks the experiment `succeeded` or `failed`. Re-running a failed job requires a new queue request after the underlying issue is fixed.

The web route `POST /api/jobs/process` supports an authenticated smoke test. Production deployment should invoke the same worker module from a durable queue or scheduled job.

## Release verification

Run the repository release gate before a deployment:

```bash
npm run verify:release
```

The gate runs syntax checks, tests, TypeScript checks, and the Next.js production build.

## Vercel deployment

Required production variables:

- `DATABASE_URL` with the pooled Neon connection string
- `NEON_AUTH_BASE_URL` with the Neon Auth base URL
- `NEON_AUTH_COOKIE_SECRET` with a random secret stored as a Vercel secret
- `CUSTOMER_DATA_MODE=tokenized-only`

After deployment:

1. Add the hosted origin to Neon Auth trusted domains.
2. Check `/api/health` and confirm status `ok`, database `configured`, auth `true`, and `liveTradingEnabled` `false`.
3. Open sign-up and sign-in pages.
4. Confirm an unauthenticated request to `/api/datasets` redirects to sign-in.
5. Create a test workspace with a tokenized sample only.
6. Confirm onboarding tasks, dataset validation, audit records, and read-only venue metadata.

Do not place orders or save broker credentials during the first pilot.

## Local demo

```bash
npm run check
npm test
npm run demo
```

## Demo outputs

`demo/output/` is gitignored, because report v2 contains held-out validation results.

- `demo/output/synthetic-events.json`
- `demo/output/report-v2.json`
- `demo/output/report-v2.html`

## Production job states

- queued
- running
- succeeded
- failed
- cancelled

Store job input, model version, policy version, random seed, start time, finish time, and failure details.

## Failure response

1. Preserve the failed run record.
2. Keep raw data unchanged.
3. Capture a safe error message.
4. Record the correlation ID.
5. Retry only idempotent work.
6. Require reviewer approval before report release.

## Release checklist

- Tests pass.
- Production build passes.
- Schema migration reviewed.
- Secrets configured outside source control.
- Tenant isolation tested.
- Report export tested.
- Retention settings confirmed.
- Customer data contract approved.
- Rollback plan written.
