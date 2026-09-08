import type { ClientPool } from "../../../packages/persistence/src/index.js";
import {
  AuthorizationError,
  NotFoundError,
  ValidationError,
} from "../../../packages/persistence/src/workspace/errors.js";
import { practiceCases } from "../../../packages/persistence/src/workspace/practice-cases.js";
import { practiceReferenceContent } from "./practice-reference-content.js";
import { PracticeReviewService } from "../../../packages/persistence/src/workspace/practice-reviews.js";
import {
  TrainingService,
  type PracticeCase,
} from "../../../packages/persistence/src/workspace/training.js";
import type { Actor } from "../../../packages/persistence/src/workspace/types.js";

type Body = Record<string, unknown>;
const str = (body: Body, key: string, max = 20000) => {
  const value = body[key];
  if (typeof value !== "string" || !value.trim() || value.length > max)
    throw new ValidationError(`${key} must contain 1 to ${max} characters`);
  return value.trim();
};
const num = (body: Body, key: string, zero = false) => {
  const value = body[key];
  if (
    typeof value !== "number" ||
    !Number.isSafeInteger(value) ||
    value < (zero ? 0 : 1)
  )
    throw new ValidationError(
      `${key} must be ${zero ? "nonnegative" : "positive"}`,
    );
  return value;
};
const strings = (body: Body, key: string) => {
  const value = body[key];
  if (!Array.isArray(value)) throw new ValidationError(`${key} must be a list`);
  return value as string[];
};
const decoded = (value: string) => {
  try {
    return decodeURIComponent(value);
  } catch {
    throw new ValidationError("URL path contains invalid encoding");
  }
};

const catalogCase = (definition: (typeof practiceCases)[number]) => ({
  key: definition.key,
  name: definition.name,
  purpose: definition.purpose,
  practiceCase: {
    ...definition.practiceCase,
    datasets: definition.practiceCase?.datasets.map(
      ({ csv: _, ...dataset }) => dataset,
    ),
  },
});

export async function practiceRequest(
  pool: ClientPool,
  actor: Actor,
  pathname: string,
  method: string,
  body: Body,
) {
  if (!pathname.startsWith("/api/practice")) return null;
  const reviews = new PracticeReviewService(pool),
    training = new TrainingService(pool);
  if (pathname === "/api/practice/cases" && method === "GET")
    return { status: 200, body: { cases: practiceCases.map(catalogCase) } };
  const builtIn = /^\/api\/practice\/cases\/([^/]+)\/import$/.exec(pathname);
  if (builtIn && method === "POST") {
    const definition = practiceCases.find(
      (x) => x.key === decoded(builtIn[1]!),
    );
    if (!definition) throw new NotFoundError("Practice case not found");
    return {
      status: 201,
      body: {
        version: await training.createDraft(actor, {
          requestKey: str(body, "requestKey", 200),
          key: definition.key,
          name: definition.name,
          purpose: definition.purpose,
          items: definition.items,
          ...(definition.practiceCase
            ? { practiceCase: definition.practiceCase }
            : {}),
        }),
      },
    };
  }
  const guideImport =
    /^\/api\/practice\/cases\/([^/]+)\/reviewer-draft\/import$/.exec(pathname);
  if (guideImport && method === "POST") {
    const trainingKey = decoded(guideImport[1]!);
    const trainingVersion = num(body, "trainingVersion");
    const content = practiceReferenceContent[trainingKey];
    if (!content || !practiceCases.some((item) => item.key === trainingKey))
      throw new NotFoundError("Built-in reviewer guide not found");
    const learner = await pool.query(
      "SELECT 1 FROM workspace_training_assignments WHERE training_key=$1 AND training_version=$2 AND learner_user_id=$3 LIMIT 1",
      [trainingKey, trainingVersion, actor.id],
    );
    if (learner.rows.length)
      throw new AuthorizationError(
        "A learner assigned to this case cannot access its reviewer guide",
      );
    return {
      status: 201,
      body: {
        reference: await reviews.createDraft(actor, {
          trainingKey,
          trainingVersion,
          ...content,
          requestKey: str(body, "requestKey", 200),
        }),
      },
    };
  }
  const dataset =
    /^\/api\/practice\/training\/([^/]+)\/([1-9][0-9]*)\/datasets\/([^/]+)\/download$/.exec(
      pathname,
    );
  if (dataset && method === "GET") {
    const stored: any = await training.getVersion(
      actor,
      decoded(dataset[1]!),
      Number(dataset[2]),
    );
    if (stored.definition?.state !== "published")
      throw new NotFoundError("Published practice case not found");
    const definition = stored.definition as { practiceCase?: PracticeCase };
    const found = definition.practiceCase?.datasets.find(
      (x) => x.key === decoded(dataset[3]!),
    );
    if (!found) throw new NotFoundError("Practice dataset not found");
    return {
      status: 200,
      download: {
        fileName: found.fileName,
        mediaType: "text/csv; charset=utf-8",
        data: Buffer.from(found.csv, "utf8"),
      },
    };
  }
  if (pathname === "/api/practice/references" && method === "POST")
    return {
      status: 201,
      body: {
        reference: await reviews.createDraft(actor, {
          trainingKey: str(body, "trainingKey", 200),
          trainingVersion: num(body, "trainingVersion"),
          expectedApproach: str(body, "expectedApproach"),
          checks: strings(body, "checks"),
          pitfalls: strings(body, "pitfalls"),
          acceptableAlternatives: strings(body, "acceptableAlternatives"),
          rubric: body.rubric as any,
          requestKey: str(body, "requestKey", 200),
        }),
      },
    };
  const referenceList =
    /^\/api\/practice\/references\/training\/([^/]+)\/([1-9][0-9]*)$/.exec(
      pathname,
    );
  if (referenceList && method === "GET")
    return {
      status: 200,
      body: {
        references: await reviews.listReferences(
          actor,
          decoded(referenceList[1]!),
          Number(referenceList[2]),
        ),
      },
    };
  const referenceDraft =
    /^\/api\/practice\/references\/([a-zA-Z0-9-]+)\/(draft|versions)$/.exec(
      pathname,
    );
  if (referenceDraft && method === "POST") {
    const referenceId = referenceDraft[1]!;
    const base = {
      expectedRevision: num(body, "expectedRevision"),
      requestKey: str(body, "requestKey", 200),
    };
    if (referenceDraft[2] === "draft")
      return {
        status: 200,
        body: {
          reference: await reviews.updateDraft(actor, referenceId, {
            ...base,
            expectedApproach: str(body, "expectedApproach"),
            checks: strings(body, "checks"),
            pitfalls: strings(body, "pitfalls"),
            acceptableAlternatives: strings(body, "acceptableAlternatives"),
            rubric: body.rubric as any,
          }),
        },
      };
    return {
      status: 201,
      body: {
        reference: await reviews.createVersion(actor, referenceId, {
          ...base,
          rationale: str(body, "rationale", 10000),
          ...(body.expectedApproach === undefined
            ? {}
            : { expectedApproach: str(body, "expectedApproach") }),
          ...(body.checks === undefined
            ? {}
            : { checks: strings(body, "checks") }),
          ...(body.pitfalls === undefined
            ? {}
            : { pitfalls: strings(body, "pitfalls") }),
          ...(body.acceptableAlternatives === undefined
            ? {}
            : {
                acceptableAlternatives: strings(body, "acceptableAlternatives"),
              }),
          ...(body.rubric === undefined ? {} : { rubric: body.rubric as any }),
        }),
      },
    };
  }
  const publish =
    /^\/api\/practice\/references\/([a-zA-Z0-9-]+)\/publish$/.exec(pathname);
  if (publish && method === "POST")
    return {
      status: 200,
      body: {
        reference: await reviews.publish(actor, publish[1]!, {
          expectedRevision: num(body, "expectedRevision"),
          requestKey: str(body, "requestKey", 200),
          rationale: str(body, "rationale", 10000),
          confirmation: str(
            body,
            "confirmation",
            100,
          ) as "publish-reviewer-reference",
        }),
      },
    };
  if (pathname === "/api/practice/self-start" && method === "POST")
    return {
      status: 201,
      body: {
        assignment: await reviews.selfStart(actor, {
          trainingKey: str(body, "trainingKey", 200),
          version: num(body, "version"),
          requestKey: str(body, "requestKey", 200),
        }),
      },
    };
  const assignment =
    /^\/api\/practice\/assignments\/([a-zA-Z0-9-]+)(?:\/(reference|proposals|comparisons|feedback|mentor))?$/.exec(
      pathname,
    );
  if (assignment) {
    const id = assignment[1]!,
      action = assignment[2];
    if (method === "GET" && action === "reference")
      return {
        status: 200,
        body: { reference: await reviews.getForAssignment(actor, id) },
      };
    if (method === "GET" && action === "proposals")
      return {
        status: 200,
        body: { proposals: await reviews.listProposals(actor, id) },
      };
    if (method === "GET" && action === "feedback")
      return {
        status: 200,
        body: { feedback: await reviews.getFeedback(actor, id) },
      };
    if (method === "POST" && action === "proposals")
      return {
        status: 201,
        body: {
          proposal: await reviews.submitProposal(actor, id, {
            selectedProblem: str(body, "selectedProblem", 10000),
            rationale: str(body, "rationale", 10000),
            questions: strings(body, "questions"),
            proposedApproach: str(body, "proposedApproach"),
            proposedDeliverables: strings(body, "proposedDeliverables"),
            successCriteria: strings(body, "successCriteria"),
            requestKey: str(body, "requestKey", 200),
          }),
        },
      };
    if (method === "POST" && action === "comparisons")
      return {
        status: 201,
        body: {
          comparison: await reviews.compare(actor, id, {
            referenceId: str(body, "referenceId", 200),
            proposalId: str(body, "proposalId", 200),
            criteria: body.criteria as any,
            overallFeedback: str(body, "overallFeedback", 10000),
            requestKey: str(body, "requestKey", 200),
          }),
        },
      };
    if (method === "POST" && action === "mentor")
      return {
        status: 200,
        body: {
          assignment: await reviews.setMentor(actor, id, {
            mentorUserId: str(body, "mentorUserId", 200),
            expectedRevision: num(body, "expectedRevision"),
            requestKey: str(body, "requestKey", 200),
          }),
        },
      };
  }
  throw new NotFoundError("Practice action not found");
}
