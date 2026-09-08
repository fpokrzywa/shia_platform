import dotenv from "dotenv";
import { spawn } from "node:child_process";

export function sourceUrl() {
  dotenv.config({ path: ".env.local", override: false, quiet: true });
  const value = process.env.DATABASE_URL?.trim();
  if (!value) throw new Error("DATABASE_URL is required");
  const url = new URL(value);
  if (!/^postgres(?:ql)?:$/.test(url.protocol))
    throw new Error("DATABASE_URL must use PostgreSQL");
  for (const key of ["host", "port", "dbname", "database", "options"])
    if (url.searchParams.has(key))
      throw new Error(`DATABASE_URL query parameter ${key} is not allowed for backup or restore`);
  return url;
}

export function postgresEnvironment(
  url,
  database = decodeURIComponent(url.pathname.slice(1)),
) {
  const env = { ...process.env };
  delete env.DATABASE_URL;
  delete env.TEST_DATABASE_URL;
  env.PGHOST = url.hostname;
  env.PGPORT = url.port || "5432";
  env.PGUSER = decodeURIComponent(url.username);
  env.PGPASSWORD = decodeURIComponent(url.password);
  env.PGDATABASE = database;
  if (url.searchParams.get("sslmode"))
    env.PGSSLMODE = url.searchParams.get("sslmode");
  return env;
}

export function runPostgresTool(command, args, env) {
  return new Promise((resolve, reject) => {
    const child = spawn(command, args, {
      env,
      stdio: ["ignore", "ignore", "pipe"],
      windowsHide: true,
    });
    let stderr = "";
    child.stderr.on("data", (chunk) => {
      stderr += chunk.toString();
    });
    child.once("error", () => reject(new Error(`${command} is unavailable`)));
    child.once("exit", (code) =>
      code === 0
        ? resolve()
        : reject(
            new Error(`${command} failed${stderr ? `: ${stderr.trim()}` : ""}`),
          ),
    );
  });
}

export function databaseName(url) {
  return decodeURIComponent(url.pathname.slice(1));
}

export function validateTarget(name) {
  if (!/^[A-Za-z][A-Za-z0-9_]{0,62}$/.test(name))
    throw new Error(
      "Target database must be an explicit PostgreSQL identifier",
    );
}
