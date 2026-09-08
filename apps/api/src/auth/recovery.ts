import { randomUUID } from "node:crypto";
import { fileURLToPath } from "node:url";
import {
  createPool,
  type ClientPool,
} from "../../../../packages/persistence/src/index.js";
import { loadConfig } from "../config.js";
import { hashPassword } from "./password.js";

export class LocalRecoveryError extends Error {}

export async function resetLocalPassword(
  pool: ClientPool,
  input: { email: string; password: string },
): Promise<void> {
  const email = input.email.trim();
  if (!email || email.length > 254)
    throw new LocalRecoveryError("A valid account email is required");
  const passwordHash = await hashPassword(input.password);
  const client = await pool.connect();
  try {
    await client.query("BEGIN");
    const found = await client.query<{ id: string }>(
      "SELECT id FROM app_users WHERE lower(email)=lower($1) AND disabled_at IS NULL FOR UPDATE",
      [email],
    );
    if (found.rowCount !== 1)
      throw new LocalRecoveryError(
        "Exactly one enabled local account must match the email",
      );
    const userId = found.rows[0]!.id;
    await client.query("UPDATE app_users SET password_hash=$2 WHERE id=$1", [
      userId,
      passwordHash,
    ]);
    await client.query(
      "UPDATE app_sessions SET revoked_at=COALESCE(revoked_at,now()) WHERE user_id=$1",
      [userId],
    );
    await client.query(
      "INSERT INTO identity_audit_events(id,event_type,actor_user_id,subject_user_id,details) VALUES($1,'password_reset',NULL,$2,$3)",
      [randomUUID(), userId, { provenance: "local_operator_recovery" }],
    );
    await client.query("COMMIT");
  } catch (error) {
    await client.query("ROLLBACK");
    throw error;
  } finally {
    client.release();
  }
}

async function readPassword(): Promise<string> {
  if (process.stdin.isTTY)
    throw new LocalRecoveryError(
      "Password must be supplied through standard input; use scripts/reset-password.ps1 for a masked prompt",
    );
  const chunks: Buffer[] = [];
  let bytes = 0;
  for await (const chunk of process.stdin) {
    const value = Buffer.isBuffer(chunk) ? chunk : Buffer.from(chunk);
    bytes += value.length;
    if (bytes > 258)
      throw new LocalRecoveryError("Password input exceeds 256 bytes");
    chunks.push(value);
  }
  return Buffer.concat(chunks)
    .toString("utf8")
    .replace(/[\r\n]+$/, "");
}

async function main() {
  const email = process.env.SHI_RECOVERY_EMAIL;
  if (!email) throw new LocalRecoveryError("Account email is required");
  const pool = createPool(loadConfig());
  try {
    await resetLocalPassword(pool, { email, password: await readPassword() });
    process.stdout.write(
      "Local password reset completed; all account sessions were revoked.\n",
    );
  } finally {
    await pool.end();
  }
}
const invokedFile = process.argv[1]
  ? fileURLToPath(import.meta.url)
  : undefined;
if (invokedFile && process.argv[1] === invokedFile)
  void main().catch((error) => {
    const safe =
      error instanceof LocalRecoveryError
        ? error.message
        : "Password reset failed; verify the account, migration state, and database availability";
    process.stderr.write(`${safe}\n`);
    process.exitCode = 1;
  });
