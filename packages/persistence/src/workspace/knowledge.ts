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
  requireAdmin,
  transaction,
} from "./shared.js";
import type { Actor } from "./types.js";

export type KnowledgeKind =
  "recipe" | "discovery_guide" | "architecture_pattern";
export interface KnowledgeSourceRef {
  title: string;
  url: string;
}
export interface KnowledgeDefinition {
  key: string;
  version: number;
  kind: KnowledgeKind;
  title: string;
  summary: string;
  body: string;
  sourceRefs: KnowledgeSourceRef[];
}
type Content = {
  key: string;
  kind: KnowledgeKind;
  title: string;
  summary: string;
  body: string;
  sourceRefs?: KnowledgeSourceRef[];
};
const clean = (v: unknown, label: string, max: number) => {
  if (typeof v !== "string") throw new ValidationError(`${label} must be text`);
  const s = v.trim();
  if (!s || s.length > max)
    throw new ValidationError(`${label} must contain 1 to ${max} characters`);
  return s;
};
function definition(input: Content, version: number): KnowledgeDefinition {
  if (
    !["recipe", "discovery_guide", "architecture_pattern"].includes(input.kind)
  )
    throw new ValidationError("Unsupported knowledge kind");
  const refs = input.sourceRefs ?? [];
  if (!Array.isArray(refs) || refs.length > 30)
    throw new ValidationError(
      "Source references must contain at most 30 entries",
    );
  return {
    key: clean(input.key, "Key", 200),
    version,
    kind: input.kind,
    title: clean(input.title, "Title", 300),
    summary: clean(input.summary, "Summary", 2000),
    body: clean(input.body, "Body", 50000),
    sourceRefs: refs.map((r, i) => {
      const title = clean(r?.title, `Source ${i + 1} title`, 300);
      let u: URL;
      try {
        u = new URL(r?.url);
      } catch {
        throw new ValidationError("Source URLs must use HTTP or HTTPS");
      }
      if (
        !["http:", "https:"].includes(u.protocol) ||
        u.username ||
        u.password ||
        u.toString().length > 2048
      )
        throw new ValidationError("Source URLs must use HTTP or HTTPS");
      return { title, url: u.toString() };
    }),
  };
}
async function audit(
  c: PoolClient,
  actor: Actor,
  action: string,
  engagementId: string | null,
  details: unknown,
) {
  await c.query(
    "INSERT INTO workspace_audit_events(actor_id,action,engagement_id,details) VALUES($1,$2,$3,$4)",
    [actor.id, action, engagementId, details],
  );
  return details;
}
async function visible(
  c: PoolClient,
  actor: Actor,
  key: string,
  version: number,
  lock = false,
) {
  const r = await c.query(
    `SELECT v.*,s.kind,s.archived_at FROM workspace_knowledge_versions v JOIN workspace_knowledge_sets s USING(knowledge_key) WHERE knowledge_key=$1 AND version=$2${lock ? " FOR UPDATE OF v" : ""}`,
    [key, version],
  );
  const row = r.rows[0];
  if (!row) throw new NotFoundError("Knowledge version not found");
  const ordinarilyVisible =
    ["published", "retired"].includes(row.state) ||
    actor.role === "practice_admin" ||
    row.author_id === actor.id;
  if (
    !ordinarilyVisible &&
    row.state === "submitted" &&
    row.provenance_engagement_id
  )
    await reviewer(c, actor, row);
  else if (!ordinarilyVisible)
    throw new AuthorizationError("Knowledge draft access is required");
  return row;
}
async function reviewer(c: PoolClient, actor: Actor, row: any) {
  if (actor.role === "practice_admin") return;
  if (!row.provenance_engagement_id)
    throw new AuthorizationError("Practice administrator review is required");
  await authorizeEngagement(
    c,
    actor,
    row.provenance_engagement_id,
    "knowledge.publish",
  );
  const r = await c.query(
    "SELECT 1 FROM workspace_engagement_memberships WHERE engagement_id=$1 AND user_id=$2 AND role='reviewer'",
    [row.provenance_engagement_id, actor.id],
  );
  if (!r.rowCount)
    throw new AuthorizationError("Assigned reviewer access is required");
}

export class KnowledgeService {
  constructor(private readonly pool: ClientPool) {}
  async createDraft(actor: Actor, input: { requestKey: string } & Content) {
    const d = definition(input, 1);
    return transaction(this.pool, (c) =>
      idempotent(
        c,
        actor,
        "knowledge.draft_create",
        input.requestKey,
        input,
        async () => {
          await c.query(
            "INSERT INTO workspace_knowledge_sets(knowledge_key,kind,title,created_by) VALUES($1,$2,$3,$4)",
            [d.key, d.kind, d.title, actor.id],
          );
          await c.query(
            "INSERT INTO workspace_knowledge_versions(knowledge_key,version,state,definition,author_id) VALUES($1,1,'draft',$2,$3)",
            [d.key, d, actor.id],
          );
          return audit(c, actor, "knowledge.draft_create", null, {
            definition: d,
            revision: 1,
          });
        },
      ),
    );
  }
  async submitFromEngagement(
    actor: Actor,
    input: {
      requestKey: string;
      engagementId: string;
      source: { type: "note" | "learning_log"; id: string };
    } & Content,
  ) {
    const d = definition(input, 1);
    if (!["note", "learning_log"].includes(input.source?.type))
      throw new ValidationError("Unsupported provenance type");
    return transaction(this.pool, async (c) => {
      await authorizeEngagement(
        c,
        actor,
        input.engagementId,
        "knowledge.submit_from_engagement",
      );
      const source =
        input.source.type === "note"
          ? await c.query(
              "SELECT 1 FROM workspace_engagement_notes WHERE id=$1 AND engagement_id=$2",
              [input.source.id, input.engagementId],
            )
          : await c.query(
              "SELECT 1 FROM workspace_learning_logs l JOIN workspace_training_assignments a ON a.id=l.assignment_id WHERE l.id=$1 AND a.engagement_id=$2",
              [input.source.id, input.engagementId],
            );
      if (!source.rowCount)
        throw new ValidationError(
          "Provenance record does not belong to this engagement",
        );
      return idempotent(
        c,
        actor,
        "knowledge.submit_from_engagement",
        input.requestKey,
        input,
        async () => {
          await c.query(
            "INSERT INTO workspace_knowledge_sets(knowledge_key,kind,title,created_by) VALUES($1,$2,$3,$4)",
            [d.key, d.kind, d.title, actor.id],
          );
          await c.query(
            "INSERT INTO workspace_knowledge_versions(knowledge_key,version,state,definition,author_id,provenance_engagement_id,provenance_type,provenance_id) VALUES($1,1,'draft',$2,$3,$4,$5,$6)",
            [
              d.key,
              d,
              actor.id,
              input.engagementId,
              input.source.type,
              input.source.id,
            ],
          );
          return audit(
            c,
            actor,
            "knowledge.submit_from_engagement",
            input.engagementId,
            { definition: d, revision: 1 },
          );
        },
      );
    });
  }
  async updateDraft(
    actor: Actor,
    key: string,
    version: number,
    input: {
      requestKey: string;
      expectedRevision: number;
      title?: string;
      summary?: string;
      body?: string;
      sourceRefs?: KnowledgeSourceRef[];
    },
  ) {
    return transaction(this.pool, async (c) => {
      const row = await visible(c, actor, key, version, true);
      if (row.state !== "draft")
        throw new ConflictError("Only drafts can be edited");
      const old = row.definition as KnowledgeDefinition;
      const d = definition({ ...old, ...input, key, kind: old.kind }, version);
      return idempotent(
        c,
        actor,
        "knowledge.draft_update",
        input.requestKey,
        { key, version, ...input },
        async () => {
          if (Number(row.revision) !== input.expectedRevision)
            throw new ConflictError("Knowledge revision is stale");
          const r = await c.query(
            "UPDATE workspace_knowledge_versions SET definition=$3,revision=revision+1 WHERE knowledge_key=$1 AND version=$2 RETURNING revision",
            [key, version, d],
          );
          return audit(
            c,
            actor,
            "knowledge.draft_update",
            row.provenance_engagement_id,
            { definition: d, revision: Number(r.rows[0].revision) },
          );
        },
      );
    });
  }
  async createVersion(
    actor: Actor,
    key: string,
    sourceVersion: number,
    input: {
      requestKey: string;
      expectedRevision: number;
      rationale: string;
      title?: string;
      summary?: string;
      body?: string;
      sourceRefs?: KnowledgeSourceRef[];
    },
  ) {
    const rationale = clean(input.rationale, "Version rationale", 5000);
    return transaction(this.pool, async (c) => {
      const source = await visible(c, actor, key, sourceVersion, true);
      if (source.state !== "published")
        throw new ConflictError("A published source version is required");
      if (actor.role !== "practice_admin" && source.author_id !== actor.id)
        throw new AuthorizationError("Knowledge author access is required");
      return idempotent(
        c,
        actor,
        "knowledge.version_create",
        input.requestKey,
        { key, sourceVersion, ...input },
        async () => {
          if (Number(source.revision) !== input.expectedRevision)
            throw new ConflictError("Knowledge revision is stale");
          const next = await c.query<{ version: number }>(
            "SELECT COALESCE(max(version),0)+1 version FROM workspace_knowledge_versions WHERE knowledge_key=$1",
            [key],
          );
          const version = Number(next.rows[0]!.version);
          const old = source.definition as KnowledgeDefinition;
          const d = definition(
            { ...old, ...input, key, kind: old.kind },
            version,
          );
          await c.query(
            "INSERT INTO workspace_knowledge_versions(knowledge_key,version,state,definition,author_id) VALUES($1,$2,'draft',$3,$4)",
            [key, version, d, actor.id],
          );
          return audit(c, actor, "knowledge.version_create", null, {
            definition: d,
            revision: 1,
            sourceVersion,
            rationale,
          });
        },
      );
    });
  }
  async submitForReview(
    actor: Actor,
    key: string,
    version: number,
    input: { requestKey: string; expectedRevision: number; rationale: string },
  ) {
    const rationale = clean(input.rationale, "Submission rationale", 5000);
    return this.transition(
      actor,
      key,
      version,
      input,
      "draft",
      "submitted",
      "knowledge.submit_review",
      { submitted_at: "now()", submission_rationale: rationale },
    );
  }
  async publish(
    actor: Actor,
    key: string,
    version: number,
    input: { requestKey: string; expectedRevision: number; rationale: string },
  ) {
    const rationale = clean(input.rationale, "Review rationale", 5000);
    return transaction(this.pool, async (c) => {
      const found = await c.query(
        "SELECT v.*,s.archived_at FROM workspace_knowledge_versions v JOIN workspace_knowledge_sets s USING(knowledge_key) WHERE knowledge_key=$1 AND version=$2 FOR UPDATE OF v",
        [key, version],
      );
      const row = found.rows[0];
      if (!row) throw new NotFoundError("Knowledge version not found");
      await reviewer(c, actor, row);
      return idempotent(
        c,
        actor,
        "knowledge.publish",
        input.requestKey,
        { key, version, ...input },
        async () => {
          if (row.state !== "submitted")
            throw new ConflictError("Knowledge version is not awaiting review");
          if (Number(row.revision) !== input.expectedRevision)
            throw new ConflictError("Knowledge revision is stale");
          const r = await c.query(
            "UPDATE workspace_knowledge_versions SET state='published',revision=revision+1,reviewed_by=$3,reviewed_at=now(),review_rationale=$4 WHERE knowledge_key=$1 AND version=$2 RETURNING revision",
            [key, version, actor.id, rationale],
          );
          return audit(
            c,
            actor,
            "knowledge.publish",
            row.provenance_engagement_id,
            {
              key,
              version,
              revision: Number(r.rows[0].revision),
              rationale,
              adminOverride: actor.role === "practice_admin",
            },
          );
        },
      );
    });
  }
  async retire(
    actor: Actor,
    key: string,
    version: number,
    input: { requestKey: string; expectedRevision: number; rationale: string },
  ) {
    requireAdmin(actor);
    const rationale = clean(input.rationale, "Retirement rationale", 5000);
    return transaction(this.pool, async (c) => {
      const row = await visible(c, actor, key, version, true);
      return idempotent(
        c,
        actor,
        "knowledge.retire",
        input.requestKey,
        { key, version, ...input },
        async () => {
          if (row.state !== "published")
            throw new ConflictError("Only published knowledge can be retired");
          if (Number(row.revision) !== input.expectedRevision)
            throw new ConflictError("Knowledge revision is stale");
          const r = await c.query(
            "UPDATE workspace_knowledge_versions SET state='retired',revision=revision+1,retired_by=$3,retired_at=now(),retirement_rationale=$4 WHERE knowledge_key=$1 AND version=$2 RETURNING revision",
            [key, version, actor.id, rationale],
          );
          return audit(
            c,
            actor,
            "knowledge.retire",
            row.provenance_engagement_id,
            { key, version, revision: Number(r.rows[0].revision), rationale },
          );
        },
      );
    });
  }
  private async transition(
    actor: Actor,
    key: string,
    version: number,
    input: any,
    from: string,
    to: string,
    action: string,
    extra: any,
  ) {
    return transaction(this.pool, async (c) => {
      const row = await visible(c, actor, key, version, true);
      return idempotent(
        c,
        actor,
        action,
        input.requestKey,
        { key, version, ...input },
        async () => {
          if (row.state !== from)
            throw new ConflictError(`Knowledge version must be ${from}`);
          if (Number(row.revision) !== input.expectedRevision)
            throw new ConflictError("Knowledge revision is stale");
          const r = await c.query(
            `UPDATE workspace_knowledge_versions SET state=$3,revision=revision+1,submitted_at=${extra.submitted_at},submission_rationale=$4 WHERE knowledge_key=$1 AND version=$2 RETURNING revision`,
            [key, version, to, extra.submission_rationale],
          );
          return audit(c, actor, action, row.provenance_engagement_id, {
            key,
            version,
            revision: Number(r.rows[0].revision),
            rationale: extra.submission_rationale,
          });
        },
      );
    });
  }
  async setArchived(
    actor: Actor,
    key: string,
    input: { requestKey: string; expectedRevision: number; archived: boolean },
  ) {
    requireAdmin(actor);
    return transaction(this.pool, (c) =>
      idempotent(
        c,
        actor,
        "knowledge.archive",
        input.requestKey,
        { key, ...input },
        async () => {
          const r = await c.query(
            "UPDATE workspace_knowledge_sets SET archived_at=CASE WHEN $3 THEN now() ELSE NULL END,archived_by=CASE WHEN $3 THEN $4 ELSE NULL END,revision=revision+1 WHERE knowledge_key=$1 AND revision=$2 RETURNING revision,archived_at",
            [key, input.expectedRevision, input.archived, actor.id],
          );
          if (!r.rowCount)
            throw new ConflictError("Knowledge set revision is stale");
          return audit(c, actor, "knowledge.archive", null, {
            key,
            archived: input.archived,
            ...r.rows[0],
          });
        },
      ),
    );
  }
  async list(actor: Actor, input: { includeDrafts?: boolean } = {}) {
    const r = await this.pool.query(
      "SELECT s.knowledge_key,s.kind,s.title,s.archived_at,s.revision set_revision,v.version,v.state,v.revision,v.author_id,v.definition,v.reviewed_by,v.reviewed_at,v.review_rationale FROM workspace_knowledge_sets s JOIN workspace_knowledge_versions v USING(knowledge_key) WHERE (v.state IN ('published','retired') OR $1 OR v.author_id=$2 OR (v.state='submitted' AND EXISTS(SELECT 1 FROM workspace_engagement_memberships m WHERE m.engagement_id=v.provenance_engagement_id AND m.user_id=$2 AND m.role='reviewer'))) AND (s.archived_at IS NULL OR $3) ORDER BY s.knowledge_key,v.version DESC",
      [actor.role === "practice_admin", actor.id, input.includeDrafts === true],
    );
    return r.rows;
  }
  async getVersion(actor: Actor, key: string, version: number) {
    return transaction(this.pool, async (c) => {
      const row = await visible(c, actor, key, version);
      const {
        provenance_id,
        provenance_type,
        provenance_engagement_id,
        ...safe
      } = row;
      return { ...safe, hasPrivateProvenance: Boolean(provenance_id) };
    });
  }
  async link(
    actor: Actor,
    engagementId: string,
    input: {
      requestKey: string;
      key: string;
      version: number;
      rationale: string;
    },
  ) {
    const rationale = clean(input.rationale, "Link rationale", 5000);
    return transaction(this.pool, async (c) => {
      await authorizeEngagement(c, actor, engagementId, "knowledge.link");
      return idempotent(
        c,
        actor,
        "knowledge.link",
        input.requestKey,
        { engagementId, ...input },
        async () => {
          const v = await c.query(
            "SELECT 1 FROM workspace_knowledge_versions v JOIN workspace_knowledge_sets s USING(knowledge_key) WHERE v.knowledge_key=$1 AND v.version=$2 AND v.state='published' AND s.archived_at IS NULL",
            [input.key, input.version],
          );
          if (!v.rowCount)
            throw new ValidationError(
              "An active published knowledge version is required",
            );
          const id = randomUUID();
          await c.query(
            "INSERT INTO workspace_knowledge_links(id,engagement_id,knowledge_key,knowledge_version,rationale,linked_by) VALUES($1,$2,$3,$4,$5,$6)",
            [id, engagementId, input.key, input.version, rationale, actor.id],
          );
          return audit(c, actor, "knowledge.link", engagementId, {
            id,
            key: input.key,
            version: input.version,
            rationale,
          });
        },
      );
    });
  }
  async listLinks(actor: Actor, engagementId: string) {
    return transaction(this.pool, async (c) => {
      await authorizeEngagement(c, actor, engagementId, "knowledge.links_read");
      const r = await c.query(
        "SELECT l.*,v.definition,v.state FROM workspace_knowledge_links l JOIN workspace_knowledge_versions v ON v.knowledge_key=l.knowledge_key AND v.version=l.knowledge_version WHERE l.engagement_id=$1 ORDER BY l.linked_at,l.id",
        [engagementId],
      );
      return r.rows;
    });
  }
}
