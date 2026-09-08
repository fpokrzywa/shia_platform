import assert from "node:assert/strict";
import { randomUUID } from "node:crypto";
import test from "node:test";
import type { TemplateVersionDefinition } from "../../packages/domain/src/templates/index.js";
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
  ReadinessService,
  SampleService,
  TemplateService,
  ValidationError,
  WorkService,
} from "../../packages/persistence/src/workspace/index.js";
import { createPostgresHarness } from "./postgres-harness.js";

const readinessTemplate: TemplateVersionDefinition = {
  templateKey: "readiness-integration",
  version: 1,
  state: "draft",
  name: "Readiness integration",
  purpose: "Exercise hard, waivable, evidence, and dependency readiness rules.",
  roles: [
    { key: "shi-engagement-lead", name: "Engagement lead" },
    { key: "shi-technical-lead", name: "Technical lead" },
  ],
  stages: [
    {
      key: "preparation",
      name: "Preparation",
      accountableRoleKey: "shi-engagement-lead",
      dependsOn: [],
      checklistItemKeys: ["hard-item", "waivable-item"],
    },
    {
      key: "delivery",
      name: "Delivery",
      accountableRoleKey: "shi-technical-lead",
      dependsOn: ["preparation"],
      checklistItemKeys: ["delivery-item"],
    },
  ],
  checklistItems: [
    {
      key: "hard-item",
      stageKey: "preparation",
      name: "Hard item",
      ownerRoleKey: "shi-engagement-lead",
      required: true,
      dependsOn: [],
      evidenceRequirementKeys: ["hard-proof"],
    },
    {
      key: "waivable-item",
      stageKey: "preparation",
      name: "Waivable item",
      ownerRoleKey: "shi-engagement-lead",
      required: true,
      dependsOn: ["hard-item"],
    },
    {
      key: "delivery-item",
      stageKey: "delivery",
      name: "Delivery item",
      ownerRoleKey: "shi-technical-lead",
      required: true,
      dependsOn: ["hard-item"],
    },
  ],
  evidenceRequirements: [{ key: "hard-proof", name: "Hard proof" }],
  gateRules: [
    { type: "hard-prerequisite", itemKey: "hard-item" },
    {
      type: "waivable-prerequisite",
      itemKey: "waivable-item",
      exceptionOwnerRoleKey: "shi-engagement-lead",
    },
    { type: "stage-complete", stageKey: "preparation" },
  ],
};

test("readiness decisions enforce current evidence, roles, dependencies, exceptions, and immutable history", async () => {
  const harness = await createPostgresHarness();
  try {
    await runMigrations(harness.pool, await readMigrationFiles("migrations"));
    const admin = { id: randomUUID(), role: "practice_admin" as const };
    const lead = { id: randomUUID(), role: "member" as const };
    const technical = { id: randomUUID(), role: "member" as const };
    const reviewer = { id: randomUUID(), role: "member" as const };
    const outsider = { id: randomUUID(), role: "member" as const };
    for (const [id, email, role] of [
      [admin.id, "ready-admin@example.test", admin.role],
      [lead.id, "ready-lead@example.test", lead.role],
      [technical.id, "ready-tech@example.test", technical.role],
      [reviewer.id, "ready-reviewer@example.test", reviewer.role],
      [outsider.id, "ready-outsider@example.test", outsider.role],
    ]) {
      await harness.pool.query(
        "INSERT INTO app_users(id,email,display_name,password_hash,role) VALUES($1,$2,$3,$4,$5)",
        [id, email, email, "unused", role],
      );
    }
    const templates = new TemplateService(harness.pool);
    const engagements = new EngagementService(harness.pool);
    const memberships = new MembershipService(harness.pool);
    const work = new WorkService(harness.pool);
    const readiness = new ReadinessService(harness.pool);
    await templates.importDraft(admin, {
      definition: readinessTemplate,
      requestKey: randomUUID(),
    });
    await templates.publish(admin, {
      templateKey: readinessTemplate.templateKey,
      version: 1,
      expectedRevision: 1,
      requestKey: randomUUID(),
    });
    const client = await engagements.createClient(admin, {
      name: "Readiness Client",
      requestKey: randomUUID(),
    });
    const engagement = await engagements.createEngagement(admin, {
      clientId: client.id,
      templateKey: readinessTemplate.templateKey,
      templateVersion: 1,
      title: "Readiness Engagement",
      leadUserId: lead.id,
      requestKey: randomUUID(),
    });
    await memberships.add(admin, {
      engagementId: engagement.id,
      userId: technical.id,
      role: "technical_lead",
      expectedRevision: 1,
      requestKey: randomUUID(),
    });
    await memberships.add(admin, {
      engagementId: engagement.id,
      userId: reviewer.id,
      role: "reviewer",
      expectedRevision: 2,
      requestKey: randomUUID(),
    });

    await assert.rejects(
      () => readiness.get(outsider, engagement.id),
      AuthorizationError,
    );
    const leadView = await readiness.get(lead, engagement.id);
    const reviewerView = await readiness.get(reviewer, engagement.id);
    const adminView = await readiness.get(admin, engagement.id);
    const preparation = leadView.stages.find(
      (stage) => stage.definitionKey === "preparation",
    )!;
    const delivery = leadView.stages.find(
      (stage) => stage.definitionKey === "delivery",
    )!;
    assert.equal(preparation.canReview, true);
    assert.equal(
      reviewerView.stages.find((stage) => stage.stageId === preparation.stageId)
        ?.canReview,
      true,
    );
    assert.equal(
      adminView.stages.find((stage) => stage.stageId === preparation.stageId)
        ?.canReview,
      true,
    );
    assert.equal(
      delivery.blockers.some(
        (blocker) => blocker.reason === "dependency_not_approved",
      ),
      true,
    );
    assert.equal(
      preparation.blockers.some((blocker) => blocker.itemKey === "preparation"),
      false,
    );

    const workState = await work.get(lead, engagement.id);
    const hard = workState.items.find((item) =>
      item.evidenceRequirementKeys.includes("hard-proof"),
    )!;
    const waivable = workState.items.find(
      (item) => item.name === "Waivable item",
    )!;
    const deliveryItem = workState.items.find(
      (item) => item.name === "Delivery item",
    )!;
    await assert.rejects(
      () =>
        work.updateItem(lead, engagement.id, hard.id, {
          expectedRevision: hard.revision,
          requestKey: randomUUID(),
          status: "complete",
        }),
      /evidence requirements/i,
    );
    await work.addEvidence(lead, engagement.id, {
      requestKey: randomUUID(),
      itemId: hard.id,
      title: "Unclassified proof",
      url: "https://example.test/unclassified",
    });
    await assert.rejects(
      () =>
        work.updateItem(lead, engagement.id, hard.id, {
          expectedRevision: hard.revision,
          requestKey: randomUUID(),
          status: "complete",
        }),
      /evidence requirements/i,
    );

    const tokenBeforeEvidence = (
      await readiness.get(lead, engagement.id)
    ).stages.find((stage) => stage.stageId === preparation.stageId)!.token;
    await work.addEvidence(lead, engagement.id, {
      requestKey: randomUUID(),
      itemId: hard.id,
      title: "Classified proof",
      evidenceRequirementKey: "hard-proof",
      url: "https://example.test/classified",
    });
    const afterEvidence = (
      await readiness.get(lead, engagement.id)
    ).stages.find((stage) => stage.stageId === preparation.stageId)!;
    assert.notEqual(afterEvidence.token, tokenBeforeEvidence);
    await assert.rejects(
      () =>
        readiness.decide(lead, engagement.id, preparation.stageId, {
          requestKey: randomUUID(),
          expectedToken: tokenBeforeEvidence,
          decision: "no_go",
          rationale: "Stale evidence preview",
        }),
      ConflictError,
    );
    const completedHard = await work.updateItem(lead, engagement.id, hard.id, {
      expectedRevision: hard.revision,
      requestKey: randomUUID(),
      status: "complete",
    });
    assert.equal(completedHard.status, "complete");
    const afterItem = (await readiness.get(lead, engagement.id)).stages.find(
      (stage) => stage.stageId === preparation.stageId,
    )!;
    assert.notEqual(afterItem.token, afterEvidence.token);
    await assert.rejects(
      () =>
        readiness.decide(lead, engagement.id, preparation.stageId, {
          requestKey: randomUUID(),
          expectedToken: afterEvidence.token,
          decision: "no_go",
          rationale: "Stale item preview",
        }),
      ConflictError,
    );
    await assert.rejects(
      () =>
        readiness.reviewNotApplicable(reviewer, engagement.id, hard.id, {
          requestKey: randomUUID(),
          expectedToken: afterItem.token,
          rationale: "Hard items cannot be waived",
        }),
      /cannot be marked not applicable/i,
    );

    const future = new Date(Date.now() + 7 * 86_400_000)
      .toISOString()
      .slice(0, 10);
    const conditionalInput = {
      requestKey: randomUUID(),
      expectedToken: afterItem.token,
      decision: "conditional_go",
      rationale: "Proceed with an accountable exception",
      exceptions: [
        {
          itemId: waivable.id,
          ownerUserId: lead.id,
          dueDate: future,
          rationale: "Lead will resolve the remaining item",
        },
      ],
    };
    await assert.rejects(
      () =>
        readiness.decide(reviewer, engagement.id, preparation.stageId, {
          ...conditionalInput,
          requestKey: randomUUID(),
          exceptions: [
            { ...conditionalInput.exceptions[0]!, ownerUserId: technical.id },
          ],
        }),
      /required engagement role/i,
    );
    await assert.rejects(
      () =>
        readiness.decide(reviewer, engagement.id, preparation.stageId, {
          ...conditionalInput,
          requestKey: randomUUID(),
          exceptions: [
            { ...conditionalInput.exceptions[0]!, dueDate: "2020-01-01" },
          ],
        }),
      /future/i,
    );
    const conditional = await readiness.decide(
      reviewer,
      engagement.id,
      preparation.stageId,
      conditionalInput,
    );
    assert.equal(conditional.latestDecision?.decision, "conditional_go");
    assert.equal(conditional.latestDecision?.effective, true);
    assert.equal(
      conditional.latestDecision?.exceptions[0]?.ownerUserId,
      lead.id,
    );
    assert.equal(conditional.latestDecision?.exceptions[0]?.dueDate, future);
    assert.deepEqual(
      await readiness.decide(
        reviewer,
        engagement.id,
        preparation.stageId,
        conditionalInput,
      ),
      conditional,
    );
    await assert.rejects(
      () =>
        readiness.decide(reviewer, engagement.id, preparation.stageId, {
          ...conditionalInput,
          requestKey: randomUUID(),
        }),
      ConflictError,
    );

    const reopenedConditional = await readiness.reopen(
      reviewer,
      engagement.id,
      preparation.stageId,
      {
        requestKey: randomUUID(),
        expectedToken: conditional.token,
        rationale: "Reopen to review remaining applicability",
      },
    );
    const notApplicable = await readiness.reviewNotApplicable(
      reviewer,
      engagement.id,
      waivable.id,
      {
        requestKey: randomUUID(),
        expectedToken: reopenedConditional.token,
        rationale: "Reviewed as not applicable for this engagement",
      },
    );
    assert.equal(notApplicable.latestDecision?.effective, false);
    assert.equal(
      (await work.get(reviewer, engagement.id)).items.find(
        (item) => item.id === waivable.id,
      )?.status,
      "not_applicable",
    );
    assert.notEqual(notApplicable.token, conditional.token);
    await assert.rejects(
      () =>
        readiness.decide(reviewer, engagement.id, preparation.stageId, {
          requestKey: randomUUID(),
          expectedToken: conditional.token,
          decision: "go",
          rationale: "Stale after not-applicable review",
        }),
      ConflictError,
    );
    const go = await readiness.decide(
      reviewer,
      engagement.id,
      preparation.stageId,
      {
        requestKey: randomUUID(),
        expectedToken: notApplicable.token,
        decision: "go",
        rationale: "All current readiness requirements are resolved",
      },
    );
    assert.equal(go.latestDecision?.decision, "go");
    assert.equal(go.latestDecision?.effective, true);
    const deliveryAfterGo = (
      await readiness.get(technical, engagement.id)
    ).stages.find((stage) => stage.stageId === delivery.stageId)!;
    assert.equal(
      deliveryAfterGo.blockers.some(
        (blocker) => blocker.reason === "dependency_not_approved",
      ),
      false,
    );
    await work.updateItem(technical, engagement.id, deliveryItem.id, {
      expectedRevision: deliveryItem.revision,
      requestKey: randomUUID(),
      status: "complete",
    });
    const readyDelivery = (
      await readiness.get(technical, engagement.id)
    ).stages.find((stage) => stage.stageId === delivery.stageId)!;
    const deliveryGo = await readiness.decide(
      technical,
      engagement.id,
      delivery.stageId,
      {
        requestKey: randomUUID(),
        expectedToken: readyDelivery.token,
        decision: "go",
        rationale: "Delivery requirements are complete",
      },
    );
    assert.equal(deliveryGo.latestDecision?.effective, true);

    const reopened = await readiness.reopen(
      reviewer,
      engagement.id,
      preparation.stageId,
      {
        requestKey: randomUUID(),
        expectedToken: go.token,
        rationale: "New information requires another review",
      },
    );
    assert.equal(reopened.latestDecision?.effective, false);
    const deliveryAfterReopen = (
      await readiness.get(technical, engagement.id)
    ).stages.find((stage) => stage.stageId === delivery.stageId)!;
    assert.equal(
      deliveryAfterReopen.blockers.some(
        (blocker) => blocker.reason === "dependency_not_approved",
      ),
      true,
    );
    assert.equal(deliveryAfterReopen.latestDecision?.effective, false);
    const noGo = await readiness.decide(
      admin,
      engagement.id,
      preparation.stageId,
      {
        requestKey: randomUUID(),
        expectedToken: reopened.token,
        decision: "no_go",
        rationale: "Administrator override records a deliberate pause",
      },
    );
    assert.equal(noGo.latestDecision?.decision, "no_go");
    assert.equal(noGo.latestDecision?.effective, true);
    const goAgain = await readiness.decide(
      lead,
      engagement.id,
      preparation.stageId,
      {
        requestKey: randomUUID(),
        expectedToken: noGo.token,
        decision: "go",
        rationale: "Accountable lead confirms readiness again",
      },
    );
    assert.equal(
      goAgain.history.some((entry) => entry.decision === "conditional_go"),
      true,
    );
    assert.equal(
      goAgain.history.some((entry) => entry.decision === "no_go"),
      true,
    );
    assert.equal(
      goAgain.history.filter((entry) => entry.decision === "reopen").length,
      2,
    );
    assert.equal(
      goAgain.history.filter((entry) => entry.decision === "go").length,
      2,
    );
    assert.equal(
      (
        await harness.pool.query(
          "SELECT 1 FROM workspace_audit_events WHERE engagement_id=$1 AND action='readiness.reopen'",
          [engagement.id],
        )
      ).rows.length,
      2,
    );
    assert.equal(
      (
        await harness.pool.query(
          "SELECT 1 FROM workspace_audit_events WHERE engagement_id=$1 AND action='readiness.decide' AND details->>'adminOverride'='true'",
          [engagement.id],
        )
      ).rows.length,
      1,
    );

    const reviewerRemovalRevision = Number(
      (
        await harness.pool.query<{ revision: string }>(
          "SELECT revision FROM workspace_engagements WHERE id=$1",
          [engagement.id],
        )
      ).rows[0]!.revision,
    );
    await memberships.remove(admin, {
      engagementId: engagement.id,
      userId: reviewer.id,
      role: "reviewer",
      expectedRevision: reviewerRemovalRevision,
      requestKey: randomUUID(),
    });
    await assert.rejects(
      () =>
        readiness.decide(
          reviewer,
          engagement.id,
          preparation.stageId,
          conditionalInput,
        ),
      AuthorizationError,
    );

    const other = await engagements.createEngagement(admin, {
      clientId: client.id,
      templateKey: readinessTemplate.templateKey,
      templateVersion: 1,
      title: "Other Engagement",
      leadUserId: lead.id,
      requestKey: randomUUID(),
    });
    const otherReadiness = await readiness.get(lead, other.id);
    const otherWork = await work.get(lead, other.id);
    await assert.rejects(
      () =>
        readiness.decide(
          lead,
          engagement.id,
          otherReadiness.stages[0]!.stageId,
          {
            requestKey: randomUUID(),
            expectedToken: otherReadiness.stages[0]!.token,
            decision: "no_go",
            rationale: "Cross engagement stage",
          },
        ),
      NotFoundError,
    );
    await assert.rejects(
      () =>
        readiness.reviewNotApplicable(
          lead,
          engagement.id,
          otherWork.items[0]!.id,
          {
            requestKey: randomUUID(),
            expectedToken: goAgain.token,
            rationale: "Cross engagement item",
          },
        ),
      NotFoundError,
    );

    await harness.pool.query(
      `CREATE FUNCTION fail_readiness_audit() RETURNS trigger AS $$ BEGIN IF NEW.action='readiness.decide' THEN RAISE EXCEPTION 'injected readiness audit failure'; END IF; RETURN NEW; END; $$ LANGUAGE plpgsql`,
    );
    await harness.pool.query(
      "CREATE TRIGGER fail_readiness_audit_trigger BEFORE INSERT ON workspace_audit_events FOR EACH ROW EXECUTE FUNCTION fail_readiness_audit()",
    );
    const rollbackKey = randomUUID();
    const decisionCount = (
      await harness.pool.query<{ count: string }>(
        "SELECT count(*)::text count FROM workspace_readiness_decisions",
      )
    ).rows[0]!.count;
    const stageBefore = await harness.pool.query<{
      state: string;
      revision: string;
    }>("SELECT state,revision FROM workspace_stage_instances WHERE id=$1", [
      otherReadiness.stages[0]!.stageId,
    ]);
    await assert.rejects(
      () =>
        readiness.decide(admin, other.id, otherReadiness.stages[0]!.stageId, {
          requestKey: rollbackKey,
          expectedToken: otherReadiness.stages[0]!.token,
          decision: "no_go",
          rationale: "Must roll back atomically",
        }),
      /injected readiness audit failure/i,
    );
    assert.equal(
      (
        await harness.pool.query<{ count: string }>(
          "SELECT count(*)::text count FROM workspace_readiness_decisions",
        )
      ).rows[0]!.count,
      decisionCount,
    );
    assert.deepEqual(
      (
        await harness.pool.query<{ state: string; revision: string }>(
          "SELECT state,revision FROM workspace_stage_instances WHERE id=$1",
          [otherReadiness.stages[0]!.stageId],
        )
      ).rows,
      stageBefore.rows,
    );
    assert.equal(
      (
        await harness.pool.query(
          "SELECT 1 FROM workspace_action_requests WHERE actor_id=$1 AND action='readiness.decide' AND request_key=$2",
          [admin.id, rollbackKey],
        )
      ).rows.length,
      0,
    );
    await harness.pool.query(
      "DROP TRIGGER fail_readiness_audit_trigger ON workspace_audit_events",
    );
    await harness.pool.query("DROP FUNCTION fail_readiness_audit()");

    const samples = new SampleService(harness.pool);
    const loadedSamples = await samples.load(admin, {
      expectedRevision: 0,
      requestKey: randomUUID(),
      confirmation: "load-sample-data",
    });
    const apprenticeship = (
      await harness.pool.query<{ id: string }>(
        "SELECT id FROM workspace_engagements WHERE id=ANY($1::text[]) AND title LIKE '%apprenticeship%'",
        [loadedSamples.engagementIds],
      )
    ).rows[0]!;
    const sampleWork = await work.get(admin, apprenticeship.id);
    let sampleReadiness = await readiness.get(admin, apprenticeship.id);
    const sampleStageId = sampleReadiness.stages.find((stage) =>
      stage.waivableItems.some((item) => item.name === "Stakeholder map"),
    )!.stageId;
    for (const itemId of new Set(
      sampleReadiness.stages
        .find((stage) => stage.stageId === sampleStageId)!
        .blockers.filter((blocker) => blocker.classification !== "waivable")
        .map((blocker) => blocker.itemId),
    )) {
      let item = sampleWork.items.find((candidate) => candidate.id === itemId)!;
      for (const requirement of item.evidenceRequirementKeys)
        await work.addEvidence(admin, apprenticeship.id, {
          requestKey: randomUUID(),
          itemId,
          title: `Sample ${requirement}`,
          evidenceRequirementKey: requirement,
          url: "https://example.test/sample-readiness",
        });
      item = (await work.get(admin, apprenticeship.id)).items.find(
        (candidate) => candidate.id === itemId,
      )!;
      if (item.status !== "complete")
        await work.updateItem(admin, apprenticeship.id, itemId, {
          expectedRevision: item.revision,
          requestKey: randomUUID(),
          status: "complete",
        });
    }
    sampleReadiness = await readiness.get(admin, apprenticeship.id);
    const sampleStage = sampleReadiness.stages.find(
      (stage) => stage.stageId === sampleStageId,
    )!;
    assert.ok(sampleStage.blockers.length > 0);
    assert.equal(
      sampleStage.blockers.every(
        (blocker) => blocker.classification === "waivable",
      ),
      true,
    );
    const sampleConditional = await readiness.decide(
      admin,
      apprenticeship.id,
      sampleStageId,
      {
        requestKey: randomUUID(),
        expectedToken: sampleStage.token,
        decision: "conditional_go",
        rationale: "Sample proceeds with the stakeholder map exception",
        exceptions: [
          ...new Set(sampleStage.blockers.map((blocker) => blocker.itemId)),
        ].map((itemId) => ({
          itemId,
          ownerUserId: admin.id,
          dueDate: future,
          rationale: "Complete the sample stakeholder map",
        })),
      },
    );
    await readiness.reopen(admin, apprenticeship.id, sampleStageId, {
      requestKey: randomUUID(),
      expectedToken: sampleConditional.token,
      rationale: "Reopen the sample before removing it",
    });
    await samples.remove(admin, {
      expectedRevision: 1,
      requestKey: randomUUID(),
      confirmation: "remove-sample-data",
    });
    assert.equal(
      (
        await harness.pool.query(
          "SELECT 1 FROM workspace_engagements WHERE id=$1",
          [engagement.id],
        )
      ).rows.length,
      1,
    );
    assert.ok(
      (
        await harness.pool.query(
          "SELECT 1 FROM workspace_readiness_decisions WHERE engagement_id=$1",
          [engagement.id],
        )
      ).rows.length >= 4,
    );
    assert.equal(
      (
        await harness.pool.query(
          "SELECT 1 FROM workspace_not_applicable_reviews WHERE engagement_id=$1",
          [engagement.id],
        )
      ).rows.length,
      1,
    );
  } finally {
    await harness.dispose();
  }
});
