import assert from "node:assert/strict";
import { createHash, randomUUID } from "node:crypto";
import { execFile } from "node:child_process";
import { rm } from "node:fs/promises";
import { promisify } from "node:util";
import test from "node:test";
import { Pool } from "pg";
import {
  readMigrationFiles,
  runMigrations,
} from "../../packages/persistence/src/migrations.js";
import {
  ReadinessService,
  SampleService,
  WorkService,
} from "../../packages/persistence/src/workspace/index.js";
import { createPostgresHarness } from "./postgres-harness.js";

const run = promisify(execFile);
test("portable backup restores migrations, attachments, and readiness history into a fresh database", async () => {
  const h = await createPostgresHarness();
  const target = `shi_agentic_restore_test_${randomUUID().replaceAll("-", "")}`;
  const backup = `work/recovery/${target}.dump`;
  let restored: Pool | undefined;
  try {
    await runMigrations(h.pool, await readMigrationFiles("migrations"));
    const admin = { id: randomUUID(), role: "practice_admin" as const };
    await h.pool.query(
      "INSERT INTO app_users(id,email,display_name,password_hash,role) VALUES($1,$2,'Recovery Admin','unused','practice_admin')",
      [admin.id, "recovery@example.test"],
    );
    const loaded = await new SampleService(h.pool).load(admin, {
      expectedRevision: 0,
      requestKey: randomUUID(),
      confirmation: "load-sample-data",
    });
    const engagementId = loaded.engagementIds[0]!;
    const work = new WorkService(h.pool);
    const item = (await work.get(admin, engagementId)).items[0]!;
    const bytes = Buffer.from(
      "qualified recovery attachment\u0000\u0001",
      "utf8",
    );
    await work.addEvidence(admin, engagementId, {
      requestKey: randomUUID(),
      itemId: item.id,
      title: "Recovery proof",
      fileName: "proof.bin",
      base64: bytes.toString("base64"),
    });
    const readiness = new ReadinessService(h.pool);
    const stage = (await readiness.get(admin, engagementId)).stages[0]!;
    await readiness.decide(admin, engagementId, stage.stageId, {
      requestKey: randomUUID(),
      expectedToken: stage.token,
      decision: "no_go",
      rationale: "Recovery qualification history",
    });
    const migrations = (
      await h.pool.query(
        "SELECT migration_id,filename,checksum FROM schema_migrations ORDER BY migration_id",
      )
    ).rows;
    const decisions = (
      await h.pool.query(
        "SELECT decision,rationale,snapshot_token FROM workspace_readiness_decisions ORDER BY id",
      )
    ).rows;

    const env = { ...process.env, DATABASE_URL: h.databaseUrl };
    const backupResult = await run(
      process.execPath,
      ["scripts/backup.mjs", backup],
      { env },
    );
    assert.doesNotMatch(
      backupResult.stdout + backupResult.stderr,
      /postgres(?:ql)?:\/\//i,
    );
    const restoreResult = await run(
      process.execPath,
      ["scripts/restore.mjs", backup, target],
      { env },
    );
    assert.doesNotMatch(
      restoreResult.stdout + restoreResult.stderr,
      /postgres(?:ql)?:\/\//i,
    );
    const restoredUrl = new URL(h.databaseUrl);
    restoredUrl.pathname = `/${target}`;
    restored = new Pool({ connectionString: restoredUrl.toString(), max: 1 });
    assert.deepEqual(
      (
        await restored.query(
          "SELECT migration_id,filename,checksum FROM schema_migrations ORDER BY migration_id",
        )
      ).rows,
      migrations,
    );
    assert.deepEqual(
      (
        await restored.query(
          "SELECT decision,rationale,snapshot_token FROM workspace_readiness_decisions ORDER BY id",
        )
      ).rows,
      decisions,
    );
    const restoredBytes = (
      await restored.query<{ attachment: Buffer }>(
        "SELECT attachment FROM workspace_evidence WHERE title='Recovery proof'",
      )
    ).rows[0]!.attachment;
    assert.equal(
      createHash("sha256").update(restoredBytes).digest("hex"),
      createHash("sha256").update(bytes).digest("hex"),
    );
    await assert.rejects(
      () =>
        run(process.execPath, ["scripts/restore.mjs", backup, target], { env }),
      /already exists/i,
    );
    await assert.rejects(
      () =>
        run(
          process.execPath,
          [
            "scripts/restore.mjs",
            backup,
            new URL(h.databaseUrl).pathname.slice(1),
          ],
          { env },
        ),
      /must differ/i,
    );
  } finally {
    await restored?.end();
    await h.pool
      .query(
        "SELECT pg_terminate_backend(pid) FROM pg_stat_activity WHERE datname=$1 AND pid<>pg_backend_pid()",
        [target],
      )
      .catch(() => {});
    await h.pool.query(`DROP DATABASE IF EXISTS "${target}"`).catch(() => {});
    await rm(backup, { force: true });
    await h.dispose();
  }
});
