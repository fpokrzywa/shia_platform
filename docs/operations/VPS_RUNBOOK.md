# Ubuntu VPS deployment runbook

Use this runbook for the owner-managed Ubuntu VPS and PostgreSQL deployment. It deliberately uses placeholders for the service name and protected backup destination. Keep `.env.local`, database credentials, private reviewer guides, backups, and evidence outside Git and out of shell history.

## Before an upgrade

1. Confirm the public service is healthy at `/health/live` and `/health/ready`.
2. Make a protected, off-host PostgreSQL backup. From the application directory, run:

   ```sh
   node scripts/backup.mjs /protected-backups/shi-agentic-$(date +%F).dump
   ```

   Record the output checksum in the operator's protected change record. Do not place the dump in the repository or web root.
3. Confirm the running branch and intended Git commit. Do not deploy unreviewed local changes.
4. Review new migrations. Never edit a migration that the production database has already applied.

## Deploy a reviewed release

1. Update the source and install the locked dependencies:

   ```sh
   git pull --ff-only origin main
   npm ci
   ```

2. Keep the existing private `.env.local` in place. For the public site header, set a non-sensitive build-time label before building:

   ```env
   VITE_DEPLOYMENT_LABEL=SHI Agentic production
   ```

   `PUBLIC_ORIGIN` must remain the exact HTTPS browser origin. Do not commit either file.
3. Apply migrations, build the application, and restart the existing Node service through the VPS service manager:

   ```sh
   npm run db:migrate
   npm run build
   sudo systemctl restart <shi-agentic-service>
   ```

   Replace `<shi-agentic-service>` with the owner-configured service name. Do not use `vite preview` for this deployment; the Node server supplies authentication and API routes.
4. Verify the exact deployed version with:

   ```sh
   curl --fail https://<public-host>/health/live
   curl --fail https://<public-host>/health/ready
   ```

5. Sign in through the public URL and perform the approved acceptance workflow. Record the deployed commit, migration result, backup checksum, health checks, and any findings in the owner’s change record.

## If an upgrade fails

1. Stop and preserve the error details without printing credentials or user data.
2. If the prior server artifact is compatible with the now-current database schema, restore that known-good artifact and restart the service. Do not reverse or edit database migrations to force a rollback.
3. If data recovery is required, use the protected backup with the fresh-target procedure in [RECOVERY.md](RECOVERY.md). Validate the restored database in a separately controlled process before any deliberate live cutover.
4. Reconcile any business work created after the backup before authorizing a live recovery.

## Regular operating checks

- Monitor public liveness/readiness, Node service restarts, database capacity, backup completion, failed sign-ins, and HTTP 5xx responses.
- Keep alerts free of credentials, session values, evidence, and user-entered text.
- Schedule a fresh-target restore rehearsal and record its date, result, recovery-point objective, and recovery-time objective.
- Retain logs, evidence, readouts, training records, audit records, and backups only under an approved retention and legal-hold policy.
