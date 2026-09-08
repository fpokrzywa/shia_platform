import assert from "node:assert/strict";
import { test } from "node:test";

import { ConfigurationError, loadConfig } from "../../apps/api/src/config.js";
import { sanitize } from "../../apps/api/src/logger.js";

function baseEnv(overrides: NodeJS.ProcessEnv = {}): NodeJS.ProcessEnv {
  return {
    DATABASE_URL: "postgresql://localhost/shi_test",
    ...overrides,
  };
}

test("missing database configuration fails with an actionable, non-secret error", () => {
  const secret = "super-secret-value-that-must-not-appear";

  assert.throws(
    () => loadConfig({ env: { SESSION_SECRET: secret }, loadEnvFiles: false }),
    (error: unknown) => {
      assert(error instanceof ConfigurationError);
      assert.match(error.message, /missing required configuration: DATABASE_URL/i);
      assert.equal(error.message.includes(secret), false);
      return true;
    },
  );
});

test("invalid connection and session settings fail without echoing credentials", () => {
  const password = "db-password-that-must-not-appear";

  assert.throws(
    () =>
      loadConfig({
        env: baseEnv({
          DATABASE_URL: `http://user:${password}@db.example.invalid/shi`,
          SESSION_SECRET: "this-session-secret-is-long-enough",
        }),
        loadEnvFiles: false,
      }),
    (error: unknown) => {
      assert(error instanceof ConfigurationError);
      assert.match(error.message, /postgres.*scheme/i);
      assert.equal(error.message.includes(password), false);
      return true;
    },
  );

  assert.throws(
    () =>
      loadConfig({
        env: baseEnv({ SESSION_SECRET: "short" }),
        loadEnvFiles: false,
      }),
    (error: unknown) => {
      assert(error instanceof ConfigurationError);
      assert.match(error.message, /SESSION_SECRET.*16 characters/i);
      assert.equal(error.message.includes("short"), false);
      return true;
    },
  );
});

test("port validation rejects non-integer and out-of-range values", () => {
  for (const port of ["-1", "65536", "3.5", "abc"]) {
    assert.throws(
      () => loadConfig({ env: baseEnv({ PORT: port }), loadEnvFiles: false }),
      (error: unknown) => error instanceof ConfigurationError && /PORT/.test(error.message),
      `expected PORT=${port} to fail`,
    );
  }
});

test("configuration defaults remain usable when optional settings are absent", () => {
  const result = loadConfig({ env: baseEnv(), cwd: "C:/shi-review", loadEnvFiles: false });

  assert.equal(result.host, "127.0.0.1");
  assert.equal(result.port, 0);
  assert.equal(result.storageDir, "C:\\shi-review\\data");
  assert.equal("sessionSecret" in result, false);
});

test("diagnostic sanitization redacts nested secret values and credentials", () => {
  const value = sanitize({
    password: "password-value",
    nested: {
      apiKey: "api-key-value",
      authorization: "Bearer bearer-value",
      connection: "postgresql://db-user:db-password@db.example.invalid/shi",
      queryConnection: "postgresql://db.example.invalid/shi?password=query-secret",
    },
    values: ["Bearer array-token", { secret: "array-secret" }, "postgresql://db.example.invalid/shi?password=query-secret"],
  });

  assert.deepEqual(value, {
    password: "[redacted]",
    nested: {
      apiKey: "[redacted]",
      authorization: "[redacted]",
      connection: "[redacted]",
      queryConnection: "[redacted]",
    },
    values: ["Bearer [redacted]", { secret: "[redacted]" }, "postgresql://db.example.invalid/shi?password=[redacted]"],
  });
  assert.equal(JSON.stringify(value).includes("db-password"), false);

  // A connection URL can carry credentials in its query string as well.
  assert.equal(JSON.stringify(value).includes("query-secret"), false);
});
