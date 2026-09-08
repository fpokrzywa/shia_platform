import { access } from "node:fs/promises";
import pg from "pg";
import {
  databaseName,
  postgresEnvironment,
  runPostgresTool,
  sourceUrl,
  validateTarget,
} from "./postgres-ops.mjs";

const [backup, target] = process.argv.slice(2);
if (!backup || !target)
  throw new Error(
    "Usage: node scripts/restore.mjs <backup-file> <fresh-target-database>",
  );
await access(backup);
validateTarget(target);
const url = sourceUrl();
if (target.toLowerCase() === databaseName(url).toLowerCase())
  throw new Error("Restore target must differ from DATABASE_URL");
const pool = new pg.Pool({ connectionString: url.toString(), max: 1 });
let created = false;
try {
  const exists = await pool.query(
    "SELECT 1 FROM pg_database WHERE datname=$1",
    [target],
  );
  if (exists.rowCount)
    throw new Error(
      "Restore target already exists; choose a fresh database name",
    );
  await pool.query(`CREATE DATABASE "${target}"`);
  created = true;
  await runPostgresTool(
    "psql",
    ["--set", "ON_ERROR_STOP=1", "--file", backup],
    postgresEnvironment(url, target),
  );
  console.log(`Restore completed into fresh database: ${target}`);
} catch (error) {
  if (created) await pool.query(`DROP DATABASE "${target}"`).catch(() => {});
  throw error;
} finally {
  await pool.end();
}
