import type { IncomingMessage } from "node:http";

export function requestOriginAllowed(
  request: IncomingMessage,
  publicOrigin?: string,
): boolean {
  if (request.headers["sec-fetch-site"] === "cross-site") return false;
  const origin = request.headers.origin;
  if (!origin) return true;
  if (publicOrigin) return origin === publicOrigin;
  const host = request.headers.host;
  if (!host) return false;
  const secure = Boolean(
    (request.socket as typeof request.socket & { encrypted?: boolean }).encrypted,
  );
  return origin === `${secure ? "https" : "http"}://${host}`;
}

export function requestUsesSecureCookies(
  request: IncomingMessage,
  publicOrigin?: string,
): boolean {
  if (publicOrigin) return new URL(publicOrigin).protocol === "https:";
  return Boolean(
    (request.socket as typeof request.socket & { encrypted?: boolean }).encrypted,
  );
}
