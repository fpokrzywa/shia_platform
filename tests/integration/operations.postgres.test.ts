import assert from "node:assert/strict";
import { randomUUID } from "node:crypto";
import test from "node:test";
import {
  cleanupSessions,
  collectOperationalStatus,
} from "../../apps/api/src/operations.js";
import {
  readMigrationFiles,
  runMigrations,
} from "../../packages/persistence/src/migrations.js";
import { createPostgresHarness } from "./postgres-harness.js";

test("operational status is aggregate-only and session cleanup is dry-run by default", async () => {
  const h = await createPostgresHarness();
  try {
    const migrations = await readMigrationFiles("migrations");
    await runMigrations(h.pool, migrations);
    const userId = randomUUID();
    await h.pool.query(
      "INSERT INTO app_users(id,email,display_name,password_hash,role) VALUES($1,$2,'Operations User','unused','member')",
      [userId, "private-operator@example.test"],
    );
    await h.pool.query(
      `INSERT INTO app_sessions(id,user_id,token_hash,expires_at,revoked_at) VALUES
      ($1,$4,$5,now()+interval '1 hour',NULL),($2,$4,$6,now()-interval '1 hour',NULL),($3,$4,$7,now()+interval '1 hour',now())`,
      [
        randomUUID(),
        randomUUID(),
        randomUUID(),
        userId,
        randomUUID(),
        randomUUID(),
        randomUUID(),
      ],
    );
    const status = await collectOperationalStatus(h.pool, migrations);
    assert.equal(status.migrations, "current");
    assert.deepEqual(status.counts, {
      accounts: 1,
      engagements: 0,
      evidence: 0,
      activeSessions: 1,
      removableSessions: 2,
    });
    assert.equal(JSON.stringify(status).includes("private-operator"), false);
    assert.deepEqual(await cleanupSessions(h.pool), {
      dryRun: true,
      eligible: 2,
      deleted: 0,
    });
    assert.equal(
      (await h.pool.query("SELECT count(*)::int count FROM app_sessions"))
        .rows[0]!.count,
      3,
    );
    const removed = await cleanupSessions(h.pool, { execute: true });
    assert.deepEqual(removed, { dryRun: false, eligible: 2, deleted: 2 });
    assert.equal(
      (
        await h.pool.query(
          "SELECT count(*)::int count FROM app_sessions WHERE revoked_at IS NULL AND expires_at>now()",
        )
      ).rows[0]!.count,
      1,
    );
    const audit = (
      await h.pool.query<{ details: { deleted: number } }>(
        "SELECT details FROM operational_maintenance_events WHERE event_type='session_cleanup'",
      )
    ).rows[0]!;
    assert.equal(audit.details.deleted, 2);
    const incomplete = await collectOperationalStatus(
      h.pool,
      migrations.slice(0, -1),
    );
    assert.equal(incomplete.migrations, "mismatch");
  } finally {
    await h.dispose();
  }
});

test("session cleanup rolls back deletion when its audit cannot be recorded", async () => {
  const h = await createPostgresHarness();
  try {
    await runMigrations(h.pool, await readMigrationFiles("migrations"));
    const userId = randomUUID(),
      sessionId = randomUUID();
    await h.pool.query(
      "INSERT INTO app_users(id,email,display_name,password_hash,role) VALUES($1,$2,'Operations User','unused','member')",
      [userId, "operations-rollback@example.test"],
    );
    await h.pool.query(
      "INSERT INTO app_sessions(id,user_id,token_hash,expires_at) VALUES($1,$2,$3,now()-interval '1 hour')",
      [sessionId, userId, randomUUID()],
    );
    await h.pool.query(
      "CREATE FUNCTION fail_maintenance_audit() RETURNS trigger AS $$ BEGIN RAISE EXCEPTION 'injected maintenance audit failure'; END; $$ LANGUAGE plpgsql",
    );
    await h.pool.query(
      "CREATE TRIGGER fail_maintenance_audit_trigger BEFORE INSERT ON operational_maintenance_events FOR EACH ROW EXECUTE FUNCTION fail_maintenance_audit()",
    );
    await assert.rejects(
      () => cleanupSessions(h.pool, { execute: true }),
      /injected maintenance audit failure/,
    );
    assert.equal(
      (
        await h.pool.query("SELECT 1 FROM app_sessions WHERE id=$1", [
          sessionId,
        ])
      ).rowCount,
      1,
    );
  } finally {
    await h.dispose();
  }
});
