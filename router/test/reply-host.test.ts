// The router command on a reply host: reply, submit, answer and choose sent
// to a router's events endpoint as the participant session, in-process; and
// as the process a participant runs, from copies of src/ with no
// node_modules above them, so the path loads no package: directly, and
// under a stand-in Codex.
import test from "node:test";
import assert from "node:assert/strict";
import { spawn, type ChildProcessWithoutNullStreams } from "node:child_process";
import { createServer, type IncomingMessage } from "node:http";
import { cpSync, mkdirSync, writeFileSync } from "node:fs";
import { dirname, join } from "node:path";
import { sharedScratch } from "./test-scratch.ts";
import { checkoutCommit } from "../src/checkout.ts";
import { runReplyHost } from "../src/reply-host.ts";
import { invocation, UsageError } from "../src/request.ts";
import type { Processes } from "../src/caller.ts";
import { ancestry, systemProcesses } from "../src/caller.ts";
import { LAUNCHED, MBA_DAEMON, plain, under } from "./processes.ts";

const dir = sharedScratch("reply-host-");
const file = join(dir, "reply.md");
const body =
  'Merged: skhlo/designs@abc\n\n- `jsx/card.jsx`\n- "quoted" $(not run)';
writeFileSync(file, `${body}\n`);

// A router's events endpoint that records what it is sent and accepts it,
// except anything about T404, which it refuses as the core would. With a
// commit, every answer carries it, as serve's do; /check takes the token t
// as mini's.
async function router(t: test.TestContext, commit?: string) {
  const posted: Record<string, unknown>[] = [];
  const tokens: (string | undefined)[] = [];
  const read = (request: IncomingMessage): Promise<string> =>
    new Promise((resolve) => {
      let raw = "";
      request.on("data", (chunk) => (raw += chunk));
      request.on("end", () => resolve(raw));
    });
  const server = createServer((request, response) => {
    const answer = (status: number, payload: Record<string, unknown>) => {
      response.writeHead(status, { "content-type": "application/json" });
      response.end(JSON.stringify(commit ? { ...payload, commit } : payload));
    };
    if (request.url === "/health") return answer(200, { ok: true });
    if (request.url === "/check")
      return request.headers.authorization === "Bearer t"
        ? answer(200, { ok: true, host: "mini" })
        : answer(401, { ok: false, code: "unauthorized" });
    void read(request).then((raw) => {
      const event = JSON.parse(raw) as Record<string, unknown>;
      posted.push(event);
      tokens.push(request.headers.authorization);
      answer(
        200,
        event.taskId === "T404"
          ? { ok: false, code: "not_found", message: "No such request." }
          : { ok: true, message: "recorded", report: ["delivered D1"] },
      );
    });
  });
  await new Promise<void>((resolve) => server.listen(0, "127.0.0.1", resolve));
  t.after(() => server.close());
  const address = server.address();
  if (address === null || typeof address === "string")
    throw new Error("no port");
  const url = `http://127.0.0.1:${address.port}`;
  // A command line as the session A1 runs it, in a shell with no Codex
  // above it, unless `env` and `processes` say otherwise: its exit code and
  // printed lines.
  const run = async (
    argv: string[],
    env: Record<string, string> = { PASEO_AGENT_ID: "A1" },
    to = url,
    token = "t",
    processes: () => Processes = plain,
  ) => {
    const out: string[] = [];
    const err: string[] = [];
    const inv = invocation(argv, env, processes);
    const code = await runReplyHost(inv, to, token, {
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
    processes?: () => Processes,
  ) =>
    assert.rejects(
      run(argv, env, url, "t", processes),
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
  // Claude Code in a Paseo terminal replies as its terminal; with both
  // ids, or neither, there is no one session to act as.
  await run([...reply, "working"], { PASEO_TERMINAL_ID: "T9" });
  assert.partialDeepStrictEqual(posted[1], { by: "terminal:T9" });
  await refused([...reply, "working"], /^Both \$PASEO_AGENT_ID and/, {
    PASEO_AGENT_ID: "A1",
    PASEO_TERMINAL_ID: "T9",
  });
  await refused([...reply, "working"], /\$PASEO_TERMINAL_ID are unset/, {});
  await refused(
    [...reply, "done"],
    /--kind is working, question, completed or failed/,
  );
  assert.equal(posted.length, 2);
});

// Codex in terminal B attached to the daemon terminal A started: its
// commands carry A's terminal id.
const shared = under("/bin/zsh -c router", MBA_DAEMON, "codex", "-zsh");
const unknown = under("/bin/zsh -c router", "codex app-server proxy", "-zsh");
const own = under(
  "/bin/zsh -c router",
  "codex --no-daemon resume 0199c0de",
  "-zsh",
);

test("reply host: under a shared Codex server, or one the router does not know, nothing is sent; under the session's own Codex it goes as the session", async (t) => {
  const { posted, run, refused } = await router(t);
  const A = { PASEO_TERMINAL_ID: "A" };
  for (const argv of [
    [...reply, "completed", "--text", "done"],
    ["submit", "--to", "environment", "Which shell?"],
    ["answer", "--task", "T3", "--question", "Q1", "--text", "ubuntu"],
    ["choose", "--task", "T3", "--to", "incus"],
  ]) {
    await refused(
      argv,
      /^This runs under a shared Codex server \(pid 98, /,
      A,
      shared,
    );
    await refused(
      argv,
      /^The router does not know the Codex above this command \(pid 98, codex app-server proxy\)/,
      A,
      unknown,
    );
  }
  assert.equal(posted.length, 0);
  // --as cannot bring the refused session back.
  await refused(
    ["choose", "--task", "T3", "--to", "incus", "--as", "terminal:A"],
    /shared Codex server/,
    A,
    shared,
  );
  assert.equal(posted.length, 0);
  const sent = await run(
    [...reply, "completed", "--text", "done"],
    { PASEO_TERMINAL_ID: "B" },
    undefined,
    "t",
    own,
  );
  assert.deepEqual(sent, {
    code: 0,
    out: ["recorded", "delivered D1"],
    err: [],
  });
  assert.equal(posted.length, 1);
  assert.partialDeepStrictEqual(posted[0], {
    type: "update",
    by: "terminal:B",
  });
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

test("reply host: check says the router answers, takes this host's token and runs this commit", async (t) => {
  const ours = checkoutCommit();
  assert.ok(ours, "the tests run from a checkout");
  const same = await router(t, ours);
  assert.deepEqual(await same.run(["check"], {}), {
    code: 0,
    out: [
      `router: ${same.url} answers`,
      "token: accepted for mini",
      `commit: ${ours.slice(0, 7)} on both`,
    ],
    err: [],
  });
  const refused = await same.run(["check"], {}, same.url, "wrong");
  assert.equal(refused.code, 1);
  assert.equal(refused.out[1], "token: refused");
  const behind = await router(t, "0123456789abcdef");
  const differs = await behind.run(["check"], {});
  assert.equal(differs.code, 1);
  assert.equal(
    differs.out[2],
    `commit: the router runs 0123456, this host ${ours.slice(0, 7)}`,
  );
  const lost = await same.run(["check"], {}, "http://127.0.0.1:9");
  assert.equal(lost.code, 1);
  assert.match(lost.err[0] ?? "", /^Cannot reach the router at /);
});

test("reply host: an event still goes when the router runs another commit, and the host is told", async (t) => {
  const { run } = await router(t, "0123456789abcdef");
  const sent = await run([...reply, "working"]);
  assert.equal(sent.code, 0);
  assert.deepEqual(sent.out, ["recorded", "delivered D1"]);
  assert.match(
    sent.err[0] ?? "",
    /^This host's router is at [0-9a-f]{7}, the router's at 0123456: run router host setup for this host on the router host\.$/,
  );
});

// A child's exit code and what it printed.
const exited = (child: ChildProcessWithoutNullStreams) =>
  new Promise<{ code: number | null; stdout: string; stderr: string }>(
    (resolve) => {
      let stdout = "";
      let stderr = "";
      child.stdout.on("data", (chunk) => (stdout += chunk));
      child.stderr.on("data", (chunk) => (stderr += chunk));
      child.on("close", (code) => resolve({ code, stdout, stderr }));
    },
  );

// A copy of src/ in the scratch directory, with no node_modules above it.
const copyOfSrc = (name: string): string => {
  const copy = join(dir, name);
  cpSync(join(import.meta.dirname, "..", "src"), join(copy, "src"), {
    recursive: true,
  });
  return copy;
};

// The secrets beside a configuration's path: the router at url, token t.
const secretsBeside = (config: string, url: string) =>
  writeFileSync(
    join(dirname(config), "secrets.env"),
    `ROUTER_URL=${url}\nROUTER_TOKEN=t\n`,
  );

// Whether the tests' ancestry is their own, as a copy reads this host's
// process table, which must read. Run under a shared Codex server or one
// the router does not know, the copies' commands are refused, as any
// would be.
const ancestryIsOwn = (): boolean => {
  const here = ancestry(systemProcesses);
  assert.notEqual(here.kind, "unresolved", JSON.stringify(here));
  return here.kind === "plain" || here.kind === "own";
};

test("reply host: the router command runs from a copy of src/ with no packages, its secrets beside the configuration's path", async (t) => {
  const { posted, url } = await router(t);
  const copy = copyOfSrc("copy");
  // HOME is the scratch directory: no configuration, and the host's own
  // secrets stay out.
  const cli = (args: string[]) =>
    exited(
      spawn(
        process.execPath,
        ["--no-warnings", join(copy, "src", "cli.ts"), ...args],
        {
          env: { PATH: process.env.PATH, HOME: dir, PASEO_AGENT_ID: "A1" },
        },
      ),
    );
  const lost = await cli([...reply, "working"]);
  assert.equal(lost.code, 2);
  assert.match(lost.stderr, /^No configuration at .*, and no ROUTER_URL/);

  const config = join(dir, "elsewhere", "config.json");
  mkdirSync(join(dir, "elsewhere"));
  secretsBeside(config, url);
  const sent = await cli([...reply, "working", "--config", config]);
  const mistake = await cli([...reply, "done", "--config", config]);
  if (ancestryIsOwn()) {
    assert.equal(sent.code, 0, sent.stderr);
    assert.equal(sent.stdout, "recorded\ndelivered D1\n");
    assert.partialDeepStrictEqual(posted[0], { type: "update", by: "A1" });
    assert.equal(mistake.code, 2);
    assert.match(mistake.stderr, /--kind is working/);
  } else {
    for (const refused of [sent, mistake]) {
      assert.equal(refused.code, 2, refused.stderr);
      assert.match(refused.stderr, /Nothing was sent\./);
    }
    assert.equal(posted.length, 0);
  }
});

// Codex as codex-terminal starts it, and shared servers' command lines,
// stood in for by a shell run as codex: `codex -s workspace-write
// <arguments>`, -s being an option Codex takes, which reads its script,
// the router command from a copy of src/, from stdin. The router command
// runs with --no-warnings, as the router's own launcher runs it.
test("reply host: the router command run by Codex as codex-terminal starts it, with a prompt, an image or --, goes as its terminal; run by a shared server's command line, the daemon's or one with a prompt or a spaced value before app-server, nothing is sent", async (t) => {
  const { posted, url } = await router(t);
  const copy = copyOfSrc("launched");
  const config = join(copy, "config.json");
  secretsBeside(config, url);
  const quoted = (arg: string) => `'${arg.replaceAll("'", "'\\''")}'`;
  const command = [
    process.execPath,
    "--no-warnings",
    join(copy, "src", "cli.ts"),
    ...reply,
    "working",
    "--config",
    config,
  ];
  // A second command keeps sh from exec'ing node, so the stand-in stays
  // the router command's parent.
  const script = `${command.map(quoted).join(" ")}; exit $?`;
  const codex = (args: string[]) => {
    const child = spawn("/bin/sh", ["-s", "workspace-write", ...args], {
      argv0: "codex",
      env: { PATH: process.env.PATH, HOME: dir, PASEO_TERMINAL_ID: "B1" },
    });
    child.stdin.end(`${script}\n`);
    return exited(child);
  };
  const mine = ancestryIsOwn();
  for (const [, ...args] of LAUNCHED) {
    const before = posted.length;
    const ran = await codex(args);
    assert.equal(ran.code, mine ? 0 : 2, `${args.join(" ")}: ${ran.stderr}`);
    assert.equal(posted.length, before + (mine ? 1 : 0));
    if (mine)
      assert.partialDeepStrictEqual(posted.at(-1), {
        type: "update",
        by: "terminal:B1",
      });
  }
  for (const [args, what] of [
    [MBA_DAEMON.split(" ").slice(1), "--managed-daemon, the shared daemon"],
    [["a prompt", "app-server", "--listen", "ws://127.0.0.1:9"], "--listen"],
    [
      ["-C", "/tmp/a b", "app-server", "--listen", "ws://127.0.0.1:9"],
      "--listen",
    ],
  ] as const) {
    const server = await codex([...args]);
    assert.equal(server.code, 2, server.stderr);
    assert.match(
      server.stderr,
      new RegExp(
        String.raw`^This runs under a shared Codex server \(pid \d+, codex app-server ${what}.*Nothing was sent\.`,
      ),
    );
  }
  assert.equal(posted.length, mine ? LAUNCHED.length : 0);
});
