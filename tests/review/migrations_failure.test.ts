import assert from "node:assert/strict";
import { test } from "node:test";

import {
  readMigrationFiles,
  runMigrations,
  type MigrationFile,
} from "../../packages/persistence/src/migrations.js";

type QueryCall = { text: string; values?: unknown[] };

function fakePool(options: {
  applied?: Array<{ migration_id: string; checksum: string }>;
  failOn?: (text: string) => boolean;
} = {}) {
  const calls: QueryCall[] = [];
  let released = false;
  const client = {
    async query<T = Record<string, unknown>>(text: string, values?: unknown[]) {
      calls.push({ text, values });
      if (options.failOn?.(text)) throw new Error("injected migration failure");
      if (/^SELECT migration_id, checksum/.test(text)) {
        return { rows: options.applied ?? [], rowCount: (options.applied ?? []).length } as never as {
          rows: T[];
          rowCount: number;
        };
      }
      return { rows: [], rowCount: 0 } as never as { rows: T[]; rowCount: number };
    },
    release() {
      released = true;
    },
  };
  return {
    calls,
    get released() {
      return released;
    },
    async connect() {
      return client as never;
    },
  };
}

const migration: MigrationFile = {
  id: "0001_identity",
  filename: "0001_identity.sql",
  sql: "CREATE TABLE review_fixture (id text PRIMARY KEY);",
  checksum: "checksum-1",
};

test("failed migration rolls back and is never marked as applied", async () => {
  const pool = fakePool({ failOn: (text) => text.includes("INSERT INTO schema_migrations") });

  await assert.rejects(() => runMigrations(pool, [migration]), /injected migration failure/);

  const texts = pool.calls.map((call) => call.text);
  assert.equal(texts.some((text) => text.includes(migration.sql)), true);
  assert.equal(texts.some((text) => text.includes("INSERT INTO schema_migrations")), true);
  assert.equal(texts.at(-1), "ROLLBACK");
  assert.equal(texts.includes("COMMIT"), false);
  assert.equal(pool.released, true);
});

test("checksum drift blocks startup and rolls back before executing later migrations", async () => {
  const pool = fakePool({ applied: [{ migration_id: migration.id, checksum: "old-checksum" }] });
  const later: MigrationFile = { ...migration, id: "0002_later", filename: "0002_later.sql" };

  await assert.rejects(() => runMigrations(pool, [migration, later]), /modified/);

  const texts = pool.calls.map((call) => call.text);
  assert.equal(texts.some((text) => text.includes(later.sql)), false);
  assert.equal(texts.at(-1), "ROLLBACK");
  assert.equal(texts.includes("COMMIT"), false);
  assert.equal(pool.released, true);
});

test("rerunning an already applied migration does not execute its SQL again", async () => {
  const pool = fakePool({ applied: [{ migration_id: migration.id, checksum: migration.checksum }] });

  await runMigrations(pool, [migration]);

  const texts = pool.calls.map((call) => call.text);
  assert.equal(texts.some((text) => text.includes(migration.sql)), false);
  assert.equal(texts.at(-1), "COMMIT");
  assert.equal(pool.released, true);
});

test("migration discovery rejects filenames outside the ordered format", async () => {
  const { mkdtemp, writeFile, rm } = await import("node:fs/promises");
  const { tmpdir } = await import("node:os");
  const { join } = await import("node:path");
  const directory = await mkdtemp(join(tmpdir(), "shi-migration-review-"));
  try {
    await writeFile(join(directory, "bad-name.sql"), "SELECT 1;");
    await assert.rejects(() => readMigrationFiles(directory), /Invalid migration filename/);
  } finally {
    await rm(directory, { recursive: true, force: true });
  }
});
