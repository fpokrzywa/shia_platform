import assert from "node:assert/strict";
import test from "node:test";
import { deploymentLabel } from "./deployment-label.js";

test("deploymentLabel uses an explicit public label", () => {
  assert.equal(deploymentLabel(" SHI Agentic production "), "SHI Agentic production");
});

test("deploymentLabel retains a clear local default", () => {
  assert.equal(deploymentLabel(undefined), "Local development");
  assert.equal(deploymentLabel("   "), "Local development");
});
