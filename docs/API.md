# Initial API contract

The current Next.js API exposes these routes. The original contract below stays as the expansion plan.

| Method | Route | Purpose |
| --- | --- | --- |
| GET | `/api/health` | Health and database configuration check |
| GET | `/api/me` | Current user and workspace |
| GET/PATCH | `/api/onboarding` | Read or update onboarding tasks |
| GET/POST | `/api/datasets` | List or create dataset metadata |
| POST | `/api/datasets/:id/upload` | Upload a batch file |
| POST | `/api/datasets/:id/upload-token` | Create an authenticated private Blob client-upload token |
| POST | `/api/datasets/:id/upload/complete` | Verify the private object and queue ingestion |
| POST | `/api/datasets/:id/validate` | Validate the dataset |
| GET/POST | `/api/experiments` | List or create a draft experiment |
| POST | `/api/experiments/:id/run` | Queue a held-out twin and policy analysis |
| GET | `/api/experiments/:id` | Read job status, results, and the saved report |
| GET/POST | `/api/jobs/process` | Process one queued ingestion or analysis job. Production requests require `Authorization: Bearer $CRON_SECRET`. Local development permits an authenticated owner or analyst. |
| GET | `/api/reports` | List evidence reports |
| GET | `/api/reports/:id` | Read a report JSON document |
| POST | `/api/reports/:id/approve` | Approve a report for an owner or reviewer |
| GET | `/api/venues` | List workspace venue capabilities |
| GET | `/api/venues/polymarket/markets` | Read public Polymarket market metadata |

Planned expansion routes:

| Method | Route | Purpose |
| --- | --- | --- |
| POST | `/api/workspaces` | Create a workspace |
| GET | `/api/datasets/:id/quality` | Read a detailed quality report |
| POST | `/api/twins/build` | Build twins from a ready dataset |
| GET | `/api/twins` | List workspace twins |
| GET | `/api/twins/:id` | Read a twin and validation |
| POST | `/api/policies` | Create a policy definition |
| POST | `/api/experiments/:id/run` | Queue an experiment run |
| GET | `/api/experiments/:id` | Read run status and results |
| POST | `/api/reports` | Generate an evidence report |
| GET | `/api/reports/:id` | Read a report |
| GET | `/api/reports/:id/export` | Export a report artifact |
| GET | `/api/audit` | Read workspace audit events |

Every route needs workspace authorization, request validation, audit coverage where relevant, and a typed error response.

## Local worker path

The run route inserts an `analysis_jobs` row and marks the experiment queued. The worker claims one job with `FOR UPDATE SKIP LOCKED`, reads tokenized events, runs the shared pure pipeline, persists priors, trader parameters, experiment results, and report JSON, then marks the job succeeded or failed.

```bash
npm run db:migrate
npm run worker:once
```

The worker uses a direct `DATABASE_URL` for migrations and a pooled application connection for job processing. Live execution stays disabled.
