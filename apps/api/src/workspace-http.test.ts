import test from "node:test";
import assert from "node:assert/strict";
import { createApiServer } from "./server.js";
import type { ClientPool } from "../../../packages/persistence/src/index.js";

test("business endpoints deny anonymous requests before querying business records", async () => {
  const pool = {
    query: async () => {
      throw new Error("Unexpected query");
    },
    connect: async () => {
      throw new Error("Unexpected connection");
    },
    end: async () => {},
  } as unknown as ClientPool;
  const server = createApiServer({ pool });
  await new Promise<void>((resolve) => server.listen(0, "127.0.0.1", resolve));
  const address = server.address();
  assert(address && typeof address !== "string");
  try {
    for (const route of [
      "/api/templates",
      "/api/samples",
      "/api/training/sets",
      "/api/training/assignments",
      "/api/training/assignments/unknown/evidence/unknown/download",
      "/api/practice/cases",
      "/api/practice/self-start",
      "/api/practice/training/example/1/datasets/example/download",
      "/api/practice/assignments/unknown/reference",
      "/api/clients",
      "/api/users",
      "/api/engagements",
      "/api/engagements/unknown",
      "/api/engagements/unknown/members",
      "/api/engagements/unknown/work",
      "/api/engagements/unknown/readiness",
      "/api/engagements/unknown/delivery",
      "/api/engagements/unknown/readouts",
      "/api/engagements/unknown/readouts/unknown/markdown",
      "/api/engagements/unknown/work/evidence/unknown/download",
    ]) {
      const response: Response = await fetch(
        `http://127.0.0.1:${address.port}${route}`,
      );
      assert.equal(response.status, 401, route);
      assert.equal(
        (await response.json()).error,
        "Please sign in to continue.",
      );
    }
  } finally {
    await new Promise<void>((resolve) => server.close(() => resolve()));
  }
});

test("workspace mutation rejects cross-origin requests before authentication or database work", async () => {
  const pool = {
    query: async () => {
      throw new Error("Unexpected query");
    },
    connect: async () => {
      throw new Error("Unexpected connection");
    },
    end: async () => {},
  } as unknown as ClientPool;
  const server = createApiServer({ pool });
  await new Promise<void>((resolve) => server.listen(0, "127.0.0.1", resolve));
  const address = server.address();
  assert(address && typeof address !== "string");
  try {
    const response = await fetch(
      `http://127.0.0.1:${address.port}/api/practice/self-start`,
      {
        method: "POST",
        headers: {
          origin: "https://untrusted.example",
          "content-type": "application/json",
        },
        body: "{}",
      },
    );
    assert.equal(response.status, 403);
  } finally {
    await new Promise<void>((resolve) => server.close(() => resolve()));
  }
});

test("workspace mutations use configured public origin behind an HTTPS proxy", async () => {
  const pool = { query: async () => { throw new Error("Unexpected query"); }, connect: async () => { throw new Error("Unexpected connection"); }, end: async () => {} } as unknown as ClientPool;
  const publicOrigin = "https://shi.example.test", server = createApiServer({ pool, publicOrigin });
  await new Promise<void>((resolve) => server.listen(0, "127.0.0.1", resolve)); const address = server.address(); assert(address && typeof address !== "string");
  try {
    const url = `http://127.0.0.1:${address.port}/api/practice/self-start`, body = { method: "POST", headers: { origin: publicOrigin, "content-type": "application/json" }, body: "{}" } as const;
    assert.equal((await fetch(url, body)).status, 401);
    assert.equal((await fetch(url, { ...body, headers: { ...body.headers, origin: "https://other.example" } })).status, 403);
    assert.equal((await fetch(url, { ...body, headers: { ...body.headers, "sec-fetch-site": "cross-site" } })).status, 403);
  } finally { await new Promise<void>((resolve) => server.close(() => resolve())); }
});
