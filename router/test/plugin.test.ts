// The router's Paseo plugin (plugin/): its turn-end hook asks serve for a
// run at the board's address, and reads that address as the router does.
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
  boardAddress,
  nudgeOnTurnEnd,
  type Hooks,
} from "../plugin/server/nudge.ts";

const valid = {
  ...base,
  hosts: { mbp: { paseo: "ws://127.0.0.1:6767/ws" } },
  agents: { "orchestrator@mbp": "A1" },
};

test("plugin: the board address is the one the router's configuration gives, with or without serve.board", (t) => {
  const dir = scratch(t, "plugin-");
  for (const [name, value] of [
    ["unset.json", valid],
    ["set.json", { ...valid, serve: { board: "127.0.0.1:17678" } }],
  ] as const) {
    const path = join(dir, name);
    writeFileSync(path, JSON.stringify(value));
    const env = { ROUTER_CONFIG: path };
    assert.equal(
      boardAddress(env),
      loadConfig(configPathOf(undefined, env)).serve.board,
    );
  }
});

// A daemon's hooks as the plugin sees them: the turn-end callback, to call.
function hooks(): Hooks & {
  registered(): boolean;
  turnEnded(): Promise<void>;
} {
  let callback: Parameters<Hooks["on"]>[1] | null = null;
  return {
    on(name, registered) {
      assert.equal(name, "agent.turn_ended");
      callback = registered;
      return () => undefined;
    },
    registered: () => callback !== null,
    turnEnded() {
      assert.ok(callback, "the hook is registered");
      return callback({}, { signal: new AbortController().signal });
    },
  };
}

test("plugin: a turn's end posts a nudge to serve; a failure is logged once until one gets through", async (t) => {
  let status = 202;
  const seen: string[] = [];
  const server = createServer((req, res) => {
    seen.push(`${req.method} ${req.url}`);
    res.writeHead(status).end(status === 202 ? "run queued" : "nope");
  });
  await new Promise<void>((done) => server.listen(0, "127.0.0.1", done));
  t.after(() => server.close());
  const { port } = server.address() as AddressInfo;
  const path = join(scratch(t, "plugin-"), "config.json");
  writeFileSync(
    path,
    JSON.stringify({ ...valid, serve: { board: `127.0.0.1:${port}` } }),
  );
  const log: string[] = [];
  const daemon = hooks();
  nudgeOnTurnEnd(daemon, {
    env: { ROUTER_CONFIG: path },
    log: (line) => log.push(line),
  });
  await daemon.turnEnded();
  assert.deepEqual(seen, ["POST /nudge"]);
  assert.deepEqual(log, []);
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

test("plugin: its server entry registers the turn-end hook and returns a cleanup", () => {
  const daemon = hooks();
  const cleanup = contribute(daemon);
  assert.ok(daemon.registered());
  assert.equal(typeof cleanup, "function");
});
