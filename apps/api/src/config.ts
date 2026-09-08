import path from "node:path";
import { config as loadDotenv } from "dotenv";

export interface AppConfig {
  databaseUrl: string;
  host: string;
  port: number;
  storageDir: string;
  webRoot?: string;
  migrationsDir?: string;
  sessionSecret?: string;
}

export class ConfigurationError extends Error {
  constructor(message: string) {
    super(message);
    this.name = "ConfigurationError";
  }
}

function loadEnvironmentFiles(cwd: string): void {
  // Environment variables already supplied by the process take precedence.
  loadDotenv({ path: path.resolve(cwd, ".env.local"), override: false, quiet: true });
  loadDotenv({ path: path.resolve(cwd, ".env"), override: false, quiet: true });
}

function required(env: NodeJS.ProcessEnv, key: string): string {
  const value = env[key]?.trim();
  if (!value) {
    throw new ConfigurationError(`Missing required configuration: ${key}`);
  }
  return value;
}

function parsePort(value: string | undefined): number {
  if (!value?.trim()) return 0;
  const port = Number(value);
  if (!Number.isInteger(port) || port < 0 || port > 65535) {
    throw new ConfigurationError("PORT must be 0 for automatic selection or an integer between 1 and 65535");
  }
  return port;
}

function parseDatabaseUrl(value: string): string {
  let parsed: URL;
  try {
    parsed = new URL(value);
  } catch {
    throw new ConfigurationError("DATABASE_URL must be a valid PostgreSQL connection URL");
  }
  if (parsed.protocol !== "postgres:" && parsed.protocol !== "postgresql:") {
    throw new ConfigurationError("DATABASE_URL must use the postgres or postgresql scheme");
  }
  if (!parsed.hostname) {
    throw new ConfigurationError("DATABASE_URL must include a database host");
  }
  return value;
}

export function loadConfig(options: {
  env?: NodeJS.ProcessEnv;
  cwd?: string;
  loadEnvFiles?: boolean;
} = {}): AppConfig {
  const cwd = options.cwd ?? process.cwd();
  if (options.loadEnvFiles !== false) loadEnvironmentFiles(cwd);
  const env = options.env ?? process.env;
  const sessionSecret = env.SESSION_SECRET?.trim();
  if (sessionSecret && sessionSecret.length < 16) {
    throw new ConfigurationError("SESSION_SECRET must be at least 16 characters when provided");
  }
  return {
    databaseUrl: parseDatabaseUrl(required(env, "DATABASE_URL")),
    host: env.HOST?.trim() || "127.0.0.1",
    port: parsePort(env.PORT),
    storageDir: path.resolve(cwd, env.STORAGE_DIR?.trim() || "data"),
    ...(env.MIGRATIONS_DIR?.trim() ? {migrationsDir:path.resolve(cwd,env.MIGRATIONS_DIR.trim())} : {}),
    ...(env.WEB_ROOT?.trim() ? {webRoot:path.resolve(cwd,env.WEB_ROOT.trim())} : {}),
    ...(sessionSecret ? { sessionSecret } : {})
  };
}
