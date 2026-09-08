import assert from "node:assert/strict";
import { readFile } from "node:fs/promises";
import test from "node:test";
import { DeliveryService } from "./delivery.js";

test("delivery service exposes the bounded tracking actions", () => {
  for (const method of [
    "get",
    "proposeScope",
    "decideScope",
    "createMilestone",
    "updateMilestone",
    "createRisk",
    "updateRisk",
    "addDecision",
    "createDeliverable",
    "updateDeliverable",
    "recordAcceptance",
    "createFollowup",
    "updateFollowup",
  ])
    assert.equal(
      typeof DeliveryService.prototype[method as keyof DeliveryService],
      "function",
      method,
    );
});

test("delivery migration constrains lifecycle states and engagement ownership", async () => {
  const sql = await readFile(
    new URL(
      "../../../../migrations/0007_delivery_tracking.sql",
      import.meta.url,
    ),
    "utf8",
  );
  assert.match(sql, /UNIQUE\(engagement_id,version\)/);
  assert.match(sql, /FOREIGN KEY\(deliverable_id,engagement_id\)/);
  assert.match(sql, /source_type IN\('internal','external'\)/);
  assert.match(sql, /status IN\('open','mitigated','accepted','closed'\)/);
});
