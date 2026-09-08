import { randomUUID } from "node:crypto";
import { fileURLToPath } from "node:url";
import { loadConfig } from "../config.js";
import { createPool, type ClientPool } from "../../../../packages/persistence/src/index.js";
import { hashPassword } from "./password.js";

export class BootstrapAlreadyInitializedError extends Error {}

export async function bootstrapPracticeAdmin(pool: ClientPool, input: { email: string; displayName: string; password: string }): Promise<string> {
  const email = input.email.trim().toLowerCase();
  const displayName = input.displayName.trim();
  if (!email || email.length > 254 || !/^[^\s@]+@[^\s@]+\.[^\s@]+$/.test(email)) throw new Error("A valid email is required");
  if (!displayName || displayName.length > 100) throw new Error("Display name must be between 1 and 100 characters");
  const passwordHash = await hashPassword(input.password);
  const client = await pool.connect();
  try {
    await client.query("BEGIN");
    await client.query("LOCK TABLE app_users IN EXCLUSIVE MODE");
    const existing = await client.query<{ count: string }>("SELECT count(*)::text AS count FROM app_users");
    if (existing.rows[0]?.count !== "0") throw new BootstrapAlreadyInitializedError("Bootstrap is disabled after the first account is created");
    const id = randomUUID();
    await client.query("INSERT INTO app_users (id, email, display_name, password_hash, role) VALUES ($1, $2, $3, $4, 'practice_admin')", [id, email, displayName, passwordHash]);
    await client.query("INSERT INTO identity_audit_events (id, event_type, actor_user_id, subject_user_id, details) VALUES ($1, 'practice_admin_bootstrapped', $2, $2, $3::jsonb)", [randomUUID(), id, JSON.stringify({ email })]);
    await client.query("COMMIT");
    return id;
  } catch (error) {
    await client.query("ROLLBACK");
    throw error;
  } finally {
    client.release();
  }
}

async function readPassword(): Promise<string> {
  if (process.stdin.isTTY) throw new Error("Password must be supplied through standard input; use scripts/bootstrap.ps1 for a masked prompt");
  const chunks: Buffer[] = [];
  let bytes = 0;
  for await (const chunk of process.stdin) {
    const buffer = Buffer.isBuffer(chunk) ? chunk : Buffer.from(chunk);
    bytes += buffer.length;
    if (bytes > 258) throw new Error("Password input exceeds 256 bytes");
    chunks.push(buffer);
  }
  return Buffer.concat(chunks).toString("utf8").replace(/[\r\n]+$/, "");
}

async function main(): Promise<void> {
  const emailIndex = process.argv.indexOf("--email");
  const nameIndex = process.argv.indexOf("--display-name");
  const fromEnvironment = process.argv.includes('--environment-identity');
  const email = emailIndex >= 0 ? process.argv[emailIndex + 1] : fromEnvironment ? process.env.SHI_BOOTSTRAP_EMAIL : undefined;
  const displayName = nameIndex >= 0 ? process.argv[nameIndex + 1] : fromEnvironment ? process.env.SHI_BOOTSTRAP_DISPLAY_NAME : undefined;
  if (!email || !displayName) throw new Error("Usage: bootstrap --email EMAIL --display-name NAME (password is read from stdin)");
  const pool = createPool(loadConfig());
  try {
    await bootstrapPracticeAdmin(pool, { email, displayName, password: await readPassword() });
    process.stdout.write("Practice administrator created.\n");
  } finally { await pool.end(); }
}

const invokedFile = process.argv[1] ? fileURLToPath(import.meta.url) : undefined;
if (invokedFile && process.argv[1] === invokedFile) void main().catch((error) => {
  const safeMessage = error instanceof BootstrapAlreadyInitializedError ? error.message
    : error instanceof Error && (/^(Usage:|Password |A valid email|Display name)/.test(error.message)) ? error.message
    : "Bootstrap failed; verify configuration, migration state, and database availability";
  process.stderr.write(`${safeMessage}\n`);
  process.exitCode = 1;
});
