import { formatReadout } from "./readout-format.js";
import { randomUUID } from "node:crypto";
import type { PoolClient } from "pg";
import type { ClientPool } from "../database.js";
import {
  AuthorizationError,
  ConflictError,
  NotFoundError,
  ValidationError,
} from "./errors.js";
import {
  authorizeEngagement,
  idempotent,
  inputHash,
  transaction,
} from "./shared.js";
import type { Actor } from "./types.js";
import { buildReadinessWorkspace } from "./readiness.js";

export interface FinalReadout {
  id: string;
  engagementId: string;
  title: string;
  state: "draft" | "approved" | "rejected";
  revision: number;
  sourceHash: string;
  asOf: string;
  stale: boolean;
  snapshot: Record<string, unknown>;
  generatedBy: string;
  reviewedBy?: string;
  reviewedAt?: string;
  reviewRationale?: string;
}
export type FinalReadoutSummary = Omit<FinalReadout, "snapshot">;
const normalize = (value: unknown): unknown =>
  value instanceof Date
    ? value.toISOString()
    : Array.isArray(value)
      ? value.map(normalize)
      : value && typeof value === "object"
        ? Object.fromEntries(
            Object.entries(value as Record<string, unknown>).map(([k, v]) => [
              k,
              normalize(v),
            ]),
          )
        : value;
const clean = (value: unknown, label: string, max: number) => {
  if (typeof value !== "string")
    throw new ValidationError(`${label} must be text`);
  const result = value.trim();
  if (!result || result.length > max)
    throw new ValidationError(`${label} must contain 1 to ${max} characters`);
  return result;
};
async function snapshotLocks(c: PoolClient, id: string) {
  await c.query("SET TRANSACTION ISOLATION LEVEL REPEATABLE READ");
  await c.query("SELECT pg_advisory_xact_lock(hashtextextended($1,0))", [
    `readiness:${id}`,
  ]);
  await c.query("SELECT pg_advisory_xact_lock(hashtextextended($1,0))", [
    `delivery:${id}`,
  ]);
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
async function snapshot(
  c: PoolClient,
  engagementId: string,
): Promise<Record<string, unknown>> {
  const engagement = await c.query(
    "SELECT e.id,e.title,e.state,e.revision,e.template_key,e.template_version,v.definition->>'name' template_version_name,c.id client_id,c.name client_name FROM workspace_engagements e JOIN workspace_clients c ON c.id=e.client_id JOIN workspace_template_versions v ON v.template_key=e.template_key AND v.version=e.template_version WHERE e.id=$1",
    [engagementId],
  );
  if (!engagement.rows[0]) throw new NotFoundError("Engagement not found");
  const queries: [string, string][] = [
    [
      "checklist",
      "SELECT i.id,i.definition_key,i.definition->>'name' name,i.status,i.revision,i.owner_user_id,i.due_date::text due_date,s.definition_key stage_key,s.definition->>'name' stage_name FROM workspace_checklist_instances i JOIN workspace_stage_instances s ON s.id=i.stage_id AND s.engagement_id=i.engagement_id WHERE i.engagement_id=$1 ORDER BY s.position,i.position,i.id",
    ],
    [
      "evidence",
      "SELECT id,item_id,title,url,file_name,supplied_media_type,evidence_requirement_key,attachment IS NOT NULL has_attachment,COALESCE(octet_length(attachment),0) size,recorded_by,created_at FROM workspace_evidence WHERE engagement_id=$1 ORDER BY created_at,id",
    ],
    [
      "notes",
      "SELECT id,item_id,actor_id,body,created_at FROM workspace_engagement_notes WHERE engagement_id=$1 ORDER BY created_at,id",
    ],
    [
      "participants",
      "SELECT m.user_id,u.display_name,u.email,jsonb_agg(m.role ORDER BY m.role) roles FROM workspace_engagement_memberships m JOIN app_users u ON u.id=m.user_id WHERE m.engagement_id=$1 GROUP BY m.user_id,u.display_name,u.email ORDER BY u.display_name,m.user_id",
    ],
    [
      "scopes",
      "SELECT * FROM workspace_scope_versions WHERE engagement_id=$1 ORDER BY version",
    ],
    [
      "milestones",
      "SELECT *,due_date::text due_date FROM workspace_delivery_milestones WHERE engagement_id=$1 ORDER BY id",
    ],
    [
      "risks",
      "SELECT * FROM workspace_delivery_risks WHERE engagement_id=$1 ORDER BY id",
    ],
    [
      "decisions",
      "SELECT * FROM workspace_delivery_decisions WHERE engagement_id=$1 ORDER BY created_at,id",
    ],
    [
      "deliverables",
      "SELECT * FROM workspace_deliverables WHERE engagement_id=$1 ORDER BY id",
    ],
    [
      "acceptance",
      "SELECT * FROM workspace_acceptance_records WHERE engagement_id=$1 ORDER BY created_at,id",
    ],
    [
      "followups",
      "SELECT *,due_date::text due_date FROM workspace_delivery_followups WHERE engagement_id=$1 ORDER BY id",
    ],
    [
      "discoverySessions",
      "SELECT id,purpose,session_date::text session_date,participant_user_ids,summary,created_at FROM workspace_discovery_sessions WHERE engagement_id=$1 ORDER BY session_date,id",
    ],
    [
      "useCases",
      "SELECT id,title,problem_statement,actor_description,desired_outcome FROM workspace_discovery_use_cases WHERE engagement_id=$1 ORDER BY created_at,id",
    ],
    [
      "assumptions",
      "SELECT id,statement,status,rationale FROM workspace_discovery_assumptions WHERE engagement_id=$1 ORDER BY status,id",
    ],
    [
      "approaches",
      "SELECT id,title,description,status,rationale,effort_value,effort_unit FROM workspace_discovery_approaches WHERE engagement_id=$1 ORDER BY status,id",
    ],
    [
      "outcomeMetrics",
      "SELECT id,name,unit,description,baseline,target FROM workspace_outcome_metrics WHERE engagement_id=$1 ORDER BY created_at,id",
    ],
    [
      "outcomeObservations",
      "SELECT o.id,o.metric_id,o.observed_on::text observed_on,o.value,o.note,e.title evidence_title,o.created_at FROM workspace_outcome_observations o LEFT JOIN workspace_evidence e ON e.id=o.evidence_id WHERE o.engagement_id=$1 ORDER BY o.observed_on,o.id",
    ],
    [
      "trainingReferences",
      "SELECT DISTINCT a.training_key,a.training_version version,s.name,s.purpose,v.state FROM workspace_training_assignments a JOIN workspace_training_sets s ON s.training_key=a.training_key JOIN workspace_training_versions v ON v.training_key=a.training_key AND v.version=a.training_version WHERE a.engagement_id=$1 AND v.state IN('published','retired') ORDER BY s.name,a.training_key,a.training_version",
    ],
    [
      "knowledgeReferences",
      "SELECT l.knowledge_key,l.knowledge_version version,s.kind,s.title,v.state,l.rationale,l.linked_at FROM workspace_knowledge_links l JOIN workspace_knowledge_sets s ON s.knowledge_key=l.knowledge_key JOIN workspace_knowledge_versions v ON v.knowledge_key=l.knowledge_key AND v.version=l.knowledge_version WHERE l.engagement_id=$1 ORDER BY s.title,l.knowledge_key,l.knowledge_version",
    ],
  ];
  const result: Record<string, unknown> = {
    engagement: normalize(engagement.rows[0]),
  };
  for (const [key, sql] of queries) {
    const rows = await c.query(sql, [engagementId]);
    result[key] = normalize(rows.rows);
  }
  const readiness = await buildReadinessWorkspace(
    c,
    { id: "snapshot", role: "practice_admin" },
    engagementId,
  );
  result.readiness = normalize({
    stages: readiness.stages.map(({ canReview: _, ...stage }) => stage),
  });
  const checklist = result.checklist as Array<Record<string, unknown>>;
  const risks = result.risks as Array<Record<string, unknown>>;
  const milestones = result.milestones as Array<Record<string, unknown>>;
  const followups = result.followups as Array<Record<string, unknown>>;
  const assumptions = result.assumptions as Array<Record<string, unknown>>;
  const outcomes = result.outcomeMetrics as Array<Record<string, unknown>>;
  const observations = result.outcomeObservations as Array<
    Record<string, unknown>
  >;
  result.openActions = [
    ...checklist
      .filter((x) => x.status !== "complete" && x.status !== "not_applicable")
      .map((x) => ({
        type: "checklist",
        id: x.id,
        title: x.name,
        status: x.status,
      })),
    ...risks
      .filter((x) => x.status !== "closed")
      .map((x) => ({
        type: "risk",
        id: x.id,
        title: x.title,
        status: x.status,
      })),
    ...milestones
      .filter((x) => x.status !== "complete" && x.status !== "cancelled")
      .map((x) => ({
        type: "milestone",
        id: x.id,
        title: x.title,
        status: x.status,
      })),
    ...followups
      .filter((x) => x.status === "open")
      .map((x) => ({
        type: "followup",
        id: x.id,
        title: x.title,
        status: x.status,
      })),
    ...assumptions
      .filter((x) => x.status === "open")
      .map((x) => ({
        type: "assumption",
        id: x.id,
        title: x.statement,
        status: "open",
      })),
    ...outcomes
      .filter(
        (x) =>
          x.target === null || !observations.some((o) => o.metric_id === x.id),
      )
      .map((x) => ({
        type: "outcome",
        id: x.id,
        title: x.name,
        status:
          x.target === null ? "target_not_set" : "observation_not_recorded",
      })),
  ];
  result.trainingPrivacy =
    "Detailed learner progress, evidence, logs, identities, and assessments remain in the access-controlled Training workspace.";
  return result;
}
async function source(c: PoolClient, id: string) {
  const value = await snapshot(c, id);
  return { value, hash: inputHash(value) };
}
function row(
  value: Record<string, unknown>,
  currentHash: string,
): FinalReadout {
  return {
    id: String(value.id),
    engagementId: String(value.engagement_id),
    title: String(value.title),
    state: value.state as FinalReadout["state"],
    revision: Number(value.revision),
    sourceHash: String(value.source_hash),
    asOf: new Date(String(value.as_of)).toISOString(),
    stale: String(value.source_hash) !== currentHash,
    snapshot: value.snapshot as Record<string, unknown>,
    generatedBy: String(value.generated_by),
    ...(value.reviewed_by
      ? {
          reviewedBy: String(value.reviewed_by),
          reviewedAt: new Date(String(value.reviewed_at)).toISOString(),
          reviewRationale: String(value.review_rationale),
        }
      : {}),
  };
}
async function authority(c: PoolClient, actor: Actor, id: string) {
  if (actor.role === "practice_admin") return;
  const found = await c.query(
    "SELECT 1 FROM workspace_engagement_memberships WHERE engagement_id=$1 AND user_id=$2 AND role IN('engagement_lead','reviewer')",
    [id, actor.id],
  );
  if (!found.rowCount)
    throw new AuthorizationError(
      "Engagement lead or reviewer assignment is required",
    );
}

export class FinalReadoutService {
  constructor(private readonly pool: ClientPool) {}
  async list(
    actor: Actor,
    engagementId: string,
  ): Promise<FinalReadoutSummary[]> {
    return snapshotRead(this.pool, async (c) => {
      await snapshotLocks(c, engagementId);
      await authorizeEngagement(c, actor, engagementId, "readout.list");
      const current = await source(c, engagementId);
      const values = await c.query(
        "SELECT * FROM workspace_final_readouts WHERE engagement_id=$1 ORDER BY as_of DESC,id",
        [engagementId],
      );
      return values.rows.map((value) => {
        const { snapshot: _, ...summary } = row(value, current.hash);
        return summary;
      });
    });
  }
  async get(
    actor: Actor,
    engagementId: string,
    readoutId: string,
  ): Promise<FinalReadout> {
    return snapshotRead(this.pool, async (c) => {
      await snapshotLocks(c, engagementId);
      await authorizeEngagement(c, actor, engagementId, "readout.read");
      const current = await source(c, engagementId);
      const found = await c.query(
        "SELECT * FROM workspace_final_readouts WHERE id=$1 AND engagement_id=$2",
        [readoutId, engagementId],
      );
      if (!found.rows[0]) throw new NotFoundError("Final readout not found");
      return row(found.rows[0], current.hash);
    });
  }
  async generate(
    actor: Actor,
    engagementId: string,
    input: { requestKey: string; title: string },
  ): Promise<FinalReadout> {
    const title = clean(input.title, "Title", 300);
    return transaction(this.pool, async (c) => {
      await snapshotLocks(c, engagementId);
      await authorizeEngagement(c, actor, engagementId, "readout.generate");
      return idempotent(
        c,
        actor,
        "readout.generate",
        input.requestKey,
        { engagementId, ...input },
        async () => {
          const current = await source(c, engagementId);
          const inserted = await c.query(
            "INSERT INTO workspace_final_readouts(id,engagement_id,title,source_hash,snapshot,generated_by) VALUES($1,$2,$3,$4,$5,$6) RETURNING *",
            [
              randomUUID(),
              engagementId,
              title,
              current.hash,
              current.value,
              actor.id,
            ],
          );
          const result = row(inserted.rows[0], current.hash);
          await c.query(
            "INSERT INTO workspace_audit_events(actor_id,action,engagement_id,details) VALUES($1,$2,$3,$4)",
            [
              actor.id,
              "readout.generate",
              engagementId,
              { readoutId: result.id, sourceHash: result.sourceHash },
            ],
          );
          return result;
        },
      );
    });
  }
  async review(
    actor: Actor,
    engagementId: string,
    readoutId: string,
    input: {
      requestKey: string;
      expectedRevision: number;
      decision: string;
      rationale: string;
    },
  ): Promise<FinalReadout> {
    if (!["approved", "rejected"].includes(input.decision))
      throw new ValidationError("Review decision must be approved or rejected");
    if (!Number.isInteger(input.expectedRevision) || input.expectedRevision < 1)
      throw new ValidationError("Expected revision must be positive");
    const rationale = clean(input.rationale, "Rationale", 10000);
    return transaction(this.pool, async (c) => {
      await snapshotLocks(c, engagementId);
      await authorizeEngagement(c, actor, engagementId, "readout.review");
      await authority(c, actor, engagementId);
      return idempotent(
        c,
        actor,
        "readout.review",
        input.requestKey,
        { engagementId, readoutId, ...input },
        async () => {
          const current = await source(c, engagementId);
          const existing = await c.query<{ source_hash: string }>(
            "SELECT source_hash FROM workspace_final_readouts WHERE id=$1 AND engagement_id=$2 AND state='draft' AND revision=$3 FOR UPDATE",
            [readoutId, engagementId, input.expectedRevision],
          );
          if (!existing.rows[0])
            throw new ConflictError(
              "Final readout is stale or already reviewed",
            );
          if (existing.rows[0].source_hash !== current.hash)
            throw new ConflictError(
              "Final readout sources changed; generate a new snapshot",
            );
          const updated = await c.query(
            "UPDATE workspace_final_readouts SET state=$3,revision=revision+1,reviewed_by=$4,reviewed_at=now(),review_rationale=$5 WHERE id=$1 AND engagement_id=$2 RETURNING *",
            [readoutId, engagementId, input.decision, actor.id, rationale],
          );
          const result = row(updated.rows[0], current.hash);
          await c.query(
            "INSERT INTO workspace_audit_events(actor_id,action,engagement_id,details) VALUES($1,$2,$3,$4)",
            [
              actor.id,
              "readout.review",
              engagementId,
              {
                readoutId,
                decision: input.decision,
                adminOverride: actor.role === "practice_admin",
              },
            ],
          );
          return result;
        },
      );
    });
  }
  async export(
    actor: Actor,
    engagementId: string,
    readoutId: string,
    input: { format: string },
  ): Promise<{ fileName: string; mediaType: string; content: string }> {
    const result = await this.get(actor, engagementId, readoutId);
    if (input.format === "json")
      return {
        fileName: `final-readout-${result.id}.json`,
        mediaType: "application/json; charset=utf-8",
        content: JSON.stringify(result, null, 2),
      };
    if (input.format !== "markdown")
      throw new ValidationError("Export format must be markdown or json");
    return {
      fileName: `final-readout-${result.id}.md`,
      mediaType: "text/markdown; charset=utf-8",
      content: formatReadout(result),
    };
  }
}
