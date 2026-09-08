import { randomUUID } from "node:crypto";
import { readFile } from "node:fs/promises";
import { resolve } from "node:path";
import type { PoolClient } from "pg";
import {
  publishTemplateVersion,
  validateTemplateVersion,
  type TemplateVersionDefinition,
} from "../../../domain/src/templates/index.js";
import type { ClientPool } from "../database.js";
import { ConflictError, ValidationError } from "./errors.js";
import { idempotent, requireAdmin, transaction } from "./shared.js";
import type { Actor } from "./types.js";

const PACK_FILE = "samples/engagement-walkthrough.v1.json";
const PACK_KEY = "engagement-walkthrough-v1";
interface Pack {
  packKey: string;
  templates: Array<{ templateKey: string; sourceFile: string }>;
  clients: Array<{ key: string; name: string }>;
  engagements: Array<{
    key: string;
    clientKey: string;
    templateKey: string;
    title: string;
  }>;
}
export interface SamplePackStatus {
  state: "empty" | "loaded";
  revision: number;
  clients: number;
  engagements: number;
  clientIds: string[];
  engagementIds: string[];
  generationId?: string;
}

async function readPack(): Promise<Pack> {
  const pack = JSON.parse(
    await readFile(resolve(process.cwd(), PACK_FILE), "utf8"),
  ) as Pack;
  if (pack.packKey !== PACK_KEY)
    throw new ValidationError("Unexpected sample pack identity");
  return pack;
}
async function currentStatus(c: PoolClient): Promise<SamplePackStatus> {
  const p = await c.query<{
    state: "empty" | "loaded";
    revision: string;
    generation_id: string | null;
  }>(
    "SELECT state,revision,generation_id FROM workspace_sample_packs WHERE pack_key=$1",
    [PACK_KEY],
  );
  const row = p.rows[0];
  if (!row)
    return {
      state: "empty",
      revision: 0,
      clients: 0,
      engagements: 0,
      clientIds: [],
      engagementIds: [],
    };
  const clients = await c.query<{ client_id: string }>(
    "SELECT client_id FROM workspace_sample_clients WHERE pack_key=$1 AND generation_id=$2 ORDER BY client_id",
    [PACK_KEY, row.generation_id],
  );
  const engagements = await c.query<{ engagement_id: string }>(
    "SELECT engagement_id FROM workspace_sample_engagements WHERE pack_key=$1 AND generation_id=$2 ORDER BY engagement_id",
    [PACK_KEY, row.generation_id],
  );
  return {
    state: row.state,
    revision: Number(row.revision),
    clients: clients.rowCount ?? 0,
    engagements: engagements.rowCount ?? 0,
    clientIds: clients.rows.map((x) => x.client_id),
    engagementIds: engagements.rows.map((x) => x.engagement_id),
    ...(row.generation_id ? { generationId: row.generation_id } : {}),
  };
}
async function ensureTemplate(
  c: PoolClient,
  actor: Actor,
  t: Pack["templates"][number],
): Promise<TemplateVersionDefinition> {
  const templateState = await c.query<{ archived_at: unknown }>(
    "SELECT archived_at FROM workspace_templates WHERE template_key=$1 FOR SHARE",
    [t.templateKey],
  );
  if (templateState.rows[0]?.archived_at)
    throw new ConflictError(
      "Restore the archived sample templates from Templates before loading the sample pack",
    );
  const provenance = await c.query<{
    version: number;
    state: string;
    definition: TemplateVersionDefinition;
  }>(
    "SELECT p.version,v.state,v.definition FROM workspace_sample_template_versions p JOIN workspace_template_versions v ON v.template_key=p.template_key AND v.version=p.version WHERE p.pack_key=$1 AND p.template_key=$2 ORDER BY p.version DESC",
    [PACK_KEY, t.templateKey],
  );
  if (provenance.rowCount) {
    const published = provenance.rows.find((row) => row.state === "published");
    if (published) return published.definition;
    if (provenance.rows.some((row) => row.state !== "retired"))
      throw new ConflictError("Sample template provenance is incomplete");
    const source = JSON.parse(
      await readFile(resolve(process.cwd(), t.sourceFile), "utf8"),
    ) as TemplateVersionDefinition;
    const version = provenance.rows[0]!.version + 1;
    const replacement = publishTemplateVersion({
      ...source,
      templateKey: t.templateKey,
      version,
      state: "draft",
      name: `[Sample] ${source.name}`,
      purpose: `Fictional evaluation walkthrough. ${source.purpose}`,
      sourceVersion: provenance.rows[0]!.version,
      revisionReason: "Replace retired sample walkthrough configuration",
    }) as TemplateVersionDefinition;
    const validation = validateTemplateVersion(replacement);
    if (!validation.valid)
      throw new ValidationError(
        `Invalid sample template: ${validation.errors.join("; ")}`,
      );
    await c.query(
      "INSERT INTO workspace_template_versions(template_key,version,state,definition,source_version,revision_reason,published_by,published_at) VALUES($1,$2,'published',$3,$4,$5,$6,now())",
      [
        replacement.templateKey,
        replacement.version,
        replacement,
        replacement.sourceVersion,
        replacement.revisionReason,
        actor.id,
      ],
    );
    await c.query(
      "INSERT INTO workspace_sample_template_versions(pack_key,template_key,version) VALUES($1,$2,$3)",
      [PACK_KEY, replacement.templateKey, replacement.version],
    );
    return replacement;
  }
  const collision = await c.query(
    "SELECT 1 FROM workspace_templates WHERE template_key=$1",
    [t.templateKey],
  );
  if (collision.rowCount)
    throw new ConflictError(`Template identity collision: ${t.templateKey}`);
  const source = JSON.parse(
    await readFile(resolve(process.cwd(), t.sourceFile), "utf8"),
  ) as TemplateVersionDefinition;
  const draft = {
    ...source,
    templateKey: t.templateKey,
    version: 1,
    state: "draft" as const,
    name: `[Sample] ${source.name}`,
    purpose: `Fictional evaluation walkthrough. ${source.purpose}`,
  };
  const validation = validateTemplateVersion(draft);
  if (!validation.valid)
    throw new ValidationError(
      `Invalid sample template: ${validation.errors.join("; ")}`,
    );
  const published = publishTemplateVersion(draft) as TemplateVersionDefinition;
  await c.query(
    "INSERT INTO workspace_templates(template_key,name,purpose) VALUES($1,$2,$3)",
    [published.templateKey, published.name, published.purpose],
  );
  await c.query(
    "INSERT INTO workspace_template_versions(template_key,version,state,definition,published_by,published_at) VALUES($1,$2,'published',$3,$4,now())",
    [published.templateKey, published.version, published, actor.id],
  );
  await c.query(
    "INSERT INTO workspace_sample_template_versions(pack_key,template_key,version) VALUES($1,$2,$3)",
    [PACK_KEY, published.templateKey, published.version],
  );
  return published;
}
async function instantiate(
  c: PoolClient,
  engagementId: string,
  d: TemplateVersionDefinition,
): Promise<void> {
  const stages = new Map<string, string>();
  for (const [position, stage] of d.stages.entries()) {
    const id = randomUUID();
    stages.set(stage.key, id);
    await c.query(
      "INSERT INTO workspace_stage_instances(id,engagement_id,definition_key,position,definition) VALUES($1,$2,$3,$4,$5)",
      [id, engagementId, stage.key, position, stage],
    );
  }
  for (const [position, item] of d.checklistItems.entries()) {
    const stageId = stages.get(item.stageKey);
    if (!stageId)
      throw new ValidationError(
        "Sample checklist item references a missing stage",
      );
    await c.query(
      "INSERT INTO workspace_checklist_instances(id,engagement_id,stage_id,definition_key,position,definition) VALUES($1,$2,$3,$4,$5,$6)",
      [randomUUID(), engagementId, stageId, item.key, position, item],
    );
  }
}

export class SampleService {
  constructor(private readonly pool: ClientPool) {}
  async status(actor: Actor): Promise<SamplePackStatus> {
    requireAdmin(actor);
    return transaction(this.pool, async (client) => {
      await client.query(
        "SELECT pg_advisory_xact_lock(hashtextextended($1,0))",
        [PACK_KEY],
      );
      return currentStatus(client);
    });
  }
  async load(
    actor: Actor,
    input: {
      expectedRevision: number;
      requestKey: string;
      confirmation: "load-sample-data";
    },
  ): Promise<SamplePackStatus> {
    requireAdmin(actor);
    if (input.confirmation !== "load-sample-data")
      throw new ValidationError(
        "Explicit sample load confirmation is required",
      );
    const pack = await readPack();
    return transaction(this.pool, async (c) => {
      await c.query("SELECT pg_advisory_xact_lock(hashtextextended($1,0))", [
        PACK_KEY,
      ]);
      await c.query(
        "INSERT INTO workspace_sample_packs(pack_key,state,revision) VALUES($1,'empty',0) ON CONFLICT DO NOTHING",
        [PACK_KEY],
      );
      return idempotent(
        c,
        actor,
        "sample_pack.load",
        input.requestKey,
        input,
        async () => {
          const before = await currentStatus(c);
          if (before.revision !== input.expectedRevision)
            throw new ConflictError("Sample pack revision is stale");
          if (before.state === "loaded") return before;
          const definitions = new Map<string, TemplateVersionDefinition>();
          for (const t of pack.templates)
            definitions.set(t.templateKey, await ensureTemplate(c, actor, t));
          const generationId = randomUUID();
          const clientIds = new Map<string, string>();
          for (const item of pack.clients) {
            const id = randomUUID();
            clientIds.set(item.key, id);
            await c.query(
              "INSERT INTO workspace_clients(id,name,created_by) VALUES($1,$2,$3)",
              [id, item.name, actor.id],
            );
            await c.query(
              "INSERT INTO workspace_sample_clients(pack_key,generation_id,client_id) VALUES($1,$2,$3)",
              [PACK_KEY, generationId, id],
            );
          }
          for (const item of pack.engagements) {
            const clientId = clientIds.get(item.clientKey);
            const definition = definitions.get(item.templateKey);
            if (!clientId || !definition)
              throw new ValidationError(
                "Sample engagement has an invalid configuration reference",
              );
            const id = randomUUID();
            await c.query(
              "INSERT INTO workspace_engagements(id,client_id,template_key,template_version,title,accountable_lead_user_id,created_by) VALUES($1,$2,$3,$4,$5,$6,$6)",
              [
                id,
                clientId,
                definition.templateKey,
                definition.version,
                item.title,
                actor.id,
              ],
            );
            await c.query(
              "INSERT INTO workspace_engagement_memberships(engagement_id,user_id,role,added_by) VALUES($1,$2,'engagement_lead',$2)",
              [id, actor.id],
            );
            await c.query(
              "INSERT INTO workspace_sample_engagements(pack_key,generation_id,engagement_id) VALUES($1,$2,$3)",
              [PACK_KEY, generationId, id],
            );
            await instantiate(c, id, definition);
          }
          await c.query(
            "UPDATE workspace_sample_packs SET state='loaded',revision=revision+1,generation_id=$2,loaded_by=$3,loaded_at=now() WHERE pack_key=$1",
            [PACK_KEY, generationId, actor.id],
          );
          const result = await currentStatus(c);
          await c.query(
            "INSERT INTO workspace_audit_events(actor_id,action,details) VALUES($1,$2,$3)",
            [
              actor.id,
              "sample_pack.load",
              {
                packKey: PACK_KEY,
                generationId,
                clients: result.clients,
                engagements: result.engagements,
              },
            ],
          );
          return result;
        },
      );
    });
  }
  async remove(
    actor: Actor,
    input: {
      expectedRevision: number;
      requestKey: string;
      confirmation: "remove-sample-data";
    },
  ): Promise<SamplePackStatus> {
    requireAdmin(actor);
    if (input.confirmation !== "remove-sample-data")
      throw new ValidationError(
        "Explicit sample removal confirmation is required",
      );
    return transaction(this.pool, async (c) => {
      await c.query("SELECT pg_advisory_xact_lock(hashtextextended($1,0))", [
        PACK_KEY,
      ]);
      return idempotent(
        c,
        actor,
        "sample_pack.remove",
        input.requestKey,
        input,
        async () => {
          const before = await currentStatus(c);
          if (before.revision !== input.expectedRevision)
            throw new ConflictError("Sample pack revision is stale");
          if (before.state === "empty") return before;
          const refs = await c.query(
            "SELECT e.id FROM workspace_engagements e JOIN workspace_sample_clients sc ON sc.client_id=e.client_id LEFT JOIN workspace_sample_engagements se ON se.engagement_id=e.id AND se.pack_key=sc.pack_key AND se.generation_id=sc.generation_id WHERE sc.pack_key=$1 AND sc.generation_id=$2 AND se.engagement_id IS NULL LIMIT 1",
            [PACK_KEY, before.generationId],
          );
          if (refs.rowCount)
            throw new ConflictError(
              "A non-sample engagement references a sample client",
            );
          await c.query(
            "DELETE FROM workspace_sample_engagements WHERE pack_key=$1 AND generation_id=$2",
            [PACK_KEY, before.generationId],
          );
          await c.query(
            "DELETE FROM workspace_engagements WHERE id=ANY($1::text[])",
            [before.engagementIds],
          );
          await c.query(
            "DELETE FROM workspace_sample_clients WHERE pack_key=$1 AND generation_id=$2",
            [PACK_KEY, before.generationId],
          );
          await c.query(
            "DELETE FROM workspace_clients WHERE id=ANY($1::text[])",
            [before.clientIds],
          );
          await c.query(
            "UPDATE workspace_sample_packs SET state='empty',revision=revision+1,generation_id=NULL,loaded_by=NULL,loaded_at=NULL WHERE pack_key=$1",
            [PACK_KEY],
          );
          const result = await currentStatus(c);
          await c.query(
            "INSERT INTO workspace_audit_events(actor_id,action,details) VALUES($1,$2,$3)",
            [
              actor.id,
              "sample_pack.remove",
              {
                packKey: PACK_KEY,
                generationId: before.generationId,
                clients: before.clients,
                engagements: before.engagements,
              },
            ],
          );
          return result;
        },
      );
    });
  }
}
