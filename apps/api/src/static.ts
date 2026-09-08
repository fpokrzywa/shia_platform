import { readFile } from "node:fs/promises";
import path from "node:path";
import type { IncomingMessage, ServerResponse } from "node:http";

export async function serveWeb(
  request: IncomingMessage,
  response: ServerResponse,
  root: string,
): Promise<boolean> {
  if (request.method !== "GET" && request.method !== "HEAD") return false;
  const pathname = new URL(request.url ?? "/", "http://localhost").pathname;
  // Only the entry document and Vite's flat, hashed assets are public.
  const file =
    pathname === "/" || pathname === "/index.html"
      ? "index.html"
      : /^\/assets\/[a-zA-Z0-9_-]+\.(js|css|svg|png|woff2)$/.test(pathname)
        ? pathname.slice(1)
        : undefined;
  if (!file) return false;
  try {
    const content = await readFile(path.join(root, file));
    const types: Record<string, string> = {
      ".html": "text/html; charset=utf-8",
      ".js": "text/javascript; charset=utf-8",
      ".css": "text/css; charset=utf-8",
      ".svg": "image/svg+xml",
      ".png": "image/png",
      ".woff2": "font/woff2",
    };
    response.writeHead(200, {
      "content-type": types[path.extname(file)] ?? "application/octet-stream",
      "content-length": content.length,
      "cache-control":
        file === "index.html"
          ? "no-store"
          : "public, max-age=31536000, immutable",
      "x-content-type-options": "nosniff",
      "content-security-policy":
        "default-src 'self'; script-src 'self'; style-src 'self'; img-src 'self' data:; object-src 'none'; base-uri 'none'; frame-ancestors 'none'; form-action 'self'",
      "referrer-policy": "same-origin",
    });
    response.end(request.method === "HEAD" ? undefined : content);
    return true;
  } catch (error) {
    if ((error as NodeJS.ErrnoException).code === "ENOENT") return false;
    throw error;
  }
}
