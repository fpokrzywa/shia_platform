import assert from "node:assert/strict";
import { randomUUID } from "node:crypto";
import { createServer } from "node:http";
import test from "node:test";
import { handleAuthRequest, hashPassword } from "../../apps/api/src/auth/index.js";
import { readMigrationFiles, runMigrations } from "../../packages/persistence/src/migrations.js";
import { createPostgresHarness } from "./postgres-harness.js";

test("sessions authenticate, expire, honor disabled users, and revoke on logout in real PostgreSQL", async () => {
  const harness = await createPostgresHarness();
  const server = createServer((request, response) => {
    void handleAuthRequest(request, response, harness.pool).then((handled) => {
      if (!handled) { response.statusCode = 404; response.end(); }
    });
  });
  try {
    await runMigrations(harness.pool, await readMigrationFiles("migrations"));
    const userId = randomUUID();
    const password = "integration password 123";
    await harness.pool.query(
      "INSERT INTO app_users(id,email,display_name,password_hash,role) VALUES($1,$2,$3,$4,$5)",
      [userId, "integration@example.test", "Integration User", await hashPassword(password), "member"]
    );
    await new Promise<void>((resolve) => server.listen(0, "127.0.0.1", resolve));
    const address = server.address();
    if (!address || typeof address === "string") throw new Error("Test server did not bind");
    const origin = `http://127.0.0.1:${address.port}`;

    const login = await fetch(`${origin}/api/v1/auth/login`, {
      method: "POST",
      headers: { origin, "content-type": "application/json" },
      body: JSON.stringify({ email: "INTEGRATION@example.test", password })
    });
    assert.equal(login.status, 200);
    const cookie = (login.headers.get("set-cookie") ?? "").split(";")[0] ?? "";
    assert.match(cookie, /^shi_session=/);
    assert.equal((await harness.pool.query("SELECT 1 FROM app_sessions")).rows.length, 1);

    assert.equal((await fetch(`${origin}/api/v1/auth/session`, { headers: { cookie } })).status, 200);
    await harness.pool.query("UPDATE app_sessions SET expires_at=now() - interval '1 second'");
    assert.equal((await fetch(`${origin}/api/v1/auth/session`, { headers: { cookie } })).status, 401);

    const secondLogin = await fetch(`${origin}/api/v1/auth/login`, {
      method: "POST", headers: { origin, "content-type": "application/json" },
      body: JSON.stringify({ email: "integration@example.test", password })
    });
    const secondCookie = (secondLogin.headers.get("set-cookie") ?? "").split(";")[0] ?? "";
    await harness.pool.query("UPDATE app_users SET disabled_at=now() WHERE id=$1", [userId]);
    assert.equal((await fetch(`${origin}/api/v1/auth/session`, { headers: { cookie: secondCookie } })).status, 401);
    await harness.pool.query("UPDATE app_users SET disabled_at=NULL WHERE id=$1", [userId]);

    const logout = await fetch(`${origin}/api/v1/auth/logout`, { method: "POST", headers: { origin, cookie: secondCookie } });
    assert.equal(logout.status, 204);
    assert.equal((await fetch(`${origin}/api/v1/auth/session`, { headers: { cookie: secondCookie } })).status, 401);
  } finally {
    await new Promise<void>((resolve) => server.close(() => resolve()));
    await harness.dispose();
  }
});
