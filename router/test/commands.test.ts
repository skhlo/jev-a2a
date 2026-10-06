// The commands on the record as the router command runs them, against a
// scratch journal and a Paseo where every session is idle: what each
// records and prints, and that a mistake in the options is refused before
// the journal opens.
import test from "node:test";
import assert from "node:assert/strict";
import { spawnSync } from "node:child_process";
import { existsSync, writeFileSync } from "node:fs";
import { join } from "node:path";
import { scratch } from "./test-scratch.ts";
import { runCommand } from "../src/commands.ts";
import { invocation, UsageError } from "../src/request.ts";
import { openShell, type ShellOptions } from "../src/shell.ts";
import type { RouterConfig } from "../src/config.ts";
import { config as fixture, telemetry } from "../src/board-fixture.ts";
import base from "../src/example-config.ts";

const snapshot = telemetry.placements["orchestrator@mbp"];
assert.ok(snapshot);
const idlePaseo: ShellOptions = {
  adapter: () =>
    Promise.resolve({
      observe: () =>
        Promise.resolve({
          ready: true,
          status: "idle",
          pendingPermissions: 0,
          snapshot,
        }),
      send: () => Promise.resolve("accepted" as const),
      close: () => Promise.resolve(),
    }),
  judge: null,
};

// The router on a scratch record: a command line and its environment in,
// the exit code and the printed lines out.
const routerOn = (t: test.TestContext, patch: Partial<RouterConfig> = {}) => {
  const config = { ...fixture, home: scratch(t, "commands-"), ...patch };
  let opened = 0;
  const run = async (argv: string[], env: Record<string, string> = {}) => {
    const out: string[] = [];
    const err: string[] = [];
    const open = () => {
      opened++;
      return openShell(config, idlePaseo);
    };
    const code = await runCommand(invocation(argv, env), config, open, {
      out: (line) => out.push(line),
      err: (line) => err.push(line),
    });
    return { code, out: out.join("\n"), err };
  };
  return { run, config, opened: () => opened };
};

test("a request goes out with submit and its reply comes back with reply; status and needs-you read the record", async (t) => {
  const router = routerOn(t);
  const submitted = await router.run([
    "submit",
    "--to",
    "orchestrator",
    "--message",
    "M1",
    "Fix the",
    "build",
  ]);
  assert.equal(submitted.code, 0);
  // The core's outcome, then what the run delivered.
  const lines = submitted.out.split("\n");
  assert.equal(lines[0], "T1 recorded for you/M1. The caller may disconnect.");
  assert.equal(lines.at(-1), "D1/M1: adapter reported accepted.");
  const sent = await router.run(["status", "T1"]);
  assert.match(
    sent.out,
    /^T1 working · you\/M1 → orchestrator · Fix the build$/m,
  );
  assert.match(
    sent.out,
    /^ {2}D1 orchestrator@mbp · session A1 · request M1 accepted$/m,
  );

  // A reply is the session's own: the agent id the environment names.
  const replied = await router.run(
    [
      "reply",
      "--task",
      "T1",
      "--in-reply-to",
      "M1",
      "--kind",
      "completed",
      "--text",
      "Fixed.",
      "--message",
      "R1",
    ],
    { PASEO_AGENT_ID: "A1" },
  );
  assert.equal(replied.code, 0, replied.out);
  const done = await router.run(["status", "T1"]);
  assert.match(done.out, /^ {2}A2A TASK_STATE_COMPLETED · 1 of 1 completed$/m);
  assert.match(done.out, /^ {4}completed R1 ↩ M1: Fixed\.$/m);
  assert.equal((await router.run(["needs-you"])).out, "Nothing waits on you.");

  // Held, the placement says so in the overview; the core refuses what it
  // does not know, and the command exits 1 with its reason.
  assert.equal(
    (await router.run(["observe", "knowledge@mini", "--hold"])).code,
    0,
  );
  const overview = await router.run(["status"]);
  assert.match(overview.out, /^T1 completed /m);
  assert.match(overview.out, /^knowledge@mini: ready, held · session K1$/m);
  const refused = await router.run(["cancel", "T9"]);
  assert.equal(refused.code, 1);
  assert.equal(refused.out, "No such request.");
});

test("a mistake in the options is refused before the journal opens", async (t) => {
  const router = routerOn(t);
  const cases: [argv: string[], env: Record<string, string>, RegExp][] = [
    [["submit"], {}, /Give the request text after the options/],
    [["submit", "--text-file", "x", "words"], {}, /not both/],
    [["submit", "--text", "x"], {}, /not --text/],
    [["submit", "--text-file", "/nonexistent"], {}, /--text-file: ENOENT/],
    [["choose", "--task", "T1"], {}, /^--to is required\.$/],
    [["reply", "--task", "T1"], {}, /Replies come from a participant session/],
    [
      ["reply", "--kind", "done"],
      { PASEO_TERMINAL_ID: "x" },
      /--kind is working, question, completed or failed/,
    ],
    [["answer", "--task", "T1", "--question", "Q1"], {}, /needs text/],
    [["observe"], {}, /Name the placement/],
    [["observe", "knowledge@mini"], {}, /Pass --hold or --release/],
    [["resolve", "--outcome", "maybe"], {}, /finished or not_sent/],
    [["cancel"], {}, /Name the task/],
    [["frobnicate"], {}, /^Unknown command frobnicate\.\n\nrouter: /],
    [["constructor"], {}, /^Unknown command constructor\./],
  ];
  for (const [argv, env, message] of cases)
    await assert.rejects(
      router.run(argv, env),
      (error) => error instanceof UsageError && message.test(error.message),
      argv.join(" "),
    );
  // Without --as, a command acts as the first principal in its role.
  const noRequester = routerOn(t, { principals: { operator: "operator" } });
  await assert.rejects(
    noRequester.run(["cancel", "T1"]),
    /No requester principal in the configuration; pass --as\./,
  );
  assert.equal(router.opened() + noRequester.opened(), 0);
});

test("status of a task the record does not hold is refused once it is read, and the journal is released", async (t) => {
  const router = routerOn(t);
  await assert.rejects(
    router.run(["status", "T9"]),
    (error) => error instanceof UsageError && error.message === "No task T9.",
  );
  assert.equal(router.opened(), 1);
  assert.equal(existsSync(join(router.config.home, "journal.lock")), false);
});

test("the router command: a mistake exits 2 with its message, and status reads an empty record", (t) => {
  const home = scratch(t, "commands-cli-");
  const path = join(home, "config.json");
  writeFileSync(
    path,
    JSON.stringify({ ...base, home, hosts: { mbp: { paseo: "ws://x" } } }),
  );
  const router = (...args: string[]) =>
    spawnSync(
      process.execPath,
      [
        join(import.meta.dirname, "..", "src", "cli.ts"),
        "--config",
        path,
        ...args,
      ],
      { encoding: "utf8", env: { PATH: process.env.PATH } },
    );
  const status = router("status");
  assert.equal(status.status, 0, status.stderr);
  assert.equal(status.stdout, "No tasks recorded.\n");
  const mistake = router("submit");
  assert.equal(mistake.status, 2);
  assert.equal(mistake.stderr, "Give the request text after the options.\n");
  assert.equal(router().status, 2, "no command prints the usage and exits 2");
  // An --as that every object answers to may address nobody: refused
  // before Jev is asked, so the key is never used.
  writeFileSync(join(home, "secrets.env"), "TYPESAFE_API_KEY=unused\n");
  const inherited = router("eval", "--as", "constructor");
  assert.equal(inherited.status, 2, inherited.stderr);
  assert.equal(inherited.stderr, "constructor may address nobody.\n");
});

test("a placement every object answers to is refused, and holds no other", async (t) => {
  const router = routerOn(t);
  for (const name of [
    "constructor",
    "toString",
    "__proto__",
    "hasOwnProperty",
  ]) {
    const held = await router.run(["observe", name, "--hold"]);
    assert.equal(held.code, 1, name);
    assert.equal(held.out, "No such placement.", name);
  }
  // The run observes every placement, as serve does after a board action.
  assert.equal((await router.run(["run"])).code, 0);
  assert.doesNotMatch((await router.run(["status"])).out, /held/);
});
