import assert from "node:assert/strict";
import { createServer } from "node:http";
import test from "node:test";
import type { ClientPool } from "../../../../packages/persistence/src/index.js";
import { handleAuthRequest } from "./index.js";
import { hashPassword } from "./password.js";

type User = { id: string; email: string; display_name: string; password_hash: string; role: string; disabled_at: Date | null };
type Session = { id: string; user_id: string; token_hash: string; expires_at: Date; revoked_at: Date | null };

function fakePool(user: User): ClientPool & { sessions: Session[] } {
  const sessions: Session[] = [];
  const createdUsers: User[] = [];
  const query = async (sql: string, values: unknown[] = []) => {
    if (sql.includes("FROM app_users") && sql.includes("lower(email)")) {
      return { rows: user.email === values[0] ? [user] : [] };
    }
    if (sql.startsWith("INSERT INTO app_sessions")) {
      sessions.push({ id: values[0] as string, user_id: values[1] as string, token_hash: values[2] as string, expires_at: values[3] as Date, revoked_at: null });
      return { rows: [] };
    }
    if (sql.startsWith("INSERT INTO app_users")) {
      createdUsers.push({ id: values[0] as string, email: values[1] as string, display_name: values[2] as string, password_hash: values[3] as string, role: values[4] as string, disabled_at: null });
      return { rows: [] };
    }
    if (sql === "BEGIN" || sql === "COMMIT" || sql === "ROLLBACK" || sql.startsWith("INSERT INTO identity_audit_events")) return { rows: [] };
    if (sql.includes("FROM app_sessions s")) {
      const session = sessions.find((item) => item.token_hash === values[0] && !item.revoked_at && item.expires_at > new Date());
      return { rows: session ? [{ id: user.id, email: user.email, display_name: user.display_name, role: user.role }] : [] };
    }
    if (sql.startsWith("UPDATE app_sessions")) {
      const session = sessions.find((item) => item.token_hash === values[0]);
      if (session) session.revoked_at = new Date();
      return { rows: [] };
    }
    throw new Error(`Unexpected query: ${sql}`);
  };
  return { query, connect: async () => ({ query, release() {} }) as never, end: async () => {}, sessions, createdUsers } as ClientPool & { sessions: Session[]; createdUsers: User[] };
}

async function start(pool: ClientPool) {
  const server = createServer((req, res) => void handleAuthRequest(req, res, pool).then((handled) => {
    if (!handled) { res.statusCode = 404; res.end(); }
  }));
  await new Promise<void>((resolve) => server.listen(0, "127.0.0.1", resolve));
  const address = server.address();
  if (!address || typeof address === "string") throw new Error("missing address");
  return { server, origin: `http://127.0.0.1:${address.port}` };
}

test("login issues an opaque HttpOnly strict cookie and session resolves the actor", async () => {
  const password = "correct horse battery staple";
  const pool = fakePool({ id: "user-1", email: "member@example.com", display_name: "Member", password_hash: await hashPassword(password), role: "member", disabled_at: null });
  const { server, origin } = await start(pool);
  try {
    const login = await fetch(`${origin}/api/v1/auth/login`, { method: "POST", headers: { origin, "content-type": "application/json" }, body: JSON.stringify({ email: "MEMBER@example.com", password }) });
    assert.equal(login.status, 200);
    const cookie = login.headers.get("set-cookie") ?? "";
    assert.match(cookie, /^shi_session=[A-Za-z0-9_-]+;/);
    assert.match(cookie, /HttpOnly/);
    assert.match(cookie, /SameSite=Strict/);
    assert.equal(pool.sessions.length, 1);
    assert.equal(pool.sessions[0]?.token_hash.includes(cookie.split(/[=;]/)[1] ?? "missing"), false);

    const session = await fetch(`${origin}/api/v1/auth/session`, { headers: { cookie: cookie.split(";")[0] ?? "" } });
    assert.equal(session.status, 200);
    assert.deepEqual(await session.json(), { data: { actor: { id: "user-1", email: "member@example.com", displayName: "Member", role: "member" } } });
  } finally { await new Promise<void>((resolve) => server.close(() => resolve())); }
});

test("disabled users cannot log in", async () => {
  const password = "correct horse battery staple";
  const pool = fakePool({ id: "user-1", email: "member@example.com", display_name: "Member", password_hash: await hashPassword(password), role: "member", disabled_at: new Date() });
  const { server, origin } = await start(pool);
  try {
    const response = await fetch(`${origin}/api/v1/auth/login`, { method: "POST", headers: { origin, "content-type": "application/json" }, body: JSON.stringify({ email: "member@example.com", password }) });
    assert.equal(response.status, 401);
    assert.equal(pool.sessions.length, 0);
  } finally { await new Promise<void>((resolve) => server.close(() => resolve())); }
});

test("logout revokes the server-side session and rejects a cross-origin mutation", async () => {
  const password = "correct horse battery staple";
  const pool = fakePool({ id: "user-1", email: "member@example.com", display_name: "Member", password_hash: await hashPassword(password), role: "member", disabled_at: null });
  const { server, origin } = await start(pool);
  try {
    const login = await fetch(`${origin}/api/v1/auth/login`, { method: "POST", headers: { origin, "content-type": "application/json" }, body: JSON.stringify({ email: "member@example.com", password }) });
    const cookie = (login.headers.get("set-cookie") ?? "").split(";")[0] ?? "";
    const rejected = await fetch(`${origin}/api/v1/auth/logout`, { method: "POST", headers: { origin: "https://evil.example", cookie } });
    assert.equal(rejected.status, 403);
    const logout = await fetch(`${origin}/api/v1/auth/logout`, { method: "POST", headers: { origin, cookie, "content-type": "application/json" } });
    assert.equal(logout.status, 204);
    const session = await fetch(`${origin}/api/v1/auth/session`, { headers: { cookie } });
    assert.equal(session.status, 401);
  } finally { await new Promise<void>((resolve) => server.close(() => resolve())); }
});

test("only an authenticated practice administrator can create a member account", async () => {
  const password = "correct horse battery staple";
  const pool = fakePool({ id: "admin-1", email: "admin@example.com", display_name: "Admin", password_hash: await hashPassword(password), role: "practice_admin", disabled_at: null }) as ReturnType<typeof fakePool> & { createdUsers: User[] };
  const { server, origin } = await start(pool);
  try {
    const login = await fetch(`${origin}/api/v1/auth/login`, { method: "POST", headers: { origin, "content-type": "application/json" }, body: JSON.stringify({ email: "admin@example.com", password }) });
    const cookie = (login.headers.get("set-cookie") ?? "").split(";")[0] ?? "";
    const created = await fetch(`${origin}/api/v1/auth/users`, { method: "POST", headers: { origin, cookie, "content-type": "application/json" }, body: JSON.stringify({ email: "NEW@example.com", displayName: "New Member", password: "another strong password", role: "member" }) });
    assert.equal(created.status, 201);
    assert.equal(pool.createdUsers[0]?.email, "new@example.com");
    assert.equal(pool.createdUsers[0]?.role, "member");
    assert.equal(pool.createdUsers[0]?.password_hash.includes("another strong password"), false);
  } finally { await new Promise<void>((resolve) => server.close(() => resolve())); }
});

test("successful logins do not consume the failed-login throttle", async () => {
  const password = "correct horse battery staple";
  const pool = fakePool({ id: "repeat-1", email: "repeat@example.com", display_name: "Repeat", password_hash: await hashPassword(password), role: "member", disabled_at: null });
  const { server, origin } = await start(pool);
  try {
    for (let index = 0; index < 6; index += 1) {
      const response = await fetch(`${origin}/api/v1/auth/login`, { method: "POST", headers: { origin, "content-type": "application/json" }, body: JSON.stringify({ email: "repeat@example.com", password }) });
      assert.equal(response.status, 200);
    }
  } finally { await new Promise<void>((resolve) => server.close(() => resolve())); }
});
