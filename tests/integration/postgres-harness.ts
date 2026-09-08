import { randomUUID } from "node:crypto";
import { config as loadDotenv } from "dotenv";
import { Pool } from "pg";
import { assertIsolatedTestDatabase } from "./database-safety.js";

export interface PostgresHarness {
  databaseUrl: string;
  pool: Pool;
  dispose(): Promise<void>;
}

function quoteIdentifier(identifier: string): string {
  return `"${identifier.replaceAll('"', '""')}"`;
}

export async function createPostgresHarness(): Promise<PostgresHarness> {
  loadDotenv({ path: ".env.local", override: false, quiet: true });
  const databaseUrl = process.env.DATABASE_URL?.trim();
  if (!databaseUrl) throw new Error("DATABASE_URL is required to protect the normal database");

  const configuredTestUrl = process.env.TEST_DATABASE_URL?.trim();
  if (configuredTestUrl) assertIsolatedTestDatabase(databaseUrl, configuredTestUrl);

  const adminConnectionString = configuredTestUrl ?? databaseUrl;
  const adminUrl = new URL(adminConnectionString);
  const disposableName = `shi_agentic_test_${randomUUID().replaceAll("-", "")}`;
  const adminPool = new Pool({ connectionString: adminConnectionString, max: 1 });
  try {
    await adminPool.query(`CREATE DATABASE ${quoteIdentifier(disposableName)}`);
  } catch (error) {
    await adminPool.end();
    const code = typeof error === "object" && error !== null && "code" in error ? String(error.code) : "unknown";
    throw new Error(`Unable to create an isolated disposable PostgreSQL database (server code ${code})`);
  }

  const testUrl = new URL(adminUrl);
  testUrl.pathname = `/${disposableName}`;
  const testDatabaseUrl = testUrl.toString();
  assertIsolatedTestDatabase(databaseUrl, testDatabaseUrl);
  const pool = new Pool({ connectionString: testDatabaseUrl, max: 4 });

  try {
    await pool.query("SELECT 1");
  } catch (error) {
    await pool.end();
    await adminPool.query(`DROP DATABASE ${quoteIdentifier(disposableName)}`);
    await adminPool.end();
    throw error;
  }

  return {
    databaseUrl: testDatabaseUrl,
    pool,
    async dispose() {
      await pool.end();
      await adminPool.query(
        "SELECT pg_terminate_backend(pid) FROM pg_stat_activity WHERE datname = $1 AND pid <> pg_backend_pid()",
        [disposableName]
      );
      await adminPool.query(`DROP DATABASE ${quoteIdentifier(disposableName)}`);
      await adminPool.end();
    }
  };
}
