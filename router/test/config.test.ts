// The deployment configuration and the secrets file: what is refused, what
// defaults, and that the environment wins over the file.
import test from "node:test";
import assert from "node:assert/strict";
import { writeFileSync } from "node:fs";
import { join } from "node:path";
import { sharedScratch } from "./test-scratch.ts";
import {
  callerSession,
  loadConfig,
  loadSecrets,
  terminalClis,
  terminalOf,
} from "../src/config.ts";
import base from "../src/example-config.ts";

const dir = sharedScratch("config-");
let n = 0;
const write = (value: unknown): string => {
  const path = join(dir, `config-${n++}.json`);
  writeFileSync(path, JSON.stringify(value));
  return path;
};
const TERMINAL_ID = "2bd05ba9-f398-4da9-99ad-519dbe5b8011";
const valid = {
  ...base,
  hosts: {
    mbp: { paseo: "ws://127.0.0.1:6767/ws" },
    mini: { paseo: "ssh://mini" },
  },
  agents: { "orchestrator@mbp": "A1", "knowledge@mini": "A2" },
};
// The orchestrator on mbp as a terminal, which it may be once it is not
// idempotent.
const withTerminal = {
  ...valid,
  participants: valid.participants.map((p) =>
    p.id === "orchestrator" ? { ...p, idempotent: false } : p,
  ),
  agents: { ...valid.agents, "orchestrator@mbp": `terminal:${TERMINAL_ID}` },
};

test("a valid file gets its defaults", () => {
  const config = loadConfig(write(valid));
  assert.equal(config.hosts.mbp?.replyCommand, "router");
  assert.equal(config.serve.listen, "127.0.0.1:7677");
  assert.equal(config.serve.board, "127.0.0.1:7678");
  assert.deepEqual(config.serve.identities, {});
  assert.equal(config.serve.wake, 20);
  assert.equal(config.serve.poll, 0);
  assert.equal(config.jev.model, "jev-latest");
  assert.deepEqual(config.telemetry, { sheet: true });
  assert.equal(config.usage, null, "usage is opt-in");
  assert.match(config.home, /jev-router$/);
  // Usage on: every two minutes and all four accounts unless narrowed; a
  // narrowed list is read in the page's order.
  assert.deepEqual(loadConfig(write({ ...valid, usage: {} })).usage, {
    every: 120,
    accounts: ["codex", "claude", "deepseek", "openrouter"],
  });
  assert.deepEqual(
    loadConfig(
      write({
        ...valid,
        usage: { every: 300, accounts: ["openrouter", "codex"] },
      }),
    ).usage,
    { every: 300, accounts: ["codex", "openrouter"] },
  );
  const explicit = loadConfig(
    write({
      ...valid,
      home: "/var/lib/router",
      telemetry: { sheet: false },
      serve: {
        listen: "100.64.0.1:7677",
        board: "localhost:9000",
        identities: { "me@example.com": ["you"] },
        wake: 0,
        poll: 45,
      },
      jev: { model: "jev-1.13.0", url: "https://x/y", timeoutMs: 5 },
    }),
  );
  assert.equal(explicit.home, "/var/lib/router");
  assert.deepEqual(explicit.telemetry, { sheet: false });
  assert.equal(explicit.serve.board, "localhost:9000");
  assert.equal(explicit.serve.wake, 0);
  assert.equal(explicit.serve.poll, 45);
  assert.throws(
    () => loadConfig(write({ ...valid, serve: { wake: -1 } })),
    /serve.wake is a number of seconds, 0 to 3600/,
  );
  assert.throws(
    () => loadConfig(write({ ...valid, serve: { poll: 3601 } })),
    /serve.poll is a number of seconds, 0 to 3600/,
  );
  assert.deepEqual(explicit.serve.identities, { "me@example.com": ["you"] });
  assert.deepEqual(explicit.jev, {
    model: "jev-1.13.0",
    url: "https://x/y",
    timeoutMs: 5,
  });
});

test("what the router refuses, with the reason", () => {
  const cases: [unknown, RegExp][] = [
    [{ ...valid, policy: { ...valid.policy, threshold: 2 } }, /threshold/],
    [{ ...valid, hosts: {} }, /hosts maps/],
    [{ ...valid, hosts: { mbp: {} } }, /hosts\.mbp\.paseo/],
    [{ ...valid, agents: { "nobody@mbp": "A" } }, /unknown placement/],
    [
      { ...valid, agents: { "environment@mba": "A" } },
      /host mba is not in hosts/,
    ],
    [{ ...valid, agents: { "orchestrator@mbp": 3 } }, /must be an agent id/],
    [
      { ...valid, agents: { "orchestrator@mbp": "terminal:" } },
      /by its full id/,
    ],
    [
      { ...valid, agents: { "orchestrator@mbp": "terminal:2bd05ba9" } },
      /by its full id/,
    ],
    [
      { ...valid, agents: { "orchestrator@mbp": `terminal:${TERMINAL_ID}` } },
      /takes no message key, so orchestrator must be idempotent: false/,
    ],
    [{ ...valid, terminals: "codex" }, /terminals maps terminal placements/],
    [
      { ...valid, terminals: { "orchestrator@mbp": "codex" } },
      /terminals.orchestrator@mbp names no terminal placement in agents/,
    ],
    [
      { ...withTerminal, terminals: { "nobody@mbp": "codex" } },
      /terminals.nobody@mbp names no terminal placement/,
    ],
    [
      { ...withTerminal, terminals: { "orchestrator@mbp": "pi" } },
      /terminals.orchestrator@mbp must be one of claude, codex/,
    ],
    [{ ...valid, serve: { board: "0.0.0.0:7678" } }, /loopback/],
    [
      { ...valid, telemetry: { sheet: "yes" } },
      /telemetry.sheet is true or false/,
    ],
    [{ ...valid, usage: true }, /usage is an object/],
    [{ ...valid, usage: { every: 10 } }, /usage.every is a number of seconds/],
    [{ ...valid, usage: { every: "120" } }, /usage.every/],
    [{ ...valid, usage: { every: 3601 } }, /usage.every/],
    [{ ...valid, usage: { accounts: [] } }, /usage.accounts lists accounts/],
    [{ ...valid, usage: { accounts: ["codex", "codex"] } }, /once each/],
    [{ ...valid, usage: { accounts: ["pi"] } }, /among codex, claude/],
    [{ ...valid, usage: { accounts: ["codex", "pi"] } }, /among codex/],
    [{ ...valid, usage: { accounts: "codex" } }, /usage.accounts/],
    [{ ...valid, serve: { board: "100.64.0.1:7678" } }, /loopback/],
    [{ ...valid, serve: { identities: ["me"] } }, /identities maps/],
    [
      { ...valid, serve: { identities: { "me@example.com": ["nobody"] } } },
      /configured principals/,
    ],
    [
      { ...valid, serve: { identities: { "me@example.com": "you" } } },
      /configured principals/,
    ],
  ];
  for (const [value, reason] of cases)
    assert.throws(
      () => loadConfig(write(value)),
      reason,
      JSON.stringify(value).slice(0, 80),
    );
});

test("a terminal placement is accepted for a participant that is not idempotent, runs Claude Code unless terminals names another CLI, and hands the adapter each named session's CLI", () => {
  const config = loadConfig(write(withTerminal));
  assert.equal(config.agents["orchestrator@mbp"], `terminal:${TERMINAL_ID}`);
  assert.deepEqual(config.terminals, {});
  assert.deepEqual(terminalClis(config), {});
  const codex = loadConfig(
    write({ ...withTerminal, terminals: { "orchestrator@mbp": "codex" } }),
  );
  assert.deepEqual(codex.terminals, { "orchestrator@mbp": "codex" });
  assert.deepEqual(terminalClis(codex), {
    [`terminal:${TERMINAL_ID}`]: "codex",
  });
});

test("a session is a Paseo agent id or terminal:<id>; the caller's own comes from the agent's id first, else its terminal's", () => {
  assert.equal(terminalOf(`terminal:${TERMINAL_ID}`), TERMINAL_ID);
  assert.equal(terminalOf("terminal:"), null);
  assert.equal(terminalOf("6c9370bc-d2ed-45bc-98c4-a0f1807fa42c"), null);
  assert.equal(callerSession({ PASEO_AGENT_ID: "A1" }), "A1");
  assert.equal(callerSession({ PASEO_TERMINAL_ID: "T9" }), "terminal:T9");
  assert.equal(
    callerSession({ PASEO_AGENT_ID: "A1", PASEO_TERMINAL_ID: "T9" }),
    "A1",
  );
  assert.equal(callerSession({}), null);
});

test("secrets: KEY=VALUE lines fill the environment without overriding it", () => {
  const path = join(dir, "secrets.env");
  writeFileSync(
    path,
    [
      "# comment",
      "",
      "CONFIG_TEST_A=from-file",
      "CONFIG_TEST_B = spaced ",
      "NOEQUALS",
      "=novalue",
      "CONFIG_TEST_C=",
    ].join("\n"),
  );
  process.env.CONFIG_TEST_B = "from-env";
  delete process.env.CONFIG_TEST_A;
  delete process.env.CONFIG_TEST_C;
  // The names the file sets, whether applied or already in the
  // environment; an empty value sets nothing.
  assert.deepEqual(loadSecrets(path), ["CONFIG_TEST_A", "CONFIG_TEST_B"]);
  assert.equal(process.env.CONFIG_TEST_A, "from-file");
  assert.equal(process.env.CONFIG_TEST_B, "from-env");
  assert.equal(process.env.CONFIG_TEST_C, undefined);
  assert.deepEqual(loadSecrets(join(dir, "missing.env")), []);
});

// The example the README's quick start copies loads as it is, and the one
// unit the schema cannot carry reads as hours.
test("config.example.json is a valid configuration", () => {
  const config = loadConfig(
    join(import.meta.dirname, "..", "config.example.json"),
  );
  assert.equal(config.policy.deadline, 6 * 60 * 60_000);
  assert.deepEqual(Object.keys(config.hosts), ["laptop"]);
  assert.deepEqual(Object.keys(config.agents).sort(), [
    "coder@laptop",
    "notes@laptop",
  ]);
  assert.deepEqual(config.permissions?.you, ["coder", "notes"]);
});
