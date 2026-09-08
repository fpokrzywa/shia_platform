import { Pool, type PoolClient } from "pg";
import type { AppConfig } from "../../../apps/api/src/config.js";

export interface Queryable {
  query: (text: string, values?: unknown[]) => Promise<{ rows: unknown[] }>;
}

export interface ClientPool extends Queryable {
  connect(): Promise<PoolClient>;
  end(): Promise<void>;
}

export interface MigrationPool {
  connect(): Promise<PoolClient>;
}

export function createPool(config: Pick<AppConfig, "databaseUrl">): Pool {
  return new Pool({
    connectionString: config.databaseUrl,
    max: 10,
    idleTimeoutMillis: 30_000,
    connectionTimeoutMillis: 5_000
  });
}

export async function checkDatabase(pool: Queryable): Promise<void> {
  await pool.query("SELECT 1");
}
