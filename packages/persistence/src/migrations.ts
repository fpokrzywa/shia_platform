import { createHash } from "node:crypto";
import { readdir, readFile } from "node:fs/promises";
import path from "node:path";
import type { PoolClient } from "pg";
import type { MigrationPool } from "./database.js";

export interface MigrationFile {
  id: string;
  filename: string;
  sql: string;
  checksum: string;
}

export async function readMigrationFiles(
  directory: string,
): Promise<MigrationFile[]> {
  const filenames = (await readdir(directory, { withFileTypes: true }))
    .filter((entry) => entry.isFile() && entry.name.endsWith(".sql"))
    .map((entry) => entry.name)
    .sort();
  const migrations: MigrationFile[] = [];
  const seen = new Set<string>();
  for (const filename of filenames) {
    const match = /^(\d{4}_[a-z0-9_]+)\.sql$/.exec(filename);
    if (!match) throw new Error(`Invalid migration filename: ${filename}`);
    const id = match[1] as string;
    if (seen.has(id)) throw new Error(`Duplicate migration id: ${id}`);
    seen.add(id);
    const sql = await readFile(path.join(directory, filename), "utf8");
    const checksum = createHash("sha256").update(sql).digest("hex");
    migrations.push({ id, filename, sql, checksum });
  }
  return migrations;
}

export async function runMigrations(
  pool: MigrationPool,
  migrations: MigrationFile[],
): Promise<void> {
  const client = await pool.connect();
  try {
    await client.query("BEGIN");
    // The transaction-scoped advisory lock prevents two local processes from migrating together.
    await client.query(
      "SELECT pg_advisory_xact_lock(hashtext('shi_agentic_platform:migrations'))",
    );
    await client.query(`
      CREATE TABLE IF NOT EXISTS schema_migrations (
        migration_id text PRIMARY KEY,
        filename text NOT NULL,
        checksum text NOT NULL,
        applied_at timestamptz NOT NULL DEFAULT now()
      )
    `);
    const appliedResult = await client.query<{
      migration_id: string;
      checksum: string;
    }>(
      "SELECT migration_id, checksum FROM schema_migrations ORDER BY migration_id",
    );
    const applied = new Map(
      appliedResult.rows.map((row) => [row.migration_id, row.checksum]),
    );
    for (const migration of migrations) {
      const previousChecksum = applied.get(migration.id);
      if (previousChecksum) {
        if (previousChecksum !== migration.checksum) {
          throw new Error(
            `Applied migration was modified: ${migration.filename}`,
          );
        }
        continue;
      }
      await client.query(migration.sql);
      await client.query(
        "INSERT INTO schema_migrations (migration_id, filename, checksum) VALUES ($1, $2, $3)",
        [migration.id, migration.filename, migration.checksum],
      );
    }
    await client.query("COMMIT");
  } catch (error) {
    await rollback(client);
    throw error;
  } finally {
    client.release();
  }
}

export async function checkMigrationsCurrent(
  pool: MigrationPool,
  migrations: MigrationFile[],
): Promise<void> {
  const client = await pool.connect();
  try {
    const result = await client.query<{
      migration_id: string;
      checksum: string;
    }>(
      "SELECT migration_id,checksum FROM schema_migrations ORDER BY migration_id",
    );
    if (result.rows.length !== migrations.length)
      throw new Error("Database migration state is not current");
    for (const [index, migration] of migrations.entries()) {
      const applied = result.rows[index];
      if (
        applied?.migration_id !== migration.id ||
        applied.checksum !== migration.checksum
      )
        throw new Error("Database migration state is not current");
    }
  } finally {
    client.release();
  }
}

async function rollback(client: PoolClient): Promise<void> {
  try {
    await client.query("ROLLBACK");
  } catch {
    // Preserve the original migration error; the connection is released below.
  }
}
