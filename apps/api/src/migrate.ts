import path from "node:path";
import { loadConfig } from "./config.js";
import { createPool, readMigrationFiles, runMigrations } from "../../../packages/persistence/src/index.js";

async function main(): Promise<void> {
  const config = loadConfig();
  const pool = createPool(config);
  try {
    const migrations = await readMigrationFiles(path.resolve(process.cwd(), "migrations"));
    await runMigrations(pool, migrations);
    process.stdout.write(`Applied migrations: ${migrations.length}\n`);
  } finally {
    await pool.end();
  }
}

main().catch((error: unknown) => {
  const message = error instanceof Error ? error.message : "Unknown migration error";
  process.stderr.write(`Migration failed: ${message}\n`);
  process.exitCode = 1;
});
