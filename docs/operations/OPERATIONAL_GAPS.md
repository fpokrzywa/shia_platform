# Remaining operational decisions

Local recovery and backup/restore rehearsals are qualified. Shared use still requires named owners and environment-specific decisions:

Confirmed deployment direction: an Ubuntu VPS and an operator-managed PostgreSQL database. The owner has deployed the application, and public health, sign-in-origin, and authenticated read-only interface checks have passed. Repository-based source transfer is authorized. Server administration, secret handling, database network access, service supervision, and recovery remain owner-managed and have not been independently inspected.

- **Retention:** retention periods and legal holds for audit events, sessions, evidence, readouts, training records, and backups. No automated deletion should run until periods, exceptions, approval, and restore implications are agreed.
- **Monitoring:** an on-call owner and alert destinations; process availability, migration-current readiness, PostgreSQL capacity, failed authentication patterns, HTTP 5xx responses, backup completion, and restore-rehearsal age. Alerts must exclude credentials, session tokens, evidence, and user-entered text.
- **Shared deployment:** documented service supervision, secret storage, patching owner, upgrade and rollback procedure, and capacity expectations. The public TLS/proxy path is reachable, but its server-side configuration has not been independently inspected.
- **Corporate identity:** the approved identity provider and account lifecycle source before replacing local accounts. This repository does not claim SSO support.
- **Disaster recovery:** recovery-point and recovery-time objectives, backup frequency, off-host storage, encryption/key ownership, and recurring restore rehearsals.

These are explicit release gaps rather than defaults supplied by the application.

## Local status and session retention

Run `node --import tsx scripts/status.ts` for a read-only connectivity, migration, and aggregate-count report. It contains no account identities, engagement titles, evidence content, connection details, or secrets. Application error details remain in process logs; they are deliberately not copied into the database status response.

Run `node --import tsx scripts/cleanup-sessions.ts` to preview expired or revoked sessions eligible for deletion. Nothing is deleted unless `--execute` is supplied. An executed cleanup deletes only those sessions and records an aggregate maintenance event; active sessions and all business, evidence, readiness, review, audit, training, and readout history remain untouched.

There is no automatic destructive pruning. This preserves history until an approved retention schedule exists, but audit, evidence, and attachment storage will continue to grow and must be monitored.
