import { randomUUID } from "node:crypto";
import type { PoolClient } from "pg";
import type { ClientPool } from "../database.js";
import { ConflictError, NotFoundError, ValidationError } from "./errors.js";
import { authorizeEngagement, idempotent, transaction } from "./shared.js";
import type { Actor } from "./types.js";
const clean = (v: unknown, l: string, m: number, optional = false) => {
  if (v == null && optional) return null;
  if (typeof v !== "string") throw new ValidationError(`${l} must be text`);
  const s = v.trim();
  if (!s || s.length > m)
    throw new ValidationError(`${l} must contain 1 to ${m} characters`);
  return s;
};
const date = (v: unknown, l: string) => {
  if (typeof v !== "string" || !/^(\d{4})-(\d{2})-(\d{2})$/.test(v)) {
    throw new ValidationError(`${l} must be YYYY-MM-DD`);
  }
  const d = new Date(`${v}T00:00:00Z`);
  if (Number.isNaN(d.valueOf()) || d.toISOString().slice(0, 10) !== v)
    throw new ValidationError(`${l} must be YYYY-MM-DD`);
  return v;
};
const number = (v: unknown, l: string, optional = false) => {
  if (v == null && optional) return null;
  if (typeof v !== "number" || !Number.isFinite(v))
    throw new ValidationError(`${l} must be a finite number`);
  return v;
};
const camel = (value: any): any =>
  Array.isArray(value)
    ? value.map(camel)
    : value && typeof value === "object" && !(value instanceof Date)
      ? Object.fromEntries(
          Object.entries(value).map(([key, item]) => [
            key.replace(/_([a-z])/g, (_, letter: string) =>
              letter.toUpperCase(),
            ),
            camel(item),
          ]),
        )
      : value;
async function audit(
  c: PoolClient,
  a: Actor,
  action: string,
  eid: string,
  details: unknown,
) {
  await c.query(
    "INSERT INTO workspace_audit_events(actor_id,action,engagement_id,details) VALUES($1,$2,$3,$4)",
    [a.id, action, eid, details],
  );
  return camel(details);
}
const specs = {
  useCase: {
    table: "workspace_discovery_use_cases",
    fields: [
      "title",
      "problem_statement",
      "actor_description",
      "desired_outcome",
    ],
  },
  assumption: {
    table: "workspace_discovery_assumptions",
    fields: ["statement", "status", "rationale"],
  },
  approach: {
    table: "workspace_discovery_approaches",
    fields: [
      "title",
      "description",
      "status",
      "rationale",
      "effort_value",
      "effort_unit",
    ],
  },
  metric: {
    table: "workspace_outcome_metrics",
    fields: ["name", "unit", "description", "baseline", "target"],
  },
} as const;
export class DiscoveryOutcomeService {
  constructor(private readonly pool: ClientPool) {}
  async get(actor: Actor, engagementId: string) {
    return transaction(this.pool, async (c) => {
      await authorizeEngagement(c, actor, engagementId, "discovery.read");
      const queries = [
        "SELECT * FROM workspace_discovery_sessions WHERE engagement_id=$1 ORDER BY session_date DESC,id",
        "SELECT * FROM workspace_discovery_use_cases WHERE engagement_id=$1 ORDER BY created_at,id",
        "SELECT * FROM workspace_discovery_assumptions WHERE engagement_id=$1 ORDER BY status,id",
        "SELECT * FROM workspace_discovery_approaches WHERE engagement_id=$1 ORDER BY status,id",
        "SELECT * FROM workspace_outcome_metrics WHERE engagement_id=$1 ORDER BY created_at,id",
        "SELECT * FROM workspace_outcome_observations WHERE engagement_id=$1 ORDER BY observed_on DESC,id DESC",
        "SELECT l.*,s.version,s.state,s.commitments,s.exclusions,s.estimate,s.acceptance_criteria FROM workspace_discovery_scope_links l JOIN workspace_scope_versions s ON s.id=l.scope_id WHERE l.engagement_id=$1",
      ];
      const sessions = await c.query(queries[0]!, [engagementId]);
      const useCases = await c.query(queries[1]!, [engagementId]);
      const assumptions = await c.query(queries[2]!, [engagementId]);
      const approaches = await c.query(queries[3]!, [engagementId]);
      const metrics = await c.query(queries[4]!, [engagementId]);
      const observations = await c.query(queries[5]!, [engagementId]);
      const scope = await c.query(queries[6]!, [engagementId]);
      return {
        sessions: camel(sessions.rows),
        useCases: camel(useCases.rows),
        assumptions: camel(assumptions.rows),
        approaches: camel(approaches.rows),
        outcomes: metrics.rows.map((m) =>
          camel({
            ...m,
            observations: observations.rows.filter((o) => o.metric_id === m.id),
          }),
        ),
        acceptedScope: camel(scope.rows[0] ?? null),
      };
    });
  }
  async createSession(
    actor: Actor,
    eid: string,
    input: {
      requestKey: string;
      purpose: string;
      sessionDate: string;
      participantUserIds: string[];
      summary: string;
    },
  ) {
    const values = {
      purpose: clean(input.purpose, "Purpose", 5000),
      sessionDate: date(input.sessionDate, "Session date"),
      summary: clean(input.summary, "Summary", 20000),
    };
    if (
      !Array.isArray(input.participantUserIds) ||
      input.participantUserIds.length > 100 ||
      new Set(input.participantUserIds).size !==
        input.participantUserIds.length ||
      input.participantUserIds.some((x) => typeof x !== "string" || !x)
    )
      throw new ValidationError(
        "Participants must contain at most 100 unique user IDs",
      );
    return transaction(this.pool, async (c) => {
      await authorizeEngagement(c, actor, eid, "discovery.session_create");
      if (input.participantUserIds.length) {
        const r = await c.query(
          "SELECT count(*)::int n FROM workspace_engagement_memberships WHERE engagement_id=$1 AND user_id=ANY($2::text[])",
          [eid, input.participantUserIds],
        );
        if (r.rows[0].n !== input.participantUserIds.length)
          throw new ValidationError(
            "Participants must be current engagement members",
          );
      }
      return idempotent(
        c,
        actor,
        "discovery.session_create",
        input.requestKey,
        { eid, ...input },
        async () => {
          const r = await c.query(
            "INSERT INTO workspace_discovery_sessions(id,engagement_id,purpose,session_date,participant_user_ids,summary,created_by) VALUES($1,$2,$3,$4,$5,$6,$7) RETURNING *",
            [
              randomUUID(),
              eid,
              values.purpose,
              values.sessionDate,
              JSON.stringify(input.participantUserIds),
              values.summary,
              actor.id,
            ],
          );
          return audit(c, actor, "discovery.session_create", eid, r.rows[0]);
        },
      );
    });
  }
  async updateSession(
    actor: Actor,
    eid: string,
    id: string,
    input: {
      requestKey: string;
      expectedRevision: number;
      purpose: string;
      sessionDate: string;
      participantUserIds: string[];
      summary: string;
    },
  ) {
    const values = {
      purpose: clean(input.purpose, "Purpose", 5000),
      sessionDate: date(input.sessionDate, "Session date"),
      summary: clean(input.summary, "Summary", 20000),
    };
    if (
      !Array.isArray(input.participantUserIds) ||
      input.participantUserIds.length > 100 ||
      new Set(input.participantUserIds).size !== input.participantUserIds.length
    )
      throw new ValidationError(
        "Participants must contain at most 100 unique user IDs",
      );
    return this.update(actor, eid, "session", id, input, [
      values.purpose,
      values.sessionDate,
      JSON.stringify(input.participantUserIds),
      values.summary,
    ]);
  }
  async createUseCase(
    actor: Actor,
    eid: string,
    input: {
      requestKey: string;
      title: string;
      problemStatement: string;
      actor: string;
      desiredOutcome: string;
    },
  ) {
    return this.create(actor, eid, "useCase", input, [
      clean(input.title, "Title", 300),
      clean(input.problemStatement, "Problem statement", 10000),
      clean(input.actor, "Actor", 2000),
      clean(input.desiredOutcome, "Desired outcome", 10000),
    ]);
  }
  async updateUseCase(
    actor: Actor,
    eid: string,
    id: string,
    input: {
      requestKey: string;
      expectedRevision: number;
      title: string;
      problemStatement: string;
      actor: string;
      desiredOutcome: string;
    },
  ) {
    return this.update(actor, eid, "useCase", id, input, [
      clean(input.title, "Title", 300),
      clean(input.problemStatement, "Problem statement", 10000),
      clean(input.actor, "Actor", 2000),
      clean(input.desiredOutcome, "Desired outcome", 10000),
    ]);
  }
  async createAssumption(
    actor: Actor,
    eid: string,
    input: {
      requestKey: string;
      statement: string;
      status: string;
      rationale?: string;
    },
  ) {
    if (!["open", "validated", "invalidated"].includes(input.status))
      throw new ValidationError("Unsupported assumption status");
    return this.create(actor, eid, "assumption", input, [
      clean(input.statement, "Statement", 10000),
      input.status,
      clean(input.rationale, "Rationale", 10000, true),
    ]);
  }
  async updateAssumption(
    actor: Actor,
    eid: string,
    id: string,
    input: {
      requestKey: string;
      expectedRevision: number;
      statement: string;
      status: string;
      rationale?: string;
    },
  ) {
    if (!["open", "validated", "invalidated"].includes(input.status))
      throw new ValidationError("Unsupported assumption status");
    return this.update(actor, eid, "assumption", id, input, [
      clean(input.statement, "Statement", 10000),
      input.status,
      clean(input.rationale, "Rationale", 10000, true),
    ]);
  }
  async createApproach(
    actor: Actor,
    eid: string,
    input: {
      requestKey: string;
      title: string;
      description: string;
      status: string;
      rationale?: string;
      effort?: { value: number; unit: string };
    },
  ) {
    if (!["considered", "selected", "rejected"].includes(input.status))
      throw new ValidationError("Unsupported approach status");
    return this.create(actor, eid, "approach", input, [
      clean(input.title, "Title", 300),
      clean(input.description, "Description", 20000),
      input.status,
      clean(input.rationale, "Rationale", 10000, true),
      input.effort ? number(input.effort.value, "Effort") : null,
      input.effort ? clean(input.effort.unit, "Effort unit", 100) : null,
    ]);
  }
  async updateApproach(
    actor: Actor,
    eid: string,
    id: string,
    input: {
      requestKey: string;
      expectedRevision: number;
      title: string;
      description: string;
      status: string;
      rationale?: string;
      effort?: { value: number; unit: string };
    },
  ) {
    if (!["considered", "selected", "rejected"].includes(input.status))
      throw new ValidationError("Unsupported approach status");
    return this.update(actor, eid, "approach", id, input, [
      clean(input.title, "Title", 300),
      clean(input.description, "Description", 20000),
      input.status,
      clean(input.rationale, "Rationale", 10000, true),
      input.effort ? number(input.effort.value, "Effort") : null,
      input.effort ? clean(input.effort.unit, "Effort unit", 100) : null,
    ]);
  }
  async createOutcomeMetric(
    actor: Actor,
    eid: string,
    input: {
      requestKey: string;
      name: string;
      unit: string;
      description?: string;
      baseline?: number;
      target?: number;
    },
  ) {
    return this.create(actor, eid, "metric", input, [
      clean(input.name, "Metric name", 300),
      clean(input.unit, "Unit", 100),
      clean(input.description, "Description", 5000, true),
      number(input.baseline, "Baseline", true),
      number(input.target, "Target", true),
    ]);
  }
  async updateOutcomeMetric(
    actor: Actor,
    eid: string,
    id: string,
    input: {
      requestKey: string;
      expectedRevision: number;
      name: string;
      unit: string;
      description?: string;
      baseline?: number;
      target?: number;
    },
  ) {
    return this.update(actor, eid, "metric", id, input, [
      clean(input.name, "Metric name", 300),
      clean(input.unit, "Unit", 100),
      clean(input.description, "Description", 5000, true),
      number(input.baseline, "Baseline", true),
      number(input.target, "Target", true),
    ]);
  }
  private async create(
    actor: Actor,
    eid: string,
    kind: keyof typeof specs,
    input: any,
    values: unknown[],
  ) {
    const s = specs[kind];
    return transaction(this.pool, async (c) => {
      await authorizeEngagement(c, actor, eid, `discovery.${kind}_create`);
      return idempotent(
        c,
        actor,
        `discovery.${kind}_create`,
        input.requestKey,
        { eid, ...input },
        async () => {
          const params = [randomUUID(), eid, ...values, actor.id],
            marks = s.fields.map((_, i) => `$${i + 3}`).join(",");
          const r = await c.query(
            `INSERT INTO ${s.table}(id,engagement_id,${s.fields.join(",")},created_by) VALUES($1,$2,${marks},$${params.length}) RETURNING *`,
            params,
          );
          return audit(c, actor, `discovery.${kind}_create`, eid, r.rows[0]);
        },
      );
    });
  }
  private async update(
    actor: Actor,
    eid: string,
    kind: "session" | keyof typeof specs,
    id: string,
    input: any,
    values: unknown[],
  ) {
    const table =
        kind === "session" ? "workspace_discovery_sessions" : specs[kind].table,
      fields =
        kind === "session"
          ? ["purpose", "session_date", "participant_user_ids", "summary"]
          : specs[kind].fields;
    return transaction(this.pool, async (c) => {
      await authorizeEngagement(c, actor, eid, `discovery.${kind}_update`);
      if (kind === "session") {
        const participants = JSON.parse(String(values[2])) as string[];
        if (participants.length) {
          const members = await c.query(
            "SELECT count(*)::int n FROM workspace_engagement_memberships WHERE engagement_id=$1 AND user_id=ANY($2::text[])",
            [eid, participants],
          );
          if (members.rows[0].n !== participants.length)
            throw new ValidationError(
              "Participants must be current engagement members",
            );
        }
      }
      return idempotent(
        c,
        actor,
        `discovery.${kind}_update`,
        input.requestKey,
        { eid, id, ...input },
        async () => {
          const sets = fields.map((f, i) => `${f}=$${i + 3}`).join(",");
          const params = [id, eid, ...values, input.expectedRevision];
          const r = await c.query(
            `UPDATE ${table} SET ${sets},revision=revision+1,updated_at=now() WHERE id=$1 AND engagement_id=$2 AND revision=$${params.length} RETURNING *`,
            params,
          );
          if (!r.rowCount) throw new ConflictError("Record revision is stale");
          return audit(c, actor, `discovery.${kind}_update`, eid, r.rows[0]);
        },
      );
    });
  }
  async linkAcceptedScope(
    actor: Actor,
    eid: string,
    input: { requestKey: string; expectedRevision: number; scopeId: string },
  ) {
    return transaction(this.pool, async (c) => {
      await authorizeEngagement(c, actor, eid, "discovery.scope_link");
      return idempotent(
        c,
        actor,
        "discovery.scope_link",
        input.requestKey,
        { eid, ...input },
        async () => {
          const scope = await c.query(
            "SELECT 1 FROM workspace_scope_versions WHERE id=$1 AND engagement_id=$2 AND state='accepted'",
            [input.scopeId, eid],
          );
          if (!scope.rowCount)
            throw new ValidationError(
              "Accepted scope must belong to this engagement",
            );
          const r = await c.query(
            "INSERT INTO workspace_discovery_scope_links(engagement_id,scope_id,linked_by) VALUES($1,$2,$3) ON CONFLICT(engagement_id) DO UPDATE SET scope_id=EXCLUDED.scope_id,linked_by=EXCLUDED.linked_by,linked_at=now(),revision=workspace_discovery_scope_links.revision+1 WHERE workspace_discovery_scope_links.revision=$4 RETURNING *",
            [eid, input.scopeId, actor.id, input.expectedRevision],
          );
          if (!r.rowCount)
            throw new ConflictError("Scope link revision is stale");
          return audit(c, actor, "discovery.scope_link", eid, r.rows[0]);
        },
      );
    });
  }
  async addOutcomeObservation(
    actor: Actor,
    eid: string,
    metricId: string,
    input: {
      requestKey: string;
      observedOn: string;
      value: number;
      note?: string;
      evidenceId?: string;
    },
  ) {
    const values = {
      date: date(input.observedOn, "Observation date"),
      value: number(input.value, "Observed value"),
      note: clean(input.note, "Observation note", 10000, true),
    };
    return transaction(this.pool, async (c) => {
      await authorizeEngagement(c, actor, eid, "outcome.observe");
      return idempotent(
        c,
        actor,
        "outcome.observe",
        input.requestKey,
        { eid, metricId, ...input },
        async () => {
          const metric = await c.query(
            "SELECT 1 FROM workspace_outcome_metrics WHERE id=$1 AND engagement_id=$2",
            [metricId, eid],
          );
          if (!metric.rowCount)
            throw new NotFoundError("Outcome metric not found");
          if (input.evidenceId) {
            const ev = await c.query(
              "SELECT 1 FROM workspace_evidence WHERE id=$1 AND engagement_id=$2",
              [input.evidenceId, eid],
            );
            if (!ev.rowCount)
              throw new ValidationError(
                "Evidence does not belong to this engagement",
              );
          }
          const r = await c.query(
            "INSERT INTO workspace_outcome_observations(id,engagement_id,metric_id,observed_on,value,note,evidence_id,recorded_by) VALUES($1,$2,$3,$4,$5,$6,$7,$8) RETURNING *,observed_on::text",
            [
              randomUUID(),
              eid,
              metricId,
              values.date,
              values.value,
              values.note,
              input.evidenceId ?? null,
              actor.id,
            ],
          );
          return audit(c, actor, "outcome.observe", eid, r.rows[0]);
        },
      );
    });
  }
}
