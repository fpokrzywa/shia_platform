import type { ClientPool } from "../database.js";
import { ReadinessService } from "./readiness.js";
import { transaction } from "./shared.js";
import type { Actor } from "./types.js";
const camel = (row: Record<string, any>) =>
  Object.fromEntries(
    Object.entries(row).map(([key, value]) => [
      key.replace(/_([a-z])/g, (_, letter: string) => letter.toUpperCase()),
      value,
    ]),
  );
export class PortfolioService {
  constructor(private readonly pool: ClientPool) {}
  async list(actor: Actor) {
    const rows = await transaction(this.pool, async (c) => {
      const ids = await c.query(
        "SELECT e.id FROM workspace_engagements e WHERE $1 OR EXISTS(SELECT 1 FROM workspace_engagement_memberships m WHERE m.engagement_id=e.id AND m.user_id=$2) ORDER BY e.created_at DESC,e.id",
        [actor.role === "practice_admin", actor.id],
      );
      const result = [];
      for (const { id } of ids.rows) {
        if (actor.role === "practice_admin")
          await c.query(
            "INSERT INTO workspace_audit_events(actor_id,action,engagement_id,details) VALUES($1,'admin_access',$2,$3)",
            [actor.id, id, { requestedAction: "portfolio.list" }],
          );
        const r = await c.query(
          `SELECT e.id,e.title,e.state,c.id client_id,c.name client_name,
(SELECT count(*)::int FROM workspace_checklist_instances i WHERE i.engagement_id=e.id AND i.status NOT IN('complete','not_applicable')) open_items,
(SELECT count(*)::int FROM workspace_checklist_instances i WHERE i.engagement_id=e.id AND i.status NOT IN('complete','not_applicable') AND i.due_date<CURRENT_DATE) overdue_items,
(SELECT count(*)::int FROM workspace_checklist_instances i WHERE i.engagement_id=e.id AND i.status='ready_for_review') awaiting_review_items,
(SELECT jsonb_object_agg(severity,n) FROM (SELECT severity,count(*)::int n FROM workspace_delivery_risks WHERE engagement_id=e.id AND status='open' GROUP BY severity) x) open_risks,
(SELECT jsonb_agg(jsonb_build_object('id',m.id,'name',m.name,'unit',m.unit,'baseline',m.baseline,'target',m.target,'latestValue',o.value,'observedOn',o.observed_on) ORDER BY m.created_at,m.id) FROM workspace_outcome_metrics m LEFT JOIN LATERAL(SELECT value,observed_on FROM workspace_outcome_observations WHERE metric_id=m.id ORDER BY observed_on DESC,id DESC LIMIT 1)o ON true WHERE m.engagement_id=e.id) outcomes
FROM workspace_engagements e JOIN workspace_clients c ON c.id=e.client_id WHERE e.id=$1`,
          [id],
        );
        result.push(camel(r.rows[0]));
      }
      return result;
    });
    const readiness = new ReadinessService(this.pool);
    for (const row of rows) {
      const snapshot = await readiness.get(actor, String(row.id));
      row.readiness = snapshot.stages.map((stage) => ({
        stageId: stage.stageId,
        stageName: stage.name,
        decision: stage.latestDecision?.decision ?? null,
        effective: stage.latestDecision?.effective ?? false,
        stale: stage.latestDecision ? !stage.latestDecision.effective : false,
      }));
    }
    return rows;
  }
}
