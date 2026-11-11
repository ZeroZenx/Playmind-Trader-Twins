# Initial API contract

The current Next.js API exposes these routes. The original contract below stays as the expansion plan.

| Method | Route | Purpose |
| --- | --- | --- |
| GET | `/api/health` | Health and database configuration check |
| GET | `/api/me` | Current user and workspace |
| GET/PATCH | `/api/onboarding` | Read or update onboarding tasks |
| GET/POST | `/api/datasets` | List or create dataset metadata |
| POST | `/api/datasets/:id/upload` | Upload a batch file |
| POST | `/api/datasets/:id/validate` | Validate the dataset |
| GET/POST | `/api/experiments` | List or create a draft experiment |
| GET | `/api/reports` | List evidence reports |
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
