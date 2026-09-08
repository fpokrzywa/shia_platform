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
  NotFoundError,
  SampleService,
  TrainingService,
  ValidationError,
} from "../../packages/persistence/src/workspace/index.js";
import { createPostgresHarness } from "./postgres-harness.js";
test("training versions, assignments, evidence, progress and assessments remain isolated and pinned", async () => {
  const h = await createPostgresHarness();
  try {
    await runMigrations(h.pool, await readMigrationFiles("migrations"));
    const admin = { id: randomUUID(), role: "practice_admin" as const },
      learner = { id: randomUUID(), role: "member" as const },
      mentor = { id: randomUUID(), role: "member" as const },
      outsider = { id: randomUUID(), role: "member" as const };
    for (const [id, email, role] of [
      [admin.id, "ta@test", admin.role],
      [learner.id, "tl@test", learner.role],
      [mentor.id, "tm@test", mentor.role],
      [outsider.id, "to@test", outsider.role],
    ])
      await h.pool.query(
        "INSERT INTO app_users(id,email,display_name,password_hash,role) VALUES($1,$2,$2,'x',$3)",
        [id, email, role],
      );
    const service = new TrainingService(h.pool);
    const draft = await service.createDraft(admin, {
      requestKey: randomUUID(),
      key: "field-engineer",
      name: "Field engineer",
      purpose: "Build delivery skill",
      items: [
        {
          key: "read",
          type: "reading",
          title: "Read guide",
          description: "Study",
        },
        {
          key: "practice",
          type: "practical",
          title: "Run pilot",
          description: "Practice",
        },
      ],
    });
    assert.equal((await service.listSets(learner)).length, 0);
    await assert.rejects(
      () => service.getVersion(learner, "field-engineer", 1),
      NotFoundError,
    );
    const corrected: any = await service.updateDraft(
      admin,
      "field-engineer",
      1,
      {
        requestKey: randomUUID(),
        expectedRevision: Number((draft as any).revision),
        name: "Field engineer foundations",
        purpose: "Build delivery skill",
        items: (draft as any).definition.items,
      },
    );
    assert.equal(corrected.definition.name, "Field engineer foundations");
    await assert.rejects(
      () =>
        service.updateDraft(admin, "field-engineer", 1, {
          requestKey: randomUUID(),
          expectedRevision: Number((draft as any).revision),
          name: "Stale",
          purpose: "Stale",
          items: (draft as any).definition.items,
        }),
      ConflictError,
    );
    const published = await service.publish(admin, "field-engineer", 1, {
      requestKey: randomUUID(),
      expectedRevision: Number(corrected.revision),
    });
    assert.equal((await service.listSets(learner)).length, 1);
    assert.equal(
      ((await service.getVersion(learner, "field-engineer", 1)) as any)
        .definition.state,
      "published",
    );
    const revisions: any[] = await Promise.all([
      service.createVersion(admin, "field-engineer", 1, {
        requestKey: randomUUID(),
        expectedRevision: Number((published as any).revision),
        reason: "Alternative revision A",
      }),
      service.createVersion(admin, "field-engineer", 1, {
        requestKey: randomUUID(),
        expectedRevision: Number((published as any).revision),
        reason: "Alternative revision B",
      }),
    ]);
    assert.deepEqual(revisions.map((x) => x.definition.version).sort(), [2, 3]);
    assert.deepEqual(
      revisions.map((x) => x.definition.sourceVersion),
      [1, 1],
    );
    const samples = new SampleService(h.pool);
    const loaded = await samples.load(admin, {
      expectedRevision: 0,
      requestKey: randomUUID(),
      confirmation: "load-sample-data",
    });
    const assignment = await service.assign(admin, {
      requestKey: randomUUID(),
      trainingKey: "field-engineer",
      version: 1,
      learnerUserId: learner.id,
      mentorUserId: mentor.id,
      engagementId: loaded.engagementIds[0],
    });
    const id = String((assignment as any).id);
    await assert.rejects(
      () =>
        service.assess(admin, id, {
          requestKey: randomUUID(),
          expectedRevision: 0,
          result: "needs_development",
          rationale: "Administrative override without confirmation",
        }),
      /explicit administrator assessment override confirmation/i,
    );
    const selfAssessmentId = randomUUID();
    await h.pool.query(
      "INSERT INTO workspace_training_assignments(id,training_key,training_version,learner_user_id,mentor_user_id,assigned_by) VALUES($1,'field-engineer',1,$2,$3,$2)",
      [selfAssessmentId, admin.id, mentor.id],
    );
    await assert.rejects(
      () =>
        service.assess(admin, selfAssessmentId, {
          requestKey: randomUUID(),
          expectedRevision: 0,
          result: "needs_development",
          rationale: "Administrator is also learner",
          adminOverrideConfirmation: "confirm-admin-assessment",
        }),
      AuthorizationError,
    );
    await h.pool.query(
      "DELETE FROM workspace_training_assignments WHERE id=$1",
      [selfAssessmentId],
    );
    await assert.rejects(
      () => service.getAssignment(outsider, id),
      AuthorizationError,
    );
    await assert.rejects(
      () =>
        service.addEvidence(outsider, id, {
          requestKey: randomUUID(),
          title: "Unauthorized evidence",
          url: "https://example.test/unauthorized",
        }),
      AuthorizationError,
    );
    await assert.rejects(
      () =>
        service.updateProgress(mentor, id, "read", {
          requestKey: randomUUID(),
          expectedRevision: 1,
          status: "complete",
        }),
      AuthorizationError,
    );
    await assert.rejects(
      () =>
        service.assess(learner, id, {
          requestKey: randomUUID(),
          expectedRevision: 0,
          result: "needs_development",
          rationale: "Learners cannot assess themselves",
        }),
      AuthorizationError,
    );
    await assert.rejects(
      () =>
        service.assess(mentor, id, {
          requestKey: randomUUID(),
          expectedRevision: 0,
          result: "competent",
          rationale: "Required work is incomplete",
        }),
      ValidationError,
    );
    const detail = await service.getAssignment(learner, id);
    const progress = detail.progress as any[];
    await service.updateProgress(learner, id, "read", {
      requestKey: randomUUID(),
      expectedRevision: Number(
        progress.find((x) => x.item_key === "read").revision,
      ),
      status: "complete",
    });
    await assert.rejects(
      () =>
        service.updateProgress(learner, id, "practice", {
          requestKey: randomUUID(),
          expectedRevision: 1,
          status: "complete",
        }),
      ValidationError,
    );
    const ev = await service.addEvidence(learner, id, {
      requestKey: randomUUID(),
      itemKey: "practice",
      title: "Pilot evidence",
      fileName: "proof.txt",
      base64: Buffer.from("proof").toString("base64"),
    });
    await service.updateProgress(learner, id, "practice", {
      requestKey: randomUUID(),
      expectedRevision: 1,
      status: "complete",
      trainingEvidenceId: String((ev as any).id),
    });
    const assessment = await service.assess(mentor, id, {
      requestKey: randomUUID(),
      expectedRevision: 0,
      result: "competent",
      rationale: "Observed delivery",
    });
    assert.equal((assessment as any).result, "competent");
    await assert.rejects(
      () =>
        service.assess(mentor, id, {
          requestKey: randomUUID(),
          expectedRevision: 0,
          result: "competent",
          rationale: "Again",
        }),
      ConflictError,
    );
    await service.updateProgress(learner, id, "practice", {
      requestKey: randomUUID(),
      expectedRevision: 2,
      status: "in_progress",
    });
    assert.equal(
      ((await service.getAssignment(mentor, id)).assessments as any[])[0].stale,
      true,
    );
    const globalAssignment = await service.assign(admin, {
      requestKey: randomUUID(),
      trainingKey: "field-engineer",
      version: 1,
      learnerUserId: outsider.id,
      mentorUserId: mentor.id,
    });
    await assert.rejects(
      () =>
        service.updateProgress(
          outsider,
          String((globalAssignment as any).id),
          "practice",
          {
            requestKey: randomUUID(),
            expectedRevision: 1,
            status: "complete",
            trainingEvidenceId: String((ev as any).id),
          },
        ),
      /does not belong to this assignment/i,
    );
    await samples.remove(admin, {
      expectedRevision: loaded.revision,
      requestKey: randomUUID(),
      confirmation: "remove-sample-data",
    });
    const remaining = await service.getAssignments(admin);
    assert.equal(remaining.length, 1);
    assert.equal(
      String((remaining[0] as any).id),
      String((globalAssignment as any).id),
    );
    assert.equal(
      ((await service.getVersion(admin, "field-engineer", 1)) as any).definition
        .state,
      "published",
    );
  } finally {
    await h.dispose();
  }
});
