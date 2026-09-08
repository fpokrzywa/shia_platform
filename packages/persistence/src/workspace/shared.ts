import { createHash, randomUUID } from "node:crypto";
import type { PoolClient } from "pg";
import type { ClientPool } from "../database.js";
import { AuthorizationError, ConflictError, NotFoundError } from "./errors.js";
import type { Actor } from "./types.js";

export { randomUUID };

export async function transaction<T>(
  pool: ClientPool,
  work: (client: PoolClient) => Promise<T>,
): Promise<T> {
  const client = await pool.connect();
  try {
    await client.query("BEGIN");
    const result = await work(client);
    await client.query("COMMIT");
    return result;
  } catch (error) {
    await client.query("ROLLBACK");
    throw error;
  } finally {
    client.release();
  }
}

export function requireAdmin(actor: Actor): void {
  if (actor.role !== "practice_admin")
    throw new AuthorizationError("Practice administrator access is required");
}

function canonical(value: unknown): string {
  if (Array.isArray(value)) return `[${value.map(canonical).join(",")}]`;
  if (value !== null && typeof value === "object") {
    const record = value as Record<string, unknown>;
    return `{${Object.keys(record)
      .sort()
      .map((key) => `${JSON.stringify(key)}:${canonical(record[key])}`)
      .join(",")}}`;
  }
  return JSON.stringify(value);
}

export function inputHash(value: unknown): string {
  return createHash("sha256").update(canonical(value)).digest("hex");
}

export async function idempotent<T>(
  client: PoolClient,
  actor: Actor,
  action: string,
  requestKey: string,
  input: unknown,
  work: () => Promise<T>,
): Promise<T> {
  if (!requestKey.trim()) throw new ConflictError("A request key is required");
  const hash = inputHash(input);
  await client.query("SELECT pg_advisory_xact_lock(hashtextextended($1, 0))", [
    JSON.stringify([actor.id, action, requestKey]),
  ]);
  const existing = await client.query<{ input_hash: string; result: T }>(
    "SELECT input_hash, result FROM workspace_action_requests WHERE actor_id=$1 AND action=$2 AND request_key=$3 FOR UPDATE",
    [actor.id, action, requestKey],
  );
  if (existing.rows[0]) {
    if (existing.rows[0].input_hash !== hash)
      throw new ConflictError(
        "Request key was already used with different input",
      );
    return existing.rows[0].result;
  }
  const result = await work();
  await client.query(
    "INSERT INTO workspace_action_requests(actor_id,action,request_key,input_hash,result) VALUES($1,$2,$3,$4,$5)",
    [actor.id, action, requestKey, hash, result],
  );
  return result;
}

export async function authorizeEngagement(
  client: PoolClient,
  actor: Actor,
  engagementId: string,
  action: string,
): Promise<void> {
  const exists = await client.query(
    "SELECT 1 FROM workspace_engagements WHERE id=$1 FOR SHARE",
    [engagementId],
  );
  if (!exists.rowCount) throw new NotFoundError("Engagement not found");
  if (actor.role === "practice_admin") {
    await client.query(
      "INSERT INTO workspace_audit_events(actor_id,action,engagement_id,details) VALUES($1,$2,$3,$4)",
      [actor.id, "admin_access", engagementId, { requestedAction: action }],
    );
    return;
  }
  const member = await client.query(
    "SELECT 1 FROM workspace_engagement_memberships WHERE engagement_id=$1 AND user_id=$2 LIMIT 1",
    [engagementId, actor.id],
  );
  if (!member.rowCount)
    throw new AuthorizationError("Engagement membership is required");
}
