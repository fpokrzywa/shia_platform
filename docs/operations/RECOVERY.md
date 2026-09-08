# PostgreSQL backup and recovery

Run these commands from the application directory. PostgreSQL client tools must be installed and available on `PATH`. The scripts read `DATABASE_URL` from the process environment or ignored `.env.local`; credentials are passed to PostgreSQL tools through their child-process environment and are never placed in command arguments or output.

## Create a backup

Choose a protected destination outside the source tree for operational backups. The command refuses to overwrite an existing file.

```powershell
node scripts/backup.mjs D:\protected-backups\shi-agentic-2026-09-08.dump
```

The result is a portable plain SQL dump without ownership or privilege commands. The wrapper removes PostgreSQL 17's client-generated `transaction_timeout` setting so the qualified older local server can restore it; every other restore error remains fatal.. Protect it as sensitive application data.

## Restore rehearsal

Restore only to an explicitly named, fresh database on the configured PostgreSQL server:

```powershell
node scripts/restore.mjs D:\protected-backups\shi-agentic-2026-09-08.dump shi_agentic_restore_20260908
```

The target name must be a simple PostgreSQL identifier, must differ from the configured application database, and must not already exist. The script creates the target, runs `psql` with `ON_ERROR_STOP`, and removes the newly created target if restore fails. It never drops or replaces an existing database.

After a rehearsal, point a separately controlled application process at the restored database and check migration inventory, sign-in, engagement access, evidence downloads, and readiness history. Switching a live service to a restored database remains a deliberate operator action outside these scripts.

## Qualification result

The automated qualification creates synthetic fixtures in a disposable source database, writes a portable dump, restores it into a separately named fresh database, and compares every migration name/checksum, readiness decision snapshots, and the SHA-256 hash of a binary attachment. It also verifies that an existing target and the source database name are rejected. Both databases and the temporary dump are removed after the test. No normal application data is used.

## Release 14 restart rehearsal

The identical staged Release 14 artifact was stopped and started again against a disposable database. Both launches passed liveness, migration-current readiness and home-page checks; the synthetic record hash remained unchanged. Evidence is recorded in `work/release14-rollback-rehearsal.json`. The normal service was untouched.

This qualifies process recovery using the same artifact. It does not qualify switching to an older server against the upgraded database, reversing a migration, or a shared-environment rollback. Those require a compatibility check and a rehearsal for the selected deployment target. The actual pre-upgrade backup record includes its SHA-256 checksum in `work/release14-backup.json`; off-host custody and encryption are not configured.
