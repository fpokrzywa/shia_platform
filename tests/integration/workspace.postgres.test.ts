import assert from "node:assert/strict";
import { randomUUID } from "node:crypto";
import { readFile } from "node:fs/promises";
import test from "node:test";
import type { TemplateVersionDefinition } from "../../packages/domain/src/templates/index.js";
import { readMigrationFiles, runMigrations } from "../../packages/persistence/src/migrations.js";
import { AuthorizationError, ConflictError, EngagementService, MembershipService, TemplateService } from "../../packages/persistence/src/workspace/index.js";
import { createPostgresHarness } from "./postgres-harness.js";

test("workspace transactions enforce membership and serialize revision changes in real PostgreSQL", async () => {
  const harness = await createPostgresHarness();
  try {
    await runMigrations(harness.pool, await readMigrationFiles("migrations"));
    const admin = { id: randomUUID(), role: "practice_admin" as const };
    const lead = { id: randomUUID(), role: "member" as const };
    const outsider = { id: randomUUID(), role: "member" as const };
    for (const [id, email, role] of [[admin.id, "admin@example.test", admin.role], [lead.id, "lead@example.test", lead.role], [outsider.id, "outsider@example.test", outsider.role]]) {
      await harness.pool.query("INSERT INTO app_users(id,email,display_name,password_hash,role) VALUES($1,$2,$3,$4,$5)", [id, email, email, "unused-in-service-test", role]);
    }

    const templates = new TemplateService(harness.pool);
    const engagements = new EngagementService(harness.pool);
    const memberships = new MembershipService(harness.pool);
    const repeatedKey = randomUUID();
    const [firstClient, repeatedClient] = await Promise.all([
      engagements.createClient(admin, { name: "Concurrent Client", requestKey: repeatedKey }),
      engagements.createClient(admin, { name: "Concurrent Client", requestKey: repeatedKey })
    ]);
    assert.deepEqual(repeatedClient, firstClient);
    assert.equal(
      (await harness.pool.query("SELECT 1 FROM workspace_clients WHERE name='Concurrent Client'")).rows.length,
      1
    );
    const definition = JSON.parse(await readFile("templates/independent-delivery.v1.json", "utf8")) as TemplateVersionDefinition;
    await templates.importDraft(admin, { definition, requestKey: randomUUID() });
    await templates.publish(admin, { templateKey: definition.templateKey, version: definition.version, expectedRevision: 1, requestKey: randomUUID() });
    await assert.rejects(
      () => harness.pool.query("DELETE FROM workspace_template_versions WHERE template_key=$1 AND version=$2", [definition.templateKey, definition.version]),
      /immutable/i
    );
    await assert.rejects(() =>
      harness.pool.query(
        "INSERT INTO workspace_template_versions(template_key,version,state,definition) VALUES($1,2,'draft','{}'::jsonb)",
        [definition.templateKey]
      )
    );
    const client = await engagements.createClient(admin, { name: "Integration Client", requestKey: randomUUID() });
    const engagement = await engagements.createEngagement(admin, {
      clientId: client.id, templateKey: definition.templateKey, templateVersion: definition.version,
      title: "Integration Engagement", leadUserId: lead.id, requestKey: randomUUID()
    });

    assert.equal((await engagements.getEngagement(lead, engagement.id)).id, engagement.id);
    await assert.rejects(() => engagements.getEngagement(outsider, engagement.id), /membership/i);
    await assert.rejects(() => engagements.getEngagementDetail(outsider, engagement.id), AuthorizationError);
    await assert.rejects(() => memberships.list(outsider, engagement.id), AuthorizationError);

    const request = { engagementId: engagement.id, userId: outsider.id, role: "engineer" as const, expectedRevision: 1 };
    const outcomes = await Promise.allSettled([
      memberships.add(admin, { ...request, requestKey: randomUUID() }),
      memberships.add(admin, { ...request, role: "reviewer", requestKey: randomUUID() })
    ]);
    assert.equal(outcomes.filter((outcome) => outcome.status === "fulfilled").length, 1);
    const rejected = outcomes.find((outcome): outcome is PromiseRejectedResult => outcome.status === "rejected");
    assert.ok(rejected?.reason instanceof ConflictError);
    assert.equal((await engagements.getEngagement(outsider, engagement.id)).id, engagement.id);

    const granted = (await memberships.list(admin, engagement.id)).find((membership) => membership.userId === outsider.id);
    assert.ok(granted);
    const afterAdd = await engagements.getEngagement(admin, engagement.id);
    await memberships.remove(admin, {
      engagementId: engagement.id, userId: outsider.id, role: granted.role,
      expectedRevision: afterAdd.revision, requestKey: randomUUID()
    });
    await assert.rejects(() => engagements.getEngagementDetail(outsider, engagement.id), AuthorizationError);

    const current = await engagements.getEngagement(admin, engagement.id);
    await assert.rejects(
      () => memberships.remove(admin, { engagementId: engagement.id, userId: lead.id, role: "engagement_lead", expectedRevision: current.revision, requestKey: randomUUID() }),
      /accountable lead/i
    );
  } finally {
    await harness.dispose();
  }
});

test("engagement creation is atomic and template versions remain pinned in real PostgreSQL", async () => {
  const harness = await createPostgresHarness();
  try {
    await runMigrations(harness.pool, await readMigrationFiles("migrations"));
    const admin = { id: randomUUID(), role: "practice_admin" as const };
    const member = { id: randomUUID(), role: "member" as const };
    for (const [id, email, role] of [[admin.id, "version-admin@example.test", admin.role], [member.id, "version-member@example.test", member.role]]) {
      await harness.pool.query("INSERT INTO app_users(id,email,display_name,password_hash,role) VALUES($1,$2,$3,$4,$5)", [id, email, email, "unused-in-service-test", role]);
    }
    const templates = new TemplateService(harness.pool);
    const engagements = new EngagementService(harness.pool);
    const definition = JSON.parse(await readFile("templates/independent-delivery.v1.json", "utf8")) as TemplateVersionDefinition;
    await assert.rejects(() => templates.importDraft(member, { definition, requestKey: randomUUID() }), AuthorizationError);
    await templates.importDraft(admin, { definition, requestKey: randomUUID() });
    await assert.rejects(
      () => engagements.createEngagement(admin, { clientId: "missing", templateKey: definition.templateKey, templateVersion: 1, title: "Draft", leadUserId: member.id, requestKey: randomUUID() }),
      /published template/i
    );
    await assert.rejects(() => templates.publish(member, { templateKey: definition.templateKey, version: 1, expectedRevision: 1, requestKey: randomUUID() }), AuthorizationError);
    await templates.publish(admin, { templateKey: definition.templateKey, version: 1, expectedRevision: 1, requestKey: randomUUID() });
    await assert.rejects(() => templates.createVersion(member, { templateKey: definition.templateKey, sourceVersion: 1, expectedRevision: 2, changes: {}, reason: "Denied", requestKey: randomUUID() }), AuthorizationError);

    const client = await engagements.createClient(admin, { name: "Version Client", requestKey: randomUUID() });
    const first = await engagements.createEngagement(admin, { clientId: client.id, templateKey: definition.templateKey, templateVersion: 1, title: "Version One", leadUserId: member.id, requestKey: randomUUID() });
    const firstDetail = await engagements.getEngagementDetail(admin, first.id);
    const revisedStages = definition.stages.map((stage, index) => index === 0 ? { ...stage, name: "Revised qualification" } : stage);
    await templates.createVersion(admin, { templateKey: definition.templateKey, sourceVersion: 1, expectedRevision: 2, changes: { stages: revisedStages }, reason: "Integration revision", requestKey: randomUUID() });
    await assert.rejects(
      () => engagements.createEngagement(admin, { clientId: client.id, templateKey: definition.templateKey, templateVersion: 2, title: "Still Draft", leadUserId: member.id, requestKey: randomUUID() }),
      /published template/i
    );
    await templates.publish(admin, { templateKey: definition.templateKey, version: 2, expectedRevision: 1, requestKey: randomUUID() });
    const second = await engagements.createEngagement(admin, { clientId: client.id, templateKey: definition.templateKey, templateVersion: 2, title: "Version Two", leadUserId: member.id, requestKey: randomUUID() });
    assert.equal((await engagements.getEngagementDetail(admin, first.id)).stages[0]?.definition.name, firstDetail.stages[0]?.definition.name);
    assert.equal((await engagements.getEngagementDetail(admin, second.id)).stages[0]?.definition.name, "Revised qualification");

    const beforeRetire = await harness.pool.query<{ revision: string; published_by: string; published_at: Date; created_at: Date }>(
      "SELECT revision,published_by,published_at,created_at FROM workspace_template_versions WHERE template_key=$1 AND version=2",
      [definition.templateKey]
    );
    const retired = await templates.retire(admin, { templateKey: definition.templateKey, version: 2, expectedRevision: 2, requestKey: randomUUID() });
    const afterRetire = await harness.pool.query<{ revision: string; published_by: string; published_at: Date; created_at: Date; state: string }>(
      "SELECT revision,published_by,published_at,created_at,state FROM workspace_template_versions WHERE template_key=$1 AND version=2",
      [definition.templateKey]
    );
    assert.equal(retired.definition.state, "retired");
    assert.equal(Number(afterRetire.rows[0]?.revision), Number(beforeRetire.rows[0]?.revision) + 1);
    assert.equal(afterRetire.rows[0]?.published_by, beforeRetire.rows[0]?.published_by);
    assert.equal(afterRetire.rows[0]?.published_at.toISOString(), beforeRetire.rows[0]?.published_at.toISOString());
    assert.equal(afterRetire.rows[0]?.created_at.toISOString(), beforeRetire.rows[0]?.created_at.toISOString());
    await assert.rejects(
      () => engagements.createEngagement(admin, { clientId: client.id, templateKey: definition.templateKey, templateVersion: 2, title: "Retired", leadUserId: member.id, requestKey: randomUUID() }),
      /published template/i
    );

    const sameKey = randomUUID();
    const concurrentInput = { clientId: client.id, templateKey: definition.templateKey, templateVersion: 1, title: "Concurrent Engagement", leadUserId: member.id, requestKey: sameKey };
    const [sameA, sameB] = await Promise.all([engagements.createEngagement(admin, concurrentInput), engagements.createEngagement(admin, concurrentInput)]);
    assert.deepEqual(sameB, sameA);
    assert.equal((await harness.pool.query("SELECT 1 FROM workspace_engagements WHERE title=$1", [concurrentInput.title])).rows.length, 1);
    await assert.rejects(() => engagements.createEngagement(admin, { ...concurrentInput, title: "Changed Input" }), ConflictError);

    await harness.pool.query(`CREATE FUNCTION fail_mid_engagement() RETURNS trigger AS $$ BEGIN RAISE EXCEPTION 'injected engagement failure'; END; $$ LANGUAGE plpgsql`);
    await harness.pool.query("CREATE TRIGGER fail_mid_engagement_trigger BEFORE INSERT ON workspace_checklist_instances FOR EACH ROW EXECUTE FUNCTION fail_mid_engagement()");
    const failureKey = randomUUID();
    const countsBefore = await harness.pool.query<{ table_name: string; count: string }>(`SELECT 'engagements' table_name,count(*)::text count FROM workspace_engagements UNION ALL SELECT 'memberships',count(*)::text FROM workspace_engagement_memberships UNION ALL SELECT 'stages',count(*)::text FROM workspace_stage_instances UNION ALL SELECT 'items',count(*)::text FROM workspace_checklist_instances UNION ALL SELECT 'actions',count(*)::text FROM workspace_action_requests UNION ALL SELECT 'audit',count(*)::text FROM workspace_audit_events ORDER BY table_name`);
    await assert.rejects(
      () => engagements.createEngagement(admin, { clientId: client.id, templateKey: definition.templateKey, templateVersion: 1, title: "Must Roll Back", leadUserId: member.id, requestKey: failureKey }),
      /injected engagement failure/i
    );
    assert.equal((await harness.pool.query("SELECT 1 FROM workspace_engagements WHERE title='Must Roll Back'")).rows.length, 0);
    assert.equal((await harness.pool.query("SELECT 1 FROM workspace_stage_instances s JOIN workspace_engagements e ON e.id=s.engagement_id WHERE e.title='Must Roll Back'")).rows.length, 0);
    assert.equal((await harness.pool.query("SELECT 1 FROM workspace_action_requests WHERE actor_id=$1 AND action='engagement.create' AND request_key=$2", [admin.id, failureKey])).rows.length, 0);
    const countsAfter = await harness.pool.query<{ table_name: string; count: string }>(`SELECT 'engagements' table_name,count(*)::text count FROM workspace_engagements UNION ALL SELECT 'memberships',count(*)::text FROM workspace_engagement_memberships UNION ALL SELECT 'stages',count(*)::text FROM workspace_stage_instances UNION ALL SELECT 'items',count(*)::text FROM workspace_checklist_instances UNION ALL SELECT 'actions',count(*)::text FROM workspace_action_requests UNION ALL SELECT 'audit',count(*)::text FROM workspace_audit_events ORDER BY table_name`);
    assert.deepEqual(countsAfter.rows, countsBefore.rows);
  } finally {
    await harness.dispose();
  }
});
