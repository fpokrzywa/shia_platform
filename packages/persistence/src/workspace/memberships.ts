import type { ClientPool } from "../database.js";
import { ConflictError, ValidationError } from "./errors.js";
import {
  authorizeEngagement,
  idempotent,
  requireAdmin,
  transaction,
} from "./shared.js";
import type { Actor, EngagementRole } from "./types.js";
export interface MembershipRecord {
  engagementId: string;
  userId: string;
  role: EngagementRole;
  displayName: string;
  email: string;
}
export class MembershipService {
  constructor(private readonly pool: ClientPool) {}
  async list(actor: Actor, engagementId: string): Promise<MembershipRecord[]> {
    return transaction(this.pool, async (c) => {
      await authorizeEngagement(c, actor, engagementId, "membership.list");
      const r = await c.query(
        "SELECT m.engagement_id,m.user_id,m.role,u.display_name,u.email FROM workspace_engagement_memberships m JOIN app_users u ON u.id=m.user_id WHERE m.engagement_id=$1 ORDER BY u.display_name,m.user_id,m.role",
        [engagementId],
      );
      return r.rows.map((x) => {
        const v = x as Record<string, unknown>;
        return {
          engagementId: String(v.engagement_id),
          userId: String(v.user_id),
          role: v.role as EngagementRole,
          displayName: String(v.display_name),
          email: String(v.email),
        };
      });
    });
  }
  async add(
    actor: Actor,
    input: {
      engagementId: string;
      userId: string;
      role: EngagementRole;
      expectedRevision: number;
      requestKey: string;
    },
  ) {
    requireAdmin(actor);
    return transaction(this.pool, (c) =>
      idempotent(
        c,
        actor,
        "membership.add",
        input.requestKey,
        input,
        async () => {
          const e = await c.query<{ revision: string }>(
            "SELECT revision FROM workspace_engagements WHERE id=$1 FOR UPDATE",
            [input.engagementId],
          );
          if (!e.rows[0]) throw new ValidationError("Engagement not found");
          if (Number(e.rows[0].revision) !== input.expectedRevision)
            throw new ConflictError("Engagement revision is stale");
          const u = await c.query<{ display_name: string; email: string }>(
            "SELECT display_name,email FROM app_users WHERE id=$1 AND disabled_at IS NULL",
            [input.userId],
          );
          if (!u.rows[0])
            throw new ValidationError("Member must be an active internal user");
          await c.query(
            "INSERT INTO workspace_engagement_memberships(engagement_id,user_id,role,added_by) VALUES($1,$2,$3,$4) ON CONFLICT DO NOTHING",
            [input.engagementId, input.userId, input.role, actor.id],
          );
          const updated = await c.query<{ revision: string }>(
            "UPDATE workspace_engagements SET revision=revision+1 WHERE id=$1 RETURNING revision",
            [input.engagementId],
          );
          await c.query(
            "INSERT INTO workspace_audit_events(actor_id,action,engagement_id,details) VALUES($1,$2,$3,$4)",
            [
              actor.id,
              "membership.add",
              input.engagementId,
              { userId: input.userId, role: input.role },
            ],
          );
          return {
            membership: {
              engagementId: input.engagementId,
              userId: input.userId,
              role: input.role,
              displayName: u.rows[0].display_name,
              email: u.rows[0].email,
            },
            engagementRevision: Number(updated.rows[0]!.revision),
          };
        },
      ),
    );
  }
  async remove(
    actor: Actor,
    input: {
      engagementId: string;
      userId: string;
      role: EngagementRole;
      expectedRevision: number;
      requestKey: string;
    },
  ) {
    requireAdmin(actor);
    return transaction(this.pool, (c) =>
      idempotent(
        c,
        actor,
        "membership.remove",
        input.requestKey,
        input,
        async () => {
          const e = await c.query<{
            revision: string;
            accountable_lead_user_id: string;
          }>(
            "SELECT revision,accountable_lead_user_id FROM workspace_engagements WHERE id=$1 FOR UPDATE",
            [input.engagementId],
          );
          const row = e.rows[0];
          if (!row) throw new ValidationError("Engagement not found");
          if (Number(row.revision) !== input.expectedRevision)
            throw new ConflictError("Engagement revision is stale");
          if (
            row.accountable_lead_user_id === input.userId &&
            input.role === "engagement_lead"
          )
            throw new ValidationError(
              "The accountable lead role cannot be removed",
            );
          const d = await c.query(
            "DELETE FROM workspace_engagement_memberships WHERE engagement_id=$1 AND user_id=$2 AND role=$3",
            [input.engagementId, input.userId, input.role],
          );
          const updated = await c.query<{ revision: string }>(
            "UPDATE workspace_engagements SET revision=revision+1 WHERE id=$1 RETURNING revision",
            [input.engagementId],
          );
          await c.query(
            "INSERT INTO workspace_audit_events(actor_id,action,engagement_id,details) VALUES($1,$2,$3,$4)",
            [
              actor.id,
              "membership.remove",
              input.engagementId,
              { userId: input.userId, role: input.role, removed: !!d.rowCount },
            ],
          );
          return {
            removed: !!d.rowCount,
            engagementRevision: Number(updated.rows[0]!.revision),
          };
        },
      ),
    );
  }
}
