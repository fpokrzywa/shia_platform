# Remaining operational decisions

Local recovery and backup/restore rehearsals are qualified. Shared use still requires named owners and environment-specific decisions:

Confirmed deployment direction: an Ubuntu VPS and an operator-managed PostgreSQL database. Repository-based source transfer is authorized. The server connection, domain/TLS configuration, database network access and service configuration still need to be supplied privately before deployment.

- **Retention:** retention periods and legal holds for audit events, sessions, evidence, readouts, training records, and backups. No automated deletion should run until periods, exceptions, approval, and restore implications are agreed.
- **Monitoring:** an on-call owner and alert destinations; process availability, migration-current readiness, PostgreSQL capacity, failed authentication patterns, HTTP 5xx responses, backup completion, and restore-rehearsal age. Alerts must exclude credentials, session tokens, evidence, and user-entered text.
- **Shared deployment:** destination, TLS/proxy boundary, secret store, database service, network access, patching owner, deployment and rollback procedure, and capacity expectations.
- **Corporate identity:** the approved identity provider and account lifecycle source before replacing local accounts. This repository does not claim SSO support.
- **Disaster recovery:** recovery-point and recovery-time objectives, backup frequency, off-host storage, encryption/key ownership, and recurring restore rehearsals.

These are explicit release gaps rather than defaults supplied by the application.

## Local status and session retention

Run `node --import tsx scripts/status.ts` for a read-only connectivity, migration, and aggregate-count report. It contains no account identities, engagement titles, evidence content, connection details, or secrets. Application error details remain in process logs; they are deliberately not copied into the database status response.

Run `node --import tsx scripts/cleanup-sessions.ts` to preview expired or revoked sessions eligible for deletion. Nothing is deleted unless `--execute` is supplied. An executed cleanup deletes only those sessions and records an aggregate maintenance event; active sessions and all business, evidence, readiness, review, audit, training, and readout history remain untouched.

There is no automatic destructive pruning. This preserves history until an approved retention schedule exists, but audit, evidence, and attachment storage will continue to grow and must be monitored.
