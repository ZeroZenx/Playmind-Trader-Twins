# Security and privacy requirements

## Data boundary

PlayMind receives tokenized activity. The identity key stays with the customer or an approved identity custodian. PlayMind does not request names, emails, addresses, government IDs, IP addresses, or unmasked account IDs for the first pilot.

## Access rules

- Owners manage workspace membership.
- Analysts upload data and run analyses.
- Reviewers approve reports.
- Viewers read approved reports.
- Raw uploads require stricter access than derived reports.
- Every request scopes records to one workspace.

## Retention

The customer contract must define raw-file retention, derived-data retention, report retention, deletion timing, backup deletion, and audit-log retention.

## Privacy controls

- Reject direct PII before analytical processing.
- Store file checksums.
- Store source row references.
- Use encryption in transit and at rest in production.
- Keep tenant data separate.
- Remove sensitive values from application logs.
- Record export and download events.
- Require customer approval before production use.

## Legal review questions

- Who owns tokenized records?
- Who holds the identity key?
- Which customer purpose authorizes model creation?
- Which retention period applies?
- Which policy outputs require human review?
- Which cross-venue matching rules apply?
- Which reports require regulator-facing controls?
