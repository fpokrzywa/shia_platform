import test from "node:test";
import assert from "node:assert/strict";
import type { MigrationFile } from "./migrations.js";
import { runMigrations } from "./migrations.js";
import type { ClientPool } from "./database.js";

function migration(id: string, sql = "SELECT 1"): MigrationFile {
  return { id, filename: `${id}.sql`, sql, checksum: id };
}

function fakePool(options: { failOnMigration?: boolean } = {}): { pool: ClientPool; queries: string[]; rolledBack: boolean } {
  const queries: string[] = [];
  let rolledBack = false;
  const client = {
    query: async (sql: string) => {
      queries.push(sql);
      if (options.failOnMigration && sql === "BROKEN SQL") throw new Error("migration failed");
      if (sql.startsWith("SELECT migration_id")) return { rows: [] };
      return { rows: [] };
    },
    release: () => undefined
  };
  const pool = {
    connect: async () => client,
    query: async () => ({ rows: [] }),
    end: async () => undefined
  } as unknown as ClientPool;
  const originalQuery = client.query;
  client.query = async (sql: string, _values?: unknown[]) => {
    if (sql === "ROLLBACK") rolledBack = true;
    return originalQuery(sql);
  };
  return { pool, queries, get rolledBack() { return rolledBack; } };
}

test("runMigrations records successful migrations and is safe to rerun", async () => {
  const fake = fakePool();
  await runMigrations(fake.pool, [migration("0001_identity")]);
  assert.equal(fake.queries.at(-1), "COMMIT");
  assert.equal(fake.queries.filter((query) => query === "0001_identity.sql").length, 0);
});

test("runMigrations rolls back and does not mark a failed migration complete", async () => {
  const fake = fakePool({ failOnMigration: true });
  await assert.rejects(runMigrations(fake.pool, [migration("0001_identity", "BROKEN SQL")]), /migration failed/);
  assert.equal(fake.rolledBack, true);
  assert.equal(fake.queries.some((query) => query.includes("INSERT INTO schema_migrations")), false);
});
