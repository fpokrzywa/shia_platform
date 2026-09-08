import assert from "node:assert/strict";
import { randomUUID } from "node:crypto";
import test from "node:test";
import {
  LocalRecoveryError,
  resetLocalPassword,
} from "../../apps/api/src/auth/recovery.js";
import {
  hashPassword,
  verifyPassword,
} from "../../apps/api/src/auth/password.js";
import {
  createSession,
  resolveActor,
} from "../../apps/api/src/auth/sessions.js";
import {
  readMigrationFiles,
  runMigrations,
} from "../../packages/persistence/src/migrations.js";
import { createPostgresHarness } from "./postgres-harness.js";

test("local password recovery preserves the account, revokes every session, and audits operator provenance", async () => {
  const h = await createPostgresHarness();
  try {
    await runMigrations(h.pool, await readMigrationFiles("migrations"));
    const id = randomUUID(),
      oldHash = await hashPassword("old-password-value");
    await h.pool.query(
      "INSERT INTO app_users(id,email,display_name,password_hash,role) VALUES($1,$2,'Recovery User',$3,'practice_admin')",
      [id, "Recovery@Example.Test", oldHash],
    );
    const first = await createSession(h.pool, id),
      second = await createSession(h.pool, id);
    await resetLocalPassword(h.pool, {
      email: " recovery@example.test ",
      password: "new-password-value",
    });
    const user = (
      await h.pool.query<{
        password_hash: string;
        role: string;
        email: string;
      }>("SELECT password_hash,role,email FROM app_users WHERE id=$1", [id])
    ).rows[0]!;
    assert.equal(
      await verifyPassword("new-password-value", user.password_hash),
      true,
    );
    assert.equal(
      await verifyPassword("old-password-value", user.password_hash),
      false,
    );
    assert.equal(user.role, "practice_admin");
    assert.equal(user.email, "Recovery@Example.Test");
    assert.equal(await resolveActor(h.pool, first.token), null);
    assert.equal(await resolveActor(h.pool, second.token), null);
    const audit = (
      await h.pool.query<{
        actor_user_id: string | null;
        details: { provenance: string };
      }>(
        "SELECT actor_user_id,details FROM identity_audit_events WHERE event_type='password_reset' AND subject_user_id=$1",
        [id],
      )
    ).rows[0]!;
    assert.equal(audit.actor_user_id, null);
    assert.equal(audit.details.provenance, "local_operator_recovery");
    assert.equal(
      (await h.pool.query("SELECT count(*)::int count FROM app_users")).rows[0]!
        .count,
      1,
    );
  } finally {
    await h.dispose();
  }
});

test("local recovery rejects missing and disabled accounts and rolls back if auditing fails", async () => {
  const h = await createPostgresHarness();
  try {
    await runMigrations(h.pool, await readMigrationFiles("migrations"));
    const id = randomUUID(),
      original = await hashPassword("original-password");
    await h.pool.query(
      "INSERT INTO app_users(id,email,display_name,password_hash,role,disabled_at) VALUES($1,$2,'Disabled',$3,'member',now())",
      [id, "disabled@example.test", original],
    );
    await assert.rejects(
      () =>
        resetLocalPassword(h.pool, {
          email: "missing@example.test",
          password: "valid-new-password",
        }),
      LocalRecoveryError,
    );
    await assert.rejects(
      () =>
        resetLocalPassword(h.pool, {
          email: "disabled@example.test",
          password: "valid-new-password",
        }),
      LocalRecoveryError,
    );
    await assert.rejects(
      () =>
        resetLocalPassword(h.pool, {
          email: "disabled@example.test",
          password: "short",
        }),
      /12/,
    );
    await h.pool.query("UPDATE app_users SET disabled_at=NULL WHERE id=$1", [
      id,
    ]);
    const session = await createSession(h.pool, id);
    await h.pool.query(
      "CREATE FUNCTION fail_recovery_audit() RETURNS trigger AS $$ BEGIN IF NEW.event_type='password_reset' THEN RAISE EXCEPTION 'injected recovery audit failure'; END IF; RETURN NEW; END; $$ LANGUAGE plpgsql",
    );
    await h.pool.query(
      "CREATE TRIGGER fail_recovery_audit_trigger BEFORE INSERT ON identity_audit_events FOR EACH ROW EXECUTE FUNCTION fail_recovery_audit()",
    );
    await assert.rejects(
      () =>
        resetLocalPassword(h.pool, {
          email: "disabled@example.test",
          password: "replacement-password",
        }),
      /injected recovery audit failure/,
    );
    assert.equal(
      (
        await h.pool.query<{ password_hash: string }>(
          "SELECT password_hash FROM app_users WHERE id=$1",
          [id],
        )
      ).rows[0]!.password_hash,
      original,
    );
    assert.notEqual(await resolveActor(h.pool, session.token), null);
  } finally {
    await h.dispose();
  }
});
