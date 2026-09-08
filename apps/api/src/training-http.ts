import type { Actor } from "../../../packages/persistence/src/workspace/types.js";
import {
  TrainingService,
  type PracticeCase,
  type TrainingItem,
} from "../../../packages/persistence/src/workspace/training.js";
import {
  ValidationError,
  NotFoundError,
} from "../../../packages/persistence/src/workspace/errors.js";
import type { ClientPool } from "../../../packages/persistence/src/index.js";
export async function trainingRequest(
  pool: ClientPool,
  actor: Actor,
  pathname: string,
  method: string,
  body: Record<string, unknown>,
) {
  if (!pathname.startsWith("/api/training")) return null;
  const service = new TrainingService(pool);
  const str = (k: string, max = 10000) => {
    const v = body[k];
    if (typeof v !== "string" || !v.trim() || v.length > max)
      throw new ValidationError(`${k} must contain 1 to ${max} characters`);
    return v;
  };
  const optional = (k: string, max = 10000) =>
    body[k] === undefined ? {} : { [k]: str(k, max) };
  const number = (k: string) => {
    const v = body[k];
    if (typeof v !== "number" || !Number.isSafeInteger(v) || v < 1)
      throw new ValidationError(`${k} must be positive`);
    return v;
  };
  const practiceCase = () => {
    const value = body.practiceCase;
    if (!value || typeof value !== "object" || Array.isArray(value))
      throw new ValidationError("practiceCase must be an object");
    return value as PracticeCase;
  };
  const items = (allowEmpty = false): TrainingItem[] => {
    const v = body.items;
    if (
      !Array.isArray(v) ||
      (!allowEmpty && v.length < 1) ||
      v.length > 200 ||
      v.some((x) => !x || typeof x !== "object" || Array.isArray(x))
    )
      throw new ValidationError(
        `Provide ${allowEmpty ? "0" : "1"} to 200 training items`,
      );
    return v as TrainingItem[];
  };
  if (pathname === "/api/training/sets") {
    if (method === "GET")
      return { status: 200, body: { sets: await service.listSets(actor) } };
    return {
      status: 201,
      body: {
        version: await service.createDraft(actor, {
          requestKey: str("requestKey", 200),
          key: str("key", 200),
          name: str("name", 300),
          purpose: str("purpose", 5000),
          items: items(body.practiceCase !== undefined),
          ...(body.practiceCase === undefined
            ? {}
            : { practiceCase: practiceCase() }),
        }),
      },
    };
  }
  const versionRoute =
    /^\/api\/training\/sets\/([^/]+)\/([1-9][0-9]*)(?:\/(publish|versions|draft))?$/.exec(
      pathname,
    );
  if (versionRoute) {
    const key = decodeURIComponent(versionRoute[1]!);
    const version = Number(versionRoute[2]);
    if (!Number.isSafeInteger(version))
      throw new ValidationError("Invalid version");
    if (method === "GET" && !versionRoute[3])
      return {
        status: 200,
        body: { version: await service.getVersion(actor, key, version) },
      };
    const base = {
      requestKey: str("requestKey", 200),
      expectedRevision: number("expectedRevision"),
    };
    if (method === "POST" && versionRoute[3] === "publish")
      return {
        status: 200,
        body: { version: await service.publish(actor, key, version, base) },
      };
    if (method === "POST" && versionRoute[3] === "versions")
      return {
        status: 201,
        body: {
          version: await service.createVersion(actor, key, version, {
            ...base,
            reason: str("reason", 5000),
            ...optional("name", 300),
            ...optional("purpose", 5000),
            ...(body.items === undefined
              ? {}
              : { items: items(body.practiceCase !== undefined) }),
            ...(body.practiceCase === undefined
              ? {}
              : { practiceCase: practiceCase() }),
          }),
        },
      };
    if (method === "POST" && versionRoute[3] === "draft")
      return {
        status: 200,
        body: {
          version: await service.updateDraft(actor, key, version, {
            ...base,
            name: str("name", 300),
            purpose: str("purpose", 5000),
            items: items(body.practiceCase !== undefined),
            ...(body.practiceCase === undefined
              ? {}
              : { practiceCase: practiceCase() }),
          }),
        },
      };
  }
  if (pathname === "/api/training/assignments") {
    if (method === "GET")
      return {
        status: 200,
        body: { assignments: await service.getAssignments(actor) },
      };
    return {
      status: 201,
      body: {
        assignment: await service.assign(actor, {
          requestKey: str("requestKey", 200),
          trainingKey: str("trainingKey", 200),
          version: number("version"),
          learnerUserId: str("learnerUserId", 200),
          mentorUserId: str("mentorUserId", 200),
          ...optional("engagementId", 200),
        }),
      },
    };
  }
  const assignment =
    /^\/api\/training\/assignments\/([a-zA-Z0-9-]+)(?:\/(progress|logs|evidence|assessments)(?:\/([^/]+)(\/download)?)?)?$/.exec(
      pathname,
    );
  if (assignment) {
    const [, id, action, target, download] = assignment;
    if (method === "GET" && !action)
      return {
        status: 200,
        body: { assignment: await service.getAssignment(actor, id!) },
      };
    if (method === "GET" && action === "evidence" && target && download)
      return {
        status: 200,
        download: await service.readAttachment(actor, id!, target),
      };
    if (method === "POST") {
      const base = { requestKey: str("requestKey", 200) };
      let record: unknown;
      if (action === "progress" && target && !download)
        record = await service.updateProgress(
          actor,
          id!,
          decodeURIComponent(target),
          {
            ...base,
            expectedRevision: number("expectedRevision"),
            status: str("status"),
            ...optional("trainingEvidenceId", 200),
            ...optional("engagementEvidenceId", 200),
          },
        );
      else if (action === "logs" && !target)
        record = await service.addLearningLog(actor, id!, {
          ...base,
          text: str("text"),
          ...optional("itemKey", 200),
          ...optional("trainingEvidenceId", 200),
          ...optional("engagementEvidenceId", 200),
        });
      else if (action === "evidence" && !target)
        record = await service.addEvidence(actor, id!, {
          ...base,
          title: str("title", 300),
          ...optional("itemKey", 200),
          ...optional("sourceDate", 10),
          ...optional("url", 2000),
          ...optional("fileName", 200),
          ...optional("mediaType", 200),
          ...optional("base64", 3 * 1024 * 1024),
        });
      else if (action === "assessments" && !target) {
        const rev = body.expectedRevision;
        if (typeof rev !== "number" || !Number.isSafeInteger(rev) || rev < 0)
          throw new ValidationError("Assessment revision must be nonnegative");
        record = await service.assess(actor, id!, {
          ...base,
          expectedRevision: rev,
          result: str("result"),
          rationale: str("rationale"),
          ...optional("adminOverrideConfirmation", 100),
        });
      } else throw new NotFoundError("Training action not found");
      return { status: action === "progress" ? 200 : 201, body: { record } };
    }
  }
  throw new NotFoundError("Training action not found");
}
