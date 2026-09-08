import {
  createServer,
  type IncomingMessage,
  type Server,
  type ServerResponse,
} from "node:http";
import { fileURLToPath } from "node:url";
import path from "node:path";
import { serveWeb } from "./static.js";
import { handleAuthRequest } from "./auth/index.js";
import { handleWorkspaceRequest } from "./workspace-http.js";
import { loadConfig, type AppConfig } from "./config.js";
import { logger as defaultLogger, type Logger } from "./logger.js";
import {
  readMigrationFiles,
  checkMigrationsCurrent,
  type MigrationFile,
  checkDatabase,
  createPool,
  type ClientPool,
  type Queryable,
} from "../../../packages/persistence/src/index.js";

export interface ServerDependencies {
  pool: Queryable;
  logger?: Logger;
  webRoot?: string;
  expectedMigrations?: MigrationFile[];
  publicOrigin?: string;
}

function respond(
  response: ServerResponse,
  status: number,
  body: Record<string, string>,
): void {
  const payload = JSON.stringify(body);
  response.writeHead(status, {
    "content-type": "application/json; charset=utf-8",
    "content-length": Buffer.byteLength(payload),
    "cache-control": "no-store",
  });
  response.end(payload);
}

export function createApiServer(dependencies: ServerDependencies): Server {
  const log = dependencies.logger ?? defaultLogger;
  return createServer(
    async (request: IncomingMessage, response: ServerResponse) => {
      const method = request.method ?? "GET";
      const requestPath = new URL(request.url ?? "/", "http://localhost")
        .pathname;
      if (
        method === "GET" &&
        (requestPath === "/health/live" || requestPath === "/healthz")
      ) {
        respond(response, 200, { status: "ok" });
        return;
      }
      if (
        method === "GET" &&
        (requestPath === "/health/ready" || requestPath === "/readyz")
      ) {
        try {
          await checkDatabase(dependencies.pool);
          if (dependencies.expectedMigrations) {
            if (!("connect" in dependencies.pool))
              throw new Error("Migration checks unavailable");
            await checkMigrationsCurrent(
              dependencies.pool as ClientPool,
              dependencies.expectedMigrations,
            );
          }
          respond(response, 200, { status: "ready" });
        } catch {
          log.warn("Database readiness check failed");
          respond(response, 503, { status: "unavailable" });
        }
        return;
      }
      try {
        if ("connect" in dependencies.pool) {
          const pool = dependencies.pool as ClientPool;
          if (await handleAuthRequest(request, response, pool, dependencies.publicOrigin)) return;
          if (await handleWorkspaceRequest(request, response, pool, dependencies.publicOrigin)) return;
        }
        if (
          await serveWeb(
            request,
            response,
            dependencies.webRoot ?? path.resolve("apps/web/dist"),
          )
        )
          return;
        respond(response, 404, { error: "Not found" });
      } catch {
        log.warn("Request failed");
        respond(response, 500, { error: "Request failed. Please try again." });
      }
    },
  );
}

export async function startApplication(
  config: AppConfig,
  dependencies?: {
    pool?: ClientPool;
    logger?: Logger;
  },
): Promise<{
  server: Server;
  pool: ClientPool;
  url: string;
  close: () => Promise<void>;
}> {
  const expectedMigrations = await readMigrationFiles(
    config.migrationsDir ?? path.resolve("migrations"),
  );
  const pool = dependencies?.pool ?? createPool(config);
  const server = createApiServer({
    pool,
    expectedMigrations,
    ...(dependencies?.logger ? { logger: dependencies.logger } : {}),
    ...(config.webRoot ? { webRoot: config.webRoot } : {}),
    ...(config.publicOrigin ? { publicOrigin: config.publicOrigin } : {}),
  });
  await new Promise<void>((resolve, reject) => {
    const onError = (error: Error) => {
      server.off("listening", onListening);
      reject(error);
    };
    const onListening = () => {
      server.off("error", onError);
      resolve();
    };
    server.once("error", onError);
    server.once("listening", onListening);
    server.listen(config.port, config.host);
  });
  const log = dependencies?.logger ?? defaultLogger;
  const address = server.address();
  if (!address || typeof address === "string")
    throw new Error("Server address is unavailable");
  const browserHost =
    address.address === "0.0.0.0"
      ? "127.0.0.1"
      : address.address === "::"
        ? "[::1]"
        : address.family === "IPv6"
          ? `[${address.address}]`
          : address.address;
  const url = `http://${browserHost}:${address.port}`;
  log.info("SHI Agentic is ready", {
    url,
    host: address.address,
    port: address.port,
  });
  const eventPool = pool as unknown as {
    on?: (event: "error", listener: () => void) => void;
  };
  eventPool.on?.("error", () => log.warn("Database pool error"));
  let closed = false;
  const close = async (): Promise<void> => {
    if (closed) return;
    closed = true;
    await new Promise<void>((resolve, reject) => {
      server.close((error) => (error ? reject(error) : resolve()));
    });
    await pool.end();
  };
  return { server, pool, url, close };
}

async function main(): Promise<void> {
  try {
    const config = loadConfig();
    const app = await startApplication(config);
    const shutdown = async (signal: string) => {
      defaultLogger.info("Shutting down", { signal });
      try {
        await app.close();
      } catch {
        defaultLogger.error("Graceful shutdown failed");
        process.exitCode = 1;
      }
    };
    process.once("SIGINT", () => void shutdown("SIGINT"));
    process.once("SIGTERM", () => void shutdown("SIGTERM"));
  } catch (error) {
    const message =
      error instanceof Error ? error.message : "Unknown startup error";
    process.stderr.write(`Startup failed: ${message}\n`);
    process.exitCode = 1;
  }
}

const invokedFile = process.argv[1]
  ? fileURLToPath(import.meta.url)
  : undefined;
if (invokedFile && process.argv[1] === invokedFile) void main();
