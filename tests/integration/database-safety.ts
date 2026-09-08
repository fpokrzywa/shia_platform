const LOOPBACK_HOST = "loopback";
const ROUTING_PARAMETERS = new Set(["host", "hostaddr", "port", "database", "dbname", "service", "options"]);

export interface DatabaseTarget {
  host: string;
  port: number;
  database: string;
}

export function normalizeDatabaseTarget(connectionString: string): DatabaseTarget {
  const parsed = new URL(connectionString);
  if (parsed.protocol !== "postgres:" && parsed.protocol !== "postgresql:") {
    throw new Error("Database test URLs must use the postgres or postgresql scheme");
  }
  for (const key of parsed.searchParams.keys()) {
    if (ROUTING_PARAMETERS.has(key.toLowerCase())) {
      throw new Error(`Database URLs must not override routing through the ${key} query parameter`);
    }
  }

  const rawHost = parsed.hostname.toLowerCase().replace(/^\[|\]$/g, "");
  const host = ["localhost", "127.0.0.1", "::1"].includes(rawHost) ? LOOPBACK_HOST : rawHost;
  const database = decodeURIComponent(parsed.pathname.replace(/^\//, ""));
  if (!host || !database) throw new Error("Database test URLs must include a host and database name");

  return { host, port: parsed.port ? Number(parsed.port) : 5432, database };
}

export function assertIsolatedTestDatabase(databaseUrl: string, testDatabaseUrl: string): void {
  const normal = normalizeDatabaseTarget(databaseUrl);
  const test = normalizeDatabaseTarget(testDatabaseUrl);
  if (normal.host === test.host && normal.port === test.port && normal.database === test.database) {
    throw new Error("Refusing integration tests: TEST_DATABASE_URL resolves to the normal DATABASE_URL database");
  }
}
