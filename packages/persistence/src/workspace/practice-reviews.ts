import { randomUUID } from "node:crypto";
import type { ClientPool } from "../database.js";
import {
  AuthorizationError,
  ConflictError,
  NotFoundError,
  ValidationError,
} from "./errors.js";
import { idempotent, requireAdmin, transaction } from "./shared.js";
import type { Actor } from "./types.js";

type Criterion = { criterion: string; description: string };
type Comparison = {
  criterion: string;
  result: "met" | "partially_met" | "not_met";
  feedback: string;
  validAlternativeNote?: string;
};
type ProposalInput = {
  selectedProblem: string;
  rationale: string;
  questions: string[];
  proposedApproach: string;
  proposedDeliverables: string[];
  successCriteria: string[];
  requestKey: string;
};
const text = (v: unknown, label: string, max = 20000) => {
  if (typeof v !== "string" || !v.trim() || v.length > max)
    throw new ValidationError(`${label} must contain 1 to ${max} characters`);
  return v.trim();
};
const list = (v: unknown, label: string) => {
  if (!Array.isArray(v) || v.length > 100)
    throw new ValidationError(`${label} must be a list of up to 100 entries`);
  return v.map((x) => text(x, label, 2000));
};
const requiredList = (v: unknown, label: string) => {
  const values = list(v, label);
  if (!values.length) throw new ValidationError(`${label} must not be empty`);
  return values;
};
const audit = (c: any, actor: Actor, action: string, details: unknown) =>
  c.query(
    "INSERT INTO workspace_audit_events(actor_id,action,details) VALUES($1,$2,$3)",
    [actor.id, action, details],
  );
const rubric = (v: unknown): Criterion[] => {
  if (!Array.isArray(v) || !v.length || v.length > 100)
    throw new ValidationError("Rubric must contain 1 to 100 criteria");
  const values = v.map((x: any) => ({
    criterion: text(x?.criterion, "Criterion", 300),
    description: text(x?.description, "Criterion description", 2000),
  }));
  if (new Set(values.map((x) => x.criterion)).size !== values.length)
    throw new ValidationError("Rubric criteria must be unique");
  return values;
};

export class PracticeReviewService {
  constructor(private readonly pool: ClientPool) {}
  private async denyAssignedLearner(c: any, actor: Actor, trainingKey: string, trainingVersion: number) {
    const learner = await c.query(
      "SELECT 1 FROM workspace_training_assignments WHERE training_key=$1 AND training_version=$2 AND learner_user_id=$3 LIMIT 1",
      [trainingKey, trainingVersion, actor.id],
    );
    if (learner.rowCount)
      throw new AuthorizationError("Learners cannot access reviewer references");
  }
  async listReferences(actor: Actor, trainingKey: string, trainingVersion: number) {
    requireAdmin(actor);
    return transaction(this.pool, async c => {
      await this.denyAssignedLearner(c, actor, trainingKey, trainingVersion);
      return (await c.query(
        "SELECT * FROM workspace_practice_review_references WHERE training_key=$1 AND training_version=$2 ORDER BY reference_version,id",
        [trainingKey, trainingVersion],
      )).rows;
    });
  }
  async createDraft(
    actor: Actor,
    input: {
      trainingKey: string;
      trainingVersion: number;
      expectedApproach: string;
      checks: string[];
      pitfalls: string[];
      acceptableAlternatives: string[];
      rubric: Criterion[];
      requestKey: string;
    },
  ) {
    requireAdmin(actor);
    const expected = text(input.expectedApproach, "Expected approach"),
      checks = list(input.checks, "Checks"),
      pitfalls = list(input.pitfalls, "Pitfalls"),
      alternatives = list(
        input.acceptableAlternatives,
        "Acceptable alternatives",
      ),
      criteria = rubric(input.rubric);
    return transaction(this.pool, async (c) => {
      await this.denyAssignedLearner(c, actor, input.trainingKey, input.trainingVersion);
      await c.query("SELECT pg_advisory_xact_lock(hashtextextended($1,0))", [
        `practice-reference:${input.trainingKey}:${input.trainingVersion}`,
      ]);
      return idempotent(
        c,
        actor,
        "practice.reference_create",
        input.requestKey,
        input,
        async () => {
          const training = await c.query(
            "SELECT 1 FROM workspace_training_versions WHERE training_key=$1 AND version=$2 AND state='published'",
            [input.trainingKey, input.trainingVersion],
          );
          if (!training.rowCount)
            throw new ValidationError(
              "A published training version is required",
            );
          const next = Number(
            (
              await c.query(
                "SELECT COALESCE(max(reference_version),0)+1 version FROM workspace_practice_review_references WHERE training_key=$1 AND training_version=$2",
                [input.trainingKey, input.trainingVersion],
              )
            ).rows[0].version,
          );
          const row = await c.query(
            "INSERT INTO workspace_practice_review_references(id,training_key,training_version,reference_version,expected_approach,checks,pitfalls,acceptable_alternatives,rubric,authored_by) VALUES($1,$2,$3,$4,$5,$6,$7,$8,$9,$10) RETURNING *",
            [
              randomUUID(),
              input.trainingKey,
              input.trainingVersion,
              next,
              expected,
              JSON.stringify(checks),
              JSON.stringify(pitfalls),
              JSON.stringify(alternatives),
              JSON.stringify(criteria),
              actor.id,
            ],
          );
          await audit(c, actor, "practice_reference_draft_created", {
            referenceId: row.rows[0].id,
            trainingKey: input.trainingKey,
            trainingVersion: input.trainingVersion,
          });
          return row.rows[0];
        },
      );
    });
  }
  async updateDraft(actor: Actor, referenceId: string, input: {
    expectedRevision: number; requestKey: string; expectedApproach: string;
    checks: string[]; pitfalls: string[]; acceptableAlternatives: string[]; rubric: Criterion[];
  }) {
    requireAdmin(actor);
    const values = { expectedApproach: text(input.expectedApproach, "Expected approach"), checks: list(input.checks, "Checks"), pitfalls: list(input.pitfalls, "Pitfalls"), acceptableAlternatives: list(input.acceptableAlternatives, "Acceptable alternatives"), rubric: rubric(input.rubric) };
    return transaction(this.pool, async c => {
      const found = await c.query("SELECT training_key,training_version FROM workspace_practice_review_references WHERE id=$1 AND state='draft'", [referenceId]);
      if (!found.rows[0]) throw new NotFoundError("Draft reviewer reference not found");
      await this.denyAssignedLearner(c, actor, found.rows[0].training_key, found.rows[0].training_version);
      return idempotent(c, actor, "practice.reference_update", input.requestKey, {referenceId,...input}, async()=>{
        const row=await c.query("UPDATE workspace_practice_review_references SET expected_approach=$3,checks=$4,pitfalls=$5,acceptable_alternatives=$6,rubric=$7,revision=revision+1 WHERE id=$1 AND state='draft' AND revision=$2 RETURNING *",[referenceId,input.expectedRevision,values.expectedApproach,JSON.stringify(values.checks),JSON.stringify(values.pitfalls),JSON.stringify(values.acceptableAlternatives),JSON.stringify(values.rubric)]);
        if(!row.rowCount)throw new ConflictError("Practice reference revision is stale");
        await audit(c,actor,"practice_reference_draft_updated",{referenceId});return row.rows[0];
      });
    });
  }
  async createVersion(actor: Actor, referenceId: string, input: {
    expectedRevision: number; requestKey: string; rationale: string; expectedApproach?: string;
    checks?: string[]; pitfalls?: string[]; acceptableAlternatives?: string[]; rubric?: Criterion[];
  }) {
    requireAdmin(actor); const reason=text(input.rationale,"Revision rationale",10000);
    return transaction(this.pool, async c=>{
      const source=await c.query("SELECT * FROM workspace_practice_review_references WHERE id=$1 AND state='published'",[referenceId]);const old=source.rows[0];
      if(!old)throw new NotFoundError("Published reviewer reference not found");if(Number(old.revision)!==input.expectedRevision)throw new ConflictError("Practice reference revision is stale");
      await this.denyAssignedLearner(c,actor,old.training_key,old.training_version);
      return idempotent(c,actor,"practice.reference_version_create",input.requestKey,{referenceId,...input},async()=>{
        const next=Number((await c.query("SELECT COALESCE(max(reference_version),0)+1 version FROM workspace_practice_review_references WHERE training_key=$1 AND training_version=$2",[old.training_key,old.training_version])).rows[0].version);
        const expected=input.expectedApproach===undefined?old.expected_approach:text(input.expectedApproach,"Expected approach");const checks=input.checks===undefined?old.checks:list(input.checks,"Checks"),pitfalls=input.pitfalls===undefined?old.pitfalls:list(input.pitfalls,"Pitfalls"),alternatives=input.acceptableAlternatives===undefined?old.acceptable_alternatives:list(input.acceptableAlternatives,"Acceptable alternatives"),criteria=input.rubric===undefined?old.rubric:rubric(input.rubric);
        const row=await c.query("INSERT INTO workspace_practice_review_references(id,training_key,training_version,reference_version,expected_approach,checks,pitfalls,acceptable_alternatives,rubric,authored_by) VALUES($1,$2,$3,$4,$5,$6,$7,$8,$9,$10) RETURNING *",[randomUUID(),old.training_key,old.training_version,next,expected,JSON.stringify(checks),JSON.stringify(pitfalls),JSON.stringify(alternatives),JSON.stringify(criteria),actor.id]);
        await audit(c,actor,"practice_reference_version_created",{sourceReferenceId:referenceId,referenceId:row.rows[0].id,rationale:reason});return row.rows[0];
      });
    });
  }
  async publish(
    actor: Actor,
    referenceId: string,
    input: {
      expectedRevision: number;
      requestKey: string;
      rationale: string;
      confirmation: "publish-reviewer-reference";
    },
  ) {
    requireAdmin(actor);
    if (input.confirmation !== "publish-reviewer-reference")
      throw new ValidationError(
        "Explicit reviewer-reference publication confirmation is required",
      );
    const rationale = text(input.rationale, "Publication rationale", 10000);
    return transaction(this.pool, async (c) => {
      const found = await c.query("SELECT training_key,training_version FROM workspace_practice_review_references WHERE id=$1", [referenceId]);
      if (!found.rows[0]) throw new NotFoundError("Practice reference not found");
      await this.denyAssignedLearner(c, actor, found.rows[0].training_key, found.rows[0].training_version);
      return idempotent(
        c,
        actor,
        "practice.reference_publish",
        input.requestKey,
        { referenceId, ...input },
        async () => {
          const row = await c.query(
            "UPDATE workspace_practice_review_references SET state='published',revision=revision+1,published_by=$3,published_at=now(),publication_rationale=$4 WHERE id=$1 AND state='draft' AND revision=$2 RETURNING *",
            [referenceId, input.expectedRevision, actor.id, rationale],
          );
          if (!row.rowCount)
            throw new ConflictError(
              "Practice reference revision or state is stale",
            );
          await audit(c, actor, "practice_reference_published", {
            referenceId,
            rationale,
          });
          return row.rows[0];
        },
      );
    });
  }
  private async authorized(c: any, actor: Actor, assignmentId: string) {
    const r = await c.query(
      "SELECT * FROM workspace_training_assignments WHERE id=$1",
      [assignmentId],
    );
    const a = r.rows[0];
    if (!a) throw new NotFoundError("Training assignment not found");
    if (actor.id === a.learner_user_id)
      throw new AuthorizationError(
        "Learners cannot access reviewer references",
      );
    if (actor.role !== "practice_admin" && actor.id !== a.mentor_user_id)
      throw new AuthorizationError("Assigned mentor access is required");
    return a;
  }
  async getForAssignment(actor: Actor, assignmentId: string) {
    return transaction(this.pool, async (c) => {
      const a = await this.authorized(c, actor, assignmentId);
      const r = await c.query(
        "SELECT * FROM workspace_practice_review_references WHERE training_key=$1 AND training_version=$2 AND state='published' ORDER BY reference_version DESC LIMIT 1",
        [a.training_key, a.training_version],
      );
      if (!r.rows[0])
        throw new NotFoundError("Published reviewer reference not found");
      return r.rows[0];
    });
  }
  async submitProposal(
    actor: Actor,
    assignmentId: string,
    input: ProposalInput,
  ) {
    const proposal = {
      selectedProblem: text(input.selectedProblem, "Selected problem"),
      rationale: text(input.rationale, "Rationale"),
      questions: list(input.questions, "Questions"),
      proposedApproach: text(input.proposedApproach, "Proposed approach"),
      proposedDeliverables: requiredList(
        input.proposedDeliverables,
        "Proposed deliverables",
      ),
      successCriteria: requiredList(input.successCriteria, "Success criteria"),
    };
    return transaction(this.pool, async (c) => {
      const a = await c.query(
        "SELECT learner_user_id FROM workspace_training_assignments WHERE id=$1 FOR UPDATE",
        [assignmentId],
      );
      if (!a.rows[0]) throw new NotFoundError("Training assignment not found");
      if (actor.id !== a.rows[0].learner_user_id)
        throw new AuthorizationError(
          "Only the assigned learner may submit a proposal",
        );
      return idempotent(
        c,
        actor,
        "practice.proposal_submit",
        input.requestKey,
        { assignmentId, ...proposal },
        async () => {
          const version = Number(
            (
              await c.query(
                "SELECT COALESCE(max(proposal_version),0)+1 version FROM workspace_practice_proposals WHERE assignment_id=$1",
                [assignmentId],
              )
            ).rows[0].version,
          );
          const created = (
            await c.query(
              "INSERT INTO workspace_practice_proposals(id,assignment_id,proposal_version,selected_problem,rationale,questions,proposed_approach,proposed_deliverables,success_criteria,authored_by) VALUES($1,$2,$3,$4,$5,$6,$7,$8,$9,$10) RETURNING *",
              [
                randomUUID(),
                assignmentId,
                version,
                proposal.selectedProblem,
                proposal.rationale,
                JSON.stringify(proposal.questions),
                proposal.proposedApproach,
                JSON.stringify(proposal.proposedDeliverables),
                JSON.stringify(proposal.successCriteria),
                actor.id,
              ],
            )
          ).rows[0];
          await audit(c, actor, "practice_proposal_submitted", {
            assignmentId,
            proposalId: created.id,
            proposalVersion: version,
          });
          return created;
        },
      );
    });
  }
  async listProposals(actor: Actor, assignmentId: string) {
    return transaction(this.pool, async (c) => {
      const a = await c.query(
        "SELECT learner_user_id,mentor_user_id FROM workspace_training_assignments WHERE id=$1",
        [assignmentId],
      );
      if (!a.rows[0]) throw new NotFoundError("Training assignment not found");
      if (
        actor.role !== "practice_admin" &&
        actor.id !== a.rows[0].learner_user_id &&
        actor.id !== a.rows[0].mentor_user_id
      )
        throw new AuthorizationError("Training assignment access is required");
      return (
        await c.query(
          "SELECT * FROM workspace_practice_proposals WHERE assignment_id=$1 ORDER BY proposal_version",
          [assignmentId],
        )
      ).rows;
    });
  }
  async compare(
    actor: Actor,
    assignmentId: string,
    input: {
      referenceId: string;
      proposalId: string;
      criteria: Comparison[];
      overallFeedback: string;
      requestKey: string;
    },
  ) {
    const overall = text(input.overallFeedback, "Overall feedback", 10000);
    return transaction(this.pool, async (c) => {
      const a = await this.authorized(c, actor, assignmentId);
      return idempotent(
        c,
        actor,
        "practice.compare",
        input.requestKey,
        { assignmentId, ...input },
        async () => {
          const ref = await c.query<{ rubric: Criterion[] }>(
            "SELECT rubric FROM workspace_practice_review_references WHERE id=$1 AND training_key=$2 AND training_version=$3 AND state='published'",
            [input.referenceId, a.training_key, a.training_version],
          );
          if (!ref.rows[0])
            throw new ValidationError(
              "Published reference does not match this assignment",
            );
          const proposal = await c.query(
            "SELECT 1 FROM workspace_practice_proposals WHERE id=$1 AND assignment_id=$2",
            [input.proposalId, assignmentId],
          );
          if (!proposal.rowCount)
            throw new ValidationError(
              "Proposal does not match this assignment",
            );
          const allowed = new Set(ref.rows[0].rubric.map((x) => x.criterion));
          if (
            !Array.isArray(input.criteria) ||
            input.criteria.length !== allowed.size
          )
            throw new ValidationError(
              "Comparison must address every rubric criterion",
            );
          const seen = new Set<string>();
          const criteria = input.criteria.map((x) => {
            const criterion = text(x?.criterion, "Criterion", 300);
            if (!allowed.has(criterion) || seen.has(criterion))
              throw new ValidationError(
                "Comparison criteria do not match the rubric",
              );
            seen.add(criterion);
            if (!["met", "partially_met", "not_met"].includes(x?.result))
              throw new ValidationError("Unsupported criterion result");
            return {
              criterion,
              result: x.result,
              feedback: text(x.feedback, "Feedback", 5000),
              ...(x.validAlternativeNote
                ? {
                    validAlternativeNote: text(
                      x.validAlternativeNote,
                      "Valid alternative note",
                      5000,
                    ),
                  }
                : {}),
            };
          });
          const row = await c.query(
            "INSERT INTO workspace_practice_comparisons(id,assignment_id,reference_id,proposal_id,criteria,overall_feedback,reviewed_by) VALUES($1,$2,$3,$4,$5,$6,$7) RETURNING id,assignment_id,proposal_id,criteria,overall_feedback,reviewed_by,created_at",
            [
              randomUUID(),
              assignmentId,
              input.referenceId,
              input.proposalId,
              JSON.stringify(criteria),
              overall,
              actor.id,
            ],
          );
          await audit(c, actor, "practice_comparison_recorded", {
            assignmentId,
            proposalId: input.proposalId,
            comparisonId: row.rows[0].id,
          });
          return row.rows[0];
        },
      );
    });
  }
  async getFeedback(actor: Actor, assignmentId: string) {
    return transaction(this.pool, async (c) => {
      const r = await c.query(
        "SELECT * FROM workspace_training_assignments WHERE id=$1",
        [assignmentId],
      );
      const a = r.rows[0];
      if (!a) throw new NotFoundError("Training assignment not found");
      if (
        actor.role !== "practice_admin" &&
        actor.id !== a.learner_user_id &&
        actor.id !== a.mentor_user_id
      )
        throw new AuthorizationError("Training assignment access is required");
      return (
        await c.query(
          "SELECT c.id,c.assignment_id,c.proposal_id,c.criteria,c.overall_feedback,c.reviewed_by,c.created_at,(c.proposal_id<>(SELECT id FROM workspace_practice_proposals WHERE assignment_id=c.assignment_id ORDER BY proposal_version DESC LIMIT 1)) stale FROM workspace_practice_comparisons c WHERE c.assignment_id=$1 ORDER BY c.created_at,c.id",
          [assignmentId],
        )
      ).rows;
    });
  }
  async selfStart(
    actor: Actor,
    input: { trainingKey: string; version: number; requestKey: string },
  ) {
    return transaction(this.pool, (c) =>
      idempotent(
        c,
        actor,
        "practice.self_start",
        input.requestKey,
        input,
        async () => {
          const active = await c.query(
            "SELECT 1 FROM app_users WHERE id=$1 AND disabled_at IS NULL",
            [actor.id],
          );
          if (!active.rowCount)
            throw new AuthorizationError("Active learner account is required");
          const version = await c.query<{
            definition: { items: Array<{ key: string }> };
          }>(
            "SELECT definition FROM workspace_training_versions WHERE training_key=$1 AND version=$2 AND state='published' AND definition ? 'practiceCase'",
            [input.trainingKey, input.version],
          );
          if (!version.rows[0])
            throw new ValidationError(
              "A published training version is required",
            );
          const id = randomUUID();
          await c.query(
            "INSERT INTO workspace_training_assignments(id,training_key,training_version,learner_user_id,mentor_user_id,assigned_by) VALUES($1,$2,$3,$4,NULL,$4)",
            [id, input.trainingKey, input.version, actor.id],
          );
          for (const item of version.rows[0].definition.items)
            await c.query(
              "INSERT INTO workspace_training_progress(assignment_id,item_key,updated_by) VALUES($1,$2,$3)",
              [id, item.key, actor.id],
            );
          await audit(c, actor, "practice_self_started", {
            assignmentId: id,
            trainingKey: input.trainingKey,
            trainingVersion: input.version,
          });
          return {
            id,
            trainingKey: input.trainingKey,
            trainingVersion: input.version,
            learnerUserId: actor.id,
            mentorUserId: null,
            revision: 1,
          };
        },
      ),
    );
  }
  async setMentor(
    actor: Actor,
    assignmentId: string,
    input: {
      mentorUserId: string;
      expectedRevision: number;
      requestKey: string;
    },
  ) {
    requireAdmin(actor);
    return transaction(this.pool, (c) =>
      idempotent(
        c,
        actor,
        "practice.mentor_set",
        input.requestKey,
        { assignmentId, ...input },
        async () => {
          const a = await c.query(
            "SELECT learner_user_id FROM workspace_training_assignments WHERE id=$1",
            [assignmentId],
          );
          if (!a.rows[0])
            throw new NotFoundError("Training assignment not found");
          if (a.rows[0].learner_user_id === input.mentorUserId)
            throw new ValidationError("Learner cannot be their own mentor");
          const active = await c.query(
            "SELECT 1 FROM app_users WHERE id=$1 AND disabled_at IS NULL",
            [input.mentorUserId],
          );
          if (!active.rowCount)
            throw new ValidationError("Mentor must be an active account");
          const row = await c.query(
            "UPDATE workspace_training_assignments SET mentor_user_id=$3,revision=revision+1 WHERE id=$1 AND revision=$2 RETURNING *",
            [assignmentId, input.expectedRevision, input.mentorUserId],
          );
          if (!row.rowCount)
            throw new ConflictError("Assignment revision is stale");
          await audit(c, actor, "practice_mentor_assigned", {
            assignmentId,
            mentorUserId: input.mentorUserId,
          });
          return row.rows[0];
        },
      ),
    );
  }
}
