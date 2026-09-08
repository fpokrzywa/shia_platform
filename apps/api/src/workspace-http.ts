import { practiceRequest } from "./practice-http.js";
import { discoveryRequest } from "./discovery-http.js";
import { knowledgeRequest } from "./knowledge-http.js";
import { trainingRequest } from "./training-http.js";
import { readoutRequest } from "./readout-http.js";
import { deliveryRequest } from "./delivery-http.js";
import type { IncomingMessage, ServerResponse } from "node:http";
import { readFile } from "node:fs/promises";
import path from "node:path";
import type { ClientPool } from "../../../packages/persistence/src/index.js";
import {
  TemplateService,
  EngagementService,
  MembershipService,
  AuthorizationError,
  ConflictError,
  NotFoundError,
  ValidationError,
} from "../../../packages/persistence/src/workspace/index.js";
import { readSessionToken, resolveActor } from "./auth/index.js";
import type { TemplateVersionDefinition } from "../../../packages/domain/src/templates/index.js";
import type { EngagementRecord } from "../../../packages/persistence/src/workspace/engagements.js";
import type { StoredTemplateVersion } from "../../../packages/persistence/src/workspace/templates.js";
import type { EngagementRole } from "../../../packages/persistence/src/workspace/types.js";
import { SampleService } from "../../../packages/persistence/src/workspace/samples.js";
import { WorkService } from "../../../packages/persistence/src/workspace/work.js";
import { ReadinessService } from "../../../packages/persistence/src/workspace/readiness.js";
import { requestOriginAllowed } from "./request-origin.js";

function json(response: ServerResponse, status: number, body: unknown): void {
  response.writeHead(status, {
    "content-type": "application/json; charset=utf-8",
    "cache-control": "no-store",
    "x-content-type-options": "nosniff",
  });
  response.end(JSON.stringify(body));
}
function text(body: Record<string, unknown>, key: string, max = 200): string {
  const value = body[key];
  if (typeof value !== "string" || !value.trim() || value.length > max)
    throw new ValidationError(
      `${key} must be between 1 and ${max} characters.`,
    );
  return value;
}
function integer(body: Record<string, unknown>, key: string): number {
  const value = body[key];
  if (typeof value !== "number" || !Number.isSafeInteger(value) || value < 1)
    throw new ValidationError(`${key} must be a positive integer.`);
  return value;
}
async function readBody(
  request: IncomingMessage,
  maxBytes = 256 * 1024,
): Promise<Record<string, unknown>> {
  if (
    request.headers["content-type"]?.split(";")[0]?.trim() !==
    "application/json"
  )
    throw new ValidationError("Use application/json for this request.");
  const chunks: Buffer[] = [];
  let size = 0;
  for await (const chunk of request) {
    const bytes = Buffer.isBuffer(chunk) ? chunk : Buffer.from(chunk);
    size += bytes.length;
    if (size > maxBytes)
      throw new ValidationError("Request body exceeds the allowed size.");
    chunks.push(bytes);
  }
  let data: unknown;
  try {
    data = JSON.parse(Buffer.concat(chunks).toString("utf8"));
  } catch {
    throw new ValidationError("Request body must contain valid JSON.");
  }
  if (!data || typeof data !== "object" || Array.isArray(data))
    throw new ValidationError("Request body must be an object.");
  return data as Record<string, unknown>;
}
const templateView = (stored: StoredTemplateVersion) => ({
  ...stored,
  templateKey: stored.definition.templateKey,
  version: stored.definition.version,
  state: stored.definition.state,
});
const engagementView = (stored: EngagementRecord) => ({
  ...stored,
  leadUserId: stored.accountableLeadUserId,
  status: stored.state,
});

export async function handleWorkspaceRequest(
  request: IncomingMessage,
  response: ServerResponse,
  pool: ClientPool,
  publicOrigin?: string,
): Promise<boolean> {
  const pathname = new URL(request.url ?? "/", "http://localhost").pathname;
  if (
    !/^\/api\/(templates|clients|users|engagements|samples|training|practice|knowledge|portfolio)(\/|$)/.test(
      pathname,
    )
  )
    return false;
  const method = request.method ?? "GET";
  if (method !== "GET" && method !== "POST") {
    json(response, 405, { error: "Method not allowed." });
    return true;
  }
  if (method === "POST") {
    if (!requestOriginAllowed(request, publicOrigin)) {
      json(response, 403, { error: "Request origin is not allowed." });
      return true;
    }
  }
  const actor = await resolveActor(
    pool,
    readSessionToken(request.headers.cookie),
  );
  if (!actor) {
    json(response, 401, { error: "Please sign in to continue." });
    return true;
  }
  const templates = new TemplateService(pool),
    engagements = new EngagementService(pool),
    memberships = new MembershipService(pool);
  try {
    const body =
      method === "POST"
        ? await readBody(
            request,
            /^\/api\/(?:engagements\/[a-zA-Z0-9-]+\/work|training\/assignments\/[a-zA-Z0-9-]+)\/evidence$/.test(
              pathname,
            ) ||
              /^\/api\/training\/sets(?:$|\/[^/]+\/[1-9][0-9]*\/(?:versions|draft)$)/.test(
                pathname,
              )
              ? 3 * 1024 * 1024
              : 256 * 1024,
          )
        : {};
    const practice = await practiceRequest(pool, actor, pathname, method, body);
    if (practice) {
      if (practice.download) {
        response.writeHead(200, {
          "content-type": practice.download.mediaType,
          "content-disposition": `attachment; filename="${practice.download.fileName.replace(/[^a-zA-Z0-9_.-]/g, "_")}"`,
          "cache-control": "no-store",
          "x-content-type-options": "nosniff",
        });
        response.end(practice.download.data);
      } else json(response, practice.status, practice.body);
      return true;
    }
    const discovery = await discoveryRequest(
      pool,
      actor,
      pathname,
      method,
      body,
    );
    if (discovery) {
      json(response, discovery.status, discovery.body);
      return true;
    }
    const knowledge = await knowledgeRequest(
      pool,
      actor,
      pathname,
      method,
      body,
    );
    if (knowledge) {
      json(response, knowledge.status, knowledge.body);
      return true;
    }
    const training = await trainingRequest(pool, actor, pathname, method, body);
    if (training) {
      if (training.download) {
        response.writeHead(200, {
          "content-type": "application/octet-stream",
          "content-disposition": `attachment; filename="${training.download.fileName.replace(/[^a-zA-Z0-9_.-]/g, "_")}"`,
          "cache-control": "no-store",
          "x-content-type-options": "nosniff",
        });
        response.end(training.download.data);
      } else json(response, training.status, training.body);
      return true;
    }
    const readout = await readoutRequest(pool, actor, pathname, method, body);
    if (readout) {
      if (readout.download) {
        response.writeHead(200, {
          "content-type": readout.download.mediaType,
          "content-disposition": `attachment; filename="${readout.download.fileName.replace(/[^a-zA-Z0-9_.-]/g, "_")}"`,
          "cache-control": "no-store",
          "x-content-type-options": "nosniff",
        });
        response.end(readout.download.content);
      } else json(response, readout.status, readout.body);
      return true;
    }
    const delivery = await deliveryRequest(pool, actor, pathname, method, body);
    if (delivery) {
      json(response, delivery.status, delivery.body);
      return true;
    }
    const readinessRoute =
      /^\/api\/engagements\/([a-zA-Z0-9-]+)\/readiness(?:\/(stages|items)\/([a-zA-Z0-9-]+)\/(decisions|reopen|not-applicable))?$/.exec(
        pathname,
      );
    if (readinessRoute) {
      const [, engagementId, kind, subjectId, action] = readinessRoute;
      const service = new ReadinessService(pool);
      if (method === "GET" && !kind) {
        json(response, 200, {
          readiness: await service.get(actor, engagementId!),
        });
        return true;
      }
      if (method === "POST" && subjectId) {
        const input = {
          requestKey: text(body, "requestKey"),
          expectedToken: text(body, "expectedToken"),
          rationale: text(body, "rationale", 5000),
        };
        if (kind === "stages" && action === "decisions") {
          const decision = text(body, "decision");
          if (
            decision !== "go" &&
            decision !== "conditional_go" &&
            decision !== "no_go"
          )
            throw new ValidationError("Choose go, conditional go or no-go.");
          if (
            body.exceptions !== undefined &&
            (!Array.isArray(body.exceptions) || body.exceptions.length > 100)
          )
            throw new ValidationError(
              "Exceptions must be a list of at most 100 items.",
            );
          const exceptions = (body.exceptions as unknown[] | undefined)?.map(
            (value) => {
              if (!value || typeof value !== "object" || Array.isArray(value))
                throw new ValidationError("Each exception must be an object.");
              const exception = value as Record<string, unknown>;
              return {
                itemId: text(exception, "itemId"),
                ownerUserId: text(exception, "ownerUserId"),
                dueDate: text(exception, "dueDate", 10),
                rationale: text(exception, "rationale", 5000),
              };
            },
          );
          json(response, 201, {
            stage: await service.decide(actor, engagementId!, subjectId, {
              ...input,
              decision,
              ...(exceptions !== undefined ? { exceptions } : {}),
            }),
          });
          return true;
        }
        if (kind === "stages" && action === "reopen") {
          json(response, 200, {
            stage: await service.reopen(actor, engagementId!, subjectId, input),
          });
          return true;
        }
        if (kind === "items" && action === "not-applicable") {
          json(response, 200, {
            stage: await service.reviewNotApplicable(
              actor,
              engagementId!,
              subjectId,
              input,
            ),
          });
          return true;
        }
      }
      json(response, 404, { error: "Not found." });
      return true;
    }
    const workRoute =
      /^\/api\/engagements\/([a-zA-Z0-9-]+)\/work(?:\/(items|notes|evidence)(?:\/([a-zA-Z0-9-]+)(\/download)?)?)?$/.exec(
        pathname,
      );
    if (workRoute) {
      const [, engagementId, resource, resourceId, download] = workRoute;
      const service = new WorkService(pool);
      if (method === "GET" && !resource) {
        json(response, 200, { work: await service.get(actor, engagementId!) });
        return true;
      }
      if (
        method === "GET" &&
        resource === "evidence" &&
        resourceId &&
        download
      ) {
        const attachment = await service.readAttachment(
          actor,
          engagementId!,
          resourceId,
        );
        response.writeHead(200, {
          "content-type": "application/octet-stream",
          "content-disposition": `attachment; filename="attachment"; filename*=UTF-8''${encodeURIComponent(attachment.fileName).replace(/['()*]/g, (character) => `%${character.charCodeAt(0).toString(16)}`)}`,
          "content-length": attachment.data.length,
          "cache-control": "no-store",
          "x-content-type-options": "nosniff",
          "content-security-policy": "default-src 'none'; sandbox",
        });
        response.end(attachment.data);
        return true;
      }
      if (method === "POST" && !download) {
        const requestKey = text(body, "requestKey");
        if (resource === "items" && resourceId) {
          const optionalValue = (key: string) =>
            body[key] === null || body[key] === "" ? null : text(body, key);
          json(response, 200, {
            item: await service.updateItem(actor, engagementId!, resourceId, {
              requestKey,
              expectedRevision: integer(body, "expectedRevision"),
              status: text(body, "status"),
              ...(body.ownerUserId !== undefined
                ? { ownerUserId: optionalValue("ownerUserId") }
                : {}),
              ...(body.dueDate !== undefined
                ? { dueDate: optionalValue("dueDate") }
                : {}),
            }),
          });
          return true;
        }
        if (resource === "notes" && !resourceId) {
          json(response, 201, {
            note: await service.addNote(actor, engagementId!, {
              requestKey,
              text: text(body, "text", 10000),
              ...(body.itemId ? { itemId: text(body, "itemId") } : {}),
            }),
          });
          return true;
        }
        if (resource === "evidence" && !resourceId) {
          json(response, 201, {
            evidence: await service.addEvidence(actor, engagementId!, {
              requestKey,
              itemId: text(body, "itemId"),
              title: text(body, "title", 300),
              ...(body.evidenceRequirementKey !== undefined
                ? {
                    evidenceRequirementKey: text(
                      body,
                      "evidenceRequirementKey",
                    ),
                  }
                : {}),
              ...(body.url !== undefined
                ? { url: text(body, "url", 4000) }
                : {}),
              ...(body.fileName !== undefined
                ? { fileName: text(body, "fileName", 255) }
                : {}),
              ...(body.mediaType !== undefined
                ? { mediaType: text(body, "mediaType", 200) }
                : {}),
              ...(body.base64 !== undefined
                ? { base64: text(body, "base64", 2800000) }
                : {}),
            }),
          });
          return true;
        }
      }
      json(response, 404, { error: "Not found." });
      return true;
    }
    if (pathname.startsWith("/api/samples") && actor.role !== "practice_admin")
      throw new AuthorizationError("Practice administrator access required.");
    if (pathname === "/api/samples" && method === "GET") {
      json(response, 200, {
        sample: await new SampleService(pool).status(actor),
      });
      return true;
    }
    if (
      (pathname === "/api/samples/load" ||
        pathname === "/api/samples/remove") &&
      method === "POST"
    ) {
      const confirmation = pathname.endsWith("/load")
        ? "load-sample-data"
        : "remove-sample-data";
      if (body.confirmation !== confirmation)
        throw new ValidationError(
          "Confirm this sample data action before continuing.",
        );
      const revision = body.expectedRevision;
      if (
        typeof revision !== "number" ||
        !Number.isSafeInteger(revision) ||
        revision < 0
      )
        throw new ValidationError(
          "Expected revision must be a nonnegative integer.",
        );
      const input = {
        expectedRevision: revision,
        requestKey: text(body, "requestKey"),
        confirmation,
      };
      const service = new SampleService(pool);
      json(response, 200, {
        sample: await (pathname.endsWith("/load")
          ? service.load(actor, { ...input, confirmation: "load-sample-data" })
          : service.remove(actor, {
              ...input,
              confirmation: "remove-sample-data",
            })),
      });
      return true;
    }
    if (pathname === "/api/templates" && method === "GET") {
      const records = await templates.listTemplates(actor);
      const versions = await Promise.all(
        records.flatMap((t) =>
          t.versions.map((v) =>
            templates.getTemplateVersion(actor, t.templateKey, v.version),
          ),
        ),
      );
      const metadata = await pool.query(
        "SELECT t.template_key,t.archived_at IS NOT NULL is_archived,t.management_revision,EXISTS(SELECT 1 FROM workspace_sample_template_versions s WHERE s.template_key=t.template_key) is_sample FROM workspace_templates t",
      );
      const byKey = new Map(
        (
          metadata.rows as Array<{
            template_key: string;
            is_sample: boolean;
            is_archived: boolean;
            management_revision: string;
          }>
        ).map((row) => [row.template_key, row]),
      );
      json(response, 200, {
        templates: versions.map((version) => {
          const meta = byKey.get(version.definition.templateKey);
          return {
            ...templateView(version),
            isSampleTemplate: meta?.is_sample ?? false,
            isArchived: meta?.is_archived ?? false,
            managementRevision: Number(meta?.management_revision ?? 1),
          };
        }),
      });
      return true;
    }
    if (
      (pathname === "/api/templates/archive" ||
        pathname === "/api/templates/restore") &&
      method === "POST"
    ) {
      json(response, 200, {
        template: await templates.setArchived(actor, {
          templateKey: text(body, "templateKey"),
          archived: pathname.endsWith("/archive"),
          expectedRevision: integer(body, "expectedRevision"),
          requestKey: text(body, "requestKey"),
        }),
      });
      return true;
    }
    if (pathname === "/api/templates/import-defaults" && method === "POST") {
      if (actor.role !== "practice_admin")
        throw new AuthorizationError("Practice administrator access required.");
      const loaded = [];
      for (const filename of [
        "apprenticeship.v1.json",
        "independent-delivery.v1.json",
      ]) {
        const definition = JSON.parse(
          await readFile(path.resolve("templates", filename), "utf8"),
        ) as TemplateVersionDefinition;
        try {
          loaded.push(
            templateView(
              await templates.importDraft(actor, {
                definition,
                requestKey: `${text(body, "requestKey")}:${filename}`,
              }),
            ),
          );
        } catch (error) {
          if (!(error instanceof ConflictError)) throw error;
          loaded.push(
            templateView(
              await templates.getTemplateVersion(
                actor,
                definition.templateKey,
                definition.version,
              ),
            ),
          );
        }
      }
      json(response, 200, { templates: loaded });
      return true;
    }
    if (pathname === "/api/templates/publish" && method === "POST") {
      json(response, 200, {
        template: templateView(
          await templates.publish(actor, {
            templateKey: text(body, "templateKey"),
            version: integer(body, "version"),
            expectedRevision: integer(body, "expectedRevision"),
            requestKey: text(body, "requestKey"),
          }),
        ),
      });
      return true;
    }
    if (pathname === "/api/templates/new-version" && method === "POST") {
      if (
        body.changes !== undefined &&
        (!body.changes ||
          typeof body.changes !== "object" ||
          Array.isArray(body.changes))
      )
        throw new ValidationError("Changes must be an object.");
      json(response, 201, {
        template: templateView(
          await templates.createVersion(actor, {
            templateKey: text(body, "templateKey"),
            sourceVersion: integer(body, "sourceVersion"),
            expectedRevision: integer(body, "expectedRevision"),
            reason: text(body, "reason", 2000),
            changes: (body.changes ?? {}) as Partial<TemplateVersionDefinition>,
            requestKey: text(body, "requestKey"),
          }),
        ),
      });
      return true;
    }
    if (pathname === "/api/templates/draft-update" && method === "POST") {
      if (
        !body.definition ||
        typeof body.definition !== "object" ||
        Array.isArray(body.definition)
      )
        throw new ValidationError("Definition must be an object.");
      json(response, 200, {
        template: templateView(
          await templates.updateDraft(actor, {
            templateKey: text(body, "templateKey"),
            version: integer(body, "version"),
            expectedRevision: integer(body, "expectedRevision"),
            reason: text(body, "reason", 2000),
            definition: body.definition as Partial<TemplateVersionDefinition>,
            requestKey: text(body, "requestKey"),
          }),
        ),
      });
      return true;
    }
    if (pathname === "/api/templates/retire" && method === "POST") {
      json(response, 200, {
        template: templateView(
          await templates.retire(actor, {
            templateKey: text(body, "templateKey"),
            version: integer(body, "version"),
            expectedRevision: integer(body, "expectedRevision"),
            requestKey: text(body, "requestKey"),
          }),
        ),
      });
      return true;
    }
    if (pathname === "/api/clients" && method === "GET") {
      json(response, 200, { clients: await engagements.listClients(actor) });
      return true;
    }
    if (pathname === "/api/clients" && method === "POST") {
      json(response, 201, {
        client: await engagements.createClient(actor, {
          name: text(body, "name"),
          requestKey: text(body, "requestKey"),
        }),
      });
      return true;
    }
    if (pathname === "/api/users" && method === "GET") {
      json(response, 200, {
        users: await engagements.listAssignableUsers(actor),
      });
      return true;
    }
    if (pathname === "/api/engagements" && method === "GET") {
      json(response, 200, {
        engagements: (await engagements.listEngagements(actor)).map(
          engagementView,
        ),
      });
      return true;
    }
    if (pathname === "/api/engagements" && method === "POST") {
      const engagement = await engagements.createEngagement(actor, {
        clientId: text(body, "clientId"),
        templateKey: text(body, "templateKey"),
        templateVersion: integer(body, "templateVersion"),
        title: text(body, "title"),
        leadUserId: text(body, "leadUserId"),
        requestKey: text(body, "requestKey"),
      });
      json(response, 201, { engagement: engagementView(engagement) });
      return true;
    }
    const detail = /^\/api\/engagements\/([a-zA-Z0-9-]+)$/.exec(pathname);
    if (detail && method === "GET") {
      const engagement = await engagements.getEngagementDetail(
        actor,
        detail[1]!,
      );
      json(response, 200, {
        engagement: {
          ...engagementView(engagement),
          stages: engagement.stages.map((s) => ({
            ...s,
            name: s.definition.name,
            definitionKey: s.definitionKey,
          })),
          items: engagement.items.map((i) => ({
            ...i,
            name: i.definition.name,
            definitionKey: i.definitionKey,
          })),
        },
      });
      return true;
    }
    const member =
      /^\/api\/engagements\/([a-zA-Z0-9-]+)\/members(?:\/(remove))?$/.exec(
        pathname,
      );
    if (member) {
      if (method === "GET" && !member[2]) {
        json(response, 200, {
          members: await memberships.list(actor, member[1]!),
        });
        return true;
      }
      if (method === "POST") {
        const role = text(body, "role");
        if (
          ![
            "engagement_lead",
            "technical_lead",
            "engineer",
            "reviewer",
          ].includes(role)
        )
          throw new ValidationError("Unknown engagement role.");
        const input = {
          engagementId: member[1]!,
          userId: text(body, "userId"),
          role: role as EngagementRole,
          expectedRevision: integer(body, "expectedRevision"),
          requestKey: text(body, "requestKey"),
        };
        json(
          response,
          200,
          await (member[2]
            ? memberships.remove(actor, input)
            : memberships.add(actor, input)),
        );
        return true;
      }
    }
    json(response, 404, { error: "Not found." });
    return true;
  } catch (error) {
    if (error instanceof AuthorizationError) {
      json(response, 403, { error: error.message });
      return true;
    }
    if (error instanceof ConflictError) {
      json(response, 409, {
        error: `${error.message}. Refresh and review before trying again.`,
      });
      return true;
    }
    if (error instanceof NotFoundError) {
      json(response, 404, { error: error.message });
      return true;
    }
    if (error instanceof ValidationError) {
      json(response, 422, { error: error.message });
      return true;
    }
    throw error;
  }
}
