import assert from "node:assert/strict";
import { test } from "node:test";

import {
  createDraftVersion,
  publishTemplateVersion,
  validateTemplateVersion,
  type TemplateVersionDraft,
} from "../../packages/domain/src/templates/index.js";

function fixture(overrides: Partial<TemplateVersionDraft> = {}): TemplateVersionDraft {
  return {
    templateKey: "review-template",
    version: 1,
    state: "draft",
    name: "Review template",
    purpose: "A template for adversarial contract checks.",
    roles: [
      { key: "lead", name: "Engagement lead" },
      { key: "reviewer", name: "Reviewer" },
    ],
    stages: [
      {
        key: "prepare",
        name: "Prepare",
        accountableRoleKey: "lead",
        checklistItemKeys: ["brief", "access"],
        dependsOn: [],
      },
      {
        key: "review",
        name: "Review",
        accountableRoleKey: "reviewer",
        checklistItemKeys: ["decision"],
        dependsOn: ["prepare"],
      },
    ],
    checklistItems: [
      {
        key: "brief",
        stageKey: "prepare",
        name: "Client brief",
        ownerRoleKey: "lead",
        required: true,
        dependsOn: [],
        evidenceRequirementKeys: ["brief-doc"],
      },
      {
        key: "access",
        stageKey: "prepare",
        name: "Access checks",
        ownerRoleKey: "lead",
        required: true,
        dependsOn: ["brief"],
      },
      {
        key: "decision",
        stageKey: "review",
        name: "Readiness decision",
        ownerRoleKey: "reviewer",
        required: true,
        dependsOn: ["access"],
      },
    ],
    evidenceRequirements: [{ key: "brief-doc", name: "Brief document" }],
    gateRules: [
      { type: "hard-prerequisite", itemKey: "brief" },
      { type: "waivable-prerequisite", itemKey: "access", exceptionOwnerRoleKey: "reviewer" },
      { type: "stage-complete", stageKey: "review" },
    ],
    ...overrides,
  };
}

test("rejects cross-collection references and reverse stage membership gaps", () => {
  const draft = fixture({
    stages: [
      { ...fixture().stages[0]!, checklistItemKeys: ["brief", "missing-item"] },
      { ...fixture().stages[1]!, accountableRoleKey: "missing-role" },
    ],
    checklistItems: [
      { ...fixture().checklistItems[0]!, evidenceRequirementKeys: ["missing-evidence"] },
      { ...fixture().checklistItems[1]!, stageKey: "missing-stage" },
      { ...fixture().checklistItems[2]!, stageKey: "review", dependsOn: ["missing-item"] },
    ],
    gateRules: [
      { type: "waivable-prerequisite", itemKey: "brief", exceptionOwnerRoleKey: "missing-role" },
      { type: "stage-complete", stageKey: "missing-stage" },
    ],
  });

  const result = validateTemplateVersion(draft);

  assert.equal(result.valid, false);
  assert.match(result.errors.join("\n"), /missing (accountable )?role/i);
  assert.match(result.errors.join("\n"), /missing checklist item/i);
  assert.match(result.errors.join("\n"), /missing evidence requirement/i);
  assert.match(result.errors.join("\n"), /missing stage/i);
  assert.match(result.errors.join("\n"), /missing dependency/i);
});

test("rejects checklist dependency cycles even when stage dependencies are valid", () => {
  const base = fixture();
  const result = validateTemplateVersion({
    ...base,
    checklistItems: [
      { ...base.checklistItems[0]!, dependsOn: ["decision"] },
      base.checklistItems[1]!,
      { ...base.checklistItems[2]!, dependsOn: ["brief"] },
    ],
  });

  assert.equal(result.valid, false);
  assert.match(result.errors.join("\n"), /checklist item dependency cycle/i);
});

test("returns validation errors for malformed collection fields instead of throwing", () => {
  for (const [field, value] of [
    ["checklistItems", null],
    ["evidenceRequirements", {}],
    ["gateRules", "not-an-array"],
  ] as const) {
    const malformed = { ...fixture(), [field]: value };
    assert.doesNotThrow(() => {
      const result = validateTemplateVersion(malformed as never);
      assert.equal(result.valid, false);
      assert.match(result.errors.join("\n"), new RegExp(field.replace(/[A-Z]/g, (letter) => ` ${letter.toLowerCase()}`), "i"));
    }, `validator threw for malformed ${field}`);
  }
});

test("publishing freezes the complete snapshot and isolates it from the draft", () => {
  const draft = fixture();
  const published = publishTemplateVersion(draft);

  assert.equal(Object.isFrozen(published), true);
  assert.equal(Object.isFrozen(published.roles), true);
  assert.equal(Object.isFrozen(published.stages[0]), true);
  assert.equal(Object.isFrozen(published.stages[0]!.checklistItemKeys), true);
  assert.equal(Object.isFrozen(published.checklistItems[0]!.evidenceRequirementKeys), true);
  assert.equal(Object.isFrozen(published.gateRules[1]), true);

  draft.roles[0]!.name = "Changed draft role";
  draft.stages[0]!.checklistItemKeys.push("new-item");
  draft.checklistItems[0]!.evidenceRequirementKeys!.push("new-evidence");

  assert.equal(published.roles[0]!.name, "Engagement lead");
  assert.deepEqual(published.stages[0]!.checklistItemKeys, ["brief", "access"]);
  assert.deepEqual(published.checklistItems[0]!.evidenceRequirementKeys, ["brief-doc"]);
});

test("new draft versions clone changed nested definitions and preserve publication", () => {
  const published = publishTemplateVersion(fixture());
  const changes: Partial<TemplateVersionDraft> = {
    stages: fixture().stages.map((stage, index) =>
      index === 0 ? { ...stage, description: "Narrowed preparation scope" } : { ...stage },
    ),
  };
  const draft = createDraftVersion(published, changes, "Narrow preparation scope");

  changes.stages![0]!.checklistItemKeys.push("mutated-after-create");

  assert.equal(draft.version, published.version + 1);
  assert.equal(draft.sourceVersion, published.version);
  assert.equal(draft.stages[0]!.description, "Narrowed preparation scope");
  assert.deepEqual(draft.stages[0]!.checklistItemKeys, ["brief", "access"]);
  assert.deepEqual(published.stages[0]!.checklistItemKeys, ["brief", "access"]);
  assert.equal(Object.isFrozen(published), true);
});
