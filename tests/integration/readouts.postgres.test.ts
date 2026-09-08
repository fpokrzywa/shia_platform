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
  FinalReadoutService,
  SampleService,
  WorkService,
} from "../../packages/persistence/src/workspace/index.js";
import { createPostgresHarness } from "./postgres-harness.js";

test("final readouts isolate access, preserve snapshots, detect staleness and cascade with samples", async () => {
  const h = await createPostgresHarness();
  try {
    await runMigrations(h.pool, await readMigrationFiles("migrations"));
    const admin = { id: randomUUID(), role: "practice_admin" as const };
    const outsider = { id: randomUUID(), role: "member" as const };
    const member = { id: randomUUID(), role: "member" as const };
    for (const [id, email, role] of [
      [admin.id, "readout-admin@example.test", admin.role],
      [outsider.id, "readout-outsider@example.test", outsider.role],
      [member.id, "readout-member@example.test", member.role],
    ])
      await h.pool.query(
        "INSERT INTO app_users(id,email,display_name,password_hash,role) VALUES($1,$2,$2,'unused',$3)",
        [id, email, role],
      );
    const samples = new SampleService(h.pool);
    const loaded = await samples.load(admin, {
      expectedRevision: 0,
      requestKey: randomUUID(),
      confirmation: "load-sample-data",
    });
    const engagementId = loaded.engagementIds[0]!;
    await h.pool.query(
      "INSERT INTO workspace_engagement_memberships(engagement_id,user_id,role,added_by) VALUES($1,$2,'engineer',$3)",
      [engagementId, member.id, admin.id],
    );
    await h.pool.query(
      "INSERT INTO workspace_discovery_assumptions(id,engagement_id,statement,status,created_by) VALUES($1,$2,'Confirm operating ownership','open',$3)",
      [randomUUID(), engagementId, admin.id],
    );
    const metricId = randomUUID();
    await h.pool.query(
      "INSERT INTO workspace_outcome_metrics(id,engagement_id,name,unit,description,baseline,target,created_by) VALUES($1,$2,'Cycle time','hours','Time to complete the workflow',12,4,$3)",
      [metricId, engagementId, admin.id],
    );
    await h.pool.query(
      "INSERT INTO workspace_outcome_observations(id,engagement_id,metric_id,observed_on,value,note,recorded_by) VALUES($1,$2,$3,current_date,6,'First measured result',$4)",
      [randomUUID(), engagementId, metricId, admin.id],
    );
    await h.pool.query(
      "INSERT INTO workspace_training_sets(training_key,name,purpose,created_by) VALUES('private-training','Delivery practice','Practice safely',$1)",
      [admin.id],
    );
    await h.pool.query(
      "INSERT INTO workspace_training_versions(training_key,version,state,definition,published_by,published_at) VALUES('private-training',1,'published',$2,$1,now())",
      [
        admin.id,
        {
          key: "private-training",
          version: 1,
          state: "published",
          name: "Delivery practice",
          purpose: "Practice safely",
          items: [],
        },
      ],
    );
    const assignmentId = randomUUID();
    await h.pool.query(
      "INSERT INTO workspace_training_assignments(id,training_key,training_version,learner_user_id,mentor_user_id,engagement_id,assigned_by) VALUES($1,'private-training',1,$2,$3,$4,$3)",
      [assignmentId, member.id, admin.id, engagementId],
    );
    await h.pool.query(
      "INSERT INTO workspace_learning_logs(id,assignment_id,body,actor_id) VALUES($1,$2,'PRIVATE LEARNER LOG MUST NOT LEAK',$3)",
      [randomUUID(), assignmentId, member.id],
    );
    await h.pool.query(
      "INSERT INTO workspace_mentor_assessments(id,assignment_id,assessment_revision,result,rationale,snapshot_token,actor_id) VALUES($1,$2,1,'needs_development','PRIVATE ASSESSMENT MUST NOT LEAK','opaque',$3)",
      [randomUUID(), assignmentId, admin.id],
    );
    await h.pool.query(
      "UPDATE workspace_training_assignments SET assessment_revision=1 WHERE id=$1",
      [assignmentId],
    );
    await h.pool.query(
      "INSERT INTO workspace_knowledge_sets(knowledge_key,kind,title,created_by) VALUES('linked-guide','discovery_guide','Linked discovery guide',$1)",
      [admin.id],
    );
    await h.pool.query(
      "INSERT INTO workspace_knowledge_versions(knowledge_key,version,state,definition,author_id,submitted_at,submission_rationale,reviewed_by,reviewed_at,review_rationale,provenance_engagement_id,provenance_type,provenance_id) VALUES('linked-guide',1,'published',$2,$1,now(),'Submitted',$1,now(),'Approved',$3,'learning_log','PRIVATE-SOURCE-ID')",
      [
        admin.id,
        {
          key: "linked-guide",
          title: "Linked discovery guide",
          body: "Reviewed guidance",
          sourceRefs: [],
        },
        engagementId,
      ],
    );
    await h.pool.query(
      "INSERT INTO workspace_knowledge_links(id,engagement_id,knowledge_key,knowledge_version,rationale,linked_by) VALUES($1,$2,'linked-guide',1,'Use this reviewed guide',$3)",
      [randomUUID(), engagementId, admin.id],
    );
    const work = new WorkService(h.pool);
    const evidenceItem = (await work.get(admin, engagementId)).items[0]!;
    await work.addEvidence(admin, engagementId, {
      requestKey: randomUUID(),
      itemId: evidenceItem.id,
      title: "Readout evidence metadata",
      fileName: "readout-proof.bin",
      base64: Buffer.from("PRIVATE ATTACHMENT BYTES MUST NOT LEAK").toString(
        "base64",
      ),
    });
    const service = new FinalReadoutService(h.pool);
    await assert.rejects(
      () => service.list(outsider, engagementId),
      AuthorizationError,
    );
    const generated = await service.generate(admin, engagementId, {
      requestKey: randomUUID(),
      title: "Engagement readout",
    });
    assert.equal(generated.state, "draft");
    assert.equal(generated.stale, false);
    assert.ok(Array.isArray(generated.snapshot.openActions));
    const snapshotText = JSON.stringify(generated.snapshot);
    assert.doesNotMatch(
      snapshotText,
      /PRIVATE LEARNER LOG|PRIVATE ASSESSMENT|PRIVATE-SOURCE-ID|PRIVATE ATTACHMENT BYTES/,
    );
    assert.match(
      snapshotText,
      /Cycle time|Delivery practice|Linked discovery guide|Readout evidence metadata|readout-proof.bin/,
    );
    assert.equal(
      (await service.get(member, engagementId, generated.id)).id,
      generated.id,
    );
    const reviewed = await service.review(admin, engagementId, generated.id, {
      requestKey: randomUUID(),
      expectedRevision: 1,
      decision: "approved",
      rationale: "Reviewed against current records",
    });
    assert.equal(reviewed.state, "approved");
    await h.pool.query(
      "INSERT INTO workspace_outcome_observations(id,engagement_id,metric_id,observed_on,value,note,recorded_by) VALUES($1,$2,$3,current_date+1,5,'Later measured result',$4)",
      [randomUUID(), engagementId, metricId, admin.id],
    );
    const stale = await service.get(admin, engagementId, generated.id);
    assert.equal(stale.stale, true);
    assert.equal((stale.snapshot.outcomeObservations as unknown[]).length, 1);
    await assert.rejects(
      () =>
        service.review(admin, engagementId, generated.id, {
          requestKey: randomUUID(),
          expectedRevision: 2,
          decision: "rejected",
          rationale: "Changed",
        }),
      ConflictError,
    );
    const json = await service.export(admin, engagementId, generated.id, {
      format: "json",
    });
    assert.match(json.mediaType, /application\/json/);
    const markdown = await service.export(admin, engagementId, generated.id, {
      format: "markdown",
    });
    assert.match(
      markdown.content,
      /Source: Changed since snapshot — generate a new readout for current work/,
    );
    assert.match(markdown.content, /^## Engagement$/m);
    assert.match(markdown.content, /^## Open actions$/m);
    assert.match(markdown.content, /^## Measured outcomes$/m);
    assert.match(markdown.content, /^## Open obligations$/m);
    assert.doesNotMatch(markdown.content, /^```|"snapshot"\s*:/m);
    await samples.remove(admin, {
      expectedRevision: loaded.revision,
      requestKey: randomUUID(),
      confirmation: "remove-sample-data",
    });
    const count = await h.pool.query<{ count: string }>(
      "SELECT count(*) count FROM workspace_final_readouts",
    );
    assert.equal(count.rows[0]!.count, "0");
  } finally {
    await h.dispose();
  }
});
