import { createPool } from "../packages/persistence/src/index.js";
import { loadConfig } from "../apps/api/src/config.js";
import { cleanupSessions } from "../apps/api/src/operations.js";

const execute = process.argv.includes("--execute");
const pool = createPool(loadConfig());
try {
  const result = await cleanupSessions(pool, { execute });
  process.stdout.write(
    `${result.dryRun ? "Dry run" : "Session cleanup complete"}: ${result.eligible} eligible, ${result.deleted} deleted.\n`,
  );
} catch {
  process.stderr.write("Session cleanup failed; no completion is claimed.\n");
  process.exitCode = 1;
} finally {
  await pool.end();
}
