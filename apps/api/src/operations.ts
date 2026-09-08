import { randomUUID } from "node:crypto";
import type { ClientPool } from "../../../packages/persistence/src/index.js";
import {
  checkMigrationsCurrent,
  type MigrationFile,
} from "../../../packages/persistence/src/migrations.js";

export interface OperationalStatus {
  database: "reachable";
  migrations: "current" | "mismatch";
  counts: {
    accounts: number;
    engagements: number;
    evidence: number;
    activeSessions: number;
    removableSessions: number;
  };
  lastMigrationAt: string | null;
  recentMaintenanceEvents: number;
  errorSignal: { persisted: false; source: "process logs" };
}

export async function collectOperationalStatus(
  pool: ClientPool,
  migrations: MigrationFile[],
): Promise<OperationalStatus> {
  let migrationState: OperationalStatus["migrations"] = "current";
  try {
    await checkMigrationsCurrent(pool, migrations);
  } catch {
    migrationState = "mismatch";
  }
  const result = await pool.query(`
    SELECT
      (SELECT count(*)::int FROM app_users) accounts,
      (SELECT count(*)::int FROM workspace_engagements) engagements,
      (SELECT count(*)::int FROM workspace_evidence) evidence,
      (SELECT count(*)::int FROM app_sessions WHERE revoked_at IS NULL AND expires_at>now()) active_sessions,
      (SELECT count(*)::int FROM app_sessions WHERE revoked_at IS NOT NULL OR expires_at<=now()) removable_sessions,
      (SELECT max(applied_at) FROM schema_migrations) last_migration_at,
      (SELECT count(*)::int FROM operational_maintenance_events WHERE created_at>=now()-interval '24 hours') recent_events
  `);
  const row = result.rows[0] as {
    accounts: number;
    engagements: number;
    evidence: number;
    active_sessions: number;
    removable_sessions: number;
    last_migration_at: Date | null;
    recent_events: number;
  };
  return {
    database: "reachable",
    migrations: migrationState,
    counts: {
      accounts: row.accounts,
      engagements: row.engagements,
      evidence: row.evidence,
      activeSessions: row.active_sessions,
      removableSessions: row.removable_sessions,
    },
    lastMigrationAt: row.last_migration_at?.toISOString() ?? null,
    recentMaintenanceEvents: row.recent_events,
    errorSignal: { persisted: false, source: "process logs" },
  };
}

export async function cleanupSessions(
  pool: ClientPool,
  options: { execute?: boolean } = {},
): Promise<{ dryRun: boolean; eligible: number; deleted: number }> {
  const client = await pool.connect();
  try {
    await client.query("BEGIN");
    if (!options.execute) {
      const eligible = Number(
        (
          await client.query<{ count: string }>(
            "SELECT count(*)::text count FROM app_sessions WHERE revoked_at IS NOT NULL OR expires_at<=now()",
          )
        ).rows[0]!.count,
      );
      await client.query("ROLLBACK");
      return { dryRun: true, eligible, deleted: 0 };
    }
    const candidates = await client.query(
      "SELECT id FROM app_sessions WHERE revoked_at IS NOT NULL OR expires_at<=now() FOR UPDATE",
    );
    const eligible = candidates.rowCount ?? 0;
    const removed = await client.query(
      "DELETE FROM app_sessions WHERE revoked_at IS NOT NULL OR expires_at<=now() RETURNING id",
    );
    await client.query(
      "INSERT INTO operational_maintenance_events(id,event_type,details) VALUES($1,'session_cleanup',$2)",
      [randomUUID(), { eligible, deleted: removed.rowCount }],
    );
    await client.query("COMMIT");
    return { dryRun: false, eligible, deleted: removed.rowCount ?? 0 };
  } catch (error) {
    await client.query("ROLLBACK");
    throw error;
  } finally {
    client.release();
  }
}
