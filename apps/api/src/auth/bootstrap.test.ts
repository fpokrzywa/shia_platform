import assert from "node:assert/strict";
import test from "node:test";
import type { ClientPool } from "../../../../packages/persistence/src/index.js";
import { bootstrapPracticeAdmin } from "./bootstrap.js";

function bootstrapPool(existingCount: string) {
  const calls: Array<{ sql: string; values?: unknown[] }> = [];
  const client = {
    async query(sql: string, values?: unknown[]) {
      calls.push(values ? { sql, values } : { sql });
      if (sql.startsWith("SELECT count")) return { rows: [{ count: existingCount }] };
      return { rows: [] };
    },
    release() {}
  };
  return { calls, pool: { connect: async () => client, query: async () => ({ rows: [] }), end: async () => {} } as unknown as ClientPool };
}

test("bootstrap creates exactly one practice administrator with a password hash", async () => {
  const fixture = bootstrapPool("0");
  const id = await bootstrapPracticeAdmin(fixture.pool, { email: "ADMIN@example.com", displayName: " Practice Admin ", password: "correct horse battery staple" });
  assert.match(id, /^[0-9a-f-]{36}$/);
  const insert = fixture.calls.find((call) => call.sql.startsWith("INSERT INTO app_users"));
  assert.equal(insert?.values?.[1], "admin@example.com");
  assert.equal(insert?.values?.[2], "Practice Admin");
  assert.match(String(insert?.values?.[3]), /^scrypt\$/);
  assert.equal(fixture.calls.some((call) => call.sql.startsWith("INSERT INTO identity_audit_events")), true);
  assert.equal(fixture.calls.at(-1)?.sql, "COMMIT");
});

test("bootstrap rolls back when any account already exists", async () => {
  const fixture = bootstrapPool("1");
  await assert.rejects(() => bootstrapPracticeAdmin(fixture.pool, { email: "admin@example.com", displayName: "Admin", password: "correct horse battery staple" }), /disabled/);
  assert.equal(fixture.calls.some((call) => call.sql.startsWith("INSERT INTO app_users")), false);
  assert.equal(fixture.calls.at(-1)?.sql, "ROLLBACK");
});
