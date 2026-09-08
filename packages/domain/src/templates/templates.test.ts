import { readFile } from 'node:fs/promises';
import { test } from 'node:test';
import assert from 'node:assert/strict';

import {
  createDraftVersion,
  publishTemplateVersion,
  validateTemplateVersion,
  type TemplateVersionDraft,
} from './index.js';

const role = { key: 'lead', name: 'Engagement lead' };

function minimalTemplate(overrides: Partial<TemplateVersionDraft> = {}): TemplateVersionDraft {
  return {
    templateKey: 'test-template',
    version: 1,
    state: 'draft',
    name: 'Test template',
    purpose: 'A template used to exercise validation.',
    roles: [role],
    stages: [
      {
        key: 'prepare',
        name: 'Prepare',
        accountableRoleKey: 'lead',
        checklistItemKeys: ['brief'],
        dependsOn: [],
      },
    ],
    checklistItems: [
      {
        key: 'brief',
        stageKey: 'prepare',
        name: 'Client brief',
        ownerRoleKey: 'lead',
        required: true,
        dependsOn: [],
      },
    ],
    evidenceRequirements: [],
    gateRules: [{ type: 'hard-prerequisite', itemKey: 'brief' }],
    ...overrides,
  };
}

test('rejects duplicate stage and checklist keys', () => {
  const result = validateTemplateVersion(
    minimalTemplate({
      stages: [
        minimalTemplate().stages[0]!,
        { ...minimalTemplate().stages[0]!, name: 'Duplicate stage' },
      ],
      checklistItems: [
        minimalTemplate().checklistItems[0]!,
        { ...minimalTemplate().checklistItems[0]!, name: 'Duplicate item' },
      ],
    }),
  );

  assert.equal(result.valid, false);
  assert.match(result.errors.join('\n'), /duplicate stage key/i);
  assert.match(result.errors.join('\n'), /duplicate checklist item key/i);
});

test('rejects missing role and definition references', () => {
  const result = validateTemplateVersion(
    minimalTemplate({
      stages: [{ ...minimalTemplate().stages[0]!, accountableRoleKey: 'missing' }],
      checklistItems: [{ ...minimalTemplate().checklistItems[0]!, stageKey: 'missing', ownerRoleKey: 'missing' }],
      gateRules: [{ type: 'hard-prerequisite', itemKey: 'missing' }],
    }),
  );

  assert.equal(result.valid, false);
  assert.match(result.errors.join('\n'), /role/i);
  assert.match(result.errors.join('\n'), /stage/i);
  assert.match(result.errors.join('\n'), /gate rule.*checklist/i);
});

test('rejects dependency cycles and unsupported gate rules', () => {
  const result = validateTemplateVersion(
    minimalTemplate({
      stages: [
        { ...minimalTemplate().stages[0]!, key: 'prepare', dependsOn: ['review'] },
        { ...minimalTemplate().stages[0]!, key: 'review', checklistItemKeys: [], dependsOn: ['prepare'] },
      ],
      gateRules: [{ type: 'unsupported-rule', itemKey: 'brief' } as never],
    }),
  );

  assert.equal(result.valid, false);
  assert.match(result.errors.join('\n'), /cycle/i);
  assert.match(result.errors.join('\n'), /unsupported gate rule/i);
});

test('publishes a valid draft as a deeply immutable published snapshot', () => {
  const published = publishTemplateVersion(minimalTemplate());

  assert.equal(published.state, 'published');
  assert.equal(Object.isFrozen(published), true);
  assert.equal(Object.isFrozen(published.stages), true);
  assert.throws(() => {
    (published.stages[0] as { name: string }).name = 'changed';
  }, TypeError);
});

test('does not publish invalid, already published, or retired versions', () => {
  assert.throws(() => publishTemplateVersion(minimalTemplate({ version: 0 })), /invalid template/i);
  assert.throws(() => publishTemplateVersion(minimalTemplate({ state: 'published' })), /draft/i);
  assert.throws(() => publishTemplateVersion(minimalTemplate({ state: 'retired' })), /draft/i);
});

test('creates a new draft version from a published version with rationale', () => {
  const published = publishTemplateVersion(minimalTemplate());
  const draft = createDraftVersion(published, { purpose: 'Updated purpose' }, 'Clarify scope');

  assert.equal(draft.state, 'draft');
  assert.equal(draft.version, 2);
  assert.equal(draft.sourceVersion, 1);
  assert.equal(draft.revisionReason, 'Clarify scope');
  assert.equal(draft.purpose, 'Updated purpose');
  assert.equal(published.purpose, 'A template used to exercise validation.');
  assert.throws(() => createDraftVersion(published, {}, ''));
});

test('source definitions are valid drafts with the required workflow shape', async () => {
  const [apprenticeship, independent] = await Promise.all(
    ['apprenticeship.v1.json', 'independent-delivery.v1.json'].map(async (file) =>
      JSON.parse(await readFile(new URL(`../../../../templates/${file}`, import.meta.url), 'utf8')) as TemplateVersionDraft,
    ),
  );
  assert.ok(apprenticeship);
  assert.ok(independent);

  for (const template of [apprenticeship, independent]) {
    const result = validateTemplateVersion(template);
    assert.equal(result.valid, true, result.errors.join('\n'));
    assert.equal(template.state, 'draft');
    assert.equal(new Set(template.stages.map((stage) => stage.key)).size, template.stages.length);
    assert.equal(new Set(template.checklistItems.map((item) => item.key)).size, template.checklistItems.length);
  }

  const camps = apprenticeship.stages.filter((stage) => ['camp-1-shadowing', 'camp-2-assisted-delivery'].includes(stage.key));
  assert.equal(camps.length, 2);
  assert.deepEqual(
    camps.map((stage) => stage.durationWorkingDays),
    [10, 10],
  );
  assert.equal(independent.roles.some((roleDefinition) => /palantir/i.test(roleDefinition.name)), false);
});
