// The router's Paseo plugin (plugin/): its turn-end hook asks serve for a
// run at the board's address, and reads the router's configuration as the
// router does.
import test from "node:test";
import assert from "node:assert/strict";
import { createServer } from "node:http";
import type { AddressInfo } from "node:net";
import { writeFileSync } from "node:fs";
import { join } from "node:path";
import { scratch } from "./test-scratch.ts";
import { configPathOf, loadConfig } from "../src/config.ts";
import base from "../src/example-config.ts";
import contribute from "../plugin/index.server.ts";
import {
  configPath,
  nudgeOnTurnEnd,
  routerConfig,
  type Hooks,
} from "../plugin/server/nudge.ts";

const valid = {
  ...base,
  hosts: { mbp: { paseo: "ws://127.0.0.1:6767/ws" } },
  agents: { "orchestrator@mbp": "A1" },
};

test("plugin: it reads the router's configuration as the router does: the file, serve.board with or without a value, and the placements' sessions", (t) => {
  for (const env of [{}, { ROUTER_CONFIG: "/elsewhere/config.json" }])
    assert.equal(configPath(env), configPathOf(undefined, env));
  const dir = scratch(t, "plugin-");
  for (const [name, value] of [
    ["unset.json", valid],
    ["set.json", { ...valid, serve: { board: "127.0.0.1:17678" } }],
  ] as const) {
    const path = join(dir, name);
    writeFileSync(path, JSON.stringify(value));
    const env = { ROUTER_CONFIG: path };
    const loaded = loadConfig(configPathOf(undefined, env));
    const read = routerConfig(env);
    assert.equal(read.board, loaded.serve.board);
    assert.deepEqual([...read.sessions], Object.values(loaded.agents));
  }
});

// A daemon's hooks as the plugin sees them: the turn-end callback, to call
// as the end of an agent's turn.
function hooks(): Hooks & {
  registered(): boolean;
  turnEnded(agent?: string): Promise<void>;
} {
  let callback: Parameters<Hooks["on"]>[1] | null = null;
  return {
    on(name, hook) {
      assert.equal(name, "agent.turn_ended");
      callback = hook;
      return () => undefined;
    },
    registered: () => callback !== null,
    turnEnded(agent = "A1") {
      assert.ok(callback, "the hook is registered");
      return callback(
        { agent: { id: agent } },
        { signal: new AbortController().signal },
      );
    },
  };
}

// A config file in a scratch folder whose serve.board is `board`.
function configAt(t: test.TestContext, board: string): string {
  const path = join(scratch(t, "plugin-"), "config.json");
  writeFileSync(path, JSON.stringify({ ...valid, serve: { board } }));
  return path;
}

test("plugin: a placement's turn end posts a nudge to serve, another agent's does not; a failure is logged once until one gets through", async (t) => {
  let status = 202;
  const seen: string[] = [];
  const server = createServer((req, res) => {
    seen.push(`${req.method} ${req.url}`);
    res.writeHead(status).end(status === 202 ? "run queued" : "nope");
  });
  await new Promise<void>((done) => server.listen(0, "127.0.0.1", done));
  t.after(() => server.close());
  const { port } = server.address() as AddressInfo;
  const log: string[] = [];
  const daemon = hooks();
  nudgeOnTurnEnd(daemon, {
    env: { ROUTER_CONFIG: configAt(t, `127.0.0.1:${port}`) },
    log: (line) => log.push(line),
  });
  await daemon.turnEnded();
  assert.deepEqual(seen, ["POST /nudge"]);
  assert.deepEqual(log, []);
  // Another agent's turn cannot make a delivery ready.
  await daemon.turnEnded("not-a-placement");
  assert.deepEqual(seen, ["POST /nudge"]);
  status = 404;
  await daemon.turnEnded();
  await daemon.turnEnded();
  assert.deepEqual(log, ["nudge: serve answered 404: nope"]);
  status = 202;
  await daemon.turnEnded();
  assert.deepEqual(log, [
    "nudge: serve answered 404: nope",
    "nudge: reaches serve again",
  ]);
  assert.equal(seen.length, 4);
});

test("plugin: with serve down, the log names the reason rather than fetch's own message", async (t) => {
  const closed = createServer();
  await new Promise<void>((done) => closed.listen(0, "127.0.0.1", done));
  const { port } = closed.address() as AddressInfo;
  await new Promise<void>((done) => closed.close(() => done()));
  const log: string[] = [];
  const daemon = hooks();
  nudgeOnTurnEnd(daemon, {
    env: { ROUTER_CONFIG: configAt(t, `127.0.0.1:${port}`) },
    log: (line) => log.push(line),
  });
  await daemon.turnEnded();
  assert.equal(log.length, 1);
  assert.match(log[0] ?? "", /^nudge: fetch failed: connect ECONNREFUSED/);
});

test("plugin: its server entry registers the turn-end hook and returns a cleanup", () => {
  const daemon = hooks();
  const cleanup = contribute(daemon);
  assert.ok(daemon.registered());
  assert.equal(typeof cleanup, "function");
});
