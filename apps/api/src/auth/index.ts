import { randomUUID } from "node:crypto";
import type { IncomingMessage, ServerResponse } from "node:http";
import type { ClientPool } from "../../../../packages/persistence/src/index.js";
import { hashPassword, verifyPassword } from "./password.js";
import { createSession, readSessionToken, resolveActor, revokeSession, SESSION_COOKIE, SESSION_TTL_SECONDS, type AccountRole, type Actor } from "./sessions.js";

const BODY_LIMIT = 16 * 1024;
const ATTEMPT_WINDOW_MS = 15 * 60 * 1000;
const MAX_PAIR_ATTEMPTS = 5;
const MAX_IP_ATTEMPTS = 25;
const MAX_THROTTLE_KEYS = 10_000;
const pairAttempts = new Map<string, number[]>();
const ipAttempts = new Map<string, number[]>();
const dummyPasswordHash = hashPassword("fixed dummy password for login checks");

function respond(response: ServerResponse, status: number, body?: unknown, headers: Record<string, string> = {}): void {
  const payload = body === undefined ? "" : JSON.stringify(body);
  response.writeHead(status, { "cache-control": "no-store", ...(payload ? { "content-type": "application/json; charset=utf-8", "content-length": String(Buffer.byteLength(payload)) } : {}), ...headers });
  response.end(payload);
}

async function readJson(request: IncomingMessage): Promise<Record<string, unknown>> {
  const declared = Number(request.headers["content-length"] ?? 0);
  if (Number.isFinite(declared) && declared > BODY_LIMIT) throw new Error("BODY_TOO_LARGE");
  const chunks: Buffer[] = [];
  let size = 0;
  for await (const chunk of request) {
    const buffer = Buffer.isBuffer(chunk) ? chunk : Buffer.from(chunk);
    size += buffer.length;
    if (size > BODY_LIMIT) throw new Error("BODY_TOO_LARGE");
    chunks.push(buffer);
  }
  try {
    const value: unknown = JSON.parse(Buffer.concat(chunks).toString("utf8"));
    if (!value || Array.isArray(value) || typeof value !== "object") throw new Error("INVALID_JSON");
    return value as Record<string, unknown>;
  } catch (error) {
    if (error instanceof Error && error.message === "BODY_TOO_LARGE") throw error;
    throw new Error("INVALID_JSON");
  }
}

function sameOrigin(request: IncomingMessage): boolean {
  if (request.headers["sec-fetch-site"] === "cross-site") return false;
  const origin = request.headers.origin;
  if (!origin) return true;
  const host = request.headers.host;
  if (!host) return false;
  const secure = Boolean((request.socket as typeof request.socket & { encrypted?: boolean }).encrypted);
  return origin === `${secure ? "https" : "http"}://${host}`;
}

function clientIp(request: IncomingMessage): string {
  return request.socket.remoteAddress ?? "unknown";
}

function recent(map: Map<string, number[]>, key: string, now: number): number[] {
  const values = (map.get(key) ?? []).filter((time) => time > now - ATTEMPT_WINDOW_MS);
  if (values.length) map.set(key, values); else map.delete(key);
  return values;
}

function isThrottled(ip: string, email: string): boolean {
  const now = Date.now();
  return recent(ipAttempts, ip, now).length >= MAX_IP_ATTEMPTS || recent(pairAttempts, `${ip}:${email}`, now).length >= MAX_PAIR_ATTEMPTS;
}

function addBounded(map: Map<string, number[]>, key: string, value: number): void {
  if (!map.has(key) && map.size >= MAX_THROTTLE_KEYS) {
    const oldest = map.keys().next().value as string | undefined;
    if (oldest) map.delete(oldest);
  }
  map.set(key, [...recent(map, key, value), value]);
}

function recordFailure(ip: string, email: string): void {
  const now = Date.now();
  addBounded(ipAttempts, ip, now);
  addBounded(pairAttempts, `${ip}:${email}`, now);
}

function cookie(token: string, secure: boolean, maxAge = SESSION_TTL_SECONDS): string {
  return `${SESSION_COOKIE}=${token}; Path=/; HttpOnly; SameSite=Strict; Max-Age=${maxAge}${secure ? "; Secure" : ""}`;
}

export async function resolveRequestActor(request: IncomingMessage, pool: ClientPool): Promise<Actor | null> {
  return resolveActor(pool, readSessionToken(request.headers.cookie));
}

export async function handleAuthRequest(request: IncomingMessage, response: ServerResponse, pool: ClientPool): Promise<boolean> {
  const method = request.method ?? "GET";
  const path = new URL(request.url ?? "/", "http://localhost").pathname;
  const authPath = path.startsWith("/api/v1/auth/");
  if (!authPath) return false;

  if (method === "GET" && path === "/api/v1/auth/session") {
    const actor = await resolveRequestActor(request, pool);
    respond(response, actor ? 200 : 401, actor ? { data: { actor } } : { error: { code: "UNAUTHENTICATED", message: "Authentication required" } });
    return true;
  }
  if (method === "POST" && !sameOrigin(request)) {
    respond(response, 403, { error: { code: "ORIGIN_REJECTED", message: "Request origin is not allowed" } });
    return true;
  }
  const parsesJson = method === "POST" && (path === "/api/v1/auth/login" || path === "/api/v1/auth/users");
  if (parsesJson && request.headers["content-type"]?.split(";", 1)[0]?.trim().toLowerCase() !== "application/json") {
    respond(response, 415, { error: { code: "UNSUPPORTED_MEDIA_TYPE", message: "Content-Type must be application/json" } });
    return true;
  }
  if (method === "POST" && path === "/api/v1/auth/login") {
    let body: Record<string, unknown>;
    try { body = await readJson(request); } catch (error) {
      const tooLarge = error instanceof Error && error.message === "BODY_TOO_LARGE";
      respond(response, tooLarge ? 413 : 400, { error: { code: tooLarge ? "BODY_TOO_LARGE" : "INVALID_JSON", message: tooLarge ? "Request body is too large" : "Request body must be valid JSON" } });
      return true;
    }
    const email = typeof body.email === "string" ? body.email.trim().toLowerCase() : "";
    const password = typeof body.password === "string" ? body.password : "";
    const ip = clientIp(request);
    if (!email || !password || isThrottled(ip, email)) {
      respond(response, !email || !password ? 400 : 429, { error: { code: !email || !password ? "INVALID_REQUEST" : "RATE_LIMITED", message: !email || !password ? "Email and password are required" : "Too many login attempts" } }, !email || !password ? {} : { "retry-after": "900" });
      return true;
    }
    const result = await pool.query("SELECT id, email, display_name, password_hash, role, disabled_at FROM app_users WHERE lower(email) = $1 LIMIT 1", [email]);
    const user = result.rows[0] as { id: string; email: string; display_name: string; password_hash: string; role: AccountRole; disabled_at: Date | null } | undefined;
    const valid = await verifyPassword(password, user && !user.disabled_at ? user.password_hash : await dummyPasswordHash);
    if (!user || !valid) {
      recordFailure(ip, email);
      respond(response, 401, { error: { code: "INVALID_CREDENTIALS", message: "Email or password is incorrect" } });
      return true;
    }
    const session = await createSession(pool, user.id);
    const actor: Actor = { id: user.id, email: user.email, displayName: user.display_name, role: user.role };
    const secure = Boolean((request.socket as typeof request.socket & { encrypted?: boolean }).encrypted);
    respond(response, 200, { data: { actor } }, { "set-cookie": cookie(session.token, secure) });
    return true;
  }
  if (method === "POST" && path === "/api/v1/auth/logout") {
    await revokeSession(pool, readSessionToken(request.headers.cookie));
    const secure = Boolean((request.socket as typeof request.socket & { encrypted?: boolean }).encrypted);
    respond(response, 204, undefined, { "set-cookie": cookie("", secure, 0) });
    return true;
  }
  if (method === "POST" && path === "/api/v1/auth/users") {
    const actor = await resolveRequestActor(request, pool);
    if (!actor) { respond(response, 401, { error: { code: "UNAUTHENTICATED", message: "Authentication required" } }); return true; }
    if (actor.role !== "practice_admin") { respond(response, 403, { error: { code: "FORBIDDEN", message: "Practice administrator access required" } }); return true; }
    let body: Record<string, unknown>;
    try { body = await readJson(request); } catch { respond(response, 400, { error: { code: "INVALID_JSON", message: "Request body must be valid JSON" } }); return true; }
    const email = typeof body.email === "string" ? body.email.trim().toLowerCase() : "";
    const displayName = typeof body.displayName === "string" ? body.displayName.trim() : "";
    const password = typeof body.password === "string" ? body.password : "";
    const role = body.role === "practice_admin" ? "practice_admin" : body.role === "member" ? "member" : null;
    const emailValid = email.length <= 254 && /^[^\s@]+@[^\s@]+\.[^\s@]+$/.test(email);
    if (!emailValid || !displayName || displayName.length > 100 || !role) { respond(response, 422, { error: { code: "VALIDATION_FAILED", message: "A valid email, displayName of at most 100 characters, password, and valid role are required" } }); return true; }
    let passwordHash: string;
    try { passwordHash = await hashPassword(password); } catch (error) { respond(response, 422, { error: { code: "VALIDATION_FAILED", message: error instanceof Error ? error.message : "Invalid password" } }); return true; }
    try {
      const id = randomUUID();
      const client = await pool.connect();
      try {
        await client.query("BEGIN");
        await client.query("INSERT INTO app_users (id, email, display_name, password_hash, role) VALUES ($1, $2, $3, $4, $5)", [id, email, displayName, passwordHash, role]);
        await client.query("INSERT INTO identity_audit_events (id, event_type, actor_user_id, subject_user_id, details) VALUES ($1, 'account_created', $2, $3, $4::jsonb)", [randomUUID(), actor.id, id, JSON.stringify({ email, role })]);
        await client.query("COMMIT");
      } catch (error) {
        await client.query("ROLLBACK");
        throw error;
      } finally { client.release(); }
      respond(response, 201, { data: { user: { id, email, displayName, role } } });
    } catch (error) {
      if ((error as { code?: string }).code === "23505") respond(response, 409, { error: { code: "EMAIL_EXISTS", message: "An account with this email already exists" } });
      else throw error;
    }
    return true;
  }
  respond(response, 405, { error: { code: "METHOD_NOT_ALLOWED", message: "Method not allowed" } }, { allow: path === "/api/v1/auth/session" ? "GET" : "POST" });
  return true;
}

export { hashPassword, verifyPassword, readSessionToken, resolveActor, revokeSession };
export type { Actor, AccountRole };
