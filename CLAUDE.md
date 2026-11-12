# PlayMind Trader Twins: standing rules

These rules apply to every change in this repository. They override convenience.

## Evidence and claims

- Never write AUC, AUROC, average precision, or any other accuracy headline in README files, docs, reports, UI copy, or commit messages. Model evaluation metrics go only in gitignored local output files (for example `analysis/output/` or `data/output/`).
- Label every output as SYNTHETIC, OBSERVATIONAL (public data), or CUSTOMER.
- Policy results are simulations under stated assumptions, never causal claims.

## Data boundary

- Never commit customer data, raw or derived. All customer data lives under `data/` (gitignored) or outside the repo. This includes Sporttrade data, samples, field lists with real values, and anything derived from them.
- No direct PII in analytical data. Keep the existing rejection rules in `src/engine/validate.mjs` and `src/lib/ingestion.ts`.

## Product boundary

- PlayMind never contacts traders, places trades, or holds funds.

## Modeling

- Market and contract fields are optional everywhere. The core twin must work without them.
- Missing realized outcomes stay unavailable. Never treat them as zero.

## Workflow

- The active plan is `docs/TWIN-V02-PLAN.md`. Work on the `twin-v0.2` branch, never directly on `main`.
- Before finishing, run `npm run check`, `npm test`, and `npx tsc --noEmit`. All must pass.
- `npm run check` is a hard-coded list of files. Add every new `.mjs` module under `src/`, `scripts/`, or `demo/` to it.
- Next.js in this repo is newer than most training data. Read `AGENTS.md` and `node_modules/next/dist/docs/` before touching `src/app/`.
