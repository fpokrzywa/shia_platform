import { randomUUID } from "node:crypto";
import type { PoolClient } from "pg";
import type { ClientPool } from "../database.js";
import {
  AuthorizationError,
  ConflictError,
  NotFoundError,
  ValidationError,
} from "./errors.js";
import { authorizeEngagement, idempotent, transaction } from "./shared.js";
import type { Actor } from "./types.js";

export type DeliveryRecord = Record<string, unknown>;
export interface DeliveryWorkspace {
  scopes: DeliveryRecord[];
  milestones: DeliveryRecord[];
  risks: DeliveryRecord[];
  decisions: DeliveryRecord[];
  deliverables: DeliveryRecord[];
  acceptance: DeliveryRecord[];
  followups: DeliveryRecord[];
}
async function snapshotRead<T>(
  pool: ClientPool,
  work: (client: PoolClient) => Promise<T>,
): Promise<T> {
  for (let attempt = 0; ; attempt += 1) {
    try {
      return await transaction(pool, work);
    } catch (error) {
      if (
        attempt >= 2 ||
        typeof error !== "object" ||
        error === null ||
        !("code" in error) ||
        error.code !== "40001"
      )
        throw error;
    }
  }
}
const tables = {
  milestone: "workspace_delivery_milestones",
  risk: "workspace_delivery_risks",
  deliverable: "workspace_deliverables",
  followup: "workspace_delivery_followups",
} as const;
const allowed = {
  milestone: new Set(["planned", "in_progress", "complete", "cancelled"]),
  risk: new Set(["open", "mitigated", "accepted", "closed"]),
  deliverable: new Set(["draft", "ready", "handed_over"]),
  followup: new Set(["open", "complete", "cancelled"]),
};
const text = (value: unknown, label: string, max = 10000) => {
  if (typeof value !== "string")
    throw new ValidationError(`${label} must be text`);
  const result = value.trim();
  if (!result || result.length > max)
    throw new ValidationError(`${label} must contain 1 to ${max} characters`);
  return result;
};
const date = (value: unknown) => {
  if (value == null) return value;
  if (typeof value !== "string")
    throw new ValidationError("Date must be YYYY-MM-DD");
  const parsed = new Date(`${value}T00:00:00Z`);
  if (
    !/^\d{4}-\d{2}-\d{2}$/.test(value) ||
    Number.isNaN(parsed.valueOf()) ||
    parsed.toISOString().slice(0, 10) !== value
  )
    throw new ValidationError("Date must be YYYY-MM-DD");
  return value;
};
const camel = (row: Record<string, unknown>) =>
  Object.fromEntries(
    Object.entries(row).map(([key, value]) => [
      key.replace(/_([a-z])/g, (_, c: string) => c.toUpperCase()),
      value instanceof Date
        ? value.toISOString()
        : key === "revision" || key === "version"
          ? Number(value)
          : value,
    ]),
  );
async function lock(c: PoolClient, id: string) {
  await c.query("SELECT pg_advisory_xact_lock(hashtextextended($1,0))", [
    `delivery:${id}`,
  ]);
}
async function member(c: PoolClient, engagementId: string, userId: string) {
  const found = await c.query(
    "SELECT 1 FROM workspace_engagement_memberships WHERE engagement_id=$1 AND user_id=$2 LIMIT 1",
    [engagementId, userId],
  );
  if (!found.rowCount)
    throw new ValidationError("Owner must be a current engagement member");
}
async function evidence(
  c: PoolClient,
  engagementId: string,
  evidenceId: string | undefined,
) {
  if (!evidenceId) return;
  const found = await c.query(
    "SELECT 1 FROM workspace_evidence WHERE id=$1 AND engagement_id=$2",
    [evidenceId, engagementId],
  );
  if (!found.rowCount)
    throw new ValidationError("Evidence must belong to this engagement");
}
async function reviewAuthority(
  c: PoolClient,
  actor: Actor,
  engagementId: string,
) {
  if (actor.role === "practice_admin") return;
  const found = await c.query(
    "SELECT 1 FROM workspace_engagement_memberships WHERE engagement_id=$1 AND user_id=$2 AND role IN('engagement_lead','reviewer')",
    [engagementId, actor.id],
  );
  if (!found.rowCount)
    throw new AuthorizationError(
      "Engagement lead or reviewer assignment is required",
    );
}

export class DeliveryService {
  constructor(private readonly pool: ClientPool) {}
  async get(actor: Actor, engagementId: string): Promise<DeliveryWorkspace> {
    return snapshotRead(this.pool, async (c) => {
      await c.query("SET TRANSACTION ISOLATION LEVEL REPEATABLE READ");
      await lock(c, engagementId);
      await authorizeEngagement(c, actor, engagementId, "delivery.read");
      const result: DeliveryWorkspace = {
        scopes: [],
        milestones: [],
        risks: [],
        decisions: [],
        deliverables: [],
        acceptance: [],
        followups: [],
      };
      for (const [key, sql] of Object.entries({
        scopes:
          "SELECT * FROM workspace_scope_versions WHERE engagement_id=$1 ORDER BY version DESC",
        milestones:
          "SELECT *,due_date::text due_date FROM workspace_delivery_milestones WHERE engagement_id=$1 ORDER BY workspace_delivery_milestones.due_date NULLS LAST,id",
        risks:
          "SELECT * FROM workspace_delivery_risks WHERE engagement_id=$1 ORDER BY status,severity,id",
        decisions:
          "SELECT * FROM workspace_delivery_decisions WHERE engagement_id=$1 ORDER BY created_at DESC,id",
        deliverables:
          "SELECT * FROM workspace_deliverables WHERE engagement_id=$1 ORDER BY created_at,id",
        acceptance:
          "SELECT * FROM workspace_acceptance_records WHERE engagement_id=$1 ORDER BY created_at DESC,id",
        followups:
          "SELECT *,due_date::text due_date FROM workspace_delivery_followups WHERE engagement_id=$1 ORDER BY status,workspace_delivery_followups.due_date NULLS LAST,id",
      })) {
        const rows = await c.query(sql, [engagementId]);
        (result[key as keyof DeliveryWorkspace] as DeliveryRecord[]).push(
          ...rows.rows.map((row) => camel(row)),
        );
      }
      return result;
    });
  }
  async proposeScope(
    actor: Actor,
    engagementId: string,
    input: {
      requestKey: string;
      commitments: string[];
      exclusions: string[];
      estimate: string;
      acceptanceCriteria: string[];
    },
  ) {
    if (
      !Array.isArray(input.commitments) ||
      !Array.isArray(input.exclusions) ||
      !Array.isArray(input.acceptanceCriteria)
    )
      throw new ValidationError(
        "Scope commitments, exclusions and acceptance criteria must be lists",
      );
    for (const [label, values] of [
      ["Commitments", input.commitments],
      ["Exclusions", input.exclusions],
      ["Acceptance criteria", input.acceptanceCriteria],
    ] as const) {
      if (values.length > 100)
        throw new ValidationError(`${label} may contain at most 100 entries`);
      values.forEach((value) => text(value, label, 1000));
    }
    text(input.estimate, "Estimate", 2000);
    return transaction(this.pool, async (c) => {
      await lock(c, engagementId);
      await authorizeEngagement(
        c,
        actor,
        engagementId,
        "delivery.scope_propose",
      );
      return idempotent(
        c,
        actor,
        "delivery.scope_propose",
        input.requestKey,
        { engagementId, ...input },
        async () => {
          const version = await c.query<{ next: number }>(
            "SELECT COALESCE(MAX(version),0)+1 next FROM workspace_scope_versions WHERE engagement_id=$1",
            [engagementId],
          );
          const row = await c.query(
            "INSERT INTO workspace_scope_versions(id,engagement_id,version,state,commitments,exclusions,estimate,acceptance_criteria,proposed_by) VALUES($1,$2,$3,'proposed',$4,$5,$6,$7,$8) RETURNING *",
            [
              randomUUID(),
              engagementId,
              version.rows[0]!.next,
              JSON.stringify(input.commitments.map((x) => x.trim())),
              JSON.stringify(input.exclusions.map((x) => x.trim())),
              input.estimate.trim(),
              JSON.stringify(input.acceptanceCriteria.map((x) => x.trim())),
              actor.id,
            ],
          );
          return this.audit(
            c,
            actor,
            engagementId,
            "delivery.scope_propose",
            camel(row.rows[0]),
          );
        },
      );
    });
  }
  async decideScope(
    actor: Actor,
    engagementId: string,
    scopeId: string,
    input: {
      requestKey: string;
      expectedRevision: number;
      decision: string;
      rationale: string;
      evidenceId?: string;
    },
  ) {
    if (!Number.isInteger(input.expectedRevision) || input.expectedRevision < 1)
      throw new ValidationError("Expected revision must be a positive integer");
    if (!["accepted", "rejected"].includes(input.decision))
      throw new ValidationError("Scope decision must be accepted or rejected");
    const rationale = text(input.rationale, "Rationale");
    return transaction(this.pool, async (c) => {
      await lock(c, engagementId);
      await authorizeEngagement(
        c,
        actor,
        engagementId,
        "delivery.scope_decide",
      );
      await reviewAuthority(c, actor, engagementId);
      await evidence(c, engagementId, input.evidenceId);
      return idempotent(
        c,
        actor,
        "delivery.scope_decide",
        input.requestKey,
        { engagementId, scopeId, ...input },
        async () => {
          const row = await c.query(
            "UPDATE workspace_scope_versions SET state=$3,revision=revision+1,decided_by=$4,decided_at=now(),decision_rationale=$5,evidence_id=$6 WHERE id=$1 AND engagement_id=$2 AND state='proposed' AND revision=$7 RETURNING *",
            [
              scopeId,
              engagementId,
              input.decision,
              actor.id,
              rationale,
              input.evidenceId ?? null,
              input.expectedRevision,
            ],
          );
          if (!row.rowCount)
            throw new ConflictError("Scope is stale or already decided");
          return this.audit(
            c,
            actor,
            engagementId,
            "delivery.scope_decide",
            camel(row.rows[0]),
          );
        },
      );
    });
  }
  async createMilestone(
    actor: Actor,
    id: string,
    input: {
      requestKey: string;
      title: string;
      ownerUserId?: string | null;
      dueDate?: string | null;
    },
  ) {
    return this.createMutable(actor, id, "milestone", {
      ...input,
      title: text(input.title, "Title", 300),
      status: "planned",
      ownerUserId: input.ownerUserId ?? null,
      dueDate: date(input.dueDate) ?? null,
    });
  }
  async updateMilestone(
    actor: Actor,
    id: string,
    recordId: string,
    input: {
      requestKey: string;
      expectedRevision: number;
      status: string;
      title?: string;
      ownerUserId?: string | null;
      dueDate?: string | null;
    },
  ) {
    return this.updateMutable(actor, id, "milestone", recordId, {
      ...input,
      ...(input.title !== undefined
        ? { title: text(input.title, "Title", 300) }
        : {}),
      ...(input.dueDate !== undefined ? { dueDate: date(input.dueDate) } : {}),
    });
  }
  async createRisk(
    actor: Actor,
    id: string,
    input: {
      requestKey: string;
      title: string;
      severity: string;
      mitigation: string;
      ownerUserId?: string | null;
    },
  ) {
    if (!["low", "medium", "high", "critical"].includes(input.severity))
      throw new ValidationError("Unsupported risk severity");
    return this.createMutable(actor, id, "risk", {
      ...input,
      title: text(input.title, "Title", 300),
      mitigation: text(input.mitigation, "Mitigation"),
      status: "open",
      ownerUserId: input.ownerUserId ?? null,
    });
  }
  async updateRisk(
    actor: Actor,
    id: string,
    recordId: string,
    input: {
      requestKey: string;
      expectedRevision: number;
      status: string;
      severity?: string;
      title?: string;
      mitigation?: string;
      ownerUserId?: string | null;
    },
  ) {
    if (
      input.severity !== undefined &&
      !["low", "medium", "high", "critical"].includes(input.severity)
    )
      throw new ValidationError("Unsupported risk severity");
    return this.updateMutable(actor, id, "risk", recordId, {
      ...input,
      ...(input.title !== undefined
        ? { title: text(input.title, "Title", 300) }
        : {}),
      ...(input.mitigation !== undefined
        ? { mitigation: text(input.mitigation, "Mitigation") }
        : {}),
    });
  }
  async addDecision(
    actor: Actor,
    id: string,
    input: {
      requestKey: string;
      title: string;
      decision: string;
      rationale: string;
    },
  ) {
    const values = {
      title: text(input.title, "Title", 300),
      decision: text(input.decision, "Decision"),
      rationale: text(input.rationale, "Rationale"),
    };
    return transaction(this.pool, async (c) => {
      await lock(c, id);
      await authorizeEngagement(c, actor, id, "delivery.decision_add");
      return idempotent(
        c,
        actor,
        "delivery.decision_add",
        input.requestKey,
        { engagementId: id, ...input },
        async () => {
          const row = await c.query(
            "INSERT INTO workspace_delivery_decisions(id,engagement_id,title,decision,rationale,actor_id) VALUES($1,$2,$3,$4,$5,$6) RETURNING *",
            [
              randomUUID(),
              id,
              values.title,
              values.decision,
              values.rationale,
              actor.id,
            ],
          );
          return this.audit(
            c,
            actor,
            id,
            "delivery.decision_add",
            camel(row.rows[0]),
          );
        },
      );
    });
  }
  async createDeliverable(
    actor: Actor,
    id: string,
    input: { requestKey: string; title: string; description: string },
  ) {
    return this.createMutable(actor, id, "deliverable", {
      ...input,
      title: text(input.title, "Title", 300),
      description: text(input.description, "Description"),
      status: "draft",
    });
  }
  async updateDeliverable(
    actor: Actor,
    id: string,
    recordId: string,
    input: {
      requestKey: string;
      expectedRevision: number;
      status: string;
      title?: string;
      description?: string;
    },
  ) {
    return this.updateMutable(actor, id, "deliverable", recordId, {
      ...input,
      ...(input.title !== undefined
        ? { title: text(input.title, "Title", 300) }
        : {}),
      ...(input.description !== undefined
        ? { description: text(input.description, "Description") }
        : {}),
    });
  }
  async recordAcceptance(
    actor: Actor,
    id: string,
    input: {
      requestKey: string;
      deliverableId?: string;
      result: string;
      rationale: string;
      sourceType: string;
      externalName?: string;
      evidenceId?: string;
    },
  ) {
    if (
      !["accepted", "rejected", "partial"].includes(input.result) ||
      !["internal", "external"].includes(input.sourceType)
    )
      throw new ValidationError("Unsupported acceptance record");
    const rationale = text(input.rationale, "Rationale");
    if (input.sourceType === "external" && !input.externalName?.trim())
      throw new ValidationError("External acceptance requires attribution");
    if (input.sourceType === "external" && !input.evidenceId)
      throw new ValidationError("External acceptance requires evidence");
    if (input.sourceType === "internal" && input.externalName !== undefined)
      throw new ValidationError(
        "Internal acceptance cannot impersonate an external approver",
      );
    return transaction(this.pool, async (c) => {
      await lock(c, id);
      await authorizeEngagement(c, actor, id, "delivery.acceptance_add");
      await reviewAuthority(c, actor, id);
      await evidence(c, id, input.evidenceId);
      return idempotent(
        c,
        actor,
        "delivery.acceptance_add",
        input.requestKey,
        { engagementId: id, ...input },
        async () => {
          if (input.deliverableId) {
            const found = await c.query(
              "SELECT 1 FROM workspace_deliverables WHERE id=$1 AND engagement_id=$2",
              [input.deliverableId, id],
            );
            if (!found.rowCount)
              throw new NotFoundError("Deliverable not found");
          }
          const row = await c.query(
            "INSERT INTO workspace_acceptance_records(id,engagement_id,deliverable_id,result,rationale,source_type,external_name,evidence_id,actor_id) VALUES($1,$2,$3,$4,$5,$6,$7,$8,$9) RETURNING *",
            [
              randomUUID(),
              id,
              input.deliverableId ?? null,
              input.result,
              rationale,
              input.sourceType,
              input.externalName?.trim() ?? null,
              input.evidenceId ?? null,
              actor.id,
            ],
          );
          return this.audit(
            c,
            actor,
            id,
            "delivery.acceptance_add",
            camel(row.rows[0]),
          );
        },
      );
    });
  }
  async createFollowup(
    actor: Actor,
    id: string,
    input: {
      requestKey: string;
      title: string;
      ownerUserId?: string | null;
      dueDate?: string | null;
    },
  ) {
    return this.createMutable(actor, id, "followup", {
      ...input,
      title: text(input.title, "Title", 300),
      status: "open",
      ownerUserId: input.ownerUserId ?? null,
      dueDate: date(input.dueDate) ?? null,
    });
  }
  async updateFollowup(
    actor: Actor,
    id: string,
    recordId: string,
    input: {
      requestKey: string;
      expectedRevision: number;
      status: string;
      title?: string;
      ownerUserId?: string | null;
      dueDate?: string | null;
    },
  ) {
    return this.updateMutable(actor, id, "followup", recordId, {
      ...input,
      ...(input.title !== undefined
        ? { title: text(input.title, "Title", 300) }
        : {}),
      ...(input.dueDate !== undefined ? { dueDate: date(input.dueDate) } : {}),
    });
  }
  private async createMutable(
    actor: Actor,
    engagementId: string,
    kind: keyof typeof tables,
    input: Record<string, unknown>,
  ) {
    return transaction(this.pool, async (c) => {
      await lock(c, engagementId);
      await authorizeEngagement(
        c,
        actor,
        engagementId,
        `delivery.${kind}_create`,
      );
      if (typeof input.ownerUserId === "string")
        await member(c, engagementId, input.ownerUserId);
      return idempotent(
        c,
        actor,
        `delivery.${kind}_create`,
        String(input.requestKey),
        { engagementId, ...input },
        async () => {
          const id = randomUUID();
          let row;
          if (kind === "milestone" || kind === "followup")
            row = await c.query(
              `INSERT INTO ${tables[kind]}(id,engagement_id,title,status,owner_user_id,due_date,created_by) VALUES($1,$2,$3,$4,$5,$6,$7) RETURNING *,due_date::text due_date`,
              [
                id,
                engagementId,
                input.title,
                input.status,
                input.ownerUserId,
                input.dueDate,
                actor.id,
              ],
            );
          else if (kind === "risk")
            row = await c.query(
              `INSERT INTO ${tables[kind]}(id,engagement_id,title,severity,status,mitigation,owner_user_id,created_by) VALUES($1,$2,$3,$4,$5,$6,$7,$8) RETURNING *`,
              [
                id,
                engagementId,
                input.title,
                input.severity,
                input.status,
                input.mitigation,
                input.ownerUserId,
                actor.id,
              ],
            );
          else
            row = await c.query(
              `INSERT INTO ${tables[kind]}(id,engagement_id,title,description,status,created_by) VALUES($1,$2,$3,$4,$5,$6) RETURNING *`,
              [
                id,
                engagementId,
                input.title,
                input.description,
                input.status,
                actor.id,
              ],
            );
          return this.audit(
            c,
            actor,
            engagementId,
            `delivery.${kind}_create`,
            camel(row.rows[0]),
          );
        },
      );
    });
  }
  private async updateMutable(
    actor: Actor,
    engagementId: string,
    kind: keyof typeof tables,
    recordId: string,
    input: Record<string, unknown>,
  ) {
    if (
      !Number.isInteger(input.expectedRevision) ||
      Number(input.expectedRevision) < 1
    )
      throw new ValidationError("Expected revision must be a positive integer");
    if (!allowed[kind].has(String(input.status)))
      throw new ValidationError(`Unsupported ${kind} status`);
    return transaction(this.pool, async (c) => {
      await lock(c, engagementId);
      await authorizeEngagement(
        c,
        actor,
        engagementId,
        `delivery.${kind}_update`,
      );
      if (typeof input.ownerUserId === "string")
        await member(c, engagementId, input.ownerUserId);
      return idempotent(
        c,
        actor,
        `delivery.${kind}_update`,
        String(input.requestKey),
        { engagementId, recordId, ...input },
        async () => {
          const existing = await c.query(
            `SELECT * FROM ${tables[kind]} WHERE id=$1 AND engagement_id=$2 FOR UPDATE`,
            [recordId, engagementId],
          );
          if (!existing.rowCount) throw new NotFoundError(`${kind} not found`);
          if (
            Number((existing.rows[0] as Record<string, unknown>).revision) !==
            Number(input.expectedRevision)
          )
            throw new ConflictError(`${kind} revision is stale`);
          const changes = Object.entries(input).filter(
            ([key]) => !["requestKey", "expectedRevision"].includes(key),
          );
          const columns: { [key: string]: string } = {
            ownerUserId: "owner_user_id",
            dueDate: "due_date",
          };
          const sets = changes.map(
            ([key], i) =>
              `${columns[key] ?? key.replace(/[A-Z]/g, (c) => `_${c.toLowerCase()}`)}=$${i + 3}`,
          );
          const row = await c.query(
            `UPDATE ${tables[kind]} SET ${sets.join(",")},revision=revision+1,updated_at=now() WHERE id=$1 AND engagement_id=$2 RETURNING *${kind === "milestone" || kind === "followup" ? ",due_date::text due_date" : ""}`,
            [recordId, engagementId, ...changes.map(([, value]) => value)],
          );
          return this.audit(
            c,
            actor,
            engagementId,
            `delivery.${kind}_update`,
            camel(row.rows[0]),
          );
        },
      );
    });
  }
  private async audit(
    c: PoolClient,
    actor: Actor,
    engagementId: string,
    action: string,
    result: DeliveryRecord,
  ) {
    await c.query(
      "INSERT INTO workspace_audit_events(actor_id,action,engagement_id,details) VALUES($1,$2,$3,$4)",
      [
        actor.id,
        action,
        engagementId,
        { recordId: result.id, revision: result.revision ?? null },
      ],
    );
    return result;
  }
}
