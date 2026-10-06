// The router command on a reply host, run as the process a participant
// runs: no configuration, ROUTER_URL and ROUTER_TOKEN, and the session in
// the environment. It runs from a copy of src/ with no node_modules above
// it, so the path loads no package.
import test from "node:test";
import assert from "node:assert/strict";
import { spawn } from "node:child_process";
import { createServer, type IncomingMessage } from "node:http";
import { cpSync, mkdirSync, writeFileSync } from "node:fs";
import { join } from "node:path";
import { sharedScratch } from "./test-scratch.ts";

const dir = sharedScratch("remote-");
cpSync(join(import.meta.dirname, "..", "src"), join(dir, "src"), {
  recursive: true,
});
const cli = join(dir, "src", "cli.ts");
const file = join(dir, "reply.md");
const body =
  'Merged: skhlo/designs@abc\n\n- `jsx/card.jsx`\n- "quoted" $(not run)';
writeFileSync(file, `${body}\n`);

type Run = { code: number | null; stdout: string; stderr: string };

// HOME is the scratch directory, so there is no configuration and the
// host's own secrets stay out.
function run(
  args: string[],
  env: Record<string, string>,
  session: Record<string, string> = { PASEO_AGENT_ID: "A1" },
): Promise<Run> {
  return new Promise((resolve) => {
    const child = spawn(process.execPath, [cli, ...args], {
      env: { PATH: process.env.PATH, HOME: dir, ...env, ...session },
    });
    let stdout = "";
    let stderr = "";
    child.stdout.on("data", (chunk) => (stdout += chunk));
    child.stderr.on("data", (chunk) => (stderr += chunk));
    child.on("close", (code) => resolve({ code, stdout, stderr }));
  });
}

// A router's events endpoint that records what it is sent and accepts it,
// except a cancel of T404, which it refuses as the core would.
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
  const env = {
    ROUTER_URL: `http://127.0.0.1:${address.port}`,
    ROUTER_TOKEN: "t",
  };
  return { posted, tokens, env };
}

const reply = ["reply", "--task", "T1", "--in-reply-to", "M1", "--kind"];

test("reply host: a reply goes to the router as the session, with the text from a file", async (t) => {
  const { posted, tokens, env } = await router(t);
  const sent = await run([...reply, "completed", "--text-file", file], env);
  assert.equal(sent.code, 0, sent.stderr);
  assert.equal(sent.stdout, "recorded\ndelivered D1\n");
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

  // Mistakes are refused before anything is sent, as on the router host.
  const mistakes: [string[], RegExp][] = [
    [[...reply, "completed", "--text", "x", "--text-file", file], /not both/],
    [
      [...reply, "completed", "--text-file", join(dir, "missing")],
      /--text-file: .*ENOENT/,
    ],
    [[...reply, "done"], /--kind is working, question, completed or failed/],
  ];
  for (const [args, message] of mistakes) {
    const refused = await run(args, env);
    assert.equal(refused.code, 2, args.join(" "));
    assert.match(refused.stderr, message);
  }
  assert.equal(posted.length, 1);

  // Claude Code in a Paseo terminal replies as its terminal; a Paseo
  // agent's id comes first; with neither there is no session to act as.
  const terminal = await run([...reply, "working"], env, {
    PASEO_TERMINAL_ID: "T9",
  });
  assert.equal(terminal.code, 0, terminal.stderr);
  assert.partialDeepStrictEqual(posted[1], { by: "terminal:T9" });
  const agentFirst = await run([...reply, "working"], env, {
    PASEO_AGENT_ID: "A1",
    PASEO_TERMINAL_ID: "T9",
  });
  assert.partialDeepStrictEqual(posted[2], { by: "A1" });
  assert.equal(agentFirst.code, 0, agentFirst.stderr);
  const nobody = await run([...reply, "working"], env, {});
  assert.equal(nobody.code, 2);
  assert.match(nobody.stderr, /\$PASEO_TERMINAL_ID are unset/);
  assert.equal(posted.length, 3);
});

test("reply host: submit, answer and choose go as the session; --as changes nothing", async (t) => {
  const { posted, env } = await router(t);
  // Text as the remaining words, addressed and narrowed to hosts.
  let out = await run(
    ["submit", "--to", "environment", "--hosts", "mbp,mini", "Which", "shell?"],
    env,
  );
  assert.equal(out.code, 0, out.stderr);
  assert.partialDeepStrictEqual(posted[0], {
    type: "submit",
    by: "A1",
    text: "Which shell?",
    to: "environment",
    hosts: ["mbp", "mini"],
  });
  // Unaddressed, from a file, with the caller's own message id.
  out = await run(["submit", "--text-file", file, "--message", "M7"], env);
  assert.equal(out.code, 0, out.stderr);
  assert.deepEqual(posted[1], {
    type: "submit",
    by: "A1",
    messageId: "M7",
    text: body,
    to: null,
    hosts: null,
  });
  out = await run(
    [
      "answer",
      "--task",
      "T3",
      "--delivery",
      "D4",
      "--question",
      "Q1",
      "--text",
      "ubuntu",
    ],
    env,
  );
  assert.equal(out.code, 0, out.stderr);
  assert.partialDeepStrictEqual(posted[2], {
    type: "answer",
    by: "A1",
    taskId: "T3",
    questionId: "Q1",
    deliveryId: "D4",
    text: "ubuntu",
  });
  // The notices name --as for the router host; here the session is the
  // caller on every command.
  out = await run(
    ["choose", "--as", "someone-else", "--task", "T3", "--to", "incus"],
    env,
  );
  assert.equal(out.code, 0, out.stderr);
  assert.deepEqual(posted[3], {
    type: "choose",
    by: "A1",
    taskId: "T3",
    to: "incus",
  });

  // The router host's rules: a request's text is words or a file, never
  // --text, and an answer needs text.
  const mistakes: [string[], RegExp][] = [
    [["submit"], /Give the request text after the options/],
    [["submit", "--text", "x"], /Give the request text after the options/],
    [["submit", "--text-file", file, "and", "words"], /not both/],
    [["answer", "--task", "T3", "--text", "x"], /--question is required/],
    [["answer", "--task", "T3", "--question", "Q1"], /needs text/],
    [["status"], /other commands run on the router host/],
    [["cancel", "T3"], /other commands run on the router host/],
  ];
  for (const [args, message] of mistakes) {
    const refused = await run(args, env);
    assert.equal(refused.code, 2, args.join(" "));
    assert.match(refused.stderr, message, args.join(" "));
  }
  assert.equal(posted.length, 4);
});

test("reply host: the router's refusal exits 1; an unreachable router or no ROUTER_URL says so", async (t) => {
  const { env } = await router(t);
  const refused = await run(["choose", "--task", "T404", "--to", "incus"], env);
  assert.equal(refused.code, 1);
  assert.equal(refused.stdout, "No such request.\n");

  const unreachable = await run([...reply, "working"], {
    ROUTER_URL: "http://127.0.0.1:9",
    ROUTER_TOKEN: "t",
  });
  assert.equal(unreachable.code, 1);
  assert.match(
    unreachable.stderr,
    /^Cannot reach the router at http:\/\/127\.0\.0\.1:9: /,
  );

  const lost = await run([...reply, "working"], {});
  assert.equal(lost.code, 2);
  assert.match(lost.stderr, /^No configuration at .*, and no ROUTER_URL/);

  // secrets.env beside the configuration's path supplies them.
  const config = join(dir, "elsewhere", "config.json");
  mkdirSync(join(dir, "elsewhere"));
  writeFileSync(
    join(dir, "elsewhere", "secrets.env"),
    `ROUTER_URL=${env.ROUTER_URL}\nROUTER_TOKEN=t\n`,
  );
  const fromFile = await run([...reply, "working", "--config", config], {});
  assert.equal(fromFile.code, 0, fromFile.stderr);
});
