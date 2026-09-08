import { createHash, randomBytes, randomUUID } from "node:crypto";
import type { ClientPool } from "../../../../packages/persistence/src/index.js";

export const SESSION_COOKIE = "shi_session";
export const SESSION_TTL_SECONDS = 8 * 60 * 60;

export type AccountRole = "practice_admin" | "member";
export interface Actor { id: string; email: string; displayName: string; role: AccountRole }

function tokenHash(token: string): string {
  return createHash("sha256").update(token, "utf8").digest("hex");
}

export function readSessionToken(cookieHeader: string | undefined): string | null {
  if (!cookieHeader) return null;
  for (const item of cookieHeader.split(";")) {
    const [name, ...value] = item.trim().split("=");
    if (name === SESSION_COOKIE) {
      const token = value.join("=");
      return /^[A-Za-z0-9_-]{43}$/.test(token) ? token : null;
    }
  }
  return null;
}

export async function createSession(pool: ClientPool, userId: string): Promise<{ token: string; expiresAt: Date }> {
  const token = randomBytes(32).toString("base64url");
  const expiresAt = new Date(Date.now() + SESSION_TTL_SECONDS * 1000);
  await pool.query(
    "INSERT INTO app_sessions (id, user_id, token_hash, expires_at) VALUES ($1, $2, $3, $4)",
    [randomUUID(), userId, tokenHash(token), expiresAt]
  );
  return { token, expiresAt };
}

export async function resolveActor(pool: ClientPool, token: string | null): Promise<Actor | null> {
  if (!token) return null;
  const result = await pool.query(
    `SELECT u.id, u.email, u.display_name, u.role
       FROM app_sessions s
       JOIN app_users u ON u.id = s.user_id
      WHERE s.token_hash = $1
        AND s.revoked_at IS NULL
        AND s.expires_at > now()
        AND u.disabled_at IS NULL
      LIMIT 1`,
    [tokenHash(token)]
  );
  const row = result.rows[0] as { id: string; email: string; display_name: string; role: AccountRole } | undefined;
  return row ? { id: row.id, email: row.email, displayName: row.display_name, role: row.role } : null;
}

export async function revokeSession(pool: ClientPool, token: string | null): Promise<void> {
  if (!token) return;
  await pool.query("UPDATE app_sessions SET revoked_at = now() WHERE token_hash = $1 AND revoked_at IS NULL", [tokenHash(token)]);
}
