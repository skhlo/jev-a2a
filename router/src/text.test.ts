// --text and --text-file for the CLI, and the same rule in the client,
// run as the process a participant runs.
import test from "node:test";
import assert from "node:assert/strict";
import { spawn } from "node:child_process";
import { createServer } from "node:http";
import { writeFileSync } from "node:fs";
import { join } from "node:path";
import { sharedScratch } from "./test-scratch.ts";
import { textOption } from "./text.ts";

const dir = sharedScratch("text-");
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
  session: Record<string, string> = { PASEO_AGENT_ID: "A1" },
): Promise<{ code: number | null; stderr: string }> {
  return new Promise((resolve) => {
    const child = spawn(process.execPath, [client, ...args], {
      env: {
        PATH: process.env.PATH,
        HOME: dir,
        ROUTER_URL: url,
        ROUTER_TOKEN: "t",
        ...session,
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
  const address = server.address();
  if (address === null || typeof address === "string")
    throw new Error("no port");
  const url = `http://127.0.0.1:${address.port}`;
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

    // Claude Code in a Paseo terminal replies as its terminal; a Paseo
    // agent's id comes first; with neither there is no session to reply as.
    const terminal = await run(url, [...reply, "working"], {
      PASEO_TERMINAL_ID: "T9",
    });
    assert.equal(terminal.code, 0, terminal.stderr);
    assert.partialDeepStrictEqual(posted[1], { by: "terminal:T9" });
    const agentFirst = await run(url, [...reply, "working"], {
      PASEO_AGENT_ID: "A1",
      PASEO_TERMINAL_ID: "T9",
    });
    assert.equal(agentFirst.code, 0, agentFirst.stderr);
    assert.partialDeepStrictEqual(posted[2], { by: "A1" });
    const nobody = await run(url, [...reply, "working"], {});
    assert.equal(nobody.code, 2);
    assert.match(nobody.stderr, /\$PASEO_TERMINAL_ID are unset/);
    assert.equal(posted.length, 3);
  } finally {
    server.close();
  }
});

test("client: submit, answer and choose post as the participant session", async () => {
  const posted: Record<string, unknown>[] = [];
  const server = createServer((request, response) => {
    let raw = "";
    request.on("data", (chunk) => (raw += chunk));
    request.on("end", () => {
      posted.push(JSON.parse(raw) as Record<string, unknown>);
      response.setHeader("content-type", "application/json");
      response.end(JSON.stringify({ ok: true, message: "recorded" }));
    });
  });
  await new Promise<void>((resolve) => server.listen(0, "127.0.0.1", resolve));
  const address = server.address();
  if (address === null || typeof address === "string")
    throw new Error("no port");
  const url = `http://127.0.0.1:${address.port}`;
  try {
    // Text as the remaining words, addressed and narrowed to hosts.
    let out = await run(url, [
      "submit",
      "--to",
      "environment",
      "--hosts",
      "mbp,mini",
      "Which",
      "shell?",
    ]);
    assert.equal(out.code, 0, out.stderr);
    assert.partialDeepStrictEqual(posted[0], {
      type: "submit",
      by: "A1",
      text: "Which shell?",
      to: "environment",
      hosts: ["mbp", "mini"],
    });
    assert.match(String(posted[0]?.messageId), /^m-/);
    // Unaddressed, from a file, with the caller's own message id.
    out = await run(url, ["submit", "--text-file", file, "--message", "M7"]);
    assert.equal(out.code, 0, out.stderr);
    assert.partialDeepStrictEqual(posted[1], {
      type: "submit",
      by: "A1",
      messageId: "M7",
      text: body,
      to: null,
      hosts: null,
    });
    out = await run(url, ["submit"]);
    assert.equal(out.code, 2);
    assert.match(out.stderr, /A request needs text/);
    out = await run(url, ["submit", "--text-file", file, "and", "words"]);
    assert.equal(out.code, 2);
    assert.match(out.stderr, /not both/);

    out = await run(url, [
      "answer",
      "--task",
      "T3",
      "--delivery",
      "D4",
      "--question",
      "Q1",
      "--text",
      "ubuntu",
    ]);
    assert.equal(out.code, 0, out.stderr);
    assert.partialDeepStrictEqual(posted[2], {
      type: "answer",
      by: "A1",
      taskId: "T3",
      questionId: "Q1",
      deliveryId: "D4",
      text: "ubuntu",
    });
    out = await run(url, ["answer", "--task", "T3", "--text", "x"]);
    assert.equal(out.code, 2);
    assert.match(out.stderr, /--question is required/);

    // The notices name --as for the router host's CLI; here the session is
    // always the caller's own, so --as is taken and ignored.
    out = await run(url, [
      "choose",
      "--as",
      "someone-else",
      "--task",
      "T3",
      "--to",
      "incus",
    ]);
    assert.equal(out.code, 0, out.stderr);
    assert.deepEqual(posted[3], {
      type: "choose",
      by: "A1",
      taskId: "T3",
      to: "incus",
    });
    out = await run(url, ["status"]);
    assert.equal(out.code, 2);
    assert.match(
      out.stderr,
      /router submit \[--to <participant> \[--hosts a,b\]\]/,
    );
    assert.equal(posted.length, 4);
  } finally {
    server.close();
  }
});
