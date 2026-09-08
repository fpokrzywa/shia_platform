import test from "node:test";
import assert from "node:assert/strict";
import { sanitize } from "./logger.js";

test("sanitize redacts credential-shaped fields and connection strings", () => {
  const output = sanitize({
    databaseUrl: "postgresql://admin:super-secret@localhost/shi",
    apiKey: "secret-key",
    message: "Authorization: Bearer very-secret"
  });
  assert.deepEqual(output, {
    databaseUrl: "[redacted]",
    apiKey: "[redacted]",
    message: "Authorization: Bearer [redacted]"
  });
});

test("sanitize redacts sensitive PostgreSQL query parameters in free-form strings", () => {
  assert.equal(
    sanitize("postgresql://db.example.invalid/shi?password=query-secret&sslmode=require"),
    "postgresql://db.example.invalid/shi?password=[redacted]&sslmode=require"
  );
});
