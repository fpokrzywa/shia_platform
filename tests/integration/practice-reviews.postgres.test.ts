import assert from "node:assert/strict";
import { randomUUID } from "node:crypto";
import test from "node:test";
import { createSession } from "../../apps/api/src/auth/sessions.js";
import { practiceRequest } from "../../apps/api/src/practice-http.js";
import { practiceReferenceContent } from "../../apps/api/src/practice-reference-content.js";
import { createApiServer } from "../../apps/api/src/server.js";
import {
  readMigrationFiles,
  runMigrations,
} from "../../packages/persistence/src/migrations.js";
import {
  AuthorizationError,
  ConflictError,
  PracticeReviewService,
  TrainingService,
  ValidationError,
} from "../../packages/persistence/src/workspace/index.js";
import { createPostgresHarness } from "./postgres-harness.js";

test("practice plans and private reviewer references stay separated and versioned", async () => {
  const h = await createPostgresHarness();
  try {
    await runMigrations(h.pool, await readMigrationFiles("migrations"));
    const admin = { id: randomUUID(), role: "practice_admin" as const },
      learner = { id: randomUUID(), role: "member" as const },
      mentor = { id: randomUUID(), role: "member" as const },
      outsider = { id: randomUUID(), role: "member" as const },
      adminLearner = { id: randomUUID(), role: "practice_admin" as const };
    for (const [id, email, role] of [
      [admin.id, "pra@test", admin.role],
      [learner.id, "prl@test", learner.role],
      [mentor.id, "prm@test", mentor.role],
      [outsider.id, "pro@test", outsider.role],
      [adminLearner.id, "pral@test", adminLearner.role],
    ])
      await h.pool.query(
        "INSERT INTO app_users(id,email,display_name,password_hash,role) VALUES($1,$2,$2,'x',$3)",
        [id, email, role],
      );
    const definition = {
      key: "fictional-case",
      version: 1,
      state: "published",
      name: "Fictional operations case",
      purpose: "Discover a problem worth solving",
      items: [],
      practiceCase: {
        businessProblem: "A fictional company has fragmented operational data.",
        audience: "New field engineer",
        constraints: [],
        deliverables: [],
        assessmentCriteria: [],
        datasets: [
          {
            key: "events",
            fileName: "events.csv",
            description: "Fictional events",
            csv: "id,status\n1,open",
          },
        ],
        references: [],
      },
    };
    await h.pool.query(
      "INSERT INTO workspace_training_sets(training_key,name,purpose,created_by) VALUES($1,$2,$3,$4)",
      [definition.key, definition.name, definition.purpose, admin.id],
    );
    await h.pool.query(
      "INSERT INTO workspace_training_versions(training_key,version,state,definition,published_by,published_at) VALUES($1,1,'published',$2,$3,now())",
      [definition.key, definition, admin.id],
    );
    const service = new PracticeReviewService(h.pool);
    const draft: any = await service.createDraft(admin, {
      trainingKey: definition.key,
      trainingVersion: 1,
      expectedApproach:
        "PRIVATE: evaluate problem selection and reasoning, not one prescribed solution",
      checks: ["Reasoning uses the supplied fictional data"],
      pitfalls: ["Jumping to a tool before defining value"],
      acceptableAlternatives: ["Any defensible problem and Palantir build"],
      rubric: [
        {
          criterion: "problem-framing",
          description: "Frames a valuable, evidence-based problem",
        },
      ],
      requestKey: randomUUID(),
    });
    await assert.rejects(
      () =>
        service.createDraft(learner, {
          trainingKey: definition.key,
          trainingVersion: 1,
          expectedApproach: "leak",
          checks: [],
          pitfalls: [],
          acceptableAlternatives: [],
          rubric: [{ criterion: "x", description: "x" }],
          requestKey: randomUUID(),
        }),
      AuthorizationError,
    );
    const reference: any = await service.publish(admin, draft.id, {
      expectedRevision: 1,
      requestKey: randomUUID(),
      rationale:
        "Reviewed as a flexible mentor guide; alternatives are explicitly accepted.",
      confirmation: "publish-reviewer-reference",
    });
    await assert.rejects(() =>
      h.pool.query(
        "UPDATE workspace_practice_review_references SET expected_approach='changed' WHERE id=$1",
        [reference.id],
      ),
    );
    const training = new TrainingService(h.pool);
    assert.equal(
      JSON.stringify(
        await training.getVersion(learner, definition.key, 1),
      ).includes("PRIVATE:"),
      false,
    );
    const startKey = randomUUID();
    const assignment: any = await service.selfStart(learner, {
      trainingKey: definition.key,
      version: 1,
      requestKey: startKey,
    });
    assert.equal(assignment.mentorUserId, null);
    assert.equal(
      (
        (await service.selfStart(learner, {
          trainingKey: definition.key,
          version: 1,
          requestKey: startKey,
        })) as any
      ).id,
      assignment.id,
    );
    assert.equal(
      JSON.stringify(
        await training.getAssignment(learner, assignment.id),
      ).includes("PRIVATE:"),
      false,
    );
    const named: any = await training.getAssignment(learner, assignment.id);
    assert.equal(named.assignment.learner_display_name, "prl@test");
    await assert.rejects(
      () => training.getAssignment(outsider, assignment.id),
      AuthorizationError,
    );
    assert.equal((await training.getAssignments(outsider)).length, 0);
    await assert.rejects(
      () =>
        training.assess(admin, assignment.id, {
          requestKey: randomUUID(),
          expectedRevision: 0,
          result: "competent",
          rationale:
            "Generic assessment must not bypass the protected practice review.",
          adminOverrideConfirmation: "confirm-admin-assessment",
        }),
      ValidationError,
    );
    assert.equal(
      Number(
        (
          await h.pool.query(
            "SELECT count(*) count FROM workspace_mentor_assessments WHERE assignment_id=$1",
            [assignment.id],
          )
        ).rows[0].count,
      ),
      0,
    );
    await assert.rejects(
      () => service.getForAssignment(learner, assignment.id),
      AuthorizationError,
    );
    await assert.rejects(
      () => service.getForAssignment(outsider, assignment.id),
      AuthorizationError,
    );
    assert.equal(
      ((await service.getForAssignment(admin, assignment.id)) as any).id,
      reference.id,
    );
    await assert.rejects(
      () =>
        service.setMentor(learner, assignment.id, {
          mentorUserId: mentor.id,
          expectedRevision: 1,
          requestKey: randomUUID(),
        }),
      AuthorizationError,
    );
    const assigned: any = await service.setMentor(admin, assignment.id, {
      mentorUserId: mentor.id,
      expectedRevision: 1,
      requestKey: randomUUID(),
    });
    assert.equal(assigned.revision, "2");
    await assert.rejects(
      () =>
        service.setMentor(admin, assignment.id, {
          mentorUserId: outsider.id,
          expectedRevision: 1,
          requestKey: randomUUID(),
        }),
      ConflictError,
    );
    assert.equal(
      (
        (await service.getForAssignment(mentor, assignment.id)) as any
      ).expected_approach.startsWith("PRIVATE:"),
      true,
    );
    const plan: any = await service.submitProposal(learner, assignment.id, {
      selectedProblem: "Reduce avoidable delayed orders",
      rationale: "The event data indicates repeated open-state aging",
      questions: ["Which delays affect priority customers?"],
      proposedApproach: "Model event flow and investigate bottlenecks",
      proposedDeliverables: ["An operational view chosen after exploration"],
      successCriteria: ["Fewer aged priority orders"],
      requestKey: randomUUID(),
    });
    await assert.rejects(
      () =>
        service.submitProposal(mentor, assignment.id, {
          selectedProblem: "Override",
          rationale: "Not learner authored",
          questions: [],
          proposedApproach: "x",
          proposedDeliverables: ["x"],
          successCriteria: ["x"],
          requestKey: randomUUID(),
        }),
      AuthorizationError,
    );
    const comparison: any = await service.compare(mentor, assignment.id, {
      referenceId: reference.id,
      proposalId: plan.id,
      criteria: [
        {
          criterion: "problem-framing",
          result: "met",
          feedback: "The reasoning ties the selected problem to observed data.",
          validAlternativeNote:
            "A capacity-focused problem would also be valid with evidence.",
        },
      ],
      overallFeedback: "Proceed and validate the assumptions.",
      requestKey: randomUUID(),
    });
    const feedback: any[] = await service.getFeedback(learner, assignment.id);
    assert.equal(feedback[0].proposal_id, plan.id);
    assert.equal(feedback[0].stale, false);
    assert.equal(JSON.stringify(feedback).includes("PRIVATE:"), false);
    assert.equal(JSON.stringify(feedback).includes("expected_approach"), false);
    assert.equal(JSON.stringify(feedback).includes(reference.id), false);
    const next: any = await service.submitProposal(learner, assignment.id, {
      selectedProblem: "Improve priority order routing",
      rationale: "Further analysis changed the focus",
      questions: ["Which route is unstable?"],
      proposedApproach: "Compare route cohorts",
      proposedDeliverables: ["A learner-defined routing workflow"],
      successCriteria: ["Reduced route variance"],
      requestKey: randomUUID(),
    });
    assert.equal(next.proposal_version, 2);
    assert.equal(
      ((await service.getFeedback(learner, assignment.id)) as any[])[0].stale,
      true,
    );
    await assert.rejects(() =>
      h.pool.query("DELETE FROM workspace_practice_proposals WHERE id=$1", [
        plan.id,
      ]),
    );
    await assert.rejects(() =>
      h.pool.query(
        "UPDATE workspace_practice_comparisons SET overall_feedback='changed' WHERE id=$1",
        [comparison.id],
      ),
    );
    await assert.rejects(
      () =>
        service.compare(mentor, assignment.id, {
          referenceId: reference.id,
          proposalId: randomUUID(),
          criteria: [
            { criterion: "problem-framing", result: "met", feedback: "x" },
          ],
          overallFeedback: "x",
          requestKey: randomUUID(),
        }),
      ValidationError,
    );
    assert.equal(
      Number(
        (
          await h.pool.query(
            "SELECT count(*) count FROM workspace_practice_comparisons WHERE assignment_id=$1",
            [assignment.id],
          )
        ).rows[0].count,
      ),
      1,
    );
    assert.equal(
      Number(
        (
          await h.pool.query(
            "SELECT count(*) count FROM workspace_audit_events WHERE action LIKE 'practice_%'",
          )
        ).rows[0].count,
      ) >= 6,
      true,
    );
    const self: any = await service.selfStart(adminLearner, {
      trainingKey: definition.key,
      version: 1,
      requestKey: randomUUID(),
    });
    await assert.rejects(
      () => service.getForAssignment(adminLearner, self.id),
      AuthorizationError,
    );
    const catalog: any = await practiceRequest(
      h.pool,
      learner,
      "/api/practice/cases",
      "GET",
      {},
    );
    assert.equal(catalog.status, 200);
    assert.equal(catalog.body.cases.length >= 2, true);
    assert.equal(JSON.stringify(catalog).includes('"csv"'), false);
    const download: any = await practiceRequest(
      h.pool,
      learner,
      "/api/practice/training/fictional-case/1/datasets/events/download",
      "GET",
      {},
    );
    assert.equal(download.download.fileName, "events.csv");
    assert.equal(download.download.data.toString("utf8"), "id,status\n1,open");
    await assert.rejects(
      () =>
        practiceRequest(
          h.pool,
          learner,
          `/api/practice/assignments/${assignment.id}/reference`,
          "GET",
          {},
        ),
      AuthorizationError,
    );
    if (Object.keys(practiceReferenceContent).length > 0) {
      const imported: any = await practiceRequest(
      h.pool,
      admin,
      `/api/practice/cases/${catalog.body.cases[0].key}/import`,
      "POST",
      { requestKey: randomUUID() },
    );
    assert.equal(imported.status, 201);
    assert.equal(imported.body.version.definition.items.length, 0);
    assert.deepEqual(
      Object.keys(practiceReferenceContent).sort(),
      catalog.body.cases.map((value: any) => value.key).sort(),
    );
      const builtInKey = catalog.body.cases[0].key;
      await training.publish(admin, builtInKey, 1, {
      requestKey: randomUUID(),
      expectedRevision: Number(imported.body.version.revision),
    });
    const guide: any = await practiceRequest(
      h.pool,
      admin,
      `/api/practice/cases/${builtInKey}/reviewer-draft/import`,
      "POST",
      { trainingVersion: 1, requestKey: randomUUID() },
    );
    assert.equal(guide.status, 201);
    assert.equal(guide.body.reference.state, "draft");
    assert.equal(
      JSON.stringify(catalog).includes(guide.body.reference.expected_approach),
      false,
    );
    await service.selfStart(adminLearner, {
      trainingKey: builtInKey,
      version: 1,
      requestKey: randomUUID(),
    });
      await assert.rejects(
      () =>
        practiceRequest(
          h.pool,
          adminLearner,
          `/api/practice/cases/${builtInKey}/reviewer-draft/import`,
          "POST",
          { trainingVersion: 1, requestKey: randomUUID() },
        ),
        AuthorizationError,
      );
    }
    const session = await createSession(h.pool, learner.id),
      adminSession = await createSession(h.pool, admin.id),
      server = createApiServer({ pool: h.pool });
    await new Promise<void>((resolve) =>
      server.listen(0, "127.0.0.1", resolve),
    );
    const address = server.address();
    assert(address && typeof address !== "string");
    const origin = `http://127.0.0.1:${address.port}`,
      headers = { cookie: `shi_session=${session.token}` };
    try {
      const actualDownload = await fetch(
        `${origin}/api/practice/training/fictional-case/1/datasets/events/download`,
        { headers },
      );
      assert.equal(actualDownload.status, 200);
      assert.match(
        actualDownload.headers.get("content-disposition") ?? "",
        /^attachment;/,
      );
      assert.equal(await actualDownload.text(), "id,status\n1,open");
      assert.equal(
        (
          await fetch(
            `${origin}/api/practice/assignments/${assignment.id}/reference`,
            { headers },
          )
        ).status,
        403,
      );
      const caseBody = (key: string, csv: string) => ({
        requestKey: randomUUID(),
        key,
        name: "Large fictional case",
        purpose: "Exercise request size boundaries",
        items: [],
        practiceCase: {
          businessProblem:
            "A fictional company supplied a larger extract for open investigation.",
          audience: "New FTE",
          constraints: ["Use fictional data only."],
          references: [],
          datasets: [
            {
              key: "records",
              fileName: "records.csv",
              description: "Fictional records",
              csv,
            },
          ],
        },
      });
      const adminHeaders = {
        cookie: `shi_session=${adminSession.token}`,
        origin,
        "content-type": "application/json",
      };
      assert.equal(
        (
          await fetch(`${origin}/api/training/sets`, {
            method: "POST",
            headers: adminHeaders,
            body: JSON.stringify(
              caseBody("large-http-case", "column\n" + "a".repeat(120000)),
            ),
          })
        ).status,
        201,
      );
      assert.equal(
        (
          await fetch(`${origin}/api/training/sets`, {
            method: "POST",
            headers: adminHeaders,
            body: JSON.stringify(
              caseBody("oversize-http-case", "column\n" + "é".repeat(1050000)),
            ),
          })
        ).status,
        422,
      );
      assert.equal(
        Number(
          (
            await h.pool.query(
              "SELECT count(*) count FROM workspace_training_sets WHERE training_key='oversize-http-case'",
            )
          ).rows[0].count,
        ),
        0,
      );
      assert.equal(
        (
          await fetch(`${origin}/api/practice/cases/%ZZ/import`, {
            method: "POST",
            headers: { ...headers, origin, "content-type": "application/json" },
            body: JSON.stringify({ requestKey: randomUUID() }),
          })
        ).status,
        422,
      );
      assert.equal(
        (
          await fetch(`${origin}/api/practice/self-start`, {
            method: "POST",
            headers: {
              ...headers,
              origin: "https://evil.example",
              "content-type": "application/json",
            },
            body: "{}",
          })
        ).status,
        403,
      );
    } finally {
      await new Promise<void>((resolve) => server.close(() => resolve()));
    }
  } finally {
    await h.dispose();
  }
});
