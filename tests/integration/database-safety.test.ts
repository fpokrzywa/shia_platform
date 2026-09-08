import assert from "node:assert/strict";
import test from "node:test";
import { assertIsolatedTestDatabase, normalizeDatabaseTarget } from "./database-safety.js";

test("normalizes PostgreSQL loopback aliases and default ports", () => {
  assert.deepEqual(normalizeDatabaseTarget("postgresql://one@localhost/app"), {
    host: "loopback",
    port: 5432,
    database: "app"
  });
  assert.deepEqual(normalizeDatabaseTarget("postgres://two@[::1]:5432/app"), {
    host: "loopback",
    port: 5432,
    database: "app"
  });
});

test("refuses the normal database despite URL spelling and credential differences", () => {
  assert.throws(
    () =>
      assertIsolatedTestDatabase(
        "postgresql://normal:secret@localhost/app?sslmode=disable",
        "postgres://test:other@127.0.0.1:5432/app"
      ),
    /Refusing integration tests/
  );
});

test("accepts a distinct database on the same PostgreSQL server", () => {
  assert.doesNotThrow(() =>
    assertIsolatedTestDatabase("postgresql://user@localhost/app", "postgresql://user@localhost/app_test")
  );
});

test("refuses query parameters that can redirect the effective PostgreSQL target", () => {
  for (const parameter of ["host=127.0.0.1", "port=5433", "dbname=normal", "database=normal", "options=-csearch_path%3Dpublic"]) {
    assert.throws(
      () => normalizeDatabaseTarget(`postgresql://user@safe.example/test?${parameter}`),
      /must not override routing/
    );
  }
});
