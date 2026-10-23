// A loopback-only, dependency-free preview. No requests reach the router.
import { createServer } from "node:http";
import { readFile } from "node:fs/promises";

const port = Number(process.env.PORT ?? 4318);
const files = {
  "index.html": "text/html; charset=utf-8",
  "prototype.css": "text/css; charset=utf-8",
  "prototype.js": "text/javascript; charset=utf-8",
  "command.js": "text/javascript; charset=utf-8",
  "command.css": "text/css; charset=utf-8",
};

createServer(async (req, res) => {
  const pathname = new URL(req.url ?? "/", "http://localhost").pathname;
  const name = pathname.endsWith("/")
    ? "index.html"
    : pathname.split("/").at(-1);
  if (!Object.hasOwn(files, name)) {
    res.writeHead(404).end("Not found");
    return;
  }
  try {
    let body = await readFile(new URL(name, import.meta.url), "utf8");
    if (name === "index.html" && process.env.NODE_ENV === "production") {
      body = body.replace(
        '<html lang="en">',
        '<html lang="en" data-production="true">',
      );
    }
    res
      .writeHead(200, {
        "Content-Type": files[name],
        "Cache-Control": "no-store",
        "X-Content-Type-Options": "nosniff",
        "Content-Security-Policy":
          "default-src 'self'; style-src 'self' 'unsafe-inline'; img-src 'self' data:; script-src 'self'; connect-src 'none'; base-uri 'none'; form-action 'none'; frame-ancestors 'self'",
      })
      .end(body);
  } catch {
    res.writeHead(500).end("Preview file unavailable");
  }
}).listen(port, "127.0.0.1", () => {
  console.log(`Jev society prototype: http://127.0.0.1:${port}/`);
});
