export const TEMPLATE_VERSION_STATES = ['draft', 'published', 'retired'] as const;
export type TemplateVersionState = (typeof TEMPLATE_VERSION_STATES)[number];

export interface TemplateRoleDefinition {
  key: string;
  name: string;
  description?: string;
}

export interface StageDefinition {
  key: string;
  name: string;
  description?: string;
  accountableRoleKey: string;
  durationWorkingDays?: number;
  allowSkip?: boolean;
  dependsOn: string[];
  checklistItemKeys: string[];
}

export interface ChecklistItemDefinition {
  key: string;
  stageKey: string;
  name: string;
  description?: string;
  ownerRoleKey: string;
  required: boolean;
  dependsOn: string[];
  evidenceRequirementKeys?: string[];
}

export interface EvidenceRequirementDefinition {
  key: string;
  name: string;
  description?: string;
}

export type GateRule =
  | { type: 'hard-prerequisite'; itemKey: string }
  | { type: 'waivable-prerequisite'; itemKey: string; exceptionOwnerRoleKey: string }
  | { type: 'stage-complete'; stageKey: string };

export interface TemplateVersionDefinition {
  templateKey: string;
  version: number;
  state: TemplateVersionState;
  name: string;
  purpose: string;
  roles: TemplateRoleDefinition[];
  stages: StageDefinition[];
  checklistItems: ChecklistItemDefinition[];
  evidenceRequirements: EvidenceRequirementDefinition[];
  gateRules: GateRule[];
  sourceVersion?: number;
  revisionReason?: string;
}

/** A version definition that has not yet been published. */
export type TemplateVersionDraft = TemplateVersionDefinition;

export type PublishedTemplateVersion = ReadonlyDeep<TemplateVersionDefinition> & { readonly state: 'published' };

export interface ValidationResult {
  valid: boolean;
  errors: string[];
}

type ReadonlyDeep<T> = T extends (...args: never[]) => unknown
  ? T
  : T extends readonly (infer U)[]
    ? readonly ReadonlyDeep<U>[]
    : T extends object
      ? { readonly [K in keyof T]: ReadonlyDeep<T[K]> }
      : T;

const isRecord = (value: unknown): value is Record<string, unknown> =>
  typeof value === 'object' && value !== null;

const hasString = (value: unknown, key: string): value is string =>
  isRecord(value) && typeof value[key] === 'string' && value[key].trim().length > 0;

function duplicateKeys(values: Array<{ key: string }>, label: string, errors: string[]): Set<string> {
  const keys = new Set<string>();
  for (const value of values) {
    if (!hasString(value, 'key')) {
      errors.push(`${label} key must be a non-empty string`);
      continue;
    }
    if (keys.has(value.key)) errors.push(`Duplicate ${label} key: ${value.key}`);
    keys.add(value.key);
  }
  return keys;
}

function findCycles(graph: Map<string, string[]>): string[][] {
  const visiting = new Set<string>();
  const visited = new Set<string>();
  const cycles: string[][] = [];
  const path: string[] = [];

  function visit(key: string): void {
    if (visiting.has(key)) {
      const start = path.indexOf(key);
      cycles.push([...path.slice(start), key]);
      return;
    }
    if (visited.has(key)) return;
    visiting.add(key);
    path.push(key);
    for (const dependency of graph.get(key) ?? []) visit(dependency);
    path.pop();
    visiting.delete(key);
    visited.add(key);
  }

  for (const key of graph.keys()) visit(key);
  return cycles;
}

/**
 * Validate the declarative contract before persistence or publication.
 * The validator has no database, clock, or identity dependencies.
 */
export function validateTemplateVersion(template: TemplateVersionDefinition): ValidationResult {
  const errors: string[] = [];
  if (!isRecord(template)) return { valid: false, errors: ['Template version must be an object'] };
  if (!hasString(template, 'templateKey')) errors.push('Template key must be a non-empty string');
  if (!hasString(template, 'name')) errors.push('Template name must be a non-empty string');
  if (!hasString(template, 'purpose')) errors.push('Template purpose must be a non-empty string');
  if (!Number.isInteger(template.version) || template.version < 1) errors.push('Template version must be a positive integer');
  if (!TEMPLATE_VERSION_STATES.includes(template.state)) errors.push(`Unsupported template state: ${String(template.state)}`);

  if (!Array.isArray(template.roles)) errors.push('Roles must be an array');
  if (!Array.isArray(template.stages)) errors.push('Stages must be an array');
  if (!Array.isArray(template.checklistItems)) errors.push('Checklist items must be an array');
  if (!Array.isArray(template.evidenceRequirements)) errors.push('Evidence requirements must be an array');
  if (!Array.isArray(template.gateRules)) errors.push('Gate rules must be an array');
  if (
    !Array.isArray(template.roles) ||
    !Array.isArray(template.stages) ||
    !Array.isArray(template.checklistItems) ||
    !Array.isArray(template.evidenceRequirements) ||
    !Array.isArray(template.gateRules)
  ) {
    return { valid: false, errors };
  }

  const roles = template.roles;
  const stages = template.stages;
  const items = template.checklistItems;
  const evidence = template.evidenceRequirements;
  const roleKeys = duplicateKeys(roles, 'role', errors);
  const stageKeys = duplicateKeys(stages, 'stage', errors);
  const itemKeys = duplicateKeys(items, 'checklist item', errors);
  const evidenceKeys = duplicateKeys(evidence, 'evidence requirement', errors);

  const stageGraph = new Map<string, string[]>();
  for (const stage of stages) {
    if (!isRecord(stage) || !hasString(stage, 'key')) {
      errors.push('Stage definition must be an object with a non-empty key');
      continue;
    }
    if (!roleKeys.has(stage.accountableRoleKey)) errors.push(`Stage ${stage.key} references missing accountable role: ${stage.accountableRoleKey}`);
    if (!Array.isArray(stage.dependsOn)) errors.push(`Stage ${stage.key} dependencies must be an array`);
    if (!Array.isArray(stage.checklistItemKeys)) errors.push(`Stage ${stage.key} checklist item references must be an array`);
    const dependencies = Array.isArray(stage.dependsOn) ? stage.dependsOn : [];
    stageGraph.set(stage.key, dependencies);
    for (const dependency of dependencies) {
      if (!stageKeys.has(dependency)) errors.push(`Stage ${stage.key} references missing dependency: ${dependency}`);
    }
    if (stage.durationWorkingDays !== undefined && (!Number.isInteger(stage.durationWorkingDays) || stage.durationWorkingDays < 1)) {
      errors.push(`Stage ${stage.key} duration must be a positive integer`);
    }
  }
  for (const cycle of findCycles(stageGraph)) errors.push(`Stage dependency cycle: ${cycle.join(' -> ')}`);

  const itemGraph = new Map<string, string[]>();
  for (const item of items) {
    if (!isRecord(item) || !hasString(item, 'key')) {
      errors.push('Checklist item definition must be an object with a non-empty key');
      continue;
    }
    if (!stageKeys.has(item.stageKey)) errors.push(`Checklist item ${item.key} references missing stage: ${item.stageKey}`);
    if (!roleKeys.has(item.ownerRoleKey)) errors.push(`Checklist item ${item.key} references missing owner role: ${item.ownerRoleKey}`);
    if (!Array.isArray(item.dependsOn)) errors.push(`Checklist item ${item.key} dependencies must be an array`);
    const dependencies = Array.isArray(item.dependsOn) ? item.dependsOn : [];
    itemGraph.set(item.key, dependencies);
    for (const dependency of dependencies) {
      if (!itemKeys.has(dependency)) errors.push(`Checklist item ${item.key} references missing dependency: ${dependency}`);
    }
    if (item.evidenceRequirementKeys !== undefined) {
      if (!Array.isArray(item.evidenceRequirementKeys)) errors.push(`Checklist item ${item.key} evidence references must be an array`);
      else for (const evidenceKey of item.evidenceRequirementKeys) {
        if (!evidenceKeys.has(evidenceKey)) errors.push(`Checklist item ${item.key} references missing evidence requirement: ${evidenceKey}`);
      }
    }
  }
  for (const cycle of findCycles(itemGraph)) errors.push(`Checklist item dependency cycle: ${cycle.join(' -> ')}`);

  const referencedItems = new Set<string>();
  for (const stage of stages) {
    if (!isRecord(stage) || !hasString(stage, 'key')) continue;
    const stageItemKeys = new Set(Array.isArray(stage.checklistItemKeys) ? stage.checklistItemKeys : []);
    for (const itemKey of Array.isArray(stage.checklistItemKeys) ? stage.checklistItemKeys : []) {
      referencedItems.add(itemKey);
      if (!itemKeys.has(itemKey)) errors.push(`Stage ${stage.key} references missing checklist item: ${itemKey}`);
    }
    for (const item of items) {
      if (isRecord(item) && item.stageKey === stage.key && hasString(item, 'key') && !stageItemKeys.has(item.key)) {
        errors.push(`Checklist item ${item.key} is not listed on stage ${stage.key}`);
      }
    }
  }
  for (const item of items) {
    if (isRecord(item) && hasString(item, 'key') && !referencedItems.has(item.key)) errors.push(`Checklist item ${item.key} is not assigned to a stage`);
  }

  for (const rule of template.gateRules) {
    const ruleValue: unknown = rule;
    if (!isRecord(ruleValue) || typeof ruleValue.type !== 'string') {
      errors.push('Unsupported gate rule: rule type is missing');
    } else if (ruleValue.type === 'hard-prerequisite' || ruleValue.type === 'waivable-prerequisite') {
      if (typeof ruleValue.itemKey !== 'string' || !itemKeys.has(ruleValue.itemKey)) errors.push(`Gate rule references missing checklist item: ${String(ruleValue.itemKey)}`);
      if (ruleValue.type === 'waivable-prerequisite' && (typeof ruleValue.exceptionOwnerRoleKey !== 'string' || !roleKeys.has(ruleValue.exceptionOwnerRoleKey))) {
        errors.push(`Gate rule references missing exception owner role: ${String(ruleValue.exceptionOwnerRoleKey)}`);
      }
    } else if (ruleValue.type === 'stage-complete') {
      if (typeof ruleValue.stageKey !== 'string' || !stageKeys.has(ruleValue.stageKey)) errors.push(`Gate rule references missing stage: ${String(ruleValue.stageKey)}`);
    } else {
      errors.push(`Unsupported gate rule: ${ruleValue.type}`);
    }
  }

  return { valid: errors.length === 0, errors };
}

function deepFreeze<T>(value: T): T {
  if (!isRecord(value) && !Array.isArray(value)) return value;
  Object.freeze(value);
  for (const child of Object.values(value)) deepFreeze(child);
  return value;
}

function clone<T>(value: T): T {
  return structuredClone(value);
}

/** Convert a valid draft into an immutable published snapshot. */
export function publishTemplateVersion(template: TemplateVersionDefinition): PublishedTemplateVersion {
  if (template.state !== 'draft') throw new Error('Only draft template versions can be published');
  const validation = validateTemplateVersion(template);
  if (!validation.valid) throw new Error(`Invalid template version: ${validation.errors.join('; ')}`);
  return deepFreeze({ ...clone(template), state: 'published' }) as PublishedTemplateVersion;
}

/** Create the next editable version while preserving the source publication. */
export function createDraftVersion(
  source: PublishedTemplateVersion,
  changes: Partial<TemplateVersionDefinition>,
  revisionReason: string,
): TemplateVersionDraft {
  if (source.state !== 'published') throw new Error('A published template version is required');
  if (!revisionReason.trim()) throw new Error('A revision reason is required');
  const sourceClone = clone(source) as unknown as TemplateVersionDefinition;
  const draft: TemplateVersionDraft = {
    ...sourceClone,
    ...clone(changes),
    templateKey: source.templateKey,
    version: source.version + 1,
    state: 'draft' as const,
    sourceVersion: source.version,
    revisionReason,
  };
  const validation = validateTemplateVersion(draft);
  if (!validation.valid) throw new Error(`Invalid template version: ${validation.errors.join('; ')}`);
  return draft;
}
