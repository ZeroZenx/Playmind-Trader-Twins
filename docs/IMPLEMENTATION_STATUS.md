# Implementation status

Updated 2026-11-11.

## User-requested build list

| Area | Status | Evidence | Remaining gate |
| --- | --- | --- | --- |
| Production web application | Built locally | Next.js App Router pages in `src/app/`, production build passes, production-mode server returned the landing page | Vercel deployment and browser QA on the hosted URL |
| Hosted database | Built | Neon project `playmind-trader-twins`, PostgreSQL schema applied | Backup policy, retention policy, and production monitoring |
| Authentication | Built | Neon Managed Auth route handler, sign-in/sign-up pages, protected route middleware, production runtime rejects missing auth configuration | Production trusted domain and production cookie secret |
| Live customer-data ingestion | First production-shaped path built | Tokenized CSV upload, SHA-256 provenance, required-column checks, duplicate-header rejection, PII-header rejection, row validation, ingestion jobs, quality status | Object storage, signed upload URLs, malware scanning, large-file queue, customer retention controls |
| Production API server | Built locally | Next.js route handlers for health, workspace, onboarding, datasets, experiments, reports, venues. Production-mode health returned 200 with Neon configured | Hosted deployment and rate-limit/observability configuration |
| Predictive model tested on Jan-Mar 2026 | Built and evaluated | `analysis/polymarket_holdout_model.py`, 2,096,291 holdout episodes, report in `analysis/reports/polymarket-holdout-model.md` | Independent customer validation and model governance review |
| Live venue or broker integrations | Read-only Polymarket public adapter built | `GET /api/venues/polymarket/markets`, official Gamma API source, execution disabled | No order placement or custody integration in this release |
| Deployment | Pending | `vercel.json`, CI release gate, and production-mode local server verification are in place | Vercel team approval, environment variables, deployment, live health check |
| Customer onboarding workflow | Built locally | Workspace defaults, five-step checklist, dataset upload path | Hosted-domain QA and customer data contract sign-off |

## Evidence rules

- Synthetic demo output stays labelled synthetic.
- Public Polymarket analysis stays labelled observational.
- The 2026 holdout stays outside model fitting.
- The model predicts a next-day stake threshold. It does not infer intent, diagnose a person, or authorize an intervention.
- Live execution remains disabled. PlayMind does not place orders or manage funds.

## Holdout result

The holdout evaluation of the transparent logistic model against the prior-chase-rate baseline exists; its results are kept in local output (`analysis/output/`, gitignored).

The evaluation concerns a public-data proxy (OBSERVATIONAL). It does not support a claim about realized loss chasing across all traders or customers.

Sources:

- [Polymarket users dataset](https://huggingface.co/datasets/vgregoire/polymarket-users)
- [Dataset documentation](https://www.vincentgregoire.com/polymarket-users-data)
- [Polymarket Gamma API](https://gamma-api.polymarket.com/docs)
