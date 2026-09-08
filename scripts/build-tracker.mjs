import { createServer } from "node:http";
import { readFile, writeFile } from "node:fs/promises";
const requested = process.argv.find((x) => x.startsWith("--port="));
const port = requested ? Number(requested.slice(7)) : 0;
if (!Number.isInteger(port) || port < 0 || port > 65535)
  throw Error("Invalid tracker port");
const server = createServer(async (req, res) => {
  try {
    const p = new URL(req.url, "http://localhost").pathname;
    if (p !== "/" && p !== "/progress") {
      res.writeHead(404);
      res.end();
      return;
    }
    const content = await readFile(
      new URL(
        p === "/progress"
          ? "../docs/build-progress.json"
          : "../docs/build-progress.html",
        import.meta.url,
      ),
      "utf8",
    );
    res.writeHead(200, {
      "content-type":
        p === "/progress"
          ? "application/json; charset=utf-8"
          : "text/html; charset=utf-8",
      "cache-control": "no-store",
      "x-content-type-options": "nosniff",
    });
    res.end(content.replace(/^\uFEFF/, ""));
  } catch {
    res.writeHead(503);
    res.end("Progress temporarily unavailable");
  }
});
server.listen(port, "127.0.0.1", async () => {
  const url = `http://127.0.0.1:${server.address().port}`;
  await writeFile(
    new URL("../work/build-tracker-address.json", import.meta.url),
    JSON.stringify({ url, pid: process.pid }),
  );
  console.log(url);
});
