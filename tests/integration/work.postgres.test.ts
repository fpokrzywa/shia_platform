import assert from "node:assert/strict";
import { randomUUID } from "node:crypto";
import test from "node:test";
import {
  readMigrationFiles,
  runMigrations,
} from "../../packages/persistence/src/migrations.js";
import {
  AuthorizationError,
  ConflictError,
  EngagementService,
  MembershipService,
  NotFoundError,
  SampleService,
  ValidationError,
  WorkService,
} from "../../packages/persistence/src/workspace/index.js";
import { createPostgresHarness } from "./postgres-harness.js";

test("engagement work enforces membership, revisions, evidence isolation, and atomic audit history", async () => {
  const harness = await createPostgresHarness();
  try {
    await runMigrations(harness.pool, await readMigrationFiles("migrations"));
    const admin = { id: randomUUID(), role: "practice_admin" as const };
    const member = { id: randomUUID(), role: "member" as const };
    const outsider = { id: randomUUID(), role: "member" as const };
    for (const [id, email, role] of [
      [admin.id, "work-admin@example.test", admin.role],
      [member.id, "work-member@example.test", member.role],
      [outsider.id, "work-outsider@example.test", outsider.role],
    ]) {
      await harness.pool.query(
        "INSERT INTO app_users(id,email,display_name,password_hash,role) VALUES($1,$2,$3,$4,$5)",
        [id, email, email, "unused", role],
      );
    }
    const samples = new SampleService(harness.pool);
    const loaded = await samples.load(admin, {
      expectedRevision: 0,
      requestKey: randomUUID(),
      confirmation: "load-sample-data",
    });
    const [engagementA, engagementB] = loaded.engagementIds;
    assert.ok(engagementA && engagementB);
    const work = new WorkService(harness.pool);
    const memberships = new MembershipService(harness.pool);
    const itemA = (await work.get(admin, engagementA)).items[0]!;
    const itemB = (await work.get(admin, engagementB)).items[0]!;

    await assert.rejects(
      () => work.get(outsider, engagementA),
      AuthorizationError,
    );
    await assert.rejects(
      () => work.readAttachment(outsider, engagementA, randomUUID()),
      AuthorizationError,
    );
    await assert.rejects(
      () =>
        work.addNote(admin, engagementA, {
          requestKey: randomUUID(),
          itemId: itemB.id,
          text: "Cross engagement",
        }),
      NotFoundError,
    );
    await assert.rejects(
      () =>
        work.addEvidence(admin, engagementA, {
          requestKey: randomUUID(),
          itemId: itemB.id,
          title: "Cross engagement",
          url: "https://example.test/evidence",
        }),
      NotFoundError,
    );

    await memberships.add(admin, {
      engagementId: engagementA,
      userId: member.id,
      role: "engineer",
      expectedRevision: 1,
      requestKey: randomUUID(),
    });
    assert.ok((await work.get(member, engagementA)).items.length > 0);
    const updateKey = randomUUID();
    const updateInput = {
      expectedRevision: itemA.revision,
      requestKey: updateKey,
      status: "in_progress",
      ownerUserId: member.id,
      dueDate: "2026-10-15",
    };
    const firstUpdate = await work.updateItem(
      member,
      engagementA,
      itemA.id,
      updateInput,
    );
    const retryUpdate = await work.updateItem(
      member,
      engagementA,
      itemA.id,
      updateInput,
    );
    assert.deepEqual(retryUpdate, firstUpdate);
    await assert.rejects(
      () =>
        work.updateItem(member, engagementA, itemA.id, {
          ...updateInput,
          status: "blocked",
        }),
      ConflictError,
    );
    await assert.rejects(
      () =>
        work.updateItem(member, engagementA, itemA.id, {
          ...updateInput,
          requestKey: randomUUID(),
        }),
      ConflictError,
    );
    await assert.rejects(
      () =>
        work.updateItem(member, engagementA, itemA.id, {
          expectedRevision: firstUpdate.revision,
          requestKey: randomUUID(),
          status: "blocked",
          ownerUserId: outsider.id,
        }),
      /current engagement member/i,
    );

    for (const requirement of itemA.evidenceRequirementKeys) {
      const classified = await work.addEvidence(member, engagementA, {
        requestKey: randomUUID(),
        itemId: itemA.id,
        title: `Required ${requirement}`,
        evidenceRequirementKey: requirement,
        url: `https://example.test/required/${encodeURIComponent(requirement)}`,
      });
      assert.equal(classified.evidenceRequirementKey, requirement);
    }
    const completed = await work.updateItem(member, engagementA, itemA.id, {
      expectedRevision: firstUpdate.revision,
      requestKey: randomUUID(),
      status: "complete",
    });
    const reopened = await work.updateItem(member, engagementA, itemA.id, {
      expectedRevision: completed.revision,
      requestKey: randomUUID(),
      status: "in_progress",
    });
    const transitionAudits = await harness.pool.query<{
      action: string;
      details: Record<string, unknown>;
    }>(
      "SELECT action,details FROM workspace_audit_events WHERE engagement_id=$1 AND details->>'itemId'=$2 ORDER BY id",
      [engagementA, itemA.id],
    );
    assert.ok(
      transitionAudits.rows.some(
        (row) =>
          row.action === "work.item_update" &&
          row.details.newStatus === "complete",
      ),
    );
    assert.ok(
      transitionAudits.rows.some(
        (row) =>
          row.action === "work.item_reopen" &&
          row.details.priorStatus === "complete",
      ),
    );

    const noteKey = randomUUID();
    const note = await work.addNote(member, engagementA, {
      requestKey: noteKey,
      itemId: itemA.id,
      text: "  Persistent implementation note  ",
    });
    assert.equal(note.text, "Persistent implementation note");
    assert.deepEqual(
      await work.addNote(member, engagementA, {
        requestKey: noteKey,
        itemId: itemA.id,
        text: "  Persistent implementation note  ",
      }),
      note,
    );
    await assert.rejects(
      () =>
        work.addEvidence(member, engagementA, {
          requestKey: randomUUID(),
          itemId: itemA.id,
          title: "Unsafe",
          url: "javascript:alert(1)",
        }),
      /HTTP or HTTPS/i,
    );
    await assert.rejects(
      () =>
        work.addEvidence(member, engagementA, {
          requestKey: randomUUID(),
          itemId: itemA.id,
          title: "Oversized",
          fileName: "large.bin",
          base64: Buffer.alloc(2 * 1024 * 1024 + 1).toString("base64"),
        }),
      /2 MiB/i,
    );
    const urlEvidence = await work.addEvidence(member, engagementA, {
      requestKey: randomUUID(),
      itemId: itemA.id,
      title: "Runbook",
      url: "https://example.test/runbook",
    });
    assert.equal(urlEvidence.url, "https://example.test/runbook");
    const bytes = Buffer.from([0, 1, 2, 127, 128, 255]);
    const attachment = await work.addEvidence(member, engagementA, {
      requestKey: randomUUID(),
      itemId: itemA.id,
      title: "Attachment",
      fileName: "proof.bin",
      mediaType: "application/x-untrusted",
      base64: bytes.toString("base64"),
    });
    assert.equal(attachment.size, bytes.length);
    const download = await work.readAttachment(
      member,
      engagementA,
      attachment.id,
    );
    assert.equal(download.fileName, "proof.bin");
    assert.equal(download.mediaType, "application/octet-stream");
    assert.deepEqual(download.data, bytes);
    await assert.rejects(
      () => work.readAttachment(admin, engagementB, attachment.id),
      NotFoundError,
    );
    await assert.rejects(
      () => work.readAttachment(admin, engagementA, urlEvidence.id),
      NotFoundError,
    );

    await harness.pool.query(
      `CREATE FUNCTION fail_work_evidence_audit() RETURNS trigger AS $$ BEGIN IF NEW.action='work.evidence_add' THEN RAISE EXCEPTION 'injected evidence audit failure'; END IF; RETURN NEW; END; $$ LANGUAGE plpgsql`,
    );
    await harness.pool.query(
      "CREATE TRIGGER fail_work_evidence_audit_trigger BEFORE INSERT ON workspace_audit_events FOR EACH ROW EXECUTE FUNCTION fail_work_evidence_audit()",
    );
    const evidenceRollbackKey = randomUUID();
    const evidenceCount = (
      await harness.pool.query<{ count: string }>(
        "SELECT count(*)::text count FROM workspace_evidence",
      )
    ).rows[0]!.count;
    await assert.rejects(
      () =>
        work.addEvidence(member, engagementA, {
          requestKey: evidenceRollbackKey,
          itemId: itemA.id,
          title: "Must roll back",
          url: "https://example.test/rollback",
        }),
      /injected evidence audit failure/i,
    );
    assert.equal(
      (
        await harness.pool.query<{ count: string }>(
          "SELECT count(*)::text count FROM workspace_evidence",
        )
      ).rows[0]!.count,
      evidenceCount,
    );
    assert.equal(
      (
        await harness.pool.query(
          "SELECT 1 FROM workspace_action_requests WHERE actor_id=$1 AND action='work.evidence_add' AND request_key=$2",
          [member.id, evidenceRollbackKey],
        )
      ).rows.length,
      0,
    );
    await harness.pool.query(
      "DROP TRIGGER fail_work_evidence_audit_trigger ON workspace_audit_events",
    );
    await harness.pool.query("DROP FUNCTION fail_work_evidence_audit()");

    const engagementRevision = (
      await harness.pool.query<{ revision: string }>(
        "SELECT revision FROM workspace_engagements WHERE id=$1",
        [engagementA],
      )
    ).rows[0]!.revision;
    await memberships.remove(admin, {
      engagementId: engagementA,
      userId: member.id,
      role: "engineer",
      expectedRevision: Number(engagementRevision),
      requestKey: randomUUID(),
    });
    await assert.rejects(
      () => work.get(member, engagementA),
      AuthorizationError,
    );
    await assert.rejects(
      () => work.readAttachment(member, engagementA, attachment.id),
      AuthorizationError,
    );
    assert.equal(
      (
        await harness.pool.query<{ owner_user_id: string | null }>(
          "SELECT owner_user_id FROM workspace_checklist_instances WHERE id=$1",
          [itemA.id],
        )
      ).rows[0]?.owner_user_id,
      member.id,
    );

    await harness.pool.query(
      `CREATE FUNCTION fail_work_update_audit() RETURNS trigger AS $$ BEGIN IF NEW.action='work.item_update' THEN RAISE EXCEPTION 'injected work audit failure'; END IF; RETURN NEW; END; $$ LANGUAGE plpgsql`,
    );
    await harness.pool.query(
      "CREATE TRIGGER fail_work_update_audit_trigger BEFORE INSERT ON workspace_audit_events FOR EACH ROW EXECUTE FUNCTION fail_work_update_audit()",
    );
    const rollbackKey = randomUUID();
    const beforeRollback = await harness.pool.query<{
      status: string;
      revision: string;
      completed_at: Date | null;
      completed_by: string | null;
    }>(
      "SELECT status,revision,completed_at,completed_by FROM workspace_checklist_instances WHERE id=$1",
      [itemA.id],
    );
    const auditCount = (
      await harness.pool.query<{ count: string }>(
        "SELECT count(*)::text count FROM workspace_audit_events",
      )
    ).rows[0]!.count;
    await assert.rejects(
      () =>
        work.updateItem(admin, engagementA, itemA.id, {
          expectedRevision: reopened.revision,
          requestKey: rollbackKey,
          status: "complete",
        }),
      /injected work audit failure/i,
    );
    const afterRollback = await harness.pool.query<{
      status: string;
      revision: string;
      completed_at: Date | null;
      completed_by: string | null;
    }>(
      "SELECT status,revision,completed_at,completed_by FROM workspace_checklist_instances WHERE id=$1",
      [itemA.id],
    );
    assert.deepEqual(afterRollback.rows, beforeRollback.rows);
    assert.equal(
      (
        await harness.pool.query<{ count: string }>(
          "SELECT count(*)::text count FROM workspace_audit_events",
        )
      ).rows[0]!.count,
      auditCount,
    );
    assert.equal(
      (
        await harness.pool.query(
          "SELECT 1 FROM workspace_action_requests WHERE actor_id=$1 AND action='work.item_update' AND request_key=$2",
          [admin.id, rollbackKey],
        )
      ).rows.length,
      0,
    );
  } finally {
    await harness.dispose();
  }
});

test("sample cleanup cascades sample work while preserving ordinary engagement work", async () => {
  const harness = await createPostgresHarness();
  try {
    await runMigrations(harness.pool, await readMigrationFiles("migrations"));
    const admin = { id: randomUUID(), role: "practice_admin" as const };
    await harness.pool.query(
      "INSERT INTO app_users(id,email,display_name,password_hash,role) VALUES($1,$2,$3,$4,'practice_admin')",
      [admin.id, "cleanup-admin@example.test", "Cleanup Admin", "unused"],
    );
    const samples = new SampleService(harness.pool);
    const engagements = new EngagementService(harness.pool);
    const work = new WorkService(harness.pool);
    const loaded = await samples.load(admin, {
      expectedRevision: 0,
      requestKey: randomUUID(),
      confirmation: "load-sample-data",
    });
    const sampleEngagementId = loaded.engagementIds[0]!;
    const sampleItem = (await work.get(admin, sampleEngagementId)).items[0]!;
    const sampleNote = await work.addNote(admin, sampleEngagementId, {
      requestKey: randomUUID(),
      itemId: sampleItem.id,
      text: "Sample-only note",
    });
    const sampleEvidence = await work.addEvidence(admin, sampleEngagementId, {
      requestKey: randomUUID(),
      itemId: sampleItem.id,
      title: "Sample-only attachment",
      fileName: "sample.bin",
      base64: "AQID",
    });

    const template = (
      await harness.pool.query<{ template_key: string; version: number }>(
        "SELECT template_key,version FROM workspace_sample_template_versions ORDER BY template_key LIMIT 1",
      )
    ).rows[0]!;
    const ordinaryClient = await engagements.createClient(admin, {
      name: "Ordinary retained client",
      requestKey: randomUUID(),
    });
    const ordinaryEngagement = await engagements.createEngagement(admin, {
      clientId: ordinaryClient.id,
      templateKey: template.template_key,
      templateVersion: template.version,
      title: "Ordinary retained engagement",
      leadUserId: admin.id,
      requestKey: randomUUID(),
    });
    const ordinaryItem = (await work.get(admin, ordinaryEngagement.id))
      .items[0]!;
    const ordinaryNote = await work.addNote(admin, ordinaryEngagement.id, {
      requestKey: randomUUID(),
      itemId: ordinaryItem.id,
      text: "Ordinary retained note",
    });
    const ordinaryEvidence = await work.addEvidence(
      admin,
      ordinaryEngagement.id,
      {
        requestKey: randomUUID(),
        itemId: ordinaryItem.id,
        title: "Ordinary retained attachment",
        fileName: "ordinary.bin",
        base64: "BAUG",
      },
    );

    await samples.remove(admin, {
      expectedRevision: 1,
      requestKey: randomUUID(),
      confirmation: "remove-sample-data",
    });
    assert.equal(
      (
        await harness.pool.query(
          "SELECT 1 FROM workspace_engagement_notes WHERE id=$1",
          [sampleNote.id],
        )
      ).rows.length,
      0,
    );
    assert.equal(
      (
        await harness.pool.query(
          "SELECT 1 FROM workspace_evidence WHERE id=$1",
          [sampleEvidence.id],
        )
      ).rows.length,
      0,
    );
    assert.equal(
      (
        await harness.pool.query(
          "SELECT 1 FROM workspace_engagements WHERE id=$1",
          [ordinaryEngagement.id],
        )
      ).rows.length,
      1,
    );
    assert.equal(
      (
        await harness.pool.query(
          "SELECT 1 FROM workspace_engagement_notes WHERE id=$1",
          [ordinaryNote.id],
        )
      ).rows.length,
      1,
    );
    assert.equal(
      (
        await harness.pool.query(
          "SELECT 1 FROM workspace_evidence WHERE id=$1",
          [ordinaryEvidence.id],
        )
      ).rows.length,
      1,
    );
    assert.deepEqual(
      (
        await work.readAttachment(
          admin,
          ordinaryEngagement.id,
          ordinaryEvidence.id,
        )
      ).data,
      Buffer.from([4, 5, 6]),
    );
  } finally {
    await harness.dispose();
  }
});
