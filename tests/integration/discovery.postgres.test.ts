import assert from "node:assert/strict";
import { randomUUID } from "node:crypto";
import test from "node:test";
import {
  readMigrationFiles,
  runMigrations,
} from "../../packages/persistence/src/migrations.js";
import {
  ConflictError,
  DeliveryService,
  DiscoveryOutcomeService,
  PortfolioService,
  SampleService,
  ValidationError,
  WorkService,
} from "../../packages/persistence/src/workspace/index.js";
import { createPostgresHarness } from "./postgres-harness.js";

test("discovery, outcomes and portfolio preserve engagement isolation and measured facts", async () => {
  const h = await createPostgresHarness();
  try {
    await runMigrations(h.pool, await readMigrationFiles("migrations"));
    const admin = { id: randomUUID(), role: "practice_admin" as const },
      member = { id: randomUUID(), role: "member" as const },
      outsider = { id: randomUUID(), role: "member" as const };
    for (const u of [admin, member, outsider])
      await h.pool.query(
        "INSERT INTO app_users(id,email,display_name,password_hash,role) VALUES($1,$2,$2,'x',$3)",
        [u.id, `${u.id}@test`, u.role],
      );
    const samples = new SampleService(h.pool),
      loaded = await samples.load(admin, {
        expectedRevision: 0,
        requestKey: randomUUID(),
        confirmation: "load-sample-data",
      }),
      eid = loaded.engagementIds[0]!,
      other = loaded.engagementIds[1]!;
    await h.pool.query(
      "INSERT INTO workspace_engagement_memberships(engagement_id,user_id,role,added_by) VALUES($1,$2,'engineer',$3)",
      [eid, member.id, admin.id],
    );
    const service = new DiscoveryOutcomeService(h.pool);
    const session: any = await service.createSession(member, eid, {
      requestKey: randomUUID(),
      purpose: "Understand current delivery",
      sessionDate: "2026-09-08",
      participantUserIds: [member.id],
      summary: "Observed handoff delays",
    });
    await assert.rejects(
      () =>
        service.updateSession(member, eid, session.id, {
          requestKey: randomUUID(),
          expectedRevision: 99,
          purpose: "Understand current delivery",
          sessionDate: "2026-09-08",
          participantUserIds: [member.id],
          summary: "Changed",
        }),
      ConflictError,
    );
    await service.createUseCase(member, eid, {
      requestKey: randomUUID(),
      title: "Faster handoff",
      problemStatement: "Manual handoffs take too long",
      actor: "Delivery engineer",
      desiredOutcome: "Reduce elapsed time",
    });
    await service.createAssumption(member, eid, {
      requestKey: randomUUID(),
      statement: "Automation can access the required system",
      status: "open",
    });
    await service.createApproach(member, eid, {
      requestKey: randomUUID(),
      title: "Guided workflow",
      description: "Use an explicit review workflow",
      status: "selected",
      rationale: "Lower operational risk",
      effort: { value: 5, unit: "engineer-days" },
    });
    const delivery = new DeliveryService(h.pool),
      scope: any = await delivery.proposeScope(admin, eid, {
        requestKey: randomUUID(),
        commitments: ["Pilot workflow"],
        exclusions: ["Production rollout"],
        estimate: "Five days",
        acceptanceCriteria: ["Pilot reviewed"],
      });
    const accepted: any = await delivery.decideScope(admin, eid, scope.id, {
      requestKey: randomUUID(),
      expectedRevision: scope.revision,
      decision: "accepted",
      rationale: "Baseline approved",
    });
    const scopeLink: any = await service.linkAcceptedScope(member, eid, {
      requestKey: randomUUID(),
      expectedRevision: 0,
      scopeId: accepted.id,
    });
    assert.equal(scopeLink.scopeId, accepted.id);
    const metric: any = await service.createOutcomeMetric(member, eid, {
      requestKey: randomUUID(),
      name: "Handoff duration",
      unit: "hours",
      description: "Elapsed handoff time",
      baseline: 8,
      target: 2,
    });
    const work = await new WorkService(h.pool).get(admin, other),
      otherItem = work.items[0]!;
    const wrongEvidence: any = await new WorkService(h.pool).addEvidence(
      admin,
      other,
      {
        requestKey: randomUUID(),
        itemId: otherItem.id,
        title: "Other engagement evidence",
        url: "https://example.com/evidence",
      },
    );
    await assert.rejects(
      () =>
        service.addOutcomeObservation(member, eid, metric.id, {
          requestKey: randomUUID(),
          observedOn: "2026-09-08",
          value: 4,
          evidenceId: wrongEvidence.id,
        }),
      ValidationError,
    );
    await service.addOutcomeObservation(member, eid, metric.id, {
      requestKey: randomUUID(),
      observedOn: "2026-09-08",
      value: 4,
      note: "Observed pilot value",
    });
    const detail = await service.get(member, eid);
    assert.equal(detail.outcomes[0]!.observations[0]!.value, "4");
    assert.equal((detail as any).success, undefined);
    const memberPortfolio = await new PortfolioService(h.pool).list(member);
    assert.equal(memberPortfolio.length, 1);
    assert.equal(memberPortfolio[0]!.id, eid);
    assert.equal(memberPortfolio[0]!.outcomes[0].latestValue, 4);
    const adminPortfolio = await new PortfolioService(h.pool).list(admin);
    assert.equal(adminPortfolio.length, 2);
    const audit = await h.pool.query(
      "SELECT count(*)::int n FROM workspace_audit_events WHERE actor_id=$1 AND action='admin_access' AND details->>'requestedAction'='portfolio.list'",
      [admin.id],
    );
    assert.equal(audit.rows[0].n, 2);
    await samples.remove(admin, {
      expectedRevision: loaded.revision,
      requestKey: randomUUID(),
      confirmation: "remove-sample-data",
    });
    assert.equal(
      (
        await h.pool.query(
          "SELECT count(*)::int n FROM workspace_outcome_metrics",
        )
      ).rows[0].n,
      0,
    );
  } finally {
    await h.dispose();
  }
});
