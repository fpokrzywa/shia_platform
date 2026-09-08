import assert from "node:assert/strict";
import path from "node:path";
import test from "node:test";
import { createHash } from "node:crypto";
import {
  checkMigrationsCurrent,
  readMigrationFiles,
  runMigrations,
  type MigrationFile,
} from "../../packages/persistence/src/migrations.js";
import { createPostgresHarness } from "./postgres-harness.js";

test("real PostgreSQL migrations apply once and failed additions roll back", async () => {
  const harness = await createPostgresHarness();
  try {
    const migrations = await readMigrationFiles(path.resolve("migrations"));
    await runMigrations(harness.pool, migrations);
    await runMigrations(harness.pool, migrations);
    await checkMigrationsCurrent(harness.pool, migrations);
    await assert.rejects(
      () => checkMigrationsCurrent(harness.pool, migrations.slice(0, -1)),
      /not current/i,
    );

    const applied = await harness.pool.query<{ migration_id: string }>(
      "SELECT migration_id FROM schema_migrations ORDER BY migration_id",
    );
    assert.deepEqual(
      applied.rows.map((row) => row.migration_id),
      migrations.map((migration) => migration.id),
    );

    const failingSql =
      "CREATE TABLE integration_rollback_probe (id integer); SELECT missing_integration_function();";
    const failing: MigrationFile = {
      id: "9999_integration_rollback_probe",
      filename: "9999_integration_rollback_probe.sql",
      sql: failingSql,
      checksum: createHash("sha256").update(failingSql).digest("hex"),
    };
    await assert.rejects(() =>
      runMigrations(harness.pool, [...migrations, failing]),
    );

    const table = await harness.pool.query<{ table_name: string }>(
      "SELECT table_name FROM information_schema.tables WHERE table_schema = 'public' AND table_name = 'integration_rollback_probe'",
    );
    assert.equal(table.rows.length, 0);
    const failedRecord = await harness.pool.query(
      "SELECT 1 FROM schema_migrations WHERE migration_id = $1",
      [failing.id],
    );
    assert.equal(failedRecord.rows.length, 0);
  } finally {
    await harness.dispose();
  }
});
