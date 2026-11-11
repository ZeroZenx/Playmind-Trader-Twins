# Pilot success plan

## Pilot question

Does a selected responsible-trading policy change modeled trader behavior while preserving a defined level of activity?

## Required input

- Tokenized trader events.
- Explicit timezone.
- Event type definitions.
- Deposit and balance fields where available.
- Policy-event history where available.
- Realized outcomes where available.
- Data owner and retention approval.

## Pilot outputs

- Data-quality report.
- Signal summary.
- Twin validation summary.
- Baseline and policy comparison.
- Evidence report.
- Review record.

## Proposed success measures

These are starting proposals, not customer commitments:

- All required identity-safe fields pass validation.
- Every event has a unique source identifier.
- The twin reproduces selected aggregate behavior within a customer-approved tolerance.
- The policy run completes with a stored seed and version.
- The customer accepts the report format.
- The customer identifies a production decision supported by the report.
- No direct PII enters the analytical dataset.

## Conversion signal

The pilot supports expansion when the customer requests a second policy test, a second reporting cycle, or a paid recurring platform agreement.
