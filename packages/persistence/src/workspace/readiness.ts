import { randomUUID } from "node:crypto";
import type { PoolClient } from "pg";
import type { TemplateVersionDefinition } from "../../../domain/src/templates/index.js";
import type { ClientPool } from "../database.js";
import {
  ConflictError,
  NotFoundError,
  ValidationError,
  AuthorizationError,
} from "./errors.js";
import {
  authorizeEngagement,
  idempotent,
  inputHash,
  transaction,
} from "./shared.js";
import type { Actor, EngagementRole } from "./types.js";

export type ReadinessDecision = "go" | "conditional_go" | "no_go" | "reopen";
export interface ReadinessBlocker {
  itemId: string;
  itemKey: string;
  name: string;
  reason: "incomplete" | "missing_evidence" | "dependency_not_approved";
  classification: "hard" | "waivable" | "required";
  evidenceRequirementKey?: string;
}
export interface ReadinessException {
  itemId: string;
  ownerUserId: string;
  ownerName: string;
  dueDate: string;
  rationale: string;
}
export interface DecisionHistory {
  id: string;
  decision: ReadinessDecision;
  rationale: string;
  actorId: string;
  actorName: string;
  createdAt: string;
  token: string;
  effective: boolean;
  exceptions: ReadinessException[];
}
export interface StageReadiness {
  stageId: string;
  definitionKey: string;
  name: string;
  token: string;
  stateToken: string;
  requiredRole: EngagementRole | null;
  canReview: boolean;
  blockers: ReadinessBlocker[];
  waivableItems: Array<{
    itemId: string;
    itemKey: string;
    name: string;
    exceptionOwnerRole: EngagementRole | null;
  }>;
  notApplicableItems: Array<{
    itemId: string;
    itemKey: string;
    name: string;
    reason: "optional" | "waivable";
  }>;
  latestDecision: DecisionHistory | null;
  history: DecisionHistory[];
}
export interface ReadinessWorkspace {
  stages: StageReadiness[];
}

const iso = 2 * 1024 * 1024;
const mapRole = (key: string): EngagementRole | null =>
  key === "shi-engagement-lead"
    ? "engagement_lead"
    : key === "shi-technical-lead"
      ? "technical_lead"
      : null;
const futureDate = (value: string) =>
  /^\d{4}-\d{2}-\d{2}$/.test(value) &&
  new Date(`${value}T00:00:00Z`).valueOf() > Date.now();
const clean = (value: string, label: string) => {
  const result = value.trim();
  if (!result || result.length > 10000)
    throw new ValidationError(`${label} must contain 1 to 10000 characters`);
  return result;
};
async function lock(c: PoolClient, id: string) {
  await c.query("SELECT pg_advisory_xact_lock(hashtextextended($1,0))", [
    `readiness:${id}`,
  ]);
}

export async function buildReadinessWorkspace(
  c: PoolClient,
  actor: Actor,
  engagementId: string,
): Promise<ReadinessWorkspace> {
  const engagement = await c.query<{
    template_key: string;
    template_version: number;
  }>(
    "SELECT template_key,template_version FROM workspace_engagements WHERE id=$1",
    [engagementId],
  );
  if (!engagement.rows[0]) throw new NotFoundError("Engagement not found");
  const template = await c.query<{ definition: TemplateVersionDefinition }>(
    "SELECT definition FROM workspace_template_versions WHERE template_key=$1 AND version=$2",
    [engagement.rows[0].template_key, engagement.rows[0].template_version],
  );
  const definition = template.rows[0]!.definition;
  const stages = await c.query(
    "SELECT id,definition_key,state,revision FROM workspace_stage_instances WHERE engagement_id=$1 ORDER BY position",
    [engagementId],
  );
  const items = await c.query(
    "SELECT id,stage_id,definition_key,status,revision FROM workspace_checklist_instances WHERE engagement_id=$1",
    [engagementId],
  );
  const evidence = await c.query(
    "SELECT id,item_id,evidence_requirement_key FROM workspace_evidence WHERE engagement_id=$1 ORDER BY id",
    [engagementId],
  );
  const na = await c.query(
    "SELECT DISTINCT ON (item_id) id,item_id,item_revision FROM workspace_not_applicable_reviews WHERE engagement_id=$1 ORDER BY item_id,created_at DESC,id DESC",
    [engagementId],
  );
  const decisions = await c.query(
    "SELECT d.id,d.stage_id,d.decision,d.rationale,d.snapshot_token,d.snapshot,d.actor_id,d.created_at,u.display_name actor_name FROM workspace_readiness_decisions d JOIN app_users u ON u.id=d.actor_id WHERE d.engagement_id=$1 ORDER BY d.created_at DESC,d.id DESC",
    [engagementId],
  );
  const exceptions = await c.query(
    "SELECT x.decision_id,x.item_id,x.owner_user_id,u.display_name owner_name,x.due_date::text due_date,x.rationale FROM workspace_readiness_exceptions x JOIN workspace_readiness_decisions d ON d.id=x.decision_id JOIN app_users u ON u.id=x.owner_user_id WHERE d.engagement_id=$1 ORDER BY x.id",
    [engagementId],
  );
  const memberships = await c.query<{ user_id: string; role: EngagementRole }>(
    "SELECT user_id,role FROM workspace_engagement_memberships WHERE engagement_id=$1",
    [engagementId],
  );
  const actorRoles = new Set(
    memberships.rows.filter((x) => x.user_id === actor.id).map((x) => x.role),
  );
  const membershipKeys = new Set(
    memberships.rows.map((x) => `${x.user_id}:${x.role}`),
  );
  const stageRowByKey = new Map(
    stages.rows.map((x) => [
      String((x as Record<string, unknown>).definition_key),
      x as Record<string, unknown>,
    ]),
  );
  const itemRowByKey = new Map(
    items.rows.map((x) => [
      String((x as Record<string, unknown>).definition_key),
      x as Record<string, unknown>,
    ]),
  );
  const stageDefByKey = new Map(definition.stages.map((x) => [x.key, x]));
  const itemDefByKey = new Map(
    definition.checklistItems.map((x) => [x.key, x]),
  );
  const evidenceByItem = new Map<string, Set<string>>();
  const evidenceSnapshotByItem = new Map<
    string,
    Array<{ id: string; key: string | null }>
  >();
  for (const value of evidence.rows as Array<Record<string, unknown>>) {
    const set = evidenceByItem.get(String(value.item_id)) ?? new Set<string>();
    if (value.evidence_requirement_key)
      set.add(String(value.evidence_requirement_key));
    evidenceByItem.set(String(value.item_id), set);
    const entries = evidenceSnapshotByItem.get(String(value.item_id)) ?? [];
    entries.push({
      id: String(value.id),
      key: value.evidence_requirement_key
        ? String(value.evidence_requirement_key)
        : null,
    });
    evidenceSnapshotByItem.set(String(value.item_id), entries);
  }
  const naByItem = new Map(
    (na.rows as Array<Record<string, unknown>>).map((x) => [
      String(x.item_id),
      x,
    ]),
  );
  const exceptionsByDecision = new Map<string, ReadinessException[]>();
  for (const value of exceptions.rows as Array<Record<string, unknown>>) {
    const list = exceptionsByDecision.get(String(value.decision_id)) ?? [];
    list.push({
      itemId: String(value.item_id),
      ownerUserId: String(value.owner_user_id),
      ownerName: String(value.owner_name),
      dueDate: String(value.due_date),
      rationale: String(value.rationale),
    });
    exceptionsByDecision.set(String(value.decision_id), list);
  }
  const decisionRows = decisions.rows as Array<Record<string, unknown>>;
  const resultByKey = new Map<string, StageReadiness>();
  const orderedStageDefinitions: typeof definition.stages = [];
  const orderedKeys = new Set<string>();
  const orderStage = (key: string) => {
    if (orderedKeys.has(key)) return;
    orderedKeys.add(key);
    const stage = stageDefByKey.get(key);
    if (!stage) return;
    for (const dependency of stage.dependsOn) orderStage(dependency);
    orderedStageDefinitions.push(stage);
  };
  for (const stage of definition.stages) orderStage(stage.key);
  const ancestors = (key: string, seen = new Set<string>()): Set<string> => {
    for (const dep of stageDefByKey.get(key)?.dependsOn ?? []) {
      if (!seen.has(dep)) {
        seen.add(dep);
        ancestors(dep, seen);
      }
    }
    return seen;
  };
  for (const stageDef of orderedStageDefinitions) {
    const sr = stageRowByKey.get(stageDef.key)!;
    const requiredRole = mapRole(stageDef.accountableRoleKey);
    const target = definition.gateRules.some(
      (r) => r.type === "stage-complete" && r.stageKey === stageDef.key,
    );
    const hardKeys = new Set(
      target
        ? definition.gateRules
            .filter((r) => r.type === "hard-prerequisite")
            .map((r) => r.itemKey)
        : [],
    );
    const waiveRules = new Map(
      target
        ? definition.gateRules
            .filter((r) => r.type === "waivable-prerequisite")
            .map((r) => [r.itemKey, mapRole(r.exceptionOwnerRoleKey)])
        : [],
    );
    const scopeStages = new Set([stageDef.key, ...ancestors(stageDef.key)]);
    const scopeKeys = new Set<string>();
    const addScopeItem = (key: string) => {
      if (scopeKeys.has(key)) return;
      scopeKeys.add(key);
      for (const dependency of itemDefByKey.get(key)?.dependsOn ?? [])
        addScopeItem(dependency);
    };
    if (target) {
      for (const item of definition.checklistItems)
        if (
          scopeStages.has(item.stageKey) &&
          (item.required || hardKeys.has(item.key) || waiveRules.has(item.key))
        )
          addScopeItem(item.key);
    } else {
      for (const key of stageDef.checklistItemKeys) {
        const item = itemDefByKey.get(key);
        if (item?.required) addScopeItem(key);
      }
    }
    const blockers: ReadinessBlocker[] = [];
    const waivableItems: StageReadiness["waivableItems"] = [];
    const notApplicableItems: StageReadiness["notApplicableItems"] = [];
    for (const key of scopeKeys) {
      const row = itemRowByKey.get(key);
      const item = itemDefByKey.get(key);
      if (!row || !item) continue;
      const hard = hardKeys.has(key);
      const waive = waiveRules.has(key);
      const classification = hard ? "hard" : waive ? "waivable" : "required";
      const validNa =
        row.status === "not_applicable" &&
        Number(naByItem.get(String(row.id))?.item_revision) ===
          Number(row.revision) &&
        !hard &&
        (waive || !item.required);
      if (waive)
        waivableItems.push({
          itemId: String(row.id),
          itemKey: key,
          name: item.name,
          exceptionOwnerRole: waiveRules.get(key) ?? null,
        });
      if (!hard && (waive || !item.required))
        notApplicableItems.push({
          itemId: String(row.id),
          itemKey: key,
          name: item.name,
          reason: waive ? "waivable" : "optional",
        });
      if (row.status !== "complete" && !validNa)
        blockers.push({
          itemId: String(row.id),
          itemKey: key,
          name: item.name,
          reason: "incomplete",
          classification,
        });
      if (row.status === "complete") {
        for (const requirement of item.evidenceRequirementKeys ?? []) {
          if (!evidenceByItem.get(String(row.id))?.has(requirement))
            blockers.push({
              itemId: String(row.id),
              itemKey: key,
              name: item.name,
              reason: "missing_evidence",
              classification,
              evidenceRequirementKey: requirement,
            });
        }
      }
    }
    for (const item of definition.checklistItems) {
      if (
        item.stageKey !== stageDef.key ||
        item.required ||
        notApplicableItems.some((entry) => entry.itemKey === item.key)
      )
        continue;
      const row = itemRowByKey.get(item.key);
      if (row)
        notApplicableItems.push({
          itemId: String(row.id),
          itemKey: item.key,
          name: item.name,
          reason: "optional",
        });
    }
    for (const dep of stageDef.dependsOn) {
      const upstream = resultByKey.get(dep);
      if (
        !upstream?.latestDecision?.effective ||
        !(["go", "conditional_go"] as string[]).includes(
          upstream.latestDecision.decision,
        )
      )
        blockers.push({
          itemId: "",
          itemKey: dep,
          name: stageDefByKey.get(dep)?.name ?? dep,
          reason: "dependency_not_approved",
          classification: "required",
        });
    }
    const snapshot = {
      templateKey: engagement.rows[0].template_key,
      templateVersion: engagement.rows[0].template_version,
      stageId: String(sr.id),
      stageRevision: Number(sr.revision),
      items: [...scopeKeys].sort().map((k) => {
        const row = itemRowByKey.get(k)!;
        return {
          key: k,
          id: row.id,
          revision: Number(row.revision),
          status: row.status,
          evidence: (evidenceSnapshotByItem.get(String(row.id)) ?? []).sort(
            (a, b) => a.id.localeCompare(b.id),
          ),
          na: naByItem.get(String(row.id))?.id ?? null,
        };
      }),
      dependencies: stageDef.dependsOn.map((k) => ({
        key: k,
        decision: resultByKey.get(k)?.latestDecision?.id ?? null,
        effective: resultByKey.get(k)?.latestDecision?.effective ?? false,
      })),
    };
    const baseToken = inputHash(snapshot);
    const latestRow = decisionRows.find(
      (x) => String(x.stage_id) === String(sr.id),
    );
    const token = inputHash({
      baseToken,
      latestDecisionId: latestRow?.id ?? null,
    });
    const history: DecisionHistory[] = decisionRows
      .filter((x) => String(x.stage_id) === String(sr.id))
      .map((x) => ({
        id: String(x.id),
        decision: x.decision as ReadinessDecision,
        rationale: String(x.rationale),
        actorId: String(x.actor_id),
        actorName: String(x.actor_name),
        createdAt: new Date(String(x.created_at)).toISOString(),
        token: String(x.snapshot_token),
        effective: false,
        exceptions: exceptionsByDecision.get(String(x.id)) ?? [],
      }));
    const latestGate = history.find((entry) => entry.decision !== "reopen");
    for (const entry of history) {
      const source = decisionRows.find((row) => String(row.id) === entry.id);
      if (
        entry.id !== latestGate?.id ||
        String((source?.snapshot as { baseToken?: string }).baseToken) !==
          baseToken
      )
        continue;
      if (entry.decision === "conditional_go") {
        entry.effective = entry.exceptions.every((exception) => {
          const itemKey = [...itemRowByKey.entries()].find(
            ([, row]) => String(row.id) === exception.itemId,
          )?.[0];
          const requiredRole = itemKey ? waiveRules.get(itemKey) : null;
          return Boolean(
            requiredRole &&
            futureDate(exception.dueDate) &&
            membershipKeys.has(`${exception.ownerUserId}:${requiredRole}`),
          );
        });
      } else entry.effective = entry.decision !== "reopen";
    }
    const canReview =
      actor.role === "practice_admin" ||
      actorRoles.has("reviewer") ||
      (requiredRole !== null && actorRoles.has(requiredRole));
    resultByKey.set(stageDef.key, {
      stageId: String(sr.id),
      definitionKey: stageDef.key,
      name: stageDef.name,
      token,
      stateToken: baseToken,
      requiredRole,
      canReview,
      blockers,
      waivableItems,
      notApplicableItems,
      latestDecision: latestGate ?? null,
      history,
    });
  }
  return { stages: definition.stages.map((x) => resultByKey.get(x.key)!) };
}

export class ReadinessService {
  constructor(private readonly pool: ClientPool) {}
  async get(actor: Actor, engagementId: string) {
    return transaction(this.pool, async (c) => {
      await lock(c, engagementId);
      await authorizeEngagement(c, actor, engagementId, "readiness.read");
      return buildReadinessWorkspace(c, actor, engagementId);
    });
  }
  async decide(
    actor: Actor,
    engagementId: string,
    stageId: string,
    input: {
      requestKey: string;
      expectedToken: string;
      decision: string;
      rationale: string;
      exceptions?: Array<{
        itemId: string;
        ownerUserId: string;
        dueDate: string;
        rationale: string;
      }>;
    },
  ) {
    const rationale = clean(input.rationale, "Decision rationale");
    if (
      !(["go", "conditional_go", "no_go"] as string[]).includes(input.decision)
    )
      throw new ValidationError("Unsupported readiness decision");
    return transaction(this.pool, async (c) => {
      await lock(c, engagementId);
      await authorizeEngagement(c, actor, engagementId, "readiness.decide");
      return idempotent(
        c,
        actor,
        "readiness.decide",
        input.requestKey,
        { engagementId, stageId, ...input },
        async () => {
          const workspace = await buildReadinessWorkspace(
            c,
            actor,
            engagementId,
          );
          const stage = workspace.stages.find((x) => x.stageId === stageId);
          if (!stage) throw new NotFoundError("Stage not found");
          if (!stage.canReview)
            throw new AuthorizationError("Reviewer assignment is required");
          if (stage.token !== input.expectedToken)
            throw new ConflictError("Readiness preview is stale");
          if (input.decision === "go" && stage.blockers.length)
            throw new ValidationError(
              "Go requires all readiness blockers to be resolved",
            );
          const supplied = input.exceptions ?? [];
          if (input.decision === "conditional_go") {
            if (
              !stage.blockers.length ||
              stage.blockers.some((x) => x.classification !== "waivable")
            )
              throw new ValidationError(
                "Conditional go may only address waivable blockers",
              );
            const needed = new Set(stage.blockers.map((x) => x.itemId));
            if (
              supplied.length !== needed.size ||
              supplied.some((x) => !needed.has(x.itemId))
            )
              throw new ValidationError(
                "Each waivable blocker requires exactly one exception",
              );
            for (const exception of supplied) {
              clean(exception.rationale, "Exception rationale");
              if (!futureDate(exception.dueDate))
                throw new ValidationError(
                  "Exception due date must be in the future",
                );
              const rule = stage.waivableItems.find(
                (x) => x.itemId === exception.itemId,
              );
              if (!rule?.exceptionOwnerRole)
                throw new ValidationError(
                  "Exception owner role is not internally assignable",
                );
              const owner = await c.query(
                "SELECT 1 FROM workspace_engagement_memberships WHERE engagement_id=$1 AND user_id=$2 AND role=$3",
                [engagementId, exception.ownerUserId, rule.exceptionOwnerRole],
              );
              if (!owner.rowCount)
                throw new ValidationError(
                  "Exception owner lacks the required engagement role",
                );
            }
          } else if (supplied.length)
            throw new ValidationError(
              "Exceptions are only valid for conditional go",
            );
          const id = randomUUID();
          await c.query(
            "INSERT INTO workspace_readiness_decisions(id,engagement_id,stage_id,decision,rationale,snapshot_token,snapshot,actor_id) VALUES($1,$2,$3,$4,$5,$6,$7,$8)",
            [
              id,
              engagementId,
              stageId,
              input.decision,
              rationale,
              stage.token,
              { blockers: stage.blockers, baseToken: stage.stateToken },
              actor.id,
            ],
          );
          for (const exception of supplied)
            await c.query(
              "INSERT INTO workspace_readiness_exceptions(id,decision_id,item_id,owner_user_id,due_date,rationale) VALUES($1,$2,$3,$4,$5,$6)",
              [
                randomUUID(),
                id,
                exception.itemId,
                exception.ownerUserId,
                exception.dueDate,
                exception.rationale.trim(),
              ],
            );
          await c.query(
            "UPDATE workspace_stage_instances SET state=$3 WHERE id=$1 AND engagement_id=$2",
            [
              stageId,
              engagementId,
              input.decision === "no_go" ? "awaiting_review" : "complete",
            ],
          );
          await c.query(
            "INSERT INTO workspace_audit_events(actor_id,action,engagement_id,details) VALUES($1,$2,$3,$4)",
            [
              actor.id,
              "readiness.decide",
              engagementId,
              {
                stageId,
                decisionId: id,
                decision: input.decision,
                adminOverride: actor.role === "practice_admin",
              },
            ],
          );
          return (
            await buildReadinessWorkspace(c, actor, engagementId)
          ).stages.find((x) => x.stageId === stageId)!;
        },
      );
    });
  }
  async reopen(
    actor: Actor,
    engagementId: string,
    stageId: string,
    input: { requestKey: string; expectedToken: string; rationale: string },
  ) {
    const rationale = clean(input.rationale, "Reopen rationale");
    return transaction(this.pool, async (c) => {
      await lock(c, engagementId);
      await authorizeEngagement(c, actor, engagementId, "readiness.reopen");
      return idempotent(
        c,
        actor,
        "readiness.reopen",
        input.requestKey,
        { engagementId, stageId, ...input },
        async () => {
          const stage = (
            await buildReadinessWorkspace(c, actor, engagementId)
          ).stages.find((x) => x.stageId === stageId);
          if (!stage) throw new NotFoundError("Stage not found");
          if (!stage.canReview)
            throw new AuthorizationError("Reviewer assignment is required");
          if (stage.token !== input.expectedToken)
            throw new ConflictError("Readiness preview is stale");
          const reopenId = randomUUID();
          await c.query(
            "INSERT INTO workspace_readiness_decisions(id,engagement_id,stage_id,decision,rationale,snapshot_token,snapshot,actor_id) VALUES($1,$2,$3,'reopen',$4,$5,$6,$7)",
            [
              reopenId,
              engagementId,
              stageId,
              rationale,
              stage.token,
              { baseToken: stage.stateToken },
              actor.id,
            ],
          );
          const changed = await c.query(
            "UPDATE workspace_stage_instances SET state='active',revision=revision+1 WHERE id=$1 AND engagement_id=$2 AND state='complete'",
            [stageId, engagementId],
          );
          if (!changed.rowCount)
            throw new ValidationError("Only a completed stage can be reopened");
          await c.query(
            "INSERT INTO workspace_audit_events(actor_id,action,engagement_id,details) VALUES($1,$2,$3,$4)",
            [
              actor.id,
              "readiness.reopen",
              engagementId,
              {
                stageId,
                decisionId: reopenId,
                rationale,
                adminOverride: actor.role === "practice_admin",
              },
            ],
          );
          return (
            await buildReadinessWorkspace(c, actor, engagementId)
          ).stages.find((x) => x.stageId === stageId)!;
        },
      );
    });
  }
  async reviewNotApplicable(
    actor: Actor,
    engagementId: string,
    itemId: string,
    input: { requestKey: string; expectedToken: string; rationale: string },
  ) {
    const rationale = clean(input.rationale, "Not-applicable rationale");
    return transaction(this.pool, async (c) => {
      await lock(c, engagementId);
      await authorizeEngagement(
        c,
        actor,
        engagementId,
        "readiness.not_applicable",
      );
      return idempotent(
        c,
        actor,
        "readiness.not_applicable",
        input.requestKey,
        { engagementId, itemId, ...input },
        async () => {
          const item = await c.query<{
            stage_id: string;
            definition_key: string;
            revision: string;
            stage_state: string;
          }>(
            "SELECT i.stage_id,i.definition_key,i.revision,s.state stage_state FROM workspace_checklist_instances i JOIN workspace_stage_instances s ON s.id=i.stage_id AND s.engagement_id=i.engagement_id WHERE i.id=$1 AND i.engagement_id=$2 FOR UPDATE OF i",
            [itemId, engagementId],
          );
          const row = item.rows[0];
          if (!row) throw new NotFoundError("Checklist item not found");
          if (row.stage_state === "complete")
            throw new ValidationError(
              "Reopen the approved stage before reviewing checklist items",
            );
          const stage = (
            await buildReadinessWorkspace(c, actor, engagementId)
          ).stages.find((x) => x.stageId === row.stage_id)!;
          if (!stage.canReview)
            throw new AuthorizationError("Reviewer assignment is required");
          if (stage.token !== input.expectedToken)
            throw new ConflictError("Readiness preview is stale");
          if (!stage.notApplicableItems.some((x) => x.itemId === itemId))
            throw new ValidationError(
              "This checklist item cannot be marked not applicable",
            );
          const updated = await c.query<{ revision: string }>(
            "UPDATE workspace_checklist_instances SET status='not_applicable',revision=revision+1,completed_at=NULL,completed_by=NULL WHERE id=$1 RETURNING revision",
            [itemId],
          );
          await c.query(
            "INSERT INTO workspace_not_applicable_reviews(id,engagement_id,item_id,item_revision,snapshot_token,rationale,actor_id) VALUES($1,$2,$3,$4,$5,$6,$7)",
            [
              randomUUID(),
              engagementId,
              itemId,
              Number(updated.rows[0]!.revision),
              stage.token,
              rationale,
              actor.id,
            ],
          );
          await c.query(
            "INSERT INTO workspace_audit_events(actor_id,action,engagement_id,details) VALUES($1,$2,$3,$4)",
            [
              actor.id,
              "readiness.not_applicable",
              engagementId,
              {
                itemId,
                priorRevision: Number(row.revision),
                newRevision: Number(updated.rows[0]!.revision),
                adminOverride: actor.role === "practice_admin",
              },
            ],
          );
          return (
            await buildReadinessWorkspace(c, actor, engagementId)
          ).stages.find((x) => x.stageId === row.stage_id)!;
        },
      );
    });
  }
}
