import assert from "node:assert/strict";
import test from "node:test";
import { hashPassword, verifyPassword } from "./password.js";

test("scrypt hashes round-trip without storing the password", async () => {
  const encoded = await hashPassword("correct horse battery staple");
  assert.match(encoded, /^scrypt\$/);
  assert.equal(encoded.includes("correct horse"), false);
  assert.equal(await verifyPassword("correct horse battery staple", encoded), true);
  assert.equal(await verifyPassword("wrong password", encoded), false);
});

test("password hashing rejects unsafe input sizes", async () => {
  await assert.rejects(() => hashPassword("short"), /at least 12/);
  await assert.rejects(() => hashPassword("x".repeat(257)), /at most 256/);
});

test("password verification rejects malformed or excessive scrypt parameters", async () => {
  assert.equal(await verifyPassword("some password", "not-a-hash"), false);
  assert.equal(await verifyPassword("some password", "scrypt$1048576$8$1$AA==$AA=="), false);
});
