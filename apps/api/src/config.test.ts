import test from "node:test";
import assert from "node:assert/strict";
import { ConfigurationError, loadConfig } from "./config.js";

test('automatic port selection is the default and accepts explicit zero', () => {
  for (const port of [undefined, '0']) {
    const env = { DATABASE_URL: 'postgresql://localhost/shi', ...(port === undefined ? {} : {PORT:port}) };
    assert.equal(loadConfig({loadEnvFiles:false,env}).port,0);
  }
});

test("loadConfig validates the database URL and applies local defaults", () => {
  const config = loadConfig({
    loadEnvFiles: false,
    cwd: "C:/shi",
    env: { DATABASE_URL: "postgresql://localhost/shi", PORT: "4310" }
  });
  assert.equal(config.databaseUrl, "postgresql://localhost/shi");
  assert.equal(config.port, 4310);
  assert.equal(config.host, "127.0.0.1");
  assert.equal(config.storageDir, "C:\\shi\\data");
});

test("loadConfig fails with an actionable key when required configuration is missing", () => {
  assert.throws(
    () => loadConfig({ loadEnvFiles: false, env: {} }),
    (error: unknown) => error instanceof ConfigurationError && error.message === "Missing required configuration: DATABASE_URL"
  );
});

test("loadConfig rejects invalid port and non-PostgreSQL URLs", () => {
  assert.throws(() => loadConfig({ loadEnvFiles: false, env: { DATABASE_URL: "https://example.test", PORT: "0" } }), ConfigurationError);
  assert.throws(() => loadConfig({ loadEnvFiles: false, env: { DATABASE_URL: "postgresql://localhost/shi", PORT: "abc" } }), ConfigurationError);
});

test('release web root is explicit and does not change the test-build default',()=>{
 assert.equal(loadConfig({loadEnvFiles:false,cwd:'C:/shi',env:{DATABASE_URL:'postgresql://localhost/shi',WEB_ROOT:'work/release-web'}}).webRoot,'C:\\shi\\work\\release-web');
 assert.equal(loadConfig({loadEnvFiles:false,env:{DATABASE_URL:'postgresql://localhost/shi'}}).webRoot,undefined);
});
