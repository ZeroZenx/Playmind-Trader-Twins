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

The worker route supports an authenticated local smoke test. Production Vercel Cron calls `GET /api/jobs/process` once per minute. The handler requires `Authorization: Bearer $CRON_SECRET` and returns `401` for other requests.

The worker handles one ingestion job before one analysis job. Ingestion jobs read private Blob storage, verify object metadata, hash the content, validate tokenized CSV rows, and write normalized events. Analysis jobs use leases, bounded retries, and stale-lease recovery.

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
- `BLOB_READ_WRITE_TOKEN` for a private Vercel Blob store
- `CRON_SECRET` for the scheduled worker route
- `PLAYMIND_MAX_UPLOAD_BYTES` with a reviewed upload limit
- `MALWARE_SCAN_URL` for the customer-file scanner endpoint
- `MALWARE_SCAN_TOKEN` as a Vercel secret when the scanner requires bearer authentication

After deployment:

1. Add the hosted origin to Neon Auth trusted domains.
2. Check `/api/health` and confirm status `ok`, database `configured`, auth `true`, and `liveTradingEnabled` `false`.
3. Open sign-up and sign-in pages.
4. Confirm an unauthenticated request to `/api/datasets` redirects to sign-in.
5. Create a test workspace with a tokenized sample only.
6. Confirm signed private upload, queued ingestion, dataset validation, audit records, report approval, and read-only venue metadata.
7. Confirm the malware scanner marks a test file clean before ingestion.

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
- Private object storage verified.
- Worker secret and Cron invocation verified.
- Customer data contract approved.
- Rollback plan written.
