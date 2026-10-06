// The router command on a reply host: reply, submit, answer and choose sent
// to a router's events endpoint as the participant session, in-process; and
// once as the process a participant runs, from a copy of src/ with no
// node_modules above it, so the path loads no package.
import test from "node:test";
import assert from "node:assert/strict";
import { spawn } from "node:child_process";
import { createServer, type IncomingMessage } from "node:http";
import { cpSync, mkdirSync, writeFileSync } from "node:fs";
import { join } from "node:path";
import { sharedScratch } from "./test-scratch.ts";
import { runReplyHost } from "../src/reply-host.ts";
import { invocation, UsageError } from "../src/request.ts";

const dir = sharedScratch("reply-host-");
const file = join(dir, "reply.md");
const body =
  'Merged: skhlo/designs@abc\n\n- `jsx/card.jsx`\n- "quoted" $(not run)';
writeFileSync(file, `${body}\n`);

// A router's events endpoint that records what it is sent and accepts it,
// except anything about T404, which it refuses as the core would.
async function router(t: test.TestContext) {
  const posted: Record<string, unknown>[] = [];
  const tokens: (string | undefined)[] = [];
  const read = (request: IncomingMessage): Promise<string> =>
    new Promise((resolve) => {
      let raw = "";
      request.on("data", (chunk) => (raw += chunk));
      request.on("end", () => resolve(raw));
    });
  const server = createServer((request, response) => {
    void read(request).then((raw) => {
      const event = JSON.parse(raw) as Record<string, unknown>;
      posted.push(event);
      tokens.push(request.headers.authorization);
      response.setHeader("content-type", "application/json");
      response.end(
        JSON.stringify(
          event.taskId === "T404"
            ? { ok: false, code: "not_found", message: "No such request." }
            : { ok: true, message: "recorded", report: ["delivered D1"] },
        ),
      );
    });
  });
  await new Promise<void>((resolve) => server.listen(0, "127.0.0.1", resolve));
  t.after(() => server.close());
  const address = server.address();
  if (address === null || typeof address === "string")
    throw new Error("no port");
  const url = `http://127.0.0.1:${address.port}`;
  // A command line as the session A1 runs it, unless `env` says otherwise:
  // its exit code and printed lines.
  const run = async (
    argv: string[],
    env: Record<string, string> = { PASEO_AGENT_ID: "A1" },
    to = url,
  ) => {
    const out: string[] = [];
    const err: string[] = [];
    const code = await runReplyHost(invocation(argv, env), to, "t", {
      out: (line) => out.push(line),
      err: (line) => err.push(line),
    });
    return { code, out, err };
  };
  // A command line refused before anything is sent.
  const refused = (
    argv: string[],
    message: RegExp,
    env?: Record<string, string>,
  ) =>
    assert.rejects(
      run(argv, env),
      (error) => error instanceof UsageError && message.test(error.message),
      argv.join(" "),
    );
  return { posted, tokens, url, run, refused };
}

const reply = ["reply", "--task", "T1", "--in-reply-to", "M1", "--kind"];

test("reply host: a reply goes as the session, with the text from a file", async (t) => {
  const { posted, tokens, run, refused } = await router(t);
  const sent = await run([...reply, "completed", "--text-file", file]);
  assert.deepEqual(sent, {
    code: 0,
    out: ["recorded", "delivered D1"],
    err: [],
  });
  assert.equal(tokens[0], "Bearer t");
  assert.partialDeepStrictEqual(posted[0], {
    type: "update",
    by: "A1",
    taskId: "T1",
    inReplyTo: "M1",
    kind: "completed",
    text: body,
  });
  assert.match(String(posted[0]?.messageId), /^m-/);
  // Claude Code in a Paseo terminal replies as its terminal; a Paseo
  // agent's id comes first; with neither there is no session to act as.
  await run([...reply, "working"], { PASEO_TERMINAL_ID: "T9" });
  assert.partialDeepStrictEqual(posted[1], { by: "terminal:T9" });
  await run([...reply, "working"], {
    PASEO_AGENT_ID: "A1",
    PASEO_TERMINAL_ID: "T9",
  });
  assert.partialDeepStrictEqual(posted[2], { by: "A1" });
  await refused([...reply, "working"], /\$PASEO_TERMINAL_ID are unset/, {});
  await refused(
    [...reply, "done"],
    /--kind is working, question, completed or failed/,
  );
  assert.equal(posted.length, 3);
});

test("reply host: a request goes as the session, its text as words or a file", async (t) => {
  const { posted, run, refused } = await router(t);
  await run([
    "submit",
    "--to",
    "environment",
    "--hosts",
    "mbp,mini",
    "Which",
    "shell?",
  ]);
  assert.partialDeepStrictEqual(posted[0], {
    type: "submit",
    by: "A1",
    text: "Which shell?",
    to: "environment",
    hosts: ["mbp", "mini"],
  });
  await run(["submit", "--text-file", file, "--message", "M7"]);
  assert.deepEqual(posted[1], {
    type: "submit",
    by: "A1",
    messageId: "M7",
    text: body,
    to: null,
    hosts: null,
  });
  await refused(["submit"], /Give the request text after the options/);
  await refused(["submit", "--text", "x", "words"], /not --text/);
  await refused(["submit", "--text-file", file, "and", "words"], /not both/);
  assert.equal(posted.length, 2);
});

test("reply host: an answer goes as the session and needs its question and text", async (t) => {
  const { posted, run, refused } = await router(t);
  const answer = [
    "answer",
    "--task",
    "T3",
    "--delivery",
    "D4",
    "--question",
    "Q1",
  ];
  await run([...answer, "--text", "ubuntu"]);
  assert.partialDeepStrictEqual(posted[0], {
    type: "answer",
    by: "A1",
    taskId: "T3",
    questionId: "Q1",
    deliveryId: "D4",
    text: "ubuntu",
  });
  await refused(
    ["answer", "--task", "T3", "--text", "x"],
    /--question is required/,
  );
  await refused(answer, /needs text/);
  assert.equal(posted.length, 1);
});

test("reply host: a choice goes as the session; --as may name it, never another", async (t) => {
  const { posted, run, refused } = await router(t);
  const choose = ["choose", "--task", "T3", "--to", "incus"];
  // The router's notices name the session with --as.
  await run([...choose, "--as", "A1"]);
  assert.deepEqual(posted[0], {
    type: "choose",
    by: "A1",
    taskId: "T3",
    to: "incus",
  });
  await refused(
    [...choose, "--as", "you"],
    /acts as its own session A1, not you/,
  );
  await refused(choose, /not you/, { PASEO_AGENT_ID: "A1", ROUTER_AS: "you" });
  assert.equal(posted.length, 1);
});

test("reply host: other commands run on the router host; a refusal or an unreachable router exits 1", async (t) => {
  const { run, refused } = await router(t);
  await refused(["status"], /other commands run on the router host/);
  await refused(["cancel", "T3"], /other commands run on the router host/);
  assert.deepEqual(await run(["choose", "--task", "T404", "--to", "incus"]), {
    code: 1,
    out: ["No such request."],
    err: [],
  });
  const unreachable = await run(
    [...reply, "working"],
    undefined,
    "http://127.0.0.1:9",
  );
  assert.equal(unreachable.code, 1);
  assert.match(
    unreachable.err[0] ?? "",
    /^Cannot reach the router at http:\/\/127\.0\.0\.1:9: /,
  );
});

test("reply host: the router command runs from a copy of src/ with no packages, its secrets beside the configuration's path", async (t) => {
  const { posted, url } = await router(t);
  const copy = join(dir, "copy");
  cpSync(join(import.meta.dirname, "..", "src"), join(copy, "src"), {
    recursive: true,
  });
  // HOME is the scratch directory: no configuration, and the host's own
  // secrets stay out.
  const cli = (args: string[]) =>
    new Promise<{ code: number | null; stdout: string; stderr: string }>(
      (resolve) => {
        const child = spawn(
          process.execPath,
          [join(copy, "src", "cli.ts"), ...args],
          { env: { PATH: process.env.PATH, HOME: dir, PASEO_AGENT_ID: "A1" } },
        );
        let stdout = "";
        let stderr = "";
        child.stdout.on("data", (chunk) => (stdout += chunk));
        child.stderr.on("data", (chunk) => (stderr += chunk));
        child.on("close", (code) => resolve({ code, stdout, stderr }));
      },
    );
  const lost = await cli([...reply, "working"]);
  assert.equal(lost.code, 2);
  assert.match(lost.stderr, /^No configuration at .*, and no ROUTER_URL/);

  const config = join(dir, "elsewhere", "config.json");
  mkdirSync(join(dir, "elsewhere"));
  writeFileSync(
    join(dir, "elsewhere", "secrets.env"),
    `ROUTER_URL=${url}\nROUTER_TOKEN=t\n`,
  );
  const sent = await cli([...reply, "working", "--config", config]);
  assert.equal(sent.code, 0, sent.stderr);
  assert.equal(sent.stdout, "recorded\ndelivered D1\n");
  assert.partialDeepStrictEqual(posted[0], { type: "update", by: "A1" });
  const mistake = await cli([...reply, "done", "--config", config]);
  assert.equal(mistake.code, 2);
  assert.match(mistake.stderr, /--kind is working/);
});
