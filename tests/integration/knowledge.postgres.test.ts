import assert from "node:assert/strict";
import { randomUUID } from "node:crypto";
import test from "node:test";
import {
  readMigrationFiles,
  runMigrations,
} from "../../packages/persistence/src/migrations.js";
import {
  AuthorizationError,
  KnowledgeService,
  MembershipService,
  SampleService,
} from "../../packages/persistence/src/workspace/index.js";
import { createPostgresHarness } from "./postgres-harness.js";

test("knowledge publication isolates drafts, pins links, and preserves safe history", async () => {
  const h = await createPostgresHarness();
  try {
    await runMigrations(h.pool, await readMigrationFiles("migrations"));
    const admin = { id: randomUUID(), role: "practice_admin" as const },
      author = { id: randomUUID(), role: "member" as const },
      reviewer = { id: randomUUID(), role: "member" as const },
      outsider = { id: randomUUID(), role: "member" as const };
    for (const u of [admin, author, reviewer, outsider])
      await h.pool.query(
        "INSERT INTO app_users(id,email,display_name,password_hash,role) VALUES($1,$2,$2,'x',$3)",
        [u.id, `${u.id}@test`, u.role],
      );
    const samples = new SampleService(h.pool),
      loaded = await samples.load(admin, {
        expectedRevision: 0,
        requestKey: randomUUID(),
        confirmation: "load-sample-data",
      });
    const engagementId = loaded.engagementIds[0]!;
    let revision = Number(
      (
        await h.pool.query(
          "SELECT revision FROM workspace_engagements WHERE id=$1",
          [engagementId],
        )
      ).rows[0].revision,
    );
    const memberships = new MembershipService(h.pool);
    revision = (
      await memberships.add(admin, {
        engagementId,
        userId: author.id,
        role: "engineer",
        expectedRevision: revision,
        requestKey: randomUUID(),
      })
    ).engagementRevision;
    await memberships.add(admin, {
      engagementId,
      userId: reviewer.id,
      role: "reviewer",
      expectedRevision: revision,
      requestKey: randomUUID(),
    });
    const noteId = randomUUID();
    await h.pool.query(
      "INSERT INTO workspace_engagement_notes(id,engagement_id,actor_id,body) VALUES($1,$2,$3,$4)",
      [
        noteId,
        engagementId,
        author.id,
        "Private original note that must never be exposed",
      ],
    );
    const service = new KnowledgeService(h.pool);
    const draft: any = await service.submitFromEngagement(author, {
      requestKey: randomUUID(),
      engagementId,
      source: { type: "note", id: noteId },
      key: "discovery-one",
      kind: "discovery_guide",
      title: "Discovery guide",
      summary: "Safe summary",
      body: "Explicitly submitted reusable text",
      sourceRefs: [{ title: "Reference", url: "https://example.com/guide" }],
    });
    await assert.rejects(
      () => service.getVersion(outsider, "discovery-one", 1),
      AuthorizationError,
    );
    const submitted: any = await service.submitForReview(
      author,
      "discovery-one",
      1,
      {
        requestKey: randomUUID(),
        expectedRevision: draft.revision,
        rationale: "Ready for peer review",
      },
    );
    const reviewView: any = await service.getVersion(
      reviewer,
      "discovery-one",
      1,
    );
    assert.equal(
      reviewView.definition.body,
      "Explicitly submitted reusable text",
    );
    assert.equal(reviewView.provenance_id, undefined);
    assert.equal(
      (await service.list(reviewer)).some(
        (row: any) => row.knowledge_key === "discovery-one",
      ),
      true,
    );
    const publishKey = randomUUID();
    const published: any = await service.publish(reviewer, "discovery-one", 1, {
      requestKey: publishKey,
      expectedRevision: submitted.revision,
      rationale: "Validated and generalized",
    });
    const replay: any = await service.publish(reviewer, "discovery-one", 1, {
      requestKey: publishKey,
      expectedRevision: submitted.revision,
      rationale: "Validated and generalized",
    });
    assert.deepEqual(replay, published);
    const publicView: any = await service.getVersion(
      outsider,
      "discovery-one",
      1,
    );
    assert.equal(publicView.hasPrivateProvenance, true);
    assert.equal(
      JSON.stringify(publicView).includes("Private original note"),
      false,
    );
    const link: any = await service.link(author, engagementId, {
      requestKey: randomUUID(),
      key: "discovery-one",
      version: 1,
      rationale: "Reuse for this delivery",
    });
    assert.equal(link.version, 1);
    const v2: any = await service.createVersion(author, "discovery-one", 1, {
      requestKey: randomUUID(),
      expectedRevision: published.revision,
      rationale: "Refine later",
      body: "A second version",
    });
    assert.equal(v2.definition.version, 2);
    assert.equal(
      (await service.listLinks(author, engagementId))[0]!.knowledge_version,
      1,
    );
    const retired: any = await service.retire(admin, "discovery-one", 1, {
      requestKey: randomUUID(),
      expectedRevision: published.revision,
      rationale: "Superseded after review",
    });
    assert.equal(retired.revision, published.revision + 1);
    await samples.remove(admin, {
      expectedRevision: loaded.revision,
      requestKey: randomUUID(),
      confirmation: "remove-sample-data",
    });
    assert.equal(
      (
        await h.pool.query(
          "SELECT count(*)::int n FROM workspace_knowledge_links",
        )
      ).rows[0].n,
      0,
    );
    const retained: any = await service.getVersion(
      outsider,
      "discovery-one",
      1,
    );
    assert.equal(retained.state, "retired");
    assert.equal(retained.hasPrivateProvenance, true);
  } finally {
    await h.dispose();
  }
});
