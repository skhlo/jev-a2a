// --text and --text-file for the CLI, and the same rule in the reply client,
// run as the process a participant runs.
import test from "node:test";
import assert from "node:assert/strict";
import { spawn } from "node:child_process";
import { createServer } from "node:http";
import { mkdtempSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import type { AddressInfo } from "node:net";
import { textOption } from "./text.ts";

const dir = mkdtempSync(join(tmpdir(), "text-"));
const file = join(dir, "reply.md");
const body =
  'Merged: skhlo/designs@abc\n\n- `jsx/card.jsx`\n- "quoted" $(not run)';
writeFileSync(file, `${body}\n`);

test("textOption: --text, --text-file, neither, both, unreadable", () => {
  assert.equal(textOption("hi", undefined), "hi");
  assert.equal(textOption(undefined, undefined), "");
  assert.equal(textOption(undefined, file), body);
  assert.throws(() => textOption("hi", file), /not both/);
  assert.throws(
    () => textOption(undefined, join(dir, "missing")),
    /--text-file: .*ENOENT/,
  );
});

// The client reads ~/.config/jev-router/secrets.env; an empty HOME keeps the
// host's own router out of the test.
const client = join(import.meta.dirname, "..", "client", "router.mjs");
function run(
  url: string,
  args: string[],
): Promise<{ code: number | null; stderr: string }> {
  return new Promise((resolve) => {
    const child = spawn(process.execPath, [client, ...args], {
      env: {
        PATH: process.env.PATH,
        HOME: dir,
        ROUTER_URL: url,
        ROUTER_TOKEN: "t",
        PASEO_AGENT_ID: "A1",
      },
    });
    let stderr = "";
    child.stderr.on("data", (chunk) => (stderr += chunk));
    child.on("close", (code) => resolve({ code, stderr }));
  });
}

test("client: --text-file posts the file as the reply text", async () => {
  const posted: unknown[] = [];
  const server = createServer((request, response) => {
    let raw = "";
    request.on("data", (chunk) => (raw += chunk));
    request.on("end", () => {
      posted.push(JSON.parse(raw));
      response.setHeader("content-type", "application/json");
      response.end(JSON.stringify({ ok: true, message: "recorded" }));
    });
  });
  await new Promise<void>((resolve) => server.listen(0, "127.0.0.1", resolve));
  const { port } = server.address() as AddressInfo;
  const url = `http://127.0.0.1:${port}`;
  const reply = ["reply", "--task", "T1", "--in-reply-to", "M1", "--kind"];
  try {
    const sent = await run(url, [...reply, "completed", "--text-file", file]);
    assert.equal(sent.code, 0, sent.stderr);
    assert.equal(posted.length, 1);
    assert.partialDeepStrictEqual(posted[0], {
      type: "update",
      by: "A1",
      taskId: "T1",
      inReplyTo: "M1",
      kind: "completed",
      text: body,
    });

    const both = await run(url, [
      ...reply,
      "completed",
      "--text",
      "x",
      "--text-file",
      file,
    ]);
    assert.equal(both.code, 2);
    assert.match(both.stderr, /not both/);

    const missing = await run(url, [
      ...reply,
      "completed",
      "--text-file",
      join(dir, "missing"),
    ]);
    assert.equal(missing.code, 2);
    assert.match(missing.stderr, /--text-file: .*ENOENT/);
    assert.equal(posted.length, 1);
  } finally {
    server.close();
  }
});
