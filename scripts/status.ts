import { createPool } from "../packages/persistence/src/index.js";
import { readMigrationFiles } from "../packages/persistence/src/migrations.js";
import { loadConfig } from "../apps/api/src/config.js";
import { collectOperationalStatus } from "../apps/api/src/operations.js";

const pool = createPool(loadConfig());
try {
  const status = await collectOperationalStatus(
    pool,
    await readMigrationFiles("migrations"),
  );
  process.stdout.write(`${JSON.stringify(status, null, 2)}\n`);
  if (status.migrations !== "current") process.exitCode = 1;
} catch {
  process.stderr.write(
    "Operational status unavailable. Check database connectivity and migration state.\n",
  );
  process.exitCode = 1;
} finally {
  await pool.end();
}
