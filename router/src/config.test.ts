// The deployment configuration and the secrets file: what is refused, what
// defaults, and that the environment wins over the file.
import test from "node:test";
import assert from "node:assert/strict";
import { mkdtempSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { loadConfig, loadSecrets } from "./config.ts";
import base from "./example-config.ts";

const dir = mkdtempSync(join(tmpdir(), "config-"));
let n = 0;
const write = (value: unknown): string => {
  const path = join(dir, `config-${n++}.json`);
  writeFileSync(path, JSON.stringify(value));
  return path;
};
const valid = {
  ...base,
  hosts: {
    mbp: { paseo: "ws://127.0.0.1:6767/ws" },
    mini: { paseo: "ssh://mini" },
  },
  agents: { "orchestrator@mbp": "A1", "knowledge@mini": "A2" },
};

test("a valid file gets its defaults", () => {
  const config = loadConfig(write(valid));
  assert.equal(config.hosts.mbp?.replyCommand, "router");
  assert.equal(config.serve.listen, "127.0.0.1:7677");
  assert.equal(config.serve.board, "127.0.0.1:7678");
  assert.deepEqual(config.serve.identities, {});
  assert.equal(config.jev.model, "jev-latest");
  assert.match(config.home, /jev-router$/);
  const explicit = loadConfig(
    write({
      ...valid,
      home: "/var/lib/router",
      serve: {
        listen: "100.64.0.1:7677",
        board: "localhost:9000",
        identities: { "me@example.com": ["you"] },
      },
      jev: { model: "jev-1.13.0", url: "https://x/y", timeoutMs: 5 },
    }),
  );
  assert.equal(explicit.home, "/var/lib/router");
  assert.equal(explicit.serve.board, "localhost:9000");
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
    [{ ...valid, serve: { board: "0.0.0.0:7678" } }, /loopback/],
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
  loadSecrets(path);
  assert.equal(process.env.CONFIG_TEST_A, "from-file");
  assert.equal(process.env.CONFIG_TEST_B, "from-env");
  assert.equal(process.env.CONFIG_TEST_C, undefined);
  loadSecrets(join(dir, "missing.env"));
});
