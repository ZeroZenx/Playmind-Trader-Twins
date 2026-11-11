# Product backlog

Priority uses P0 for pilot blocking work, P1 for pilot value, and P2 for later expansion.

## Epic A: Product foundation

### A1. Product requirements and decisions - P0

Acceptance criteria:

- Scope, non-goals, assumptions, risks, and open decisions appear in version control.
- The first customer outcome uses one policy test and one evidence report.

### A2. Pilot success plan - P0

Acceptance criteria:

- The plan defines required data fields, quality checks, validation measures, review owners, and conversion criteria.

## Epic B: Workspace and security

### B1. Workspace records - P0

Acceptance criteria:

- Each dataset, twin, experiment, report, and audit event belongs to one workspace.

### B2. Roles and permissions - P0

Acceptance criteria:

- Owner, analyst, reviewer, and viewer permissions pass integration tests.

### B3. Audit trail - P0

Acceptance criteria:

- Upload, validation, model run, policy change, export, and role events receive immutable audit records.

## Epic C: Data intake

### C1. Tokenized event schema - P0

Acceptance criteria:

- Event types, required fields, timezones, outcome handling, and source row references appear in the data dictionary.

### C2. Dataset validator - P0

Acceptance criteria:

- The validator rejects direct PII, duplicates, invalid dates, invalid event types, and malformed numbers.

### C3. Data-quality report - P0

Acceptance criteria:

- The report shows row count, trader count, date range, field coverage, missingness, duplicates, rejected rows, and warnings.

## Epic D: Behavioral intelligence

### D1. Signal engine - P0

Acceptance criteria:

- Versioned signals calculate from validated events.
- Missing realized outcomes stay unavailable.

### D2. Trader twin version one - P0

Acceptance criteria:

- A seeded twin reproduces selected aggregate behavior from a training window.
- Held-out comparison shows observed metrics beside simulated metrics.

### D3. Model card - P1

Acceptance criteria:

- The model card states inputs, training window, validation window, limitations, seed, and prohibited claims.

## Epic E: Policy tests

### E1. Policy configuration - P0

Acceptance criteria:

- Cooldown, deposit limit, stake limit, and restriction escalation use validated configuration.

### E2. Experiment runner - P0

Acceptance criteria:

- Baseline and policy runs produce comparable metrics with stored versions and seeds.

### E3. Experiment review - P1

Acceptance criteria:

- Reviewers see results, uncertainty, missing outcomes, assumptions, and approval status.

## Epic F: Evidence reports

### F1. Report generator - P0

Acceptance criteria:

- JSON and HTML reports include source dataset, model, policy, results, limitations, and audit history.

### F2. Report export - P1

Acceptance criteria:

- Exported CSV values neutralize spreadsheet formulas.
- Exported reports retain synthetic or customer-data labels.

## Epic G: Pilot readiness

### G1. Customer data contract - P0

Acceptance criteria:

- Data ownership, token custody, allowed fields, retention, deletion, access, and approved use appear in a reviewable template.

### G2. Security review - P0

Acceptance criteria:

- Threat model, access matrix, retention plan, and incident checklist pass internal review.

### G3. Browser and production QA - P0

Acceptance criteria:

- Type checks, tests, production build, browser flow, and report rendering pass.

## Epic H: Future expansion

### H1. Broker workspace - P2

Blocked until one venue pilot succeeds and one broker design partner confirms demand.

### H2. Private identity matching - P2

Blocked until counsel confirms a lawful design and neutral governance model.

### H3. Multi-venue hub - P2

Blocked until data access, governance, identity, and commercial evidence exist.
