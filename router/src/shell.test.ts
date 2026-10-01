// The shell against a scripted adapter: what a run records when the host
// misbehaves, and that the record survives a configuration change.
import test from "node:test";
import assert from "node:assert/strict";
import { mkdtempSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { coreConfig, openShell, type ShellOptions } from "./shell.ts";
import { readJournal } from "./journal.ts";
import {
  RouterBug,
  sendFailure,
  type Adapter,
  type Observation,
} from "./paseo.ts";
import type { RouterConfig } from "./config.ts";
import type { Config } from "./types.ts";
import base from "./example-config.ts";

const configFor = (home: string, core: Config = base): RouterConfig => ({
  ...core,
  home,
  hosts: { mbp: { paseo: "fake://mbp", replyCommand: "router" } },
  agents: { "orchestrator@mbp": "A1" },
  serve: { listen: "127.0.0.1:0", board: "127.0.0.1:0", identities: {} },
  jev: { model: "jev-latest" },
});

// An adapter whose next observation and send are scripted per run.
type Script = {
  observe?: () => Promise<Observation | null>;
  send?: (
    key: string,
    text: string,
  ) => Promise<"accepted" | "not_sent" | "unknown">;
};
const idle: Observation = {
  ready: true,
  status: "idle",
  pendingPermissions: 0,
};
const scripted = (script: Script): ShellOptions => ({
  adapter: (): Promise<Adapter> =>
    Promise.resolve({
      observe: script.observe ?? (() => Promise.resolve(idle)),
      send: (_agent, key, text) =>
        (script.send ?? (() => Promise.resolve("accepted" as const)))(
          key,
          text,
        ),
      close: () => Promise.resolve(),
    }),
  judge: null,
  now: () => 1_000,
});

test("a failed observation records not ready: an earlier idle does not send this run", async () => {
  const home = mkdtempSync(join(tmpdir(), "shell-"));
  const config = configFor(home);
  // Run 1: the agent is idle and nothing is queued.
  let shell = await openShell(config, scripted({}));
  await shell.deliver();
  assert.equal(shell.state.placements["orchestrator@mbp"]?.ready, true);
  await shell.close();
  // Run 2: a request arrives, and the look at the agent fails.
  const sent: string[] = [];
  shell = await openShell(
    config,
    scripted({
      observe: () => Promise.reject(new Error("ssh flake")),
      send: (key) => {
        sent.push(key);
        return Promise.resolve("accepted");
      },
    }),
  );
  shell.apply({
    type: "submit",
    by: "you",
    messageId: "M1",
    text: "Fix it",
    to: "orchestrator",
  });
  const report = await shell.deliver();
  assert.equal(sent.length, 0, "nothing may be sent on a stale idle");
  assert.equal(shell.state.placements["orchestrator@mbp"]?.ready, false);
  assert.match(report.join("\n"), /unreachable \(ssh flake\); not ready/);
  assert.match(report.join("\n"), /D1 waits: not ready/);
  await shell.close();
  // Run 3: the agent is seen idle again and the request goes out.
  shell = await openShell(
    config,
    scripted({
      send: (key) => {
        sent.push(key);
        return Promise.resolve("accepted");
      },
    }),
  );
  await shell.deliver();
  assert.deepEqual(sent, ["D1/M1"]);
  await shell.close();
});

test("a key conflict aborts the run with the send left attempting", async () => {
  const home = mkdtempSync(join(tmpdir(), "shell-"));
  const config = configFor(home);
  const shell = await openShell(
    config,
    scripted({
      send: () =>
        Promise.reject(
          new RouterBug("D1/M1 was already sent with different text."),
        ),
    }),
  );
  shell.apply({
    type: "submit",
    by: "you",
    messageId: "M1",
    text: "Fix it",
    to: "orchestrator",
  });
  await assert.rejects(shell.deliver(), RouterBug);
  await shell.close();
  const events = readJournal(home).map((e) => e.event.type);
  assert.equal(events.at(-1), "attempt", "no outcome was invented");
  assert.ok(!events.includes("adapterResult"));
  // The next run marks the send unknown and the operator sees it.
  const next = await openShell(
    config,
    scripted({ send: () => Promise.resolve("accepted") }),
  );
  const send = next.state.tasks[0]?.deliveries[0]?.sends[0];
  assert.equal(send?.outcome, "unknown");
  await next.close();
});

test("a configuration change is recorded, and earlier events still replay", async () => {
  const home = mkdtempSync(join(tmpdir(), "shell-"));
  const loose = configFor(home);
  const judged = {
    ...scripted({}),
    judge: () =>
      Promise.resolve({
        ok: true as const,
        choice: "orchestrator",
        probabilities: {
          orchestrator: 0.92,
          knowledge: 0.03,
          environment: 0.03,
          incus: 0.02,
          none: 0,
        },
        confidence: 0.9,
        model: "jev-test",
        usage: null,
        ms: 1,
      }),
  };
  let shell = await openShell(loose, judged);
  assert.equal(
    readJournal(home)[0]?.event.type,
    "configured",
    "first line is the config",
  );
  shell.apply({ type: "submit", by: "you", messageId: "M1", text: "Fix it" });
  await shell.deliver();
  assert.equal(shell.state.tasks[0]?.status, "working", "dispatched at 0.9");
  await shell.close();
  const lines = readJournal(home).length;
  // Same configuration: nothing new is recorded on open.
  shell = await openShell(loose, judged);
  await shell.close();
  assert.equal(readJournal(home).length, lines + 1, "only the tick");
  // Stricter threshold and a new participant: recorded once, replay intact,
  // and the new rule applies to the next request.
  const strict: Config = structuredClone(base);
  strict.policy.threshold = 0.95;
  strict.participants.push({
    id: "reviewer",
    name: "Reviewer",
    kind: "agent",
    hosts: ["mbp"],
    idempotent: true,
    responsibility: "Reviews drafts.",
  });
  strict.permissions = {
    ...strict.permissions,
    you: [...(strict.permissions?.you ?? []), "reviewer"],
  };
  shell = await openShell(configFor(home, strict), judged);
  assert.equal(readJournal(home).at(-2)?.event.type, "configured");
  assert.equal(
    shell.state.tasks[0]?.status,
    "working",
    "the old dispatch stands",
  );
  assert.ok(shell.state.placements["reviewer@mbp"]);
  shell.apply({
    type: "submit",
    by: "you",
    messageId: "M2",
    text: "Fix it again",
  });
  await shell.deliver();
  assert.equal(
    shell.state.tasks[1]?.status,
    "needs_recipient",
    "0.92 is under 0.95 now",
  );
  await shell.close();
  // And the whole record still folds under the new configuration.
  shell = await openShell(configFor(home, strict), judged);
  assert.equal(shell.state.tasks.length, 2);
  await shell.close();
});

test("a record older than its first configured line replays under that configuration", async () => {
  const home = mkdtempSync(join(tmpdir(), "shell-"));
  // Written on a day the threshold was 0.9 and nothing recorded it yet: the
  // judgment at 0.85 handed back, and the person chose. Then the first
  // configured line arrived.
  const judged = {
    type: "judged",
    taskId: "T1",
    choice: "orchestrator",
    probabilities: {
      orchestrator: 0.85,
      knowledge: 0.05,
      environment: 0.05,
      incus: 0.05,
      none: 0,
    },
  };
  const old = coreConfig(configFor(home));
  const lines = [
    { type: "submit", by: "you", messageId: "M1", text: "Fix it" },
    judged,
    { type: "choose", by: "you", taskId: "T1", to: "orchestrator" },
    { type: "configured", config: old },
  ].map((event) => `${JSON.stringify({ at: "t", event })}\n`);
  writeFileSync(join(home, "journal.jsonl"), lines.join(""));
  // Today the threshold is 0.75: 0.85 would dispatch, and the choose would
  // be refused, were the record folded under today's rules.
  const today: Config = structuredClone(base);
  today.policy.threshold = 0.75;
  const shell = await openShell(configFor(home, today), scripted({}));
  assert.equal(
    shell.state.tasks[0]?.deliveries[0]?.participant,
    "orchestrator",
  );
  assert.equal(shell.state.tasks[0]?.judgments[0]?.threshold, 0.9);
  assert.equal(shell.state.config.policy.threshold, 0.75, "today's rules now");
  assert.equal(
    readJournal(home).filter((e) => e.event.type === "configured").length,
    2,
    "the change is recorded",
  );
  await shell.close();
});

test("a failed send is not_sent only when the daemon refused before sending", () => {
  assert.equal(
    sendFailure(new Error("Agent not found: A1"), "A1", "D1/M1"),
    "not_sent",
  );
  assert.equal(
    sendFailure(new Error("Agent identifier is empty"), "A1", "D1/M1"),
    "not_sent",
  );
  assert.equal(
    sendFailure(new Error("agent_request_outcome_unknown"), "A1", "D1/M1"),
    "unknown",
  );
  assert.equal(
    sendFailure(new Error("socket hang up"), "A1", "D1/M1"),
    "unknown",
  );
  assert.equal(
    sendFailure("Agent not found: A1 (not an Error)", "A1", "D1/M1"),
    "not_sent",
  );
  assert.throws(
    () =>
      sendFailure(
        new Error("agent_request_key_conflict: D1/M1"),
        "A1",
        "D1/M1",
      ),
    RouterBug,
  );
});
