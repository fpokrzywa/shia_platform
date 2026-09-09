import assert from "node:assert/strict";
import test from "node:test";
import { fileURLToPath } from "node:url";
import { resolve } from "node:path";
import config from "../../apps/web/vite.config.js";

test("the web build reads Vite variables from the repository environment file", () => {
  const repositoryRoot = resolve(fileURLToPath(new URL("../..", import.meta.url)));
  assert.equal(config.envDir, repositoryRoot);
});
