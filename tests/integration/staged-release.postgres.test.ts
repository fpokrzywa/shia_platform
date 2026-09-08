import assert from "node:assert/strict";
import test from "node:test";
import { mkdtemp, mkdir, writeFile, cp, rm } from "node:fs/promises";
import path from "node:path";
import os from "node:os";
import { startApplication } from "../../apps/api/src/server.js";
import {
  readMigrationFiles,
  runMigrations,
} from "../../packages/persistence/src/migrations.js";
import { createPostgresHarness } from "./postgres-harness.js";

test("staged application serves its selected assets and freezes the migration manifest until restart", async () => {
  const h = await createPostgresHarness();
  const root = await mkdtemp(path.join(os.tmpdir(), "shi-release-"));
  let app: Awaited<ReturnType<typeof startApplication>> | undefined;
  try {
    const migrations = path.join(root, "migrations"),
      web = path.join(root, "web"),
      futureWeb = path.join(root, "future-web");
    await cp("migrations", migrations, { recursive: true });
    await mkdir(web);
    await mkdir(futureWeb);
    await writeFile(path.join(web, "index.html"), "<h1>Verified release</h1>");
    await runMigrations(h.pool, await readMigrationFiles(migrations));
    app = await startApplication(
      {
        databaseUrl: "postgres://unused/unused",
        host: "127.0.0.1",
        port: 0,
        storageDir: root,
        webRoot: web,
        migrationsDir: migrations,
      },
      { pool: h.pool },
    );
    assert.equal(
      await (await fetch(app.url)).text(),
      "<h1>Verified release</h1>",
    );
    assert.equal((await fetch(app.url + "/health/ready")).status, 200);
    await writeFile(
      path.join(futureWeb, "index.html"),
      "<h1>Unreleased build</h1>",
    );
    await writeFile(path.join(migrations, "9999_future.sql"), "SELECT 1;");
    assert.equal(
      await (await fetch(app.url)).text(),
      "<h1>Verified release</h1>",
    );
    assert.equal(
      (await fetch(app.url + "/health/ready")).status,
      200,
      "running manifest is fixed at startup",
    );
    await h.pool.query(
      "UPDATE schema_migrations SET checksum='altered' WHERE migration_id=(SELECT min(migration_id) FROM schema_migrations)",
    );
    assert.equal(
      (await fetch(app.url + "/health/ready")).status,
      503,
      "stored checksum mismatch fails readiness",
    );
    assert.equal((await fetch(app.url + "/health/live")).status, 200);
  } finally {
    if (app?.server.listening)
      await new Promise<void>((resolve) => app!.server.close(() => resolve()));
    await h.dispose();
    // The only removed tree is the newly allocated temporary fixture directory.
    await rm(root, { recursive: true, force: true });
  }
});
