import type { TemplateVersionDefinition } from "../../../domain/src/templates/index.js";
import {
  createDraftVersion,
  publishTemplateVersion,
  validateTemplateVersion,
} from "../../../domain/src/templates/index.js";
import type { ClientPool } from "../database.js";
import { ConflictError, NotFoundError, ValidationError } from "./errors.js";
import { idempotent, requireAdmin, transaction } from "./shared.js";
import type { Actor } from "./types.js";

export interface StoredTemplateVersion {
  definition: TemplateVersionDefinition;
  revision: number;
  publishedBy?: string;
  publishedAt?: string;
}

export interface TemplateArchiveState {
  templateKey: string;
  archived: boolean;
  managementRevision: number;
}

export class TemplateService {
  constructor(private readonly pool: ClientPool) {}

  async importDraft(
    actor: Actor,
    input: { definition: TemplateVersionDefinition; requestKey: string },
  ): Promise<StoredTemplateVersion> {
    requireAdmin(actor);
    const { definition } = input;
    if (definition.state !== "draft")
      throw new ValidationError("Configuration imports must be drafts");
    const validation = validateTemplateVersion(definition);
    if (!validation.valid)
      throw new ValidationError(validation.errors.join("; "));
    return transaction(this.pool, (client) =>
      idempotent(
        client,
        actor,
        "template.draft_import",
        input.requestKey,
        input,
        async () => {
          await client.query(
            "INSERT INTO workspace_templates(template_key,name,purpose) VALUES($1,$2,$3) ON CONFLICT (template_key) DO NOTHING",
            [definition.templateKey, definition.name, definition.purpose],
          );
          try {
            await client.query(
              "INSERT INTO workspace_template_versions(template_key,version,state,definition,source_version,revision_reason) VALUES($1,$2,$3,$4,$5,$6)",
              [
                definition.templateKey,
                definition.version,
                "draft",
                definition,
                definition.sourceVersion ?? null,
                definition.revisionReason ?? null,
              ],
            );
          } catch (error) {
            if ((error as { code?: string }).code === "23505")
              throw new ConflictError("Template version already exists");
            throw error;
          }
          await client.query(
            "INSERT INTO workspace_audit_events(actor_id,action,details) VALUES($1,$2,$3)",
            [
              actor.id,
              "template.draft_import",
              {
                templateKey: definition.templateKey,
                version: definition.version,
              },
            ],
          );
          return { definition, revision: 1 };
        },
      ),
    );
  }

  async listTemplates(_actor: Actor): Promise<
    Array<{
      templateKey: string;
      name: string;
      purpose: string;
      isArchived: boolean;
      managementRevision: number;
      versions: Array<{ version: number; state: string; revision: number }>;
    }>
  > {
    const result = await this.pool.query(
      `SELECT t.template_key,t.name,t.purpose,t.archived_at,t.management_revision,COALESCE(jsonb_agg(jsonb_build_object('version',v.version,'state',v.state,'revision',v.revision) ORDER BY v.version) FILTER (WHERE v.version IS NOT NULL),'[]') versions FROM workspace_templates t LEFT JOIN workspace_template_versions v USING(template_key) GROUP BY t.template_key,t.name,t.purpose,t.archived_at,t.management_revision ORDER BY t.template_key`,
    );
    return result.rows.map((row) => {
      const r = row as Record<string, unknown>;
      return {
        templateKey: String(r.template_key),
        name: String(r.name),
        purpose: String(r.purpose),
        isArchived: r.archived_at !== null,
        managementRevision: Number(r.management_revision),
        versions: r.versions as Array<{
          version: number;
          state: string;
          revision: number;
        }>,
      };
    });
  }

  async setArchived(
    actor: Actor,
    input: {
      templateKey: string;
      archived: boolean;
      expectedRevision: number;
      requestKey: string;
    },
  ): Promise<TemplateArchiveState> {
    requireAdmin(actor);
    const action = input.archived ? "template.archive" : "template.restore";
    return transaction(this.pool, (client) =>
      idempotent(client, actor, action, input.requestKey, input, async () => {
        const found = await client.query<{
          template_key: string;
          management_revision: string;
          archived_at: Date | null;
        }>(
          "SELECT template_key,management_revision,archived_at FROM workspace_templates WHERE template_key=$1 FOR UPDATE",
          [input.templateKey],
        );
        const row = found.rows[0];
        if (!row) throw new NotFoundError("Template not found");
        if (Number(row.management_revision) !== input.expectedRevision)
          throw new ConflictError("Template management revision is stale");
        const currentlyArchived = row.archived_at !== null;
        if (currentlyArchived === input.archived)
          return {
            templateKey: input.templateKey,
            archived: currentlyArchived,
            managementRevision: Number(row.management_revision),
          };
        if (input.archived) {
          const referenced = await client.query(
            "SELECT 1 FROM workspace_engagements WHERE template_key=$1 LIMIT 1",
            [input.templateKey],
          );
          if (referenced.rowCount)
            throw new ConflictError(
              "Template is used by an engagement and cannot be archived",
            );
        }
        const updated = await client.query<{ management_revision: string }>(
          input.archived
            ? "UPDATE workspace_templates SET archived_at=now(),archived_by=$2,management_revision=management_revision+1 WHERE template_key=$1 RETURNING management_revision"
            : "UPDATE workspace_templates SET archived_at=NULL,archived_by=NULL,management_revision=management_revision+1 WHERE template_key=$1 RETURNING management_revision",
          input.archived ? [input.templateKey, actor.id] : [input.templateKey],
        );
        await client.query(
          "INSERT INTO workspace_audit_events(actor_id,action,details) VALUES($1,$2,$3)",
          [actor.id, action, { templateKey: input.templateKey }],
        );
        return {
          templateKey: input.templateKey,
          archived: input.archived,
          managementRevision: Number(updated.rows[0]!.management_revision),
        };
      }),
    );
  }

  async getTemplateVersion(
    _actor: Actor,
    templateKey: string,
    version: number,
  ): Promise<StoredTemplateVersion> {
    const result = await this.pool.query(
      "SELECT definition,revision,published_by,published_at FROM workspace_template_versions WHERE template_key=$1 AND version=$2",
      [templateKey, version],
    );
    const row = result.rows[0] as Record<string, unknown> | undefined;
    if (!row) throw new NotFoundError("Template version not found");
    return {
      definition: row.definition as TemplateVersionDefinition,
      revision: Number(row.revision),
      ...(row.published_by
        ? {
            publishedBy: String(row.published_by),
            publishedAt: new Date(String(row.published_at)).toISOString(),
          }
        : {}),
    };
  }

  async publish(
    actor: Actor,
    input: {
      templateKey: string;
      version: number;
      expectedRevision: number;
      requestKey: string;
    },
  ): Promise<StoredTemplateVersion> {
    requireAdmin(actor);
    return transaction(this.pool, (client) =>
      idempotent(
        client,
        actor,
        "template.publish",
        input.requestKey,
        input,
        async () => {
          const found = await client.query<{
            definition: TemplateVersionDefinition;
            revision: string;
          }>(
            "SELECT definition,revision FROM workspace_template_versions WHERE template_key=$1 AND version=$2 FOR UPDATE",
            [input.templateKey, input.version],
          );
          const row = found.rows[0];
          if (!row) throw new NotFoundError("Template version not found");
          if (Number(row.revision) !== input.expectedRevision)
            throw new ConflictError("Template revision is stale");
          let definition;
          try {
            definition = publishTemplateVersion(row.definition);
          } catch (error) {
            throw new ValidationError((error as Error).message);
          }
          const updated = await client.query<{
            revision: string;
            published_at: Date;
          }>(
            "UPDATE workspace_template_versions SET state=$3,definition=$4,revision=revision+1,published_by=$5,published_at=now() WHERE template_key=$1 AND version=$2 RETURNING revision,published_at",
            [
              input.templateKey,
              input.version,
              "published",
              definition,
              actor.id,
            ],
          );
          await client.query(
            "INSERT INTO workspace_audit_events(actor_id,action,details) VALUES($1,$2,$3)",
            [
              actor.id,
              "template.publish",
              {
                templateKey: input.templateKey,
                version: input.version,
                priorRevision: input.expectedRevision,
              },
            ],
          );
          return {
            definition: definition as TemplateVersionDefinition,
            revision: Number(updated.rows[0]!.revision),
            publishedBy: actor.id,
            publishedAt: updated.rows[0]!.published_at.toISOString(),
          };
        },
      ),
    );
  }

  async createVersion(
    actor: Actor,
    input: {
      templateKey: string;
      sourceVersion: number;
      expectedRevision: number;
      changes: Partial<TemplateVersionDefinition>;
      reason: string;
      requestKey: string;
    },
  ): Promise<StoredTemplateVersion> {
    requireAdmin(actor);
    return transaction(this.pool, (client) =>
      idempotent(
        client,
        actor,
        "template.new_version",
        input.requestKey,
        input,
        async () => {
          const found = await client.query<{
            definition: TemplateVersionDefinition;
            revision: string;
          }>(
            "SELECT definition,revision FROM workspace_template_versions WHERE template_key=$1 AND version=$2 FOR SHARE",
            [input.templateKey, input.sourceVersion],
          );
          const row = found.rows[0];
          if (!row)
            throw new NotFoundError("Source template version not found");
          if (Number(row.revision) !== input.expectedRevision)
            throw new ConflictError("Template revision is stale");
          let draft;
          try {
            draft = createDraftVersion(
              row.definition as Parameters<typeof createDraftVersion>[0],
              input.changes,
              input.reason,
            );
          } catch (error) {
            throw new ValidationError((error as Error).message);
          }
          try {
            await client.query(
              "INSERT INTO workspace_template_versions(template_key,version,state,definition,source_version,revision_reason) VALUES($1,$2,$3,$4,$5,$6)",
              [
                draft.templateKey,
                draft.version,
                draft.state,
                draft,
                draft.sourceVersion,
                draft.revisionReason,
              ],
            );
          } catch (error) {
            if ((error as { code?: string }).code === "23505")
              throw new ConflictError("Next template version already exists");
            throw error;
          }
          await client.query(
            "INSERT INTO workspace_audit_events(actor_id,action,details) VALUES($1,$2,$3)",
            [
              actor.id,
              "template.new_version",
              {
                templateKey: draft.templateKey,
                version: draft.version,
                sourceVersion: draft.sourceVersion,
                reason: draft.revisionReason,
              },
            ],
          );
          return { definition: draft, revision: 1 };
        },
      ),
    );
  }

  async updateDraft(
    actor: Actor,
    input: {
      templateKey: string;
      version: number;
      expectedRevision: number;
      definition: Partial<TemplateVersionDefinition>;
      reason: string;
      requestKey: string;
    },
  ): Promise<StoredTemplateVersion> {
    requireAdmin(actor);
    if (!input.reason.trim())
      throw new ValidationError("A draft correction reason is required");
    return transaction(this.pool, (client) =>
      idempotent(
        client,
        actor,
        "template.draft_update",
        input.requestKey,
        input,
        async () => {
          const found = await client.query<{
            definition: TemplateVersionDefinition;
            revision: string;
            state: string;
          }>(
            "SELECT definition,revision,state FROM workspace_template_versions WHERE template_key=$1 AND version=$2 FOR UPDATE",
            [input.templateKey, input.version],
          );
          const row = found.rows[0];
          if (!row) throw new NotFoundError("Template version not found");
          if (row.state !== "draft")
            throw new ConflictError(
              "Only draft template versions can be edited",
            );
          if (Number(row.revision) !== input.expectedRevision)
            throw new ConflictError("Template revision is stale");
          const changes = structuredClone(input.definition);
          delete changes.templateKey;
          delete changes.version;
          delete changes.state;
          delete changes.sourceVersion;
          delete changes.revisionReason;
          const definition: TemplateVersionDefinition = {
            ...row.definition,
            ...changes,
            templateKey: row.definition.templateKey,
            version: row.definition.version,
            state: "draft",
          };
          const validation = validateTemplateVersion(definition);
          if (!validation.valid)
            throw new ValidationError(validation.errors.join("; "));
          const updated = await client.query<{ revision: string }>(
            "UPDATE workspace_template_versions SET definition=$3,revision=revision+1 WHERE template_key=$1 AND version=$2 RETURNING revision",
            [input.templateKey, input.version, definition],
          );
          await client.query(
            "INSERT INTO workspace_audit_events(actor_id,action,details) VALUES($1,$2,$3)",
            [
              actor.id,
              "template.draft_update",
              {
                templateKey: input.templateKey,
                version: input.version,
                priorRevision: input.expectedRevision,
                reason: input.reason.trim(),
              },
            ],
          );
          return {
            definition,
            revision: Number(updated.rows[0]!.revision),
          };
        },
      ),
    );
  }

  async retire(
    actor: Actor,
    input: {
      templateKey: string;
      version: number;
      expectedRevision: number;
      requestKey: string;
    },
  ): Promise<StoredTemplateVersion> {
    requireAdmin(actor);
    return transaction(this.pool, (c) =>
      idempotent(
        c,
        actor,
        "template.retire",
        input.requestKey,
        input,
        async () => {
          const found = await c.query<{
            definition: TemplateVersionDefinition;
            revision: string;
            published_by: string;
            published_at: Date;
          }>(
            "SELECT definition,revision,published_by,published_at FROM workspace_template_versions WHERE template_key=$1 AND version=$2 AND state='published' FOR UPDATE",
            [input.templateKey, input.version],
          );
          const row = found.rows[0];
          if (!row)
            throw new ValidationError(
              "A published template version is required",
            );
          if (Number(row.revision) !== input.expectedRevision)
            throw new ConflictError("Template revision is stale");
          const definition = { ...row.definition, state: "retired" as const };
          const updated = await c.query<{ revision: string }>(
            "UPDATE workspace_template_versions SET state='retired',definition=$3,revision=revision+1 WHERE template_key=$1 AND version=$2 RETURNING revision",
            [input.templateKey, input.version, definition],
          );
          await c.query(
            "INSERT INTO workspace_audit_events(actor_id,action,details) VALUES($1,$2,$3)",
            [
              actor.id,
              "template.retire",
              { templateKey: input.templateKey, version: input.version },
            ],
          );
          return {
            definition,
            revision: Number(updated.rows[0]!.revision),
            publishedBy: row.published_by,
            publishedAt: row.published_at.toISOString(),
          };
        },
      ),
    );
  }
}
