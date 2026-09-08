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
  DeliveryService,
  NotFoundError,
  SampleService,
  ValidationError,
  WorkService,
} from "../../packages/persistence/src/workspace/index.js";
import { deliveryRequest } from "../../apps/api/src/delivery-http.js";
import { createPostgresHarness } from "./postgres-harness.js";

test("delivery records enforce revisions, attribution, idempotency and sample cascades", async () => {
  const h = await createPostgresHarness();
  try {
    await runMigrations(h.pool, await readMigrationFiles("migrations"));
    const admin = { id: randomUUID(), role: "practice_admin" as const };
    const member = { id: randomUUID(), role: "member" as const };
    const outsider = { id: randomUUID(), role: "member" as const };
    await h.pool.query(
      "INSERT INTO app_users(id,email,display_name,password_hash,role) VALUES($1,$2,'Delivery Admin','unused','practice_admin'),($3,$4,'Delivery Member','unused','member'),($5,$6,'Delivery Outsider','unused','member')",
      [
        admin.id,
        "delivery-admin@example.test",
        member.id,
        "delivery-member@example.test",
        outsider.id,
        "delivery-outsider@example.test",
      ],
    );
    const samples = new SampleService(h.pool);
    const loaded = await samples.load(admin, {
      expectedRevision: 0,
      requestKey: randomUUID(),
      confirmation: "load-sample-data",
    });
    const engagementId = loaded.engagementIds[0]!;
    const otherEngagementId = loaded.engagementIds[1]!;
    const service = new DeliveryService(h.pool);
    await h.pool.query(
      "INSERT INTO workspace_engagement_memberships(engagement_id,user_id,role,added_by) VALUES($1,$2,'engineer',$3)",
      [engagementId, member.id, admin.id],
    );
    await assert.rejects(
      () =>
        deliveryRequest(
          h.pool,
          outsider,
          `/api/engagements/${engagementId}/delivery`,
          "GET",
          {},
        ),
      AuthorizationError,
    );
    assert.equal(
      (
        await deliveryRequest(
          h.pool,
          member,
          `/api/engagements/${engagementId}/delivery`,
          "GET",
          {},
        )
      )?.status,
      200,
    );
    await h.pool.query(
      "DELETE FROM workspace_engagement_memberships WHERE engagement_id=$1 AND user_id=$2",
      [engagementId, member.id],
    );
    await assert.rejects(
      () =>
        deliveryRequest(
          h.pool,
          member,
          `/api/engagements/${engagementId}/delivery`,
          "GET",
          {},
        ),
      AuthorizationError,
    );
    await assert.rejects(
      () =>
        deliveryRequest(
          h.pool,
          admin,
          `/api/engagements/${engagementId}/delivery/milestones`,
          "POST",
          { requestKey: 42, title: "Malformed" },
        ),
      ValidationError,
    );
    const key = randomUUID();
    const milestone = await service.createMilestone(admin, engagementId, {
      requestKey: key,
      title: "Pilot demo",
      dueDate: "2026-12-01",
    });
    assert.deepEqual(
      await service.createMilestone(admin, engagementId, {
        requestKey: key,
        title: "Pilot demo",
        dueDate: "2026-12-01",
      }),
      milestone,
    );
    const updated = await service.updateMilestone(
      admin,
      engagementId,
      String(milestone.id),
      {
        requestKey: randomUUID(),
        expectedRevision: Number(milestone.revision),
        status: "complete",
      },
    );
    assert.equal(updated.status, "complete");
    await assert.rejects(
      () =>
        service.updateMilestone(admin, engagementId, String(milestone.id), {
          requestKey: randomUUID(),
          expectedRevision: Number(milestone.revision),
          status: "cancelled",
        }),
      ConflictError,
    );
    await assert.rejects(
      () =>
        service.createMilestone(admin, engagementId, {
          requestKey: randomUUID(),
          title: "Bad",
          dueDate: "2026-99-99",
        }),
      ValidationError,
    );
    const scope = await service.proposeScope(admin, engagementId, {
      requestKey: randomUUID(),
      commitments: ["Pilot"],
      exclusions: ["Production"],
      estimate: "Two weeks",
      acceptanceCriteria: ["Scenario passes"],
    });
    const accepted = await service.decideScope(
      admin,
      engagementId,
      String(scope.id),
      {
        requestKey: randomUUID(),
        expectedRevision: Number(scope.revision),
        decision: "accepted",
        rationale: "Reviewed",
      },
    );
    assert.equal(accepted.state, "accepted");
    await service.createRisk(admin, engagementId, {
      requestKey: randomUUID(),
      title: "Access",
      severity: "high",
      mitigation: "Escalate",
    });
    await service.addDecision(admin, engagementId, {
      requestKey: randomUUID(),
      title: "Architecture",
      decision: "Use pinned model",
      rationale: "Repeatability",
    });
    const deliverable = await service.createDeliverable(admin, engagementId, {
      requestKey: randomUUID(),
      title: "Pilot",
      description: "Working pilot",
    });
    const otherItem = (
      await new WorkService(h.pool).get(admin, otherEngagementId)
    ).items[0]!;
    const otherEvidence = await new WorkService(h.pool).addEvidence(
      admin,
      otherEngagementId,
      {
        requestKey: randomUUID(),
        itemId: otherItem.id,
        title: "Other evidence",
        url: "https://example.test/other",
      },
    );
    await assert.rejects(
      () =>
        deliveryRequest(
          h.pool,
          admin,
          `/api/engagements/${engagementId}/delivery/acceptance`,
          "POST",
          {
            requestKey: randomUUID(),
            result: "accepted",
            rationale: "Wrong engagement",
            sourceType: "external",
            externalName: "Client",
            evidenceId: otherEvidence.id,
          },
        ),
      ValidationError,
    );
    await assert.rejects(
      () =>
        deliveryRequest(
          h.pool,
          admin,
          `/api/engagements/${otherEngagementId}/delivery/acceptance`,
          "POST",
          {
            requestKey: randomUUID(),
            result: "accepted",
            rationale: "Wrong engagement",
            sourceType: "internal",
            deliverableId: String(deliverable.id),
          },
        ),
      NotFoundError,
    );
    await assert.rejects(
      () =>
        deliveryRequest(
          h.pool,
          admin,
          `/api/engagements/${engagementId}/delivery/milestones/${milestone.id}`,
          "POST",
          {
            requestKey: randomUUID(),
            expectedRevision: "1",
            status: "complete",
          },
        ),
      ValidationError,
    );
    await service.recordAcceptance(admin, engagementId, {
      requestKey: randomUUID(),
      deliverableId: String(deliverable.id),
      result: "partial",
      rationale: "Open follow-up",
      sourceType: "internal",
    });
    await service.createFollowup(admin, engagementId, {
      requestKey: randomUUID(),
      title: "Resolve defect",
    });
    const workspace = await service.get(admin, engagementId);
    assert.equal(workspace.scopes.length, 1);
    assert.equal(workspace.milestones.length, 1);
    const removed = await samples.remove(admin, {
      expectedRevision: loaded.revision,
      requestKey: randomUUID(),
      confirmation: "remove-sample-data",
    });
    assert.equal(removed.state, "empty");
    for (const table of [
      "workspace_scope_versions",
      "workspace_delivery_milestones",
      "workspace_delivery_risks",
      "workspace_delivery_decisions",
      "workspace_deliverables",
      "workspace_acceptance_records",
      "workspace_delivery_followups",
    ]) {
      const count = await h.pool.query<{ count: string }>(
        `SELECT count(*) count FROM ${table}`,
      );
      assert.equal(count.rows[0]!.count, "0", table);
    }
  } finally {
    await h.dispose();
  }
});
