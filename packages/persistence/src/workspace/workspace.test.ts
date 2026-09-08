import assert from "node:assert/strict";
import { readFile } from "node:fs/promises";
import test from "node:test";
import type { PoolClient } from "pg";
import { AuthorizationError, ConflictError } from "./errors.js";
import { idempotent, inputHash, requireAdmin } from "./shared.js";

test("canonical input hashes do not depend on object property order", () => {
  assert.equal(
    inputHash({ clientId: "c1", title: "Work" }),
    inputHash({ title: "Work", clientId: "c1" }),
  );
  assert.notEqual(inputHash({ clientId: "c1" }), inputHash({ clientId: "c2" }));
});

test("idempotency returns the stored result and rejects changed input", async () => {
  const stored = {
    input_hash: inputHash({ value: 1 }),
    result: { id: "original" },
  };
  const queries: string[] = [];
  const client = {
    query: async (sql: string) => {
      queries.push(sql);
      if (sql.startsWith("SELECT input_hash")) return { rows: [stored] };
      return { rows: [] };
    },
  } as unknown as PoolClient;
  let workCalls = 0;
  const actor = { id: "user-1", role: "member" as const };
  const result = await idempotent(
    client,
    actor,
    "engagement.create",
    "request-1",
    { value: 1 },
    async () => {
      workCalls += 1;
      return { id: "new" };
    },
  );
  assert.deepEqual(result, { id: "original" });
  assert.equal(workCalls, 0);
  assert.match(queries[0]!, /pg_advisory_xact_lock/);
  await assert.rejects(
    idempotent(
      client,
      actor,
      "engagement.create",
      "request-1",
      { value: 2 },
      async () => ({ id: "new" }),
    ),
    ConflictError,
  );
});

test("practice administrator authorization is explicit", () => {
  assert.doesNotThrow(() =>
    requireAdmin({ id: "admin", role: "practice_admin" }),
  );
  assert.throws(
    () => requireAdmin({ id: "member", role: "member" }),
    AuthorizationError,
  );
});

test("workspace schema protects published versions and supports separate multi-role membership", async () => {
  const sql = await readFile(
    new URL("../../../../migrations/0002_workspace.sql", import.meta.url),
    "utf8",
  );
  assert.match(sql, /BEFORE UPDATE OR DELETE ON workspace_template_versions/);
  assert.match(sql, /NEW\.state <> 'retired'/);
  assert.match(sql, /state IN \('published', 'retired'\)/);
  assert.match(sql, /jsonb_typeof\(definition->'state'\) = 'string'/);
  assert.match(sql, /jsonb_typeof\(definition->'templateKey'\) = 'string'/);
  assert.match(sql, /NEW\.revision <> OLD\.revision \+ 1/);
  assert.match(
    sql,
    /FOREIGN KEY \(stage_id, engagement_id\) REFERENCES workspace_stage_instances\(id, engagement_id\)/,
  );
  assert.match(sql, /PRIMARY KEY \(engagement_id, user_id, role\)/);
  assert.match(
    sql,
    /role IN \('engagement_lead', 'technical_lead', 'engineer', 'reviewer'\)/,
  );
  assert.match(sql, /PRIMARY KEY \(actor_id, action, request_key\)/);
});
