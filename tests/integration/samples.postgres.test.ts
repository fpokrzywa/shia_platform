import assert from "node:assert/strict";
import { randomUUID } from "node:crypto";
import { readFile } from "node:fs/promises";
import test from "node:test";
import type { TemplateVersionDefinition } from "../../packages/domain/src/templates/index.js";
import { readMigrationFiles, runMigrations } from "../../packages/persistence/src/migrations.js";
import { AuthorizationError, ConflictError, SampleService, TemplateService } from "../../packages/persistence/src/workspace/index.js";
import { createPostgresHarness } from "./postgres-harness.js";

async function seedUsers(pool: import("pg").Pool) {
  const admin = { id: randomUUID(), role: "practice_admin" as const };
  const outsider = { id: randomUUID(), role: "member" as const };
  await pool.query(
    "INSERT INTO app_users(id,email,display_name,password_hash,role) VALUES($1,$2,$3,$4,'practice_admin'),($5,$6,$7,$8,'member')",
    [admin.id, "sample-admin@example.test", "Sample Admin", "unused", outsider.id, "sample-outsider@example.test", "Sample Outsider", "unused"]
  );
  return { admin, outsider };
}

test("sample pack load, removal, and reload are isolated and idempotent in real PostgreSQL", async () => {
  const harness = await createPostgresHarness();
  try {
    await runMigrations(harness.pool, await readMigrationFiles("migrations"));
    const { admin, outsider } = await seedUsers(harness.pool);
    const samples = new SampleService(harness.pool);
    const templates = new TemplateService(harness.pool);
    const ordinaryClientId = randomUUID();
    await harness.pool.query("INSERT INTO workspace_clients(id,name,created_by) VALUES($1,$2,$3)", [ordinaryClientId, "[Sample] Ordinary client with shared prefix", admin.id]);
    const normalDefinition = JSON.parse(await readFile("templates/independent-delivery.v1.json", "utf8")) as TemplateVersionDefinition;
    await templates.importDraft(admin, { definition: normalDefinition, requestKey: randomUUID() });
    await templates.publish(admin, { templateKey: normalDefinition.templateKey, version: 1, expectedRevision: 1, requestKey: randomUUID() });
    const preservedAuditId = (await harness.pool.query<{ id: string }>("INSERT INTO workspace_audit_events(actor_id,action,details) VALUES($1,'preserved.audit',$2) RETURNING id", [admin.id, { preserved: true }])).rows[0]!.id;
    const originalUserIds = (await harness.pool.query<{ id: string }>("SELECT id FROM app_users ORDER BY id")).rows.map((row) => row.id);

    await assert.rejects(() => samples.status(outsider), AuthorizationError);
    await assert.rejects(() => samples.load(outsider, { expectedRevision: 0, requestKey: randomUUID(), confirmation: "load-sample-data" }), AuthorizationError);
    await assert.rejects(() => samples.remove(outsider, { expectedRevision: 0, requestKey: randomUUID(), confirmation: "remove-sample-data" }), AuthorizationError);

    const firstLoadKey = randomUUID();
    const [loadedA, loadedB] = await Promise.all([
      samples.load(admin, { expectedRevision: 0, requestKey: firstLoadKey, confirmation: "load-sample-data" }),
      samples.load(admin, { expectedRevision: 0, requestKey: firstLoadKey, confirmation: "load-sample-data" })
    ]);
    assert.deepEqual(loadedB, loadedA);
    assert.equal(loadedA.state, "loaded");
    assert.equal(loadedA.clients, 2);
    assert.equal(loadedA.engagements, 2);
    assert.equal(new Set(loadedA.clientIds).size, 2);
    assert.equal(new Set(loadedA.engagementIds).size, 2);
    const repeated = await samples.load(admin, { expectedRevision: 1, requestKey: randomUUID(), confirmation: "load-sample-data" });
    assert.deepEqual(repeated.clientIds, loadedA.clientIds);
    assert.deepEqual(repeated.engagementIds, loadedA.engagementIds);
    assert.equal((await harness.pool.query("SELECT 1 FROM workspace_sample_clients")).rows.length, 2);
    assert.equal((await harness.pool.query("SELECT 1 FROM workspace_sample_engagements")).rows.length, 2);

    const removed = await samples.remove(admin, { expectedRevision: 1, requestKey: randomUUID(), confirmation: "remove-sample-data" });
    assert.equal(removed.state, "empty");
    assert.equal(removed.revision, 2);
    const staleReplay = await samples.load(admin, { expectedRevision: 0, requestKey: firstLoadKey, confirmation: "load-sample-data" });
    assert.equal(staleReplay.state, "loaded");
    assert.equal((await samples.status(admin)).state, "empty");
    const reloaded = await samples.load(admin, { expectedRevision: 2, requestKey: randomUUID(), confirmation: "load-sample-data" });
    assert.equal(reloaded.revision, 3);
    assert.equal(reloaded.clients, 2);
    assert.equal(reloaded.engagements, 2);
    assert.equal(reloaded.clientIds.some((id) => loadedA.clientIds.includes(id)), false);
    assert.equal(reloaded.engagementIds.some((id) => loadedA.engagementIds.includes(id)), false);

    const sampleTemplates = await harness.pool.query<{ template_key: string; version: number }>("SELECT template_key,version FROM workspace_sample_template_versions ORDER BY template_key");
    assert.equal(sampleTemplates.rows.length, 2);
    await assert.rejects(() => harness.pool.query("UPDATE workspace_template_versions SET revision=revision+1 WHERE template_key=$1 AND version=$2", [sampleTemplates.rows[0]!.template_key, sampleTemplates.rows[0]!.version]), /immutable/i);
    assert.equal((await harness.pool.query("SELECT 1 FROM workspace_templates WHERE template_key=$1", [normalDefinition.templateKey])).rows.length, 1);
    assert.equal((await harness.pool.query("SELECT 1 FROM workspace_clients WHERE id=$1", [ordinaryClientId])).rows.length, 1);
    assert.deepEqual((await harness.pool.query<{ id: string }>("SELECT id FROM app_users ORDER BY id")).rows.map((row) => row.id), originalUserIds);
    assert.equal((await harness.pool.query("SELECT 1 FROM workspace_audit_events WHERE id=$1 AND details=$2", [preservedAuditId, { preserved: true }])).rows.length, 1);

    const blockingEngagementId = randomUUID();
    await harness.pool.query(
      "INSERT INTO workspace_engagements(id,client_id,template_key,template_version,title,accountable_lead_user_id,created_by) VALUES($1,$2,$3,$4,$5,$6,$6)",
      [blockingEngagementId, reloaded.clientIds[0], sampleTemplates.rows[0]!.template_key, sampleTemplates.rows[0]!.version, "Real engagement referencing sample client", admin.id]
    );
    await assert.rejects(() => samples.remove(admin, { expectedRevision: 3, requestKey: randomUUID(), confirmation: "remove-sample-data" }), ConflictError);
    assert.deepEqual((await samples.status(admin)).clientIds, reloaded.clientIds);
    assert.equal((await harness.pool.query("SELECT 1 FROM workspace_engagements WHERE id=$1", [blockingEngagementId])).rows.length, 1);
    await harness.pool.query("DELETE FROM workspace_engagements WHERE id=$1", [blockingEngagementId]);

    const removalFailureKey = randomUUID();
    await harness.pool.query(`CREATE FUNCTION fail_sample_client_delete() RETURNS trigger AS $$ BEGIN RAISE EXCEPTION 'injected sample remove failure'; END; $$ LANGUAGE plpgsql`);
    await harness.pool.query("CREATE TRIGGER fail_sample_client_delete_trigger BEFORE DELETE ON workspace_clients FOR EACH ROW EXECUTE FUNCTION fail_sample_client_delete()");
    const auditCountBefore = (await harness.pool.query<{ count: string }>("SELECT count(*)::text count FROM workspace_audit_events")).rows[0]!.count;
    const rowsBeforeRemove = await harness.pool.query<{ table_name: string; count: string }>(`SELECT 'clients' table_name,count(*)::text count FROM workspace_clients UNION ALL SELECT 'engagements',count(*)::text FROM workspace_engagements UNION ALL SELECT 'memberships',count(*)::text FROM workspace_engagement_memberships UNION ALL SELECT 'stages',count(*)::text FROM workspace_stage_instances UNION ALL SELECT 'items',count(*)::text FROM workspace_checklist_instances UNION ALL SELECT 'sample_clients',count(*)::text FROM workspace_sample_clients UNION ALL SELECT 'sample_engagements',count(*)::text FROM workspace_sample_engagements ORDER BY table_name`);
    await assert.rejects(() => samples.remove(admin, { expectedRevision: 3, requestKey: removalFailureKey, confirmation: "remove-sample-data" }), /injected sample remove failure/i);
    const afterFailedRemove = await samples.status(admin);
    assert.deepEqual(afterFailedRemove.clientIds, reloaded.clientIds);
    assert.deepEqual(afterFailedRemove.engagementIds, reloaded.engagementIds);
    const rowsAfterRemove = await harness.pool.query<{ table_name: string; count: string }>(`SELECT 'clients' table_name,count(*)::text count FROM workspace_clients UNION ALL SELECT 'engagements',count(*)::text FROM workspace_engagements UNION ALL SELECT 'memberships',count(*)::text FROM workspace_engagement_memberships UNION ALL SELECT 'stages',count(*)::text FROM workspace_stage_instances UNION ALL SELECT 'items',count(*)::text FROM workspace_checklist_instances UNION ALL SELECT 'sample_clients',count(*)::text FROM workspace_sample_clients UNION ALL SELECT 'sample_engagements',count(*)::text FROM workspace_sample_engagements ORDER BY table_name`);
    assert.deepEqual(rowsAfterRemove.rows, rowsBeforeRemove.rows);
    assert.equal((await harness.pool.query("SELECT 1 FROM workspace_action_requests WHERE actor_id=$1 AND action='sample_pack.remove' AND request_key=$2", [admin.id, removalFailureKey])).rows.length, 0);
    assert.equal((await harness.pool.query<{ count: string }>("SELECT count(*)::text count FROM workspace_audit_events")).rows[0]!.count, auditCountBefore);
  } finally {
    await harness.dispose();
  }
});

test("a mid-load failure rolls back the entire sample generation in real PostgreSQL", async () => {
  const harness = await createPostgresHarness();
  try {
    await runMigrations(harness.pool, await readMigrationFiles("migrations"));
    const { admin } = await seedUsers(harness.pool);
    const samples = new SampleService(harness.pool);
    await harness.pool.query(`CREATE FUNCTION fail_sample_engagement_map() RETURNS trigger AS $$ BEGIN RAISE EXCEPTION 'injected sample load failure'; END; $$ LANGUAGE plpgsql`);
    await harness.pool.query("CREATE TRIGGER fail_sample_engagement_map_trigger BEFORE INSERT ON workspace_sample_engagements FOR EACH ROW EXECUTE FUNCTION fail_sample_engagement_map()");
    const requestKey = randomUUID();
    await assert.rejects(() => samples.load(admin, { expectedRevision: 0, requestKey, confirmation: "load-sample-data" }), /injected sample load failure/i);
    for (const table of ["workspace_sample_packs", "workspace_sample_clients", "workspace_sample_engagements", "workspace_sample_template_versions", "workspace_clients", "workspace_engagements", "workspace_stage_instances", "workspace_checklist_instances", "workspace_audit_events"]) {
      assert.equal((await harness.pool.query(`SELECT 1 FROM ${table}`)).rows.length, 0, table);
    }
    assert.equal((await harness.pool.query("SELECT 1 FROM workspace_action_requests WHERE actor_id=$1 AND action='sample_pack.load' AND request_key=$2", [admin.id, requestKey])).rows.length, 0);
    assert.equal((await harness.pool.query("SELECT count(*)::int count FROM app_users")).rows[0]?.count, 2);
  } finally {
    await harness.dispose();
  }
});

test("reloading after every tracked sample version is retired creates fresh published versions", async () => {
  const harness = await createPostgresHarness();
  try {
    await runMigrations(harness.pool, await readMigrationFiles("migrations"));
    const { admin } = await seedUsers(harness.pool);
    const samples = new SampleService(harness.pool);
    const templates = new TemplateService(harness.pool);
    await samples.load(admin, { expectedRevision: 0, requestKey: randomUUID(), confirmation: "load-sample-data" });
    await samples.remove(admin, { expectedRevision: 1, requestKey: randomUUID(), confirmation: "remove-sample-data" });
    const original = (await harness.pool.query<{ template_key: string; version: number; revision: number }>(
      "SELECT p.template_key,p.version,v.revision FROM workspace_sample_template_versions p JOIN workspace_template_versions v USING(template_key,version) ORDER BY p.template_key,p.version"
    )).rows;
    assert.equal(original.length, 2);
    for (const version of original)
      await templates.retire(admin, { templateKey: version.template_key, version: version.version, expectedRevision: Number(version.revision), requestKey: randomUUID() });

    const reloaded = await samples.load(admin, { expectedRevision: 2, requestKey: randomUUID(), confirmation: "load-sample-data" });
    assert.equal(reloaded.state, "loaded");
    assert.equal(reloaded.engagements, 2);
    for (const prior of original) {
      const versions = (await harness.pool.query<{ version: number; state: string }>(
        "SELECT version,state FROM workspace_template_versions WHERE template_key=$1 ORDER BY version",
        [prior.template_key]
      )).rows;
      assert.deepEqual(versions.map((row) => row.state), ["retired", "published"]);
      assert.ok(versions[1]!.version > prior.version);
      assert.equal((await harness.pool.query(
        "SELECT 1 FROM workspace_sample_template_versions WHERE template_key=$1 AND version=$2",
        [prior.template_key, versions[1]!.version]
      )).rowCount, 1);
      assert.equal((await harness.pool.query(
        "SELECT count(*)::int count FROM workspace_engagements WHERE template_key=$1 AND template_version=$2",
        [prior.template_key, versions[1]!.version]
      )).rows[0]!.count, 1);
    }
  } finally {
    await harness.dispose();
  }
});
