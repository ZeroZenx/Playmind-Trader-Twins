# Threat model

| Threat | Risk | Control |
| --- | --- | --- |
| Direct PII upload | Privacy breach | Field rejection and pre-processing validation |
| Cross-tenant query | Customer disclosure | Workspace scope checks and permission tests |
| Malicious file | Service compromise | File limits, type checks, isolated parsing, malware scanning in production |
| Spreadsheet formula injection | Export-side execution | Neutralize formula-leading cells |
| Stolen credentials | Unauthorized access | Production identity provider, MFA, role review, audit logs |
| Raw-file exposure | Sensitive data loss | Signed URLs, short expiry, storage policy, least privilege |
| Model overclaim | Wrong customer decision | Model card, uncertainty, evidence labels, reviewer approval |
| Seed manipulation | Non-reproducible evidence | Store seed and run configuration |
| Audit tampering | Weak accountability | Append-only audit store and restricted write path |
| Prompt or report injection | Misleading narrative | Deterministic report facts, escaped HTML, optional narrative disabled by default |

## Highest-priority controls

1. Tenant isolation.
2. PII rejection.
3. Raw-file access controls.
4. Audit records.
5. Evidence labels.
6. Reproducible runs.
