import assert from "node:assert/strict";
import { randomUUID } from "node:crypto";
import { readFile } from "node:fs/promises";
import test from "node:test";
import type { TemplateVersionDefinition } from "../../packages/domain/src/templates/index.js";
import {
  readMigrationFiles,
  runMigrations,
} from "../../packages/persistence/src/migrations.js";
import {
  ConflictError,
  EngagementService,
  TemplateService,
} from "../../packages/persistence/src/workspace/index.js";
import { createPostgresHarness } from "./postgres-harness.js";

test("draft correction is revision checked while published source and engagement pin stay fixed", async () => {
  const h = await createPostgresHarness();
  try {
    await runMigrations(h.pool, await readMigrationFiles("migrations"));
    const admin = { id: randomUUID(), role: "practice_admin" as const },
      lead = { id: randomUUID(), role: "member" as const };
    for (const u of [admin, lead])
      await h.pool.query(
        "INSERT INTO app_users(id,email,display_name,password_hash,role) VALUES($1,$2,$2,'x',$3)",
        [u.id, `${u.id}@test`, u.role],
      );
    const source = JSON.parse(
        await readFile("templates/independent-delivery.v1.json", "utf8"),
      ) as TemplateVersionDefinition,
      templates = new TemplateService(h.pool);
    await templates.importDraft(admin, {
      definition: source,
      requestKey: randomUUID(),
    });
    const v1 = await templates.publish(admin, {
      templateKey: source.templateKey,
      version: 1,
      expectedRevision: 1,
      requestKey: randomUUID(),
    });
    const engagements = new EngagementService(h.pool),
      client = await engagements.createClient(admin, {
        name: "Pinned client",
        requestKey: randomUUID(),
      }),
      engagement = await engagements.createEngagement(admin, {
        clientId: client.id,
        templateKey: source.templateKey,
        templateVersion: 1,
        title: "Pinned engagement",
        leadUserId: lead.id,
        requestKey: randomUUID(),
      });
    const draft = await templates.createVersion(admin, {
        templateKey: source.templateKey,
        sourceVersion: 1,
        expectedRevision: v1.revision,
        changes: { purpose: "Initial draft purpose" },
        reason: "Prepare next version",
        requestKey: randomUUID(),
      }),
      key = randomUUID(),
      corrected = await templates.updateDraft(admin, {
        templateKey: source.templateKey,
        version: 2,
        expectedRevision: draft.revision,
        definition: {
          ...draft.definition,
          purpose: "Corrected reviewed purpose",
        },
        reason: "Correct the purpose before publication",
        requestKey: key,
      });
    assert.equal(corrected.revision, 2);
    assert.deepEqual(
      await templates.updateDraft(admin, {
        templateKey: source.templateKey,
        version: 2,
        expectedRevision: draft.revision,
        definition: {
          ...draft.definition,
          purpose: "Corrected reviewed purpose",
        },
        reason: "Correct the purpose before publication",
        requestKey: key,
      }),
      corrected,
    );
    await assert.rejects(
      () =>
        templates.updateDraft(admin, {
          templateKey: source.templateKey,
          version: 2,
          expectedRevision: 1,
          definition: { purpose: "Stale edit" },
          reason: "stale",
          requestKey: randomUUID(),
        }),
      ConflictError,
    );
    const published = await templates.publish(admin, {
      templateKey: source.templateKey,
      version: 2,
      expectedRevision: 2,
      requestKey: randomUUID(),
    });
    assert.equal(published.definition.purpose, "Corrected reviewed purpose");
    assert.equal(
      (await templates.getTemplateVersion(admin, source.templateKey, 1))
        .definition.purpose,
      source.purpose,
    );
    assert.equal(
      (await engagements.getEngagement(admin, engagement.id)).templateVersion,
      1,
    );
    await assert.rejects(
      () =>
        templates.updateDraft(admin, {
          templateKey: source.templateKey,
          version: 2,
          expectedRevision: published.revision,
          definition: { purpose: "Mutate publication" },
          reason: "forbidden",
          requestKey: randomUUID(),
        }),
      ConflictError,
    );
  } finally {
    await h.dispose();
  }
});
