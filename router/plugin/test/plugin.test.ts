// The router's Paseo plugin (plugin/): its turn-end hook asks serve for a
// run at the board's address; its RPCs answer from serve's board API, in
// the shapes their contracts declare; and it reads the router's
// configuration as the router does.
import test from "node:test";
import assert from "node:assert/strict";
import { createServer } from "node:http";
import type { AddressInfo } from "node:net";
import { writeFileSync } from "node:fs";
import { join } from "node:path";
import { scratch } from "../../test/test-scratch.ts";
import type { PluginRpcContract, RpcOutput } from "@getpaseo/plugin";
import type { PluginServerContext } from "@getpaseo/plugin/server";
import type { z } from "zod";
import {
  configPathOf,
  loadConfig,
  type RouterConfig,
} from "../../src/config.ts";
import base from "../../src/example-config.ts";
import type { BoardSummary, TaskHead } from "../../src/board-api.ts";
import { boardState, type TaskView } from "../../src/board.ts";
import { reduce } from "../../src/core.ts";
import {
  config as fixture,
  NOW,
  replacedJournal,
  sampleJournal,
  viaJournal,
} from "../../src/board-fixture.ts";
import type { Entry } from "../../src/journal.ts";
import { boardListener, recordReader, type Run } from "../../src/server.ts";
import type { Event } from "../../src/types.ts";
import contribute from "../index.server.ts";
import * as rpc from "../shared/rpc.ts";
import { serveBoard, type Handles } from "../server/board.ts";
import { configPath, routerConfig } from "../server/config.ts";
import { nudgeOnTurnEnd, type Hooks } from "../server/nudge.ts";

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

// The RPCs a daemon was given, called as the app calls them: as the SDK's
// callPluginRpc does, the input is parsed, the handler answers, and the
// output is parsed with the contract's schema.
function rpcs(): Handles & {
  names(): string[];
  call: <I extends z.ZodType, O extends z.ZodType>(
    contract: PluginRpcContract<I, O>,
    input: z.input<I>,
  ) => Promise<z.output<O>>;
} {
  const handlers = new Map<string, (input: unknown) => Promise<unknown>>();
  return {
    handle(contract, handler) {
      handlers.set(contract.name, async (input) =>
        handler(await contract.input.parseAsync(input)),
      );
    },
    names: () => [...handlers.keys()],
    async call(contract, input) {
      const handler = handlers.get(contract.name);
      assert.ok(handler, `${contract.name} is handled`);
      return contract.output.parseAsync(
        await handler(await contract.input.parseAsync(input)),
      );
    },
  };
}

// Whether two types are the same, for the checks the compiler makes.
type Same<A, B> = [A] extends [B] ? ([B] extends [A] ? true : false) : false;

test("plugin: its server entry registers the turn-end hook and the board's RPCs, and returns a cleanup", () => {
  // The entry takes what Paseo hands it.
  const takesPaseo: [PluginServerContext] extends Parameters<typeof contribute>
    ? true
    : false = true;
  assert.ok(takesPaseo);
  const daemon = { ...hooks(), ...rpcs() };
  const cleanup = contribute(daemon);
  assert.ok(daemon.registered());
  assert.deepEqual(daemon.names(), [
    "board.summary",
    "board.task",
    "task.answer",
    "task.choose",
    "task.resolve",
    "task.cancel",
    "task.hold",
    "task.release",
    "task.submit",
  ]);
  assert.equal(typeof cleanup, "function");
});

// Serve's board over a record of `entries`, its actions answered by
// `handle`, and the plugin's RPCs pointed at it.
async function boardAt(
  t: test.TestContext,
  entries: Entry[],
  handle: (event: Event) => Promise<Run> = () =>
    Promise.reject(new Error("no actions here")),
) {
  const home = scratch(t, "plugin-board-");
  writeFileSync(
    join(home, "journal.jsonl"),
    entries.map((entry) => `${JSON.stringify(entry)}\n`).join(""),
  );
  const config: RouterConfig = { ...fixture, home };
  const server = createServer(
    boardListener({
      config,
      handle,
      now: () => NOW,
      record: recordReader(config),
    }),
  );
  await new Promise<void>((done) => server.listen(0, "127.0.0.1", done));
  t.after(() => server.close());
  const board = `127.0.0.1:${(server.address() as AddressInfo).port}`;
  const app = rpcs();
  serveBoard(app, {
    env: {
      ROUTER_CONFIG: join(home, "plugin-config.json"),
    },
  });
  writeFileSync(
    join(home, "plugin-config.json"),
    JSON.stringify({ ...valid, serve: { board } }),
  );
  const api = async (path: string): Promise<unknown> =>
    (await fetch(`http://${board}/api/${path}`)).json();
  return { app, api };
}

test("plugin: the contracts are serve's shapes: the summary and every task pass through them unchanged", async (t) => {
  // The compiler holds the schemas to the router's types.
  type Summary = Extract<RpcOutput<typeof rpc.boardSummary>, { open: unknown }>;
  const same: [
    Same<Summary, BoardSummary>,
    Same<Summary["open"][number], TaskHead>,
    Same<NonNullable<RpcOutput<typeof rpc.boardTask>>["task"], TaskView>,
  ] = [true, true, true];
  assert.deepEqual(same, [true, true, true]);
  // And the records the board fixtures make: a field a schema lacks would
  // be stripped, and the comparison fail.
  let tasks = 0;
  for (const entries of [sampleJournal, replacedJournal, viaJournal]) {
    const { app, api } = await boardAt(t, entries);
    const summary = await app.call(rpc.boardSummary, {});
    assert.deepEqual(summary, await api("summary"));
    assert.ok("open" in summary);
    for (const head of [...summary.open, ...summary.finished]) {
      const full = await app.call(rpc.boardTask, { id: head.id });
      assert.deepEqual(full, await api(`task?id=${head.id}`));
      assert.equal(full?.rev, head.rev);
      tasks += 1;
    }
    assert.deepEqual(
      await app.call(rpc.boardSummary, { sinceRev: summary.rev }),
      { unchanged: true, rev: summary.rev },
    );
    assert.equal(await app.call(rpc.boardTask, { id: "T99" }), null);
  }
  assert.ok(tasks >= 10, `${tasks} tasks checked`);
  // Between them the fixtures show what the schemas name.
  const { app } = await boardAt(t, replacedJournal);
  const summary = await app.call(rpc.boardSummary, {});
  assert.ok("open" in summary);
  assert.ok(
    summary.needsYou.some((n) => n.items.some((i) => i.kind === "resolve")),
  );
});

test("plugin: an action goes to serve as the app's principals; a refusal fails with the router's reason", async (t) => {
  const events: Event[] = [];
  let outcome: Run["outcome"] = { ok: true, message: "Recorded." };
  const { app } = await boardAt(t, sampleJournal, (event) => {
    events.push(event);
    return Promise.resolve({ outcome, report: [] });
  });
  const done = await app.call(rpc.taskCancel, { taskId: "T1" });
  assert.equal(done.message, "Recorded.");
  assert.equal(done.task?.task.id, "T1");
  assert.deepEqual(events, [{ type: "cancel", by: "you", taskId: "T1" }]);
  await app.call(rpc.taskHold, { placement: "environment@mini" });
  await app.call(rpc.taskRelease, { placement: "environment@mbp" });
  await app.call(rpc.taskResolve, {
    deliveryId: "D3",
    messageId: "M4",
    outcome: "not_sent",
  });
  assert.deepEqual(events.slice(1), [
    { type: "observe", placement: "environment@mini", hold: true },
    { type: "observe", placement: "environment@mbp", hold: false },
    {
      type: "resolve",
      by: "operator",
      deliveryId: "D3",
      messageId: "M4",
      outcome: "not_sent",
      evidence: "Marked not sent in the Paseo app.",
    },
  ]);
  // A retried request carries the app's message id each time, so the core
  // recognises the repeat.
  for (let i = 0; i < 2; i += 1)
    await app.call(rpc.taskSubmit, { text: "Tidy", messageId: "app-1" });
  assert.deepEqual(
    events.slice(4).map((e) => (e.type === "submit" ? e.messageId : e.type)),
    ["app-1", "app-1"],
  );
  outcome = { ok: false, code: "closed", message: "T1 is already closed." };
  await assert.rejects(
    app.call(rpc.taskCancel, { taskId: "T1" }),
    /^Error: T1 is already closed\.$/,
  );
  // A message id the router would refuse never leaves the app.
  await assert.rejects(
    app.call(rpc.taskSubmit, { text: "Tidy", messageId: "app 1" }),
    /1-64 letters, digits or \. _ : -/,
  );
  // One serve refuses before the record: its reason, too.
  await assert.rejects(
    app.call(rpc.taskSubmit, { text: "  " }),
    /^Error: Missing text\.$/,
  );
  assert.equal(events.length, 7);
});

test("plugin: a serve too slow for Paseo's limit fails saying the action may be recorded", async (t) => {
  const silent = createServer(() => undefined);
  await new Promise<void>((done) => silent.listen(0, "127.0.0.1", done));
  t.after(() => {
    silent.closeAllConnections();
    silent.close();
  });
  const { port } = silent.address() as AddressInfo;
  const app = rpcs();
  serveBoard(app, {
    env: { ROUTER_CONFIG: configAt(t, `127.0.0.1:${port}`) },
    timeoutMs: 50,
  });
  const late = (advice: string) =>
    new RegExp(
      `^Error: The router's serve did not answer in 0\\.05 s\\.${advice.replaceAll(".", "\\.")}$`,
    );
  // A call that named its message may be repeated as it was.
  await assert.rejects(
    app.call(rpc.taskSubmit, { text: "Tidy", messageId: "app-1" }),
    late(" It may still be recorded; a retry with the same messageId is safe."),
  );
  // Without one, or for another action, the board says what happened.
  for (const call of [
    app.call(rpc.taskSubmit, { text: "Tidy" }),
    app.call(rpc.taskCancel, { taskId: "T1" }),
  ])
    await assert.rejects(
      call,
      late(" It may still be recorded; refetch the board before trying again."),
    );
  await assert.rejects(
    app.call(rpc.taskHold, { placement: "environment@mbp" }),
    late(" Repeating it is safe."),
  );
  await assert.rejects(
    app.call(rpc.boardSummary, {}),
    /^Error: The router's serve did not answer in 0\.05 s\.$/,
  );
});

test("plugin: the app's message ids follow the router's rule", () => {
  for (const id of [
    "app-1",
    "a.b:c_d",
    "a".repeat(64),
    "a".repeat(65),
    "app 1",
    "x/y",
    "",
  ]) {
    const app = rpc.taskSubmit.input.safeParse({ text: "x", messageId: id });
    const core = reduce(boardState(fixture, sampleJournal, NOW), {
      type: "submit",
      by: "you",
      messageId: id,
      text: "x",
    }).last;
    const refused =
      core?.ok === false && core.message.startsWith("A message ID");
    assert.equal(app.success, !refused, JSON.stringify(id));
  }
});

test("plugin: with serve down, an RPC fails naming where it looked and why", async (t) => {
  const closed = createServer();
  await new Promise<void>((done) => closed.listen(0, "127.0.0.1", done));
  const { port } = closed.address() as AddressInfo;
  await new Promise<void>((done) => closed.close(() => done()));
  const app = rpcs();
  serveBoard(app, {
    env: { ROUTER_CONFIG: configAt(t, `127.0.0.1:${port}`) },
  });
  await assert.rejects(
    app.call(rpc.boardSummary, {}),
    new RegExp(
      `^Error: The router's serve does not answer at 127\\.0\\.0\\.1:${port}: fetch failed: connect ECONNREFUSED`,
    ),
  );
});
