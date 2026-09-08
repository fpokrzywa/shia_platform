import test from "node:test";
import assert from "node:assert/strict";
import { mkdtemp, writeFile, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import path from "node:path";
import { createApiServer } from "./server.js";

test("serves only built public assets and never workspace secrets", async () => {
  const directory = await mkdtemp(path.join(tmpdir(), "shi-static-"));
  await writeFile(
    path.join(directory, "index.html"),
    "<!doctype html><title>SHI Agentic</title>",
  );
  const server = createApiServer({
    pool: { query: async () => ({ rows: [] }) },
    webRoot: directory,
  });
  await new Promise<void>((resolve) => server.listen(0, "127.0.0.1", resolve));
  const address = server.address();
  assert(address && typeof address !== "string");
  const base = `http://127.0.0.1:${address.port}`;
  try {
    const root = await fetch(base);
    assert.equal(root.status, 200);
    assert.match(await root.text(), /SHI Agentic/);
    assert.match(
      root.headers.get("content-security-policy") ?? "",
      /default-src 'self'/,
    );
    for (const name of [
      "/.env.local",
      "/package.json",
      "/%2e%2e%2f.env.local",
      "/assets/%2e%2e%2f.env.local",
    ]) {
      const response = await fetch(base + name);
      assert.equal(response.status, 404);
    }
  } finally {
    await new Promise<void>((resolve) => server.close(() => resolve()));
    await rm(directory, { recursive: true });
  }
});
