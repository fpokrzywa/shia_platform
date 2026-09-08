import test from "node:test";
import assert from "node:assert/strict";
import { createApiServer } from "./server.js";

function listen(server: ReturnType<typeof createApiServer>): Promise<number> {
  return new Promise((resolve) => {
    server.listen(0, "127.0.0.1", () => {
      const address = server.address();
      if (!address || typeof address === "string") throw new Error("Missing test server address");
      resolve(address.port);
    });
  });
}

test("health endpoints expose liveness and database readiness without secrets", async () => {
  const pool = { query: async () => ({ rows: [] }) };
  const server = createApiServer({ pool });
  const port = await listen(server);
  try {
    const live = await fetch(`http://127.0.0.1:${port}/health/live`);
    assert.equal(live.status, 200);
    assert.deepEqual(await live.json(), { status: "ok" });
    const ready = await fetch(`http://127.0.0.1:${port}/health/ready`);
    assert.equal(ready.status, 200);
    assert.deepEqual(await ready.json(), { status: "ready" });
    const missing = await fetch(`http://127.0.0.1:${port}/unknown`);
    assert.equal(missing.status, 404);
  } finally {
    await new Promise<void>((resolve, reject) => server.close((error) => (error ? reject(error) : resolve())));
  }
});

test("readiness returns unavailable when the database check fails", async () => {
  const server = createApiServer({ pool: { query: async () => { throw new Error("db unavailable"); } } });
  const port = await listen(server);
  try {
    const response = await fetch(`http://127.0.0.1:${port}/health/ready`);
    assert.equal(response.status, 503);
    assert.deepEqual(await response.json(), { status: "unavailable" });
  } finally {
    await new Promise<void>((resolve, reject) => server.close((error) => (error ? reject(error) : resolve())));
  }
});
