import { randomUUID } from "node:crypto";
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

export interface ClientRecord {
  id: string;
  name: string;
}
export interface EngagementRecord {
  id: string;
  clientId: string;
  templateKey: string;
  templateVersion: number;
  title: string;
  accountableLeadUserId: string;
  state: string;
  revision: number;
}
export interface EngagementDetail extends EngagementRecord {
  stages: Array<{
    id: string;
    definitionKey: string;
    definition: { name: string };
    state: string;
  }>;
  items: Array<{
    id: string;
    definitionKey: string;
    definition: { name: string };
    status: string;
  }>;
}

const engagementFromRow = (row: Record<string, unknown>): EngagementRecord => ({
  id: String(row.id),
  clientId: String(row.client_id),
  templateKey: String(row.template_key),
  templateVersion: Number(row.template_version),
  title: String(row.title),
  accountableLeadUserId: String(row.accountable_lead_user_id),
  state: String(row.state),
  revision: Number(row.revision),
});

export class EngagementService {
  constructor(private readonly pool: ClientPool) {}

  async createClient(
    actor: Actor,
    input: { name: string; requestKey: string },
  ): Promise<ClientRecord> {
    requireAdmin(actor);
    if (!input.name.trim())
      throw new ValidationError("Client name is required");
    return transaction(this.pool, (client) =>
      idempotent(
        client,
        actor,
        "client.create",
        input.requestKey,
        input,
        async () => {
          const result: ClientRecord = {
            id: randomUUID(),
            name: input.name.trim(),
          };
          await client.query(
            "INSERT INTO workspace_clients(id,name,created_by) VALUES($1,$2,$3)",
            [result.id, result.name, actor.id],
          );
          await client.query(
            "INSERT INTO workspace_audit_events(actor_id,action,details) VALUES($1,$2,$3)",
            [actor.id, "client.create", { clientId: result.id }],
          );
          return result;
        },
      ),
    );
  }

  async listClients(actor: Actor): Promise<ClientRecord[]> {
    requireAdmin(actor);
    const r = await this.pool.query(
      "SELECT id,name FROM workspace_clients ORDER BY name,id",
    );
    return r.rows.map((x) => ({
      id: String((x as Record<string, unknown>).id),
      name: String((x as Record<string, unknown>).name),
    }));
  }

  async listAssignableUsers(
    actor: Actor,
  ): Promise<Array<{ id: string; email: string; displayName: string }>> {
    requireAdmin(actor);
    const r = await this.pool.query(
      "SELECT id,email,display_name FROM app_users WHERE disabled_at IS NULL ORDER BY display_name,id",
    );
    return r.rows.map((x) => {
      const v = x as Record<string, unknown>;
      return {
        id: String(v.id),
        email: String(v.email),
        displayName: String(v.display_name),
      };
    });
  }

  async createEngagement(
    actor: Actor,
    input: {
      clientId: string;
      templateKey: string;
      templateVersion: number;
      title: string;
      leadUserId: string;
      requestKey: string;
    },
  ): Promise<EngagementRecord> {
    requireAdmin(actor);
    if (!input.title.trim())
      throw new ValidationError("Engagement title is required");
    return transaction(this.pool, (client) =>
      idempotent(
        client,
        actor,
        "engagement.create",
        input.requestKey,
        input,
        async () => {
          const templateState = await client.query<{ archived_at: unknown }>("SELECT archived_at FROM workspace_templates WHERE template_key=$1 FOR SHARE", [input.templateKey]);
          if (templateState.rows[0]?.archived_at) throw new ValidationError("Restore the archived template before creating an engagement");
          const template = await client.query<{
            definition: {
              stages: Array<Record<string, unknown>>;
              checklistItems: Array<Record<string, unknown>>;
            };
          }>(
            "SELECT definition FROM workspace_template_versions WHERE template_key=$1 AND version=$2 AND state='published' FOR SHARE",
            [input.templateKey, input.templateVersion],
          );
          if (!template.rows[0])
            throw new ValidationError(
              "A published template version is required",
            );
          const clientExists = await client.query(
            "SELECT 1 FROM workspace_clients WHERE id=$1",
            [input.clientId],
          );
          if (!clientExists.rowCount)
            throw new NotFoundError("Client not found");
          const lead = await client.query(
            "SELECT 1 FROM app_users WHERE id=$1 AND disabled_at IS NULL",
            [input.leadUserId],
          );
          if (!lead.rowCount)
            throw new ValidationError("Lead must be an active internal user");
          const result: EngagementRecord = {
            id: randomUUID(),
            clientId: input.clientId,
            templateKey: input.templateKey,
            templateVersion: input.templateVersion,
            title: input.title.trim(),
            accountableLeadUserId: input.leadUserId,
            state: "draft",
            revision: 1,
          };
          await client.query(
            "INSERT INTO workspace_engagements(id,client_id,template_key,template_version,title,accountable_lead_user_id,created_by) VALUES($1,$2,$3,$4,$5,$6,$7)",
            [
              result.id,
              result.clientId,
              result.templateKey,
              result.templateVersion,
              result.title,
              result.accountableLeadUserId,
              actor.id,
            ],
          );
          await client.query(
            "INSERT INTO workspace_engagement_memberships(engagement_id,user_id,role,added_by) VALUES($1,$2,'engagement_lead',$3)",
            [result.id, input.leadUserId, actor.id],
          );
          const stages = template.rows[0].definition.stages;
          const stageIds = new Map<string, string>();
          for (const [position, definition] of stages.entries()) {
            const id = randomUUID();
            stageIds.set(String(definition.key), id);
            await client.query(
              "INSERT INTO workspace_stage_instances(id,engagement_id,definition_key,position,definition) VALUES($1,$2,$3,$4,$5)",
              [id, result.id, definition.key, position, definition],
            );
          }
          for (const [
            position,
            definition,
          ] of template.rows[0].definition.checklistItems.entries()) {
            const stageId = stageIds.get(String(definition.stageKey));
            if (!stageId)
              throw new ValidationError(
                "Checklist item references a missing stage",
              );
            await client.query(
              "INSERT INTO workspace_checklist_instances(id,engagement_id,stage_id,definition_key,position,definition) VALUES($1,$2,$3,$4,$5,$6)",
              [
                randomUUID(),
                result.id,
                stageId,
                definition.key,
                position,
                definition,
              ],
            );
          }
          await client.query(
            "INSERT INTO workspace_audit_events(actor_id,action,engagement_id,details) VALUES($1,$2,$3,$4)",
            [
              actor.id,
              "engagement.create",
              result.id,
              {
                templateKey: input.templateKey,
                templateVersion: input.templateVersion,
              },
            ],
          );
          return result;
        },
      ),
    );
  }

  async getEngagement(actor: Actor, id: string): Promise<EngagementRecord> {
    return transaction(this.pool, async (client) => {
      await authorizeEngagement(client, actor, id, "engagement.read");
      const r = await client.query(
        "SELECT * FROM workspace_engagements WHERE id=$1",
        [id],
      );
      return engagementFromRow(r.rows[0] as Record<string, unknown>);
    });
  }
  async getEngagementDetail(
    actor: Actor,
    id: string,
  ): Promise<EngagementDetail> {
    return transaction(this.pool, async (client) => {
      await authorizeEngagement(client, actor, id, "engagement.detail");
      const e = await client.query(
        "SELECT * FROM workspace_engagements WHERE id=$1",
        [id],
      );
      const s = await client.query(
        "SELECT id,definition_key,definition,state FROM workspace_stage_instances WHERE engagement_id=$1 ORDER BY position",
        [id],
      );
      const i = await client.query(
        "SELECT id,definition_key,definition,status FROM workspace_checklist_instances WHERE engagement_id=$1 ORDER BY position",
        [id],
      );
      const base = engagementFromRow(e.rows[0] as Record<string, unknown>);
      return {
        ...base,
        stages: s.rows.map((x) => {
          const v = x as Record<string, unknown>;
          return {
            id: String(v.id),
            definitionKey: String(v.definition_key),
            definition: v.definition as { name: string },
            state: String(v.state),
          };
        }),
        items: i.rows.map((x) => {
          const v = x as Record<string, unknown>;
          return {
            id: String(v.id),
            definitionKey: String(v.definition_key),
            definition: v.definition as { name: string },
            status: String(v.status),
          };
        }),
      };
    });
  }

  async listEngagements(actor: Actor): Promise<EngagementRecord[]> {
    return transaction(this.pool, async (client) => {
      if (actor.role === "practice_admin") {
        await client.query(
          "INSERT INTO workspace_audit_events(actor_id,action,details) VALUES($1,$2,$3)",
          [actor.id, "admin_access", { requestedAction: "engagement.list" }],
        );
        const r = await client.query(
          "SELECT * FROM workspace_engagements ORDER BY created_at DESC,id",
        );
        return r.rows.map((x) => engagementFromRow(x));
      }
      const r = await client.query(
        "SELECT DISTINCT e.* FROM workspace_engagements e JOIN workspace_engagement_memberships m ON m.engagement_id=e.id WHERE m.user_id=$1 ORDER BY e.created_at DESC,e.id",
        [actor.id],
      );
      return r.rows.map((x) => engagementFromRow(x));
    });
  }
}
