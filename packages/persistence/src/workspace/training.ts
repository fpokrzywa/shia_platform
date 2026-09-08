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
  requireAdmin,
  transaction,
} from "./shared.js";
import type { Actor } from "./types.js";
export interface TrainingItem {
  key: string;
  type: "reading" | "practical";
  title: string;
  description: string;
  url?: string;
  required?: boolean;
}
export interface PracticeCase {
  businessProblem: string;
  audience: string;
  constraints: string[];
  datasets: {
    key: string;
    fileName: string;
    description: string;
    csv: string;
  }[];
  references: { title: string; url: string }[];
}
export interface TrainingDefinition {
  key: string;
  version: number;
  state: "draft" | "published";
  name: string;
  purpose: string;
  items: TrainingItem[];
  practiceCase?: PracticeCase;
  sourceVersion?: number;
  revisionReason?: string;
}
const clean = (v: unknown, l: string, m = 10000) => {
  if (typeof v !== "string") throw new ValidationError(`${l} must be text`);
  const s = v.trim();
  if (!s || s.length > m)
    throw new ValidationError(`${l} must contain 1 to ${m} characters`);
  return s;
};
function validate(d: TrainingDefinition) {
  clean(d.key, "Key", 200);
  clean(d.name, "Name", 300);
  clean(d.purpose, "Purpose", 5000);
  if (
    !Array.isArray(d.items) ||
    (!d.practiceCase && d.items.length < 1) ||
    d.items.length > 200
  )
    throw new ValidationError("Training items must contain 1 to 200 entries");
  if (d.practiceCase) {
    const p = d.practiceCase;
    if (
      typeof p !== "object" ||
      Object.keys(p).some(
        (k) =>
          ![
            "businessProblem",
            "audience",
            "constraints",
            "datasets",
            "references",
          ].includes(k),
      )
    )
      throw new ValidationError(
        "Practice cases contain company context and datasets only; keep reviewer guides separate",
      );
    clean(p.businessProblem, "Business problem", 10000);
    clean(p.audience, "Audience", 2000);
    for (const [label, values] of [["Constraints", p.constraints]] as const) {
      if (!Array.isArray(values) || values.length < 1 || values.length > 50)
        throw new ValidationError(`${label} needs 1 to 50 entries`);
      values.forEach((v) => clean(v, label, 2000));
    }
    if (
      !Array.isArray(p.datasets) ||
      p.datasets.length < 1 ||
      p.datasets.length > 10
    )
      throw new ValidationError("Provide 1 to 10 sample datasets");
    const datasetKeys = new Set<string>();
    let csvBytes = 0;
    for (const dataset of p.datasets) {
      if (!dataset || typeof dataset !== "object")
        throw new ValidationError("Invalid dataset");
      clean(dataset.key, "Dataset key", 100);
      if (!/^[a-zA-Z0-9_-]+$/.test(dataset.key) || datasetKeys.has(dataset.key))
        throw new ValidationError("Dataset keys must be unique simple names");
      datasetKeys.add(dataset.key);
      if (
        typeof dataset.fileName !== "string" ||
        !/^[a-zA-Z0-9_.-]+\.csv$/.test(dataset.fileName)
      )
        throw new ValidationError(
          "Dataset filename must be a simple CSV filename",
        );
      clean(dataset.description, "Dataset description", 2000);
      if (typeof dataset.csv !== "string" || !dataset.csv.trim())
        throw new ValidationError("CSV contents must not be empty");
      csvBytes += Buffer.byteLength(dataset.csv, "utf8");
    }
    if (csvBytes > 2 * 1024 * 1024)
      throw new ValidationError(
        "Practice case CSV data must total at most 2 MiB",
      );
    if (!Array.isArray(p.references) || p.references.length > 20)
      throw new ValidationError("Use at most 20 references");
    for (const ref of p.references) {
      if (!ref || typeof ref !== "object")
        throw new ValidationError("Invalid reference");
      clean(ref.title, "Reference title", 300);
      let url: URL;
      try {
        url = new URL(ref.url);
      } catch {
        throw new ValidationError("Reference needs an HTTP(S) URL");
      }
      if (!["http:", "https:"].includes(url.protocol))
        throw new ValidationError("Reference needs an HTTP(S) URL");
    }
  }
  const keys = new Set<string>();
  for (const item of d.items) {
    clean(item.key, "Item key", 200);
    clean(item.title, "Item title", 300);
    clean(item.description, "Item description");
    if (keys.has(item.key))
      throw new ValidationError("Training item keys must be unique");
    keys.add(item.key);
    if (!["reading", "practical"].includes(item.type))
      throw new ValidationError("Unsupported training item type");
    if (item.url) {
      let u: URL;
      try {
        u = new URL(item.url);
      } catch {
        throw new ValidationError("Reading URL must use HTTP or HTTPS");
      }
      if (
        !["http:", "https:"].includes(u.protocol) ||
        u.username ||
        u.password ||
        u.toString().length > 2048
      )
        throw new ValidationError("Reading URL must use HTTP or HTTPS");
    }
  }
}
async function lock(c: PoolClient, id: string) {
  await c.query("SELECT pg_advisory_xact_lock(hashtextextended($1,0))", [
    `training:${id}`,
  ]);
}
async function assignment(
  c: PoolClient,
  actor: Actor,
  id: string,
  update = false,
) {
  const r = await c.query(
    `SELECT a.*, (SELECT display_name FROM app_users WHERE id=a.learner_user_id) learner_display_name, (SELECT display_name FROM app_users WHERE id=a.mentor_user_id) mentor_display_name FROM workspace_training_assignments a WHERE a.id=$1${update ? " FOR UPDATE" : ""}`,
    [id],
  );
  const row = r.rows[0] as Record<string, unknown> | undefined;
  if (!row) throw new NotFoundError("Training assignment not found");
  if (
    actor.role !== "practice_admin" &&
    actor.id !== row.learner_user_id &&
    actor.id !== row.mentor_user_id
  )
    throw new AuthorizationError("Training assignment access is required");
  return row;
}
async function evidence(
  c: PoolClient,
  row: Record<string, unknown>,
  actor: Actor,
  trainingId?: string,
  engagementId?: string,
) {
  if (trainingId) {
    const r = await c.query(
      "SELECT 1 FROM workspace_training_evidence WHERE id=$1 AND assignment_id=$2",
      [trainingId, row.id],
    );
    if (!r.rowCount)
      throw new ValidationError(
        "Training evidence does not belong to this assignment",
      );
  }
  if (engagementId) {
    if (!row.engagement_id)
      throw new ValidationError(
        "This assignment is not linked to an engagement",
      );
    await authorizeEngagement(
      c,
      actor,
      String(row.engagement_id),
      "training.evidence_link",
    );
    const r = await c.query(
      "SELECT 1 FROM workspace_evidence WHERE id=$1 AND engagement_id=$2",
      [engagementId, row.engagement_id],
    );
    if (!r.rowCount)
      throw new ValidationError(
        "Engagement evidence does not belong to the linked engagement",
      );
  }
}
async function token(c: PoolClient, id: string) {
  const r = await c.query(
    "SELECT item_key,status,revision,training_evidence_id,engagement_evidence_id FROM workspace_training_progress WHERE assignment_id=$1 ORDER BY item_key",
    [id],
  );
  return inputHash(r.rows);
}
async function requireTrainingItem(
  c: PoolClient,
  a: Record<string, unknown>,
  itemKey: string | undefined,
) {
  if (!itemKey) return;
  const version = await c.query<{ definition: TrainingDefinition }>(
    "SELECT definition FROM workspace_training_versions WHERE training_key=$1 AND version=$2",
    [a.training_key, a.training_version],
  );
  if (!version.rows[0]?.definition.items.some((item) => item.key === itemKey))
    throw new NotFoundError("Training item not found");
}
export class TrainingService {
  constructor(private readonly pool: ClientPool) {}
  async createDraft(
    actor: Actor,
    input: {
      requestKey: string;
      key: string;
      name: string;
      purpose: string;
      items: TrainingItem[];
      practiceCase?: PracticeCase;
    },
  ) {
    requireAdmin(actor);
    const definition: TrainingDefinition = {
      key: input.key,
      version: 1,
      state: "draft",
      name: input.name,
      purpose: input.purpose,
      items: input.items,
      ...(input.practiceCase ? { practiceCase: input.practiceCase } : {}),
    };
    validate(definition);
    return transaction(this.pool, (c) =>
      idempotent(
        c,
        actor,
        "training.draft_create",
        input.requestKey,
        input,
        async () => {
          await c.query(
            "INSERT INTO workspace_training_sets(training_key,name,purpose,created_by) VALUES($1,$2,$3,$4)",
            [definition.key, definition.name, definition.purpose, actor.id],
          );
          await c.query(
            "INSERT INTO workspace_training_versions(training_key,version,state,definition) VALUES($1,1,'draft',$2)",
            [definition.key, definition],
          );
          return this.audit(c, actor, "training.draft_create", null, {
            definition,
            revision: 1,
          });
        },
      ),
    );
  }
  async publish(
    actor: Actor,
    key: string,
    version: number,
    input: { requestKey: string; expectedRevision: number },
  ) {
    requireAdmin(actor);
    return transaction(this.pool, (c) =>
      idempotent(
        c,
        actor,
        "training.publish",
        input.requestKey,
        { key, version, ...input },
        async () => {
          const found = await c.query<{
            definition: TrainingDefinition;
            revision: string;
          }>(
            "SELECT definition,revision FROM workspace_training_versions WHERE training_key=$1 AND version=$2 AND state='draft' FOR UPDATE",
            [key, version],
          );
          if (!found.rows[0])
            throw new NotFoundError("Draft training version not found");
          if (Number(found.rows[0].revision) !== input.expectedRevision)
            throw new ConflictError("Training revision is stale");
          validate(found.rows[0].definition);
          const definition = {
            ...found.rows[0].definition,
            state: "published" as const,
          };
          const updated = await c.query(
            "UPDATE workspace_training_versions SET state='published',definition=$3,revision=revision+1,published_by=$4,published_at=now() WHERE training_key=$1 AND version=$2 RETURNING revision,published_at",
            [key, version, definition, actor.id],
          );
          return this.audit(c, actor, "training.publish", null, {
            definition,
            revision: Number(
              (updated.rows[0] as Record<string, unknown>).revision,
            ),
          });
        },
      ),
    );
  }
  async createVersion(
    actor: Actor,
    key: string,
    sourceVersion: number,
    input: {
      requestKey: string;
      expectedRevision: number;
      reason: string;
      name?: string;
      purpose?: string;
      items?: TrainingItem[];
      practiceCase?: PracticeCase;
    },
  ) {
    requireAdmin(actor);
    clean(input.reason, "Revision reason", 5000);
    return transaction(this.pool, async (c) => {
      await c.query("SELECT pg_advisory_xact_lock(hashtextextended($1,0))", [
        `training-versions:${key}`,
      ]);
      return idempotent(
        c,
        actor,
        "training.version_create",
        input.requestKey,
        { key, sourceVersion, ...input },
        async () => {
          const source = await c.query<{
            definition: TrainingDefinition;
            revision: string;
          }>(
            "SELECT definition,revision FROM workspace_training_versions WHERE training_key=$1 AND version=$2 AND state='published'",
            [key, sourceVersion],
          );
          if (!source.rows[0])
            throw new NotFoundError("Published training source not found");
          if (Number(source.rows[0].revision) !== input.expectedRevision)
            throw new ConflictError("Training revision is stale");
          const nextVersion = Number(
            (
              await c.query(
                "SELECT COALESCE(max(version),0)+1 version FROM workspace_training_versions WHERE training_key=$1",
                [key],
              )
            ).rows[0].version,
          );
          const definition: TrainingDefinition = {
            ...source.rows[0].definition,
            version: nextVersion,
            state: "draft",
            sourceVersion,
            revisionReason: input.reason,
            ...(input.name ? { name: input.name } : {}),
            ...(input.purpose ? { purpose: input.purpose } : {}),
            ...(input.items ? { items: input.items } : {}),
            ...(input.practiceCase ? { practiceCase: input.practiceCase } : {}),
          };
          validate(definition);
          await c.query(
            "INSERT INTO workspace_training_versions(training_key,version,state,definition,source_version,revision_reason) VALUES($1,$2,'draft',$3,$4,$5)",
            [key, definition.version, definition, sourceVersion, input.reason],
          );
          return this.audit(c, actor, "training.version_create", null, {
            definition,
            revision: 1,
          });
        },
      );
    });
  }
  async listSets(actor: Actor) {
    const memberFilter =
      actor.role === "practice_admin"
        ? ""
        : " WHERE v.state='published' OR EXISTS(SELECT 1 FROM workspace_training_assignments a WHERE a.training_key=v.training_key AND a.training_version=v.version AND (a.learner_user_id=$1 OR a.mentor_user_id=$1))";
    const r = await this.pool.query(
      `SELECT s.training_key,v.definition->>'name' name,v.definition->>'purpose' purpose,v.version,v.state,v.revision,(v.definition ? 'practiceCase') is_practice FROM workspace_training_sets s JOIN workspace_training_versions v USING(training_key)${memberFilter} ORDER BY s.training_key,v.version`,
      actor.role === "practice_admin" ? [] : [actor.id],
    );
    return r.rows;
  }
  async updateDraft(
    actor: Actor,
    key: string,
    version: number,
    input: {
      requestKey: string;
      expectedRevision: number;
      name: string;
      purpose: string;
      items: TrainingItem[];
      practiceCase?: PracticeCase;
    },
  ) {
    requireAdmin(actor);
    const definition: TrainingDefinition = {
      key,
      version,
      state: "draft",
      name: input.name,
      purpose: input.purpose,
      items: input.items,
      ...(input.practiceCase ? { practiceCase: input.practiceCase } : {}),
    };
    validate(definition);
    return transaction(this.pool, async (c) => {
      await c.query("SELECT pg_advisory_xact_lock(hashtextextended($1,0))", [
        `training-versions:${key}`,
      ]);
      return idempotent(
        c,
        actor,
        "training.draft_update",
        input.requestKey,
        { key, version, ...input },
        async () => {
          const row = await c.query(
            "UPDATE workspace_training_versions SET definition=$4,revision=revision+1 WHERE training_key=$1 AND version=$2 AND state='draft' AND revision=$3 RETURNING revision",
            [key, version, input.expectedRevision, definition],
          );
          if (!row.rows[0])
            throw new ConflictError(
              "Training draft revision or state is stale",
            );
          return this.audit(c, actor, "training.draft_update", null, {
            definition,
            revision: Number(row.rows[0].revision),
          });
        },
      );
    });
  }
  async getVersion(actor: Actor, key: string, version: number) {
    const r = await this.pool.query(
      `SELECT definition,revision,published_by,published_at FROM workspace_training_versions v WHERE training_key=$1 AND version=$2${actor.role === "practice_admin" ? "" : " AND (state='published' OR EXISTS(SELECT 1 FROM workspace_training_assignments a WHERE a.training_key=v.training_key AND a.training_version=v.version AND (a.learner_user_id=$3 OR a.mentor_user_id=$3)))"}`,
      actor.role === "practice_admin"
        ? [key, version]
        : [key, version, actor.id],
    );
    if (!r.rows[0]) throw new NotFoundError("Training version not found");
    return r.rows[0];
  }
  async assign(
    actor: Actor,
    input: {
      requestKey: string;
      trainingKey: string;
      version: number;
      learnerUserId: string;
      mentorUserId: string;
      engagementId?: string;
    },
  ) {
    requireAdmin(actor);
    if (input.learnerUserId === input.mentorUserId)
      throw new ValidationError("Learner and mentor must be different users");
    return transaction(this.pool, (c) =>
      idempotent(
        c,
        actor,
        "training.assign",
        input.requestKey,
        input,
        async () => {
          if (input.engagementId)
            await authorizeEngagement(
              c,
              actor,
              input.engagementId,
              "training.assign",
            );
          const version = await c.query<{ definition: TrainingDefinition }>(
            "SELECT definition FROM workspace_training_versions WHERE training_key=$1 AND version=$2 AND state='published'",
            [input.trainingKey, input.version],
          );
          if (!version.rows[0])
            throw new ValidationError(
              "A published training version is required",
            );
          const users = await c.query(
            "SELECT id FROM app_users WHERE id=ANY($1::text[]) AND disabled_at IS NULL",
            [[input.learnerUserId, input.mentorUserId]],
          );
          if (users.rowCount !== 2)
            throw new ValidationError(
              "Learner and mentor must be active users",
            );
          const id = randomUUID();
          await c.query(
            "INSERT INTO workspace_training_assignments(id,training_key,training_version,learner_user_id,mentor_user_id,engagement_id,assigned_by) VALUES($1,$2,$3,$4,$5,$6,$7)",
            [
              id,
              input.trainingKey,
              input.version,
              input.learnerUserId,
              input.mentorUserId,
              input.engagementId ?? null,
              actor.id,
            ],
          );
          for (const item of version.rows[0].definition.items)
            await c.query(
              "INSERT INTO workspace_training_progress(assignment_id,item_key,updated_by) VALUES($1,$2,$3)",
              [id, item.key, actor.id],
            );
          return this.audit(
            c,
            actor,
            "training.assign",
            input.engagementId ?? null,
            { id, definition: version.rows[0].definition },
          );
        },
      ),
    );
  }
  async getAssignments(actor: Actor, input: { engagementId?: string } = {}) {
    const values: unknown[] = [];
    let where = "WHERE 1=1";
    if (actor.role !== "practice_admin") {
      values.push(actor.id);
      where += ` AND (learner_user_id=$${values.length} OR mentor_user_id=$${values.length})`;
    }
    if (input.engagementId) {
      values.push(input.engagementId);
      where += ` AND engagement_id=$${values.length}`;
    }
    const r = await this.pool.query(
      `SELECT a.*, (SELECT display_name FROM app_users WHERE id=a.learner_user_id) learner_display_name, (SELECT display_name FROM app_users WHERE id=a.mentor_user_id) mentor_display_name FROM workspace_training_assignments a ${where} ORDER BY assigned_at DESC,id`,
      values,
    );
    return r.rows;
  }
  async getAssignment(actor: Actor, id: string) {
    return transaction(this.pool, async (c) => {
      await lock(c, id);
      const a = await assignment(c, actor, id);
      const version = await c.query(
        "SELECT definition FROM workspace_training_versions WHERE training_key=$1 AND version=$2",
        [a.training_key, a.training_version],
      );
      const progress = await c.query(
        "SELECT * FROM workspace_training_progress WHERE assignment_id=$1 ORDER BY item_key",
        [id],
      );
      const logs = await c.query(
        "SELECT * FROM workspace_learning_logs WHERE assignment_id=$1 ORDER BY created_at,id",
        [id],
      );
      const trainingEvidence = await c.query(
        "SELECT id,item_key,title,source_date::text source_date,url,file_name,supplied_media_type,attachment IS NOT NULL has_attachment,COALESCE(octet_length(attachment),0) size,recorded_by,created_at FROM workspace_training_evidence WHERE assignment_id=$1 ORDER BY created_at,id",
        [id],
      );
      const assessments = await c.query(
        "SELECT * FROM workspace_mentor_assessments WHERE assignment_id=$1 ORDER BY assessment_revision DESC",
        [id],
      );
      const current = await token(c, id);
      return {
        assignment: a,
        definition: (version.rows[0] as Record<string, unknown>).definition,
        progress: progress.rows,
        logs: logs.rows,
        evidence: trainingEvidence.rows,
        assessments: assessments.rows.map((x) => ({
          ...x,
          stale: (x as Record<string, unknown>).snapshot_token !== current,
        })),
      };
    });
  }
  async updateProgress(
    actor: Actor,
    id: string,
    itemKey: string,
    input: {
      requestKey: string;
      expectedRevision: number;
      status: string;
      trainingEvidenceId?: string;
      engagementEvidenceId?: string;
    },
  ) {
    if (!["not_started", "in_progress", "complete"].includes(input.status))
      throw new ValidationError("Unsupported progress status");
    return transaction(this.pool, async (c) => {
      await lock(c, id);
      const a = await assignment(c, actor, id, true);
      if (actor.role !== "practice_admin" && actor.id !== a.learner_user_id)
        throw new AuthorizationError("Learner access is required");
      await evidence(
        c,
        a,
        actor,
        input.trainingEvidenceId,
        input.engagementEvidenceId,
      );
      await requireTrainingItem(c, a, itemKey);
      return idempotent(
        c,
        actor,
        "training.progress_update",
        input.requestKey,
        { id, itemKey, ...input },
        async () => {
          const version = await c.query<{ definition: TrainingDefinition }>(
            "SELECT definition FROM workspace_training_versions WHERE training_key=$1 AND version=$2",
            [a.training_key, a.training_version],
          );
          const item = version.rows[0]!.definition.items.find(
            (x) => x.key === itemKey,
          );
          if (!item) throw new NotFoundError("Training item not found");
          if (
            input.status === "complete" &&
            item.type === "practical" &&
            !input.trainingEvidenceId &&
            !input.engagementEvidenceId
          )
            throw new ValidationError("Practical completion requires evidence");
          const updated = await c.query(
            "UPDATE workspace_training_progress SET status=$3,revision=revision+1,training_evidence_id=$4,engagement_evidence_id=$5,updated_by=$6,updated_at=now() WHERE assignment_id=$1 AND item_key=$2 AND revision=$7 RETURNING *",
            [
              id,
              itemKey,
              input.status,
              input.trainingEvidenceId ?? null,
              input.engagementEvidenceId ?? null,
              actor.id,
              input.expectedRevision,
            ],
          );
          if (!updated.rowCount)
            throw new ConflictError("Progress revision is stale");
          return this.audit(
            c,
            actor,
            "training.progress_update",
            a.engagement_id as string | null,
            updated.rows[0],
          );
        },
      );
    });
  }
  async addLearningLog(
    actor: Actor,
    id: string,
    input: {
      requestKey: string;
      itemKey?: string;
      text: string;
      trainingEvidenceId?: string;
      engagementEvidenceId?: string;
    },
  ) {
    const body = clean(input.text, "Learning log");
    return transaction(this.pool, async (c) => {
      await lock(c, id);
      const a = await assignment(c, actor, id);
      if (actor.role !== "practice_admin" && actor.id !== a.learner_user_id)
        throw new AuthorizationError("Learner access is required");
      await evidence(
        c,
        a,
        actor,
        input.trainingEvidenceId,
        input.engagementEvidenceId,
      );
      await requireTrainingItem(c, a, input.itemKey);
      return idempotent(
        c,
        actor,
        "training.log_add",
        input.requestKey,
        { id, ...input },
        async () => {
          const row = await c.query(
            "INSERT INTO workspace_learning_logs(id,assignment_id,item_key,body,training_evidence_id,engagement_evidence_id,actor_id) VALUES($1,$2,$3,$4,$5,$6,$7) RETURNING *",
            [
              randomUUID(),
              id,
              input.itemKey ?? null,
              body,
              input.trainingEvidenceId ?? null,
              input.engagementEvidenceId ?? null,
              actor.id,
            ],
          );
          return this.audit(
            c,
            actor,
            "training.log_add",
            a.engagement_id as string | null,
            row.rows[0],
          );
        },
      );
    });
  }
  async addEvidence(
    actor: Actor,
    id: string,
    input: {
      requestKey: string;
      itemKey?: string;
      title: string;
      sourceDate?: string;
      url?: string;
      fileName?: string;
      mediaType?: string;
      base64?: string;
    },
  ) {
    const title = clean(input.title, "Title", 300);
    if (input.sourceDate !== undefined) {
      const parsed = new Date(`${input.sourceDate}T00:00:00Z`);
      if (
        !/^\d{4}-\d{2}-\d{2}$/.test(input.sourceDate) ||
        Number.isNaN(parsed.valueOf()) ||
        parsed.toISOString().slice(0, 10) !== input.sourceDate
      )
        throw new ValidationError("Source date must be YYYY-MM-DD");
    }
    const hasUrl = input.url !== undefined,
      hasFile = input.base64 !== undefined;
    if (hasUrl === hasFile)
      throw new ValidationError("Provide exactly one URL or attachment");
    let url: string | null = null,
      data: Buffer | null = null;
    if (
      input.mediaType !== undefined &&
      (!input.mediaType.trim() ||
        input.mediaType.length > 255 ||
        /[\u0000-\u001f\u007f]/.test(input.mediaType))
    )
      throw new ValidationError("Media type must contain 1 to 255 characters");
    if (hasUrl) {
      let u: URL;
      try {
        u = new URL(input.url!);
      } catch {
        throw new ValidationError("Evidence URL must use HTTP or HTTPS");
      }
      if (
        !["http:", "https:"].includes(u.protocol) ||
        u.username ||
        u.password ||
        u.toString().length > 2048
      )
        throw new ValidationError("Evidence URL must use HTTP or HTTPS");
      url = u.toString();
    } else {
      if (
        !input.fileName?.trim() ||
        input.fileName.length > 255 ||
        /[\\/\u0000-\u001f\u007f]/.test(input.fileName)
      )
        throw new ValidationError("Filename is required");
      if (
        !/^(?:[A-Za-z0-9+/]{4})*(?:[A-Za-z0-9+/]{2}==|[A-Za-z0-9+/]{3}=)?$/.test(
          input.base64!,
        )
      )
        throw new ValidationError("Attachment must be valid base64");
      data = Buffer.from(input.base64!, "base64");
      if (!data.length || data.length > 2097152)
        throw new ValidationError("Attachment must contain at most 2 MiB");
    }
    return transaction(this.pool, async (c) => {
      await lock(c, id);
      const a = await assignment(c, actor, id);
      await requireTrainingItem(c, a, input.itemKey);
      return idempotent(
        c,
        actor,
        "training.evidence_add",
        input.requestKey,
        { id, ...input },
        async () => {
          const row = await c.query(
            "INSERT INTO workspace_training_evidence(id,assignment_id,item_key,title,source_date,url,file_name,supplied_media_type,attachment,recorded_by) VALUES($1,$2,$3,$4,$5,$6,$7,$8,$9,$10) RETURNING id,assignment_id,item_key,title,source_date::text source_date,url,file_name,supplied_media_type,attachment IS NOT NULL has_attachment,octet_length(attachment) size,recorded_by,created_at",
            [
              randomUUID(),
              id,
              input.itemKey ?? null,
              title,
              input.sourceDate ?? null,
              url,
              input.fileName?.trim() ?? null,
              input.mediaType ?? null,
              data,
              actor.id,
            ],
          );
          return this.audit(
            c,
            actor,
            "training.evidence_add",
            a.engagement_id as string | null,
            row.rows[0],
          );
        },
      );
    });
  }
  async readAttachment(actor: Actor, id: string, evidenceId: string) {
    return transaction(this.pool, async (c) => {
      await assignment(c, actor, id);
      const r = await c.query<{ file_name: string; attachment: Buffer }>(
        "SELECT file_name,attachment FROM workspace_training_evidence WHERE id=$1 AND assignment_id=$2 AND attachment IS NOT NULL",
        [evidenceId, id],
      );
      if (!r.rows[0]) throw new NotFoundError("Training attachment not found");
      return {
        fileName: r.rows[0].file_name,
        mediaType: "application/octet-stream" as const,
        data: r.rows[0].attachment,
      };
    });
  }
  async assess(
    actor: Actor,
    id: string,
    input: {
      requestKey: string;
      expectedRevision: number;
      result: string;
      rationale: string;
      adminOverrideConfirmation?: string;
    },
  ) {
    if (!["competent", "needs_development"].includes(input.result))
      throw new ValidationError("Unsupported assessment result");
    const rationale = clean(input.rationale, "Assessment rationale");
    return transaction(this.pool, async (c) => {
      await lock(c, id);
      const a = await assignment(c, actor, id, true);
      if (actor.id === a.learner_user_id)
        throw new AuthorizationError("Learners cannot assess themselves");
      const override =
        actor.role === "practice_admin" && actor.id !== a.mentor_user_id;
      if (!override && actor.id !== a.mentor_user_id)
        throw new AuthorizationError("Mentor access is required");
      if (
        override &&
        input.adminOverrideConfirmation !== "confirm-admin-assessment"
      )
        throw new ValidationError(
          "Explicit administrator assessment override confirmation is required",
        );
      return idempotent(
        c,
        actor,
        "training.assess",
        input.requestKey,
        { id, ...input },
        async () => {
          if (Number(a.assessment_revision) !== input.expectedRevision)
            throw new ConflictError("Assessment revision is stale");
          const version = await c.query<{ definition: TrainingDefinition }>(
            "SELECT definition FROM workspace_training_versions WHERE training_key=$1 AND version=$2",
            [a.training_key, a.training_version],
          );
          if (version.rows[0]!.definition.practiceCase)
            throw new ValidationError(
              "Company practice requires a proposal comparison with a protected reviewer reference",
            );
          const progress = await c.query<{ item_key: string; status: string }>(
            "SELECT item_key,status FROM workspace_training_progress WHERE assignment_id=$1",
            [id],
          );
          const complete = new Set(
            progress.rows
              .filter((x) => x.status === "complete")
              .map((x) => x.item_key),
          );
          if (
            input.result === "competent" &&
            version.rows[0]!.definition.items.some(
              (x) => x.required !== false && !complete.has(x.key),
            )
          )
            throw new ValidationError(
              "Competence requires all required training items complete",
            );
          const revision = Number(a.assessment_revision) + 1;
          const snapshot = await token(c, id);
          const row = await c.query(
            "INSERT INTO workspace_mentor_assessments(id,assignment_id,assessment_revision,result,rationale,snapshot_token,actor_id,admin_override) VALUES($1,$2,$3,$4,$5,$6,$7,$8) RETURNING *",
            [
              randomUUID(),
              id,
              revision,
              input.result,
              rationale,
              snapshot,
              actor.id,
              override,
            ],
          );
          await c.query(
            "UPDATE workspace_training_assignments SET assessment_revision=$2 WHERE id=$1",
            [id, revision],
          );
          return this.audit(
            c,
            actor,
            "training.assess",
            a.engagement_id as string | null,
            row.rows[0],
          );
        },
      );
    });
  }
  private async audit(
    c: PoolClient,
    actor: Actor,
    action: string,
    engagementId: string | null,
    result: unknown,
  ) {
    await c.query(
      "INSERT INTO workspace_audit_events(actor_id,action,engagement_id,details) VALUES($1,$2,$3,$4)",
      [actor.id, action, engagementId, { result }],
    );
    return result;
  }
}
