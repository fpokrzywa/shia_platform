import { randomUUID } from "node:crypto";
import type { PoolClient } from "pg";
import type { ClientPool } from "../database.js";
import { NotFoundError, ValidationError, ConflictError } from "./errors.js";
import { authorizeEngagement, idempotent, transaction } from "./shared.js";
import type { Actor } from "./types.js";

export type WorkItemStatus =
  | "not_started"
  | "in_progress"
  | "blocked"
  | "ready_for_review"
  | "complete"
  | "not_applicable";
export interface WorkItem {
  id: string;
  stageId: string;
  name: string;
  status: WorkItemStatus;
  revision: number;
  ownerUserId: string | null;
  dueDate: string | null;
  required: boolean;
  evidenceRequirementKeys: string[];
  evidenceRequirements: Array<{ key: string; name: string }>;
}
export interface WorkNote {
  id: string;
  engagementId: string;
  itemId: string | null;
  actorId: string;
  text: string;
  createdAt: string;
}
export interface EvidenceMetadata {
  id: string;
  engagementId: string;
  itemId: string;
  title: string;
  url?: string;
  fileName?: string;
  suppliedMediaType?: string;
  hasAttachment: boolean;
  size: number;
  recordedBy: string;
  createdAt: string;
  evidenceRequirementKey?: string;
}
export interface EngagementWork {
  items: WorkItem[];
  notes: WorkNote[];
  evidence: EvidenceMetadata[];
}

const statuses = new Set<string>([
  "not_started",
  "in_progress",
  "blocked",
  "ready_for_review",
  "complete",
]);
const iso = (value: unknown) => new Date(String(value)).toISOString();
const itemFrom = (v: Record<string, unknown>): WorkItem => ({
  id: String(v.id),
  stageId: String(v.stage_id),
  name: String(v.name),
  status: v.status as WorkItemStatus,
  revision: Number(v.revision),
  ownerUserId: v.owner_user_id === null ? null : String(v.owner_user_id),
  dueDate: v.due_date === null ? null : String(v.due_date).slice(0, 10),
  required: Boolean((v.definition as { required?: boolean }).required),
  evidenceRequirementKeys:
    (v.definition as { evidenceRequirementKeys?: string[] })
      .evidenceRequirementKeys ?? [],
  evidenceRequirements: (
    (v.definition as { evidenceRequirementKeys?: string[] })
      .evidenceRequirementKeys ?? []
  ).map((key) => ({ key, name: key })),
});
const noteFrom = (v: Record<string, unknown>): WorkNote => ({
  id: String(v.id),
  engagementId: String(v.engagement_id),
  itemId: v.item_id === null ? null : String(v.item_id),
  actorId: String(v.actor_id),
  text: String(v.body),
  createdAt: iso(v.created_at),
});
const evidenceFrom = (v: Record<string, unknown>): EvidenceMetadata => ({
  id: String(v.id),
  engagementId: String(v.engagement_id),
  itemId: String(v.item_id),
  title: String(v.title),
  ...(v.url ? { url: String(v.url) } : {}),
  ...(v.file_name ? { fileName: String(v.file_name) } : {}),
  ...(v.supplied_media_type
    ? { suppliedMediaType: String(v.supplied_media_type) }
    : {}),
  hasAttachment: Boolean(v.has_attachment),
  size: Number(v.size),
  recordedBy: String(v.recorded_by),
  createdAt: iso(v.created_at),
  ...(v.evidence_requirement_key
    ? { evidenceRequirementKey: String(v.evidence_requirement_key) }
    : {}),
});
function validDate(value: string): boolean {
  if (!/^\d{4}-\d{2}-\d{2}$/.test(value)) return false;
  const date = new Date(`${value}T00:00:00Z`);
  return (
    !Number.isNaN(date.valueOf()) && date.toISOString().slice(0, 10) === value
  );
}
function attachment(base64: string): Buffer {
  if (
    !/^(?:[A-Za-z0-9+/]{4})*(?:[A-Za-z0-9+/]{2}==|[A-Za-z0-9+/]{3}=)?$/.test(
      base64,
    )
  )
    throw new ValidationError("Attachment must be valid base64");
  const data = Buffer.from(base64, "base64");
  if (data.length === 0)
    throw new ValidationError("Attachment must not be empty");
  if (data.length > 2 * 1024 * 1024)
    throw new ValidationError("Attachment exceeds the 2 MiB limit");
  return data;
}
const hasUnsafeControl = (value: string) =>
  /[\u0000-\u0008\u000b\u000c\u000e-\u001f\u007f]/.test(value);
async function lockEngagement(
  c: PoolClient,
  engagementId: string,
): Promise<void> {
  await c.query("SELECT pg_advisory_xact_lock(hashtextextended($1,0))", [
    `readiness:${engagementId}`,
  ]);
}
async function requireItem(
  c: PoolClient,
  engagementId: string,
  itemId: string,
): Promise<void> {
  const found = await c.query(
    "SELECT 1 FROM workspace_checklist_instances WHERE id=$1 AND engagement_id=$2",
    [itemId, engagementId],
  );
  if (!found.rowCount) throw new NotFoundError("Checklist item not found");
}

export class WorkService {
  constructor(private readonly pool: ClientPool) {}
  async get(actor: Actor, engagementId: string): Promise<EngagementWork> {
    for (let attempt = 0; ; attempt += 1) {
      try {
        return await transaction(this.pool, async (c) => {
          await c.query("SET TRANSACTION ISOLATION LEVEL REPEATABLE READ");
          await lockEngagement(c, engagementId);
          await authorizeEngagement(c, actor, engagementId, "work.read");
          const items = await c.query(
            "SELECT i.id,i.stage_id,i.definition,i.definition->>'name' name,i.status,i.revision,i.owner_user_id,i.due_date::text due_date FROM workspace_checklist_instances i JOIN workspace_stage_instances s ON s.id=i.stage_id AND s.engagement_id=i.engagement_id WHERE i.engagement_id=$1 ORDER BY s.position,i.position,i.id",
            [engagementId],
          );
          const notes = await c.query(
            "SELECT id,engagement_id,item_id,actor_id,body,created_at FROM workspace_engagement_notes WHERE engagement_id=$1 ORDER BY created_at,id",
            [engagementId],
          );
          const evidence = await c.query(
            "SELECT id,engagement_id,item_id,title,url,file_name,supplied_media_type,evidence_requirement_key,attachment IS NOT NULL has_attachment,COALESCE(octet_length(attachment),0) size,recorded_by,created_at FROM workspace_evidence WHERE engagement_id=$1 ORDER BY created_at,id",
            [engagementId],
          );
          const template = await c.query<{
            definition: {
              evidenceRequirements: Array<{ key: string; name: string }>;
            };
          }>(
            "SELECT v.definition FROM workspace_engagements e JOIN workspace_template_versions v ON v.template_key=e.template_key AND v.version=e.template_version WHERE e.id=$1",
            [engagementId],
          );
          const labels = new Map(
            (template.rows[0]?.definition.evidenceRequirements ?? []).map(
              (requirement) => [requirement.key, requirement.name],
            ),
          );
          return {
            items: items.rows.map((x) => {
              const item = itemFrom(x);
              return {
                ...item,
                evidenceRequirements: item.evidenceRequirementKeys.map(
                  (key) => ({
                    key,
                    name: labels.get(key) ?? key,
                  }),
                ),
              };
            }),
            notes: notes.rows.map((x) => noteFrom(x)),
            evidence: evidence.rows.map((x) => evidenceFrom(x)),
          };
        });
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
  async updateItem(
    actor: Actor,
    engagementId: string,
    itemId: string,
    input: {
      expectedRevision: number;
      requestKey: string;
      status: string;
      ownerUserId?: string | null;
      dueDate?: string | null;
    },
  ): Promise<WorkItem> {
    if (!statuses.has(input.status))
      throw new ValidationError("Unsupported checklist status");
    if (
      input.dueDate !== undefined &&
      input.dueDate !== null &&
      !validDate(input.dueDate)
    )
      throw new ValidationError("Due date must be a valid YYYY-MM-DD date");
    return transaction(this.pool, async (c) => {
      await lockEngagement(c, engagementId);
      await authorizeEngagement(c, actor, engagementId, "work.item_update");
      return idempotent(
        c,
        actor,
        "work.item_update",
        input.requestKey,
        { engagementId, itemId, ...input },
        async () => {
          const existing = await c.query<{
            status: WorkItemStatus;
            revision: string;
            owner_user_id: string | null;
            due_date: string | null;
            definition: { evidenceRequirementKeys?: string[] };
            stage_state: string;
          }>(
            "SELECT i.status,i.revision,i.owner_user_id,i.due_date::text due_date,i.definition,s.state stage_state FROM workspace_checklist_instances i JOIN workspace_stage_instances s ON s.id=i.stage_id AND s.engagement_id=i.engagement_id WHERE i.id=$1 AND i.engagement_id=$2 FOR UPDATE OF i",
            [itemId, engagementId],
          );
          const prior = existing.rows[0];
          if (!prior) throw new NotFoundError("Checklist item not found");
          if (prior.stage_state === "complete")
            throw new ValidationError(
              "Reopen the approved stage before changing its checklist items",
            );
          if (Number(prior.revision) !== input.expectedRevision)
            throw new ConflictError("Checklist item revision is stale");
          if (input.ownerUserId !== undefined && input.ownerUserId !== null) {
            const member = await c.query(
              "SELECT 1 FROM workspace_engagement_memberships WHERE engagement_id=$1 AND user_id=$2 LIMIT 1",
              [engagementId, input.ownerUserId],
            );
            if (!member.rowCount)
              throw new ValidationError(
                "Owner must be a current engagement member",
              );
          }
          if (input.status === "complete") {
            const requirements = prior.definition.evidenceRequirementKeys ?? [];
            if (requirements.length) {
              const found = await c.query<{ evidence_requirement_key: string }>(
                "SELECT DISTINCT evidence_requirement_key FROM workspace_evidence WHERE item_id=$1 AND engagement_id=$2 AND evidence_requirement_key=ANY($3::text[])",
                [itemId, engagementId, requirements],
              );
              if (found.rowCount !== new Set(requirements).size)
                throw new ValidationError(
                  "All defined evidence requirements must be satisfied before completion",
                );
            }
          }
          const updated = await c.query(
            "UPDATE workspace_checklist_instances SET status=$3,owner_user_id=CASE WHEN $4 THEN $5 ELSE owner_user_id END,due_date=CASE WHEN $6 THEN $7::date ELSE due_date END,revision=revision+1,completed_at=CASE WHEN $3='complete' AND status<>'complete' THEN now() WHEN $3='complete' THEN completed_at ELSE NULL END,completed_by=CASE WHEN $3='complete' AND status<>'complete' THEN $8 WHEN $3='complete' THEN completed_by ELSE NULL END WHERE id=$1 AND engagement_id=$2 RETURNING id,stage_id,definition,definition->>'name' name,status,revision,owner_user_id,due_date::text due_date",
            [
              itemId,
              engagementId,
              input.status,
              Object.hasOwn(input, "ownerUserId"),
              input.ownerUserId ?? null,
              Object.hasOwn(input, "dueDate"),
              input.dueDate ?? null,
              actor.id,
            ],
          );
          const result = itemFrom(updated.rows[0] as Record<string, unknown>);
          await c.query(
            "INSERT INTO workspace_audit_events(actor_id,action,engagement_id,details) VALUES($1,$2,$3,$4)",
            [
              actor.id,
              prior.status === "complete" && input.status !== "complete"
                ? "work.item_reopen"
                : "work.item_update",
              engagementId,
              {
                itemId,
                priorStatus: prior.status,
                newStatus: input.status,
                priorRevision: input.expectedRevision,
                newRevision: result.revision,
                priorOwnerUserId: prior.owner_user_id,
                newOwnerUserId: result.ownerUserId,
                priorDueDate: prior.due_date,
                newDueDate: result.dueDate,
              },
            ],
          );
          return result;
        },
      );
    });
  }
  async addNote(
    actor: Actor,
    engagementId: string,
    input: { requestKey: string; text: string; itemId?: string },
  ): Promise<WorkNote> {
    const text = input.text.trim();
    if (!text || text.length > 10000 || hasUnsafeControl(text))
      throw new ValidationError("Note text must contain 1 to 10000 characters");
    return transaction(this.pool, async (c) => {
      await lockEngagement(c, engagementId);
      await authorizeEngagement(c, actor, engagementId, "work.note_add");
      return idempotent(
        c,
        actor,
        "work.note_add",
        input.requestKey,
        { engagementId, ...input },
        async () => {
          if (input.itemId) await requireItem(c, engagementId, input.itemId);
          const row = await c.query(
            "INSERT INTO workspace_engagement_notes(id,engagement_id,item_id,actor_id,body) VALUES($1,$2,$3,$4,$5) RETURNING id,engagement_id,item_id,actor_id,body,created_at",
            [randomUUID(), engagementId, input.itemId ?? null, actor.id, text],
          );
          const result = noteFrom(row.rows[0] as Record<string, unknown>);
          await c.query(
            "INSERT INTO workspace_audit_events(actor_id,action,engagement_id,details) VALUES($1,$2,$3,$4)",
            [
              actor.id,
              "work.note_add",
              engagementId,
              { noteId: result.id, itemId: result.itemId },
            ],
          );
          return result;
        },
      );
    });
  }
  async addEvidence(
    actor: Actor,
    engagementId: string,
    input: {
      requestKey: string;
      itemId: string;
      title: string;
      url?: string;
      fileName?: string;
      mediaType?: string;
      base64?: string;
      evidenceRequirementKey?: string;
    },
  ): Promise<EvidenceMetadata> {
    const title = input.title.trim();
    if (!title || title.length > 500 || hasUnsafeControl(title))
      throw new ValidationError(
        "Evidence title must contain 1 to 500 characters",
      );
    const hasUrl = input.url !== undefined;
    const hasFile = input.base64 !== undefined;
    if (hasUrl === hasFile)
      throw new ValidationError(
        "Provide exactly one evidence URL or attachment",
      );
    let url: string | null = null;
    let data: Buffer | null = null;
    if (hasUrl) {
      if (input.fileName !== undefined || input.mediaType !== undefined)
        throw new ValidationError(
          "File metadata is only valid for attachments",
        );
      try {
        const parsed = new URL(input.url!);
        if (parsed.protocol !== "https:" && parsed.protocol !== "http:")
          throw new Error();
        if (
          parsed.username ||
          parsed.password ||
          parsed.toString().length > 2048
        )
          throw new Error();
        url = parsed.toString();
      } catch {
        throw new ValidationError("Evidence URL must use HTTP or HTTPS");
      }
    } else {
      if (
        !input.fileName?.trim() ||
        input.fileName.length > 255 ||
        /[\\/\u0000-\u001f\u007f]/.test(input.fileName)
      )
        throw new ValidationError(
          "Attachment filename is required and must not exceed 255 characters",
        );
      if (
        input.mediaType !== undefined &&
        (!input.mediaType.trim() ||
          input.mediaType.length > 255 ||
          hasUnsafeControl(input.mediaType))
      )
        throw new ValidationError("Supplied media type is invalid");
      data = attachment(input.base64!);
    }
    return transaction(this.pool, async (c) => {
      await lockEngagement(c, engagementId);
      await authorizeEngagement(c, actor, engagementId, "work.evidence_add");
      return idempotent(
        c,
        actor,
        "work.evidence_add",
        input.requestKey,
        { engagementId, ...input },
        async () => {
          const target = await c.query<{
            definition: { evidenceRequirementKeys?: string[] };
            stage_state: string;
          }>(
            "SELECT i.definition,s.state stage_state FROM workspace_checklist_instances i JOIN workspace_stage_instances s ON s.id=i.stage_id AND s.engagement_id=i.engagement_id WHERE i.id=$1 AND i.engagement_id=$2",
            [input.itemId, engagementId],
          );
          if (!target.rows[0])
            throw new NotFoundError("Checklist item not found");
          if (target.rows[0].stage_state === "complete")
            throw new ValidationError(
              "Reopen the approved stage before adding evidence",
            );
          if (
            input.evidenceRequirementKey !== undefined &&
            !(target.rows[0].definition.evidenceRequirementKeys ?? []).includes(
              input.evidenceRequirementKey,
            )
          )
            throw new ValidationError(
              "Evidence requirement does not belong to this checklist item",
            );
          const row = await c.query(
            "INSERT INTO workspace_evidence(id,engagement_id,item_id,title,url,file_name,supplied_media_type,attachment,recorded_by,evidence_requirement_key) VALUES($1,$2,$3,$4,$5,$6,$7,$8,$9,$10) RETURNING id,engagement_id,item_id,title,url,file_name,supplied_media_type,evidence_requirement_key,attachment IS NOT NULL has_attachment,COALESCE(octet_length(attachment),0) size,recorded_by,created_at",
            [
              randomUUID(),
              engagementId,
              input.itemId,
              title,
              url,
              input.fileName?.trim() ?? null,
              input.mediaType?.slice(0, 255) ?? null,
              data,
              actor.id,
              input.evidenceRequirementKey ?? null,
            ],
          );
          const result = evidenceFrom(row.rows[0] as Record<string, unknown>);
          await c.query(
            "INSERT INTO workspace_audit_events(actor_id,action,engagement_id,details) VALUES($1,$2,$3,$4)",
            [
              actor.id,
              "work.evidence_add",
              engagementId,
              {
                evidenceId: result.id,
                itemId: result.itemId,
                hasAttachment: result.hasAttachment,
                url: result.url ?? null,
              },
            ],
          );
          return result;
        },
      );
    });
  }
  async readAttachment(
    actor: Actor,
    engagementId: string,
    evidenceId: string,
  ): Promise<{
    fileName: string;
    mediaType: "application/octet-stream";
    data: Buffer;
  }> {
    return transaction(this.pool, async (c) => {
      await authorizeEngagement(c, actor, engagementId, "work.attachment_read");
      const result = await c.query<{ file_name: string; attachment: Buffer }>(
        "SELECT file_name,attachment FROM workspace_evidence WHERE id=$1 AND engagement_id=$2 AND attachment IS NOT NULL",
        [evidenceId, engagementId],
      );
      const row = result.rows[0];
      if (!row) throw new NotFoundError("Attachment not found");
      return {
        fileName: row.file_name,
        mediaType: "application/octet-stream",
        data: row.attachment,
      };
    });
  }
}
