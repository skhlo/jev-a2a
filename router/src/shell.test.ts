// The shell against a scripted adapter: what a run records when the host
// misbehaves, and that the record survives a configuration change.
import test from "node:test";
import assert from "node:assert/strict";
import { mkdtempSync, readFileSync, writeFileSync } from "node:fs";
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
import type { AgentSnapshot, Telemetry } from "./telemetry.ts";
import type { RouterConfig } from "./config.ts";
import type { Config, Event } from "./types.ts";
import base from "./example-config.ts";

const configFor = (home: string, core: Config = base): RouterConfig => ({
  ...core,
  home,
  hosts: { mbp: { paseo: "fake://mbp", replyCommand: "router" } },
  agents: { "orchestrator@mbp": "A1" },
  serve: {
    listen: "127.0.0.1:0",
    board: "127.0.0.1:0",
    identities: {},
    wake: 0,
    poll: 0,
  },
  jev: { model: "jev-latest" },
  telemetry: { sheet: true },
  usage: null,
});

// An adapter whose next observation and send are scripted per run.
type Script = {
  observe?: (seen: string) => Promise<Observation | null>;
  send?: (
    key: string,
    text: string,
  ) => Promise<"accepted" | "not_sent" | "unknown">;
};
const snapshot = (status: "idle" | "running"): AgentSnapshot => ({
  seen: "2026-01-01T00:00:01.000Z",
  status,
  attention: null,
  attentionAt: null,
  turnStartedAt: status === "running" ? "2026-01-01T00:00:00.000Z" : null,
  lastUserMessageAt: null,
  permissions: [],
  provider: "claude",
  model: "claude-opus-5-5",
  thinking: "high",
  mode: "auto",
  context: { used: 1_000, max: 200_000 },
  usage: null,
  error: null,
  title: null,
  cwd: "/work",
  checkout: null,
  subagents: null,
  activity: null,
});
const idle: Observation = {
  ready: true,
  status: "idle",
  pendingPermissions: 0,
  snapshot: snapshot("idle"),
};
const scripted = (script: Script): ShellOptions => ({
  adapter: (): Promise<Adapter> =>
    Promise.resolve({
      observe: (_agent, seen) =>
        (script.observe ?? (() => Promise.resolve(idle)))(seen),
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
  // Worth looking again: the next observation may release it.
  assert.equal(shell.waits(), true);
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
  // Sent and accepted: the reply is an event, so no look is owed.
  assert.equal(shell.waits(), false);
  await shell.close();
});

test("a quiet run records nothing: the tick is held until an event follows it, and an observation only when it changed the placement", async () => {
  const home = mkdtempSync(join(tmpdir(), "shell-"));
  const config = configFor(home);
  const types = (): unknown[] => readJournal(home).map((e) => e.event.type);
  let clock = 1_000;
  const at = (ms: number, script: Script = {}): ShellOptions => {
    clock = ms;
    return { ...scripted(script), now: () => clock };
  };
  // Run 1: the first observation turns the placement ready; recorded,
  // with the tick before it.
  let shell = await openShell(config, at(1_000));
  await shell.deliver();
  await shell.close();
  const first = types();
  assert.deepEqual(first.slice(-2), ["tick", "observe"]);
  // Runs 2 and 3: the same idle again. Nothing is appended, in memory the
  // run still saw its clock and its observation.
  for (const ms of [2_000, 3_000]) {
    shell = await openShell(config, at(ms));
    await shell.deliver();
    assert.equal(shell.state.now, ms);
    assert.equal(shell.state.placements["orchestrator@mbp"]?.ready, true);
    await shell.close();
    assert.deepEqual(types(), first);
  }
  // Run 4: the session is busy. The change is recorded, tick first.
  shell = await openShell(
    config,
    at(4_000, {
      observe: () =>
        Promise.resolve({
          ...idle,
          ready: false,
          status: "running",
          snapshot: snapshot("running"),
        }),
    }),
  );
  await shell.deliver();
  await shell.close();
  assert.deepEqual(types().slice(first.length), ["tick", "observe"]);
  // Run 5: a request at 5 000. Its deadline is measured from this run's
  // tick, so the held tick lands before the submit and a replay agrees.
  shell = await openShell(config, at(5_000));
  shell.apply({ type: "submit", by: "you", messageId: "M1", text: "Fix it" });
  const deadline = shell.state.tasks[0]?.deadline;
  assert.equal(deadline, 5_000 + base.policy.deadline);
  await shell.deliver();
  await shell.close();
  assert.deepEqual(types().slice(first.length + 2, first.length + 4), [
    "tick",
    "submit",
  ]);
  shell = await openShell(config, at(5_050));
  assert.equal(shell.state.tasks[0]?.deadline, deadline, "replay agrees");
  await shell.close();
  const sofar = types().length;
  // Run 6: the deadline passes with nothing else happening. The tick that
  // ends the task is recorded on its own, so a replay ends it too.
  shell = await openShell(config, at(5_000 + base.policy.deadline));
  await shell.deliver();
  assert.equal(shell.state.tasks[0]?.final?.reason, "deadline");
  await shell.close();
  assert.deepEqual(types().slice(sofar), ["tick"]);
  shell = await openShell(config, at(5_001 + base.policy.deadline));
  assert.equal(shell.state.tasks[0]?.final?.reason, "deadline", "replayed");
  await shell.close();
  // Run 7: a hold on a placement whose readiness does not change is a
  // change of the placement, and is recorded.
  shell = await openShell(config, at(7_000));
  shell.apply({ type: "observe", placement: "orchestrator@mbp", hold: true });
  await shell.deliver();
  await shell.close();
  assert.deepEqual(types().slice(sofar + 1), ["tick", "observe"]);
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
  // Same configuration and nothing to do: nothing is recorded, not even
  // the tick.
  shell = await openShell(loose, judged);
  await shell.close();
  assert.equal(readJournal(home).length, lines, "nothing recorded");
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
  assert.equal(readJournal(home).at(-1)?.event.type, "configured");
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

test("a participant sender is told a question and the end through the adapter, each once, at its idle session", async () => {
  const home = mkdtempSync(join(tmpdir(), "shell-"));
  const config = configFor(home);
  const sent: { key: string; text: string }[] = [];
  let refuse = false;
  const script = {
    send: (key: string, text: string) => {
      if (refuse) return Promise.reject(new Error("socket hang up"));
      sent.push({ key, text });
      return Promise.resolve("accepted" as const);
    },
  };
  // Run 1 binds the orchestrator's session; it then asks the dotfiles
  // service on this host for something, as a participant.
  let shell = await openShell(config, scripted(script));
  await shell.deliver();
  const submitted = shell.apply({
    type: "submit",
    by: "A1",
    messageId: "M1",
    text: "Which shell config is active on mbp?",
    to: "environment",
    hosts: ["mbp"],
  });
  assert.equal(submitted.ok, true, submitted.message);
  assert.equal(shell.state.tasks[0]?.via, "orchestrator@mbp");
  // The service's placement is not served by this router: stand in for
  // its adapter and its reply.
  for (const event of [
    {
      type: "observe",
      placement: "environment@mbp",
      session: "E1",
      ready: true,
    },
    { type: "attempt", deliveryId: "D1" },
    {
      type: "adapterResult",
      deliveryId: "D1",
      messageId: "M1",
      outcome: "accepted",
    },
    {
      type: "update",
      by: "E1",
      taskId: "T1",
      messageId: "Q1",
      inReplyTo: "M1",
      kind: "question",
      text: "Login shell or interactive?",
    },
  ] as const) {
    const outcome = shell.apply(event);
    assert.equal(outcome.ok, true, outcome.message);
  }
  let report = await shell.deliver();
  assert.deepEqual(
    sent.map((s) => s.key),
    ["N/T1/question/D1/Q1"],
  );
  assert.match(
    sent[0]?.text ?? "",
    /^\[router T1 question\/D1\/Q1\] environment asks about your request\. Answer with: router answer --as A1 --task T1 --delivery D1 --question Q1 --text "<answer>" \(or --text-file <path>\)\.\n\nLogin shell or interactive\?$/,
  );
  assert.match(report.join("\n"), /T1\/question\/D1\/Q1: notice accepted/);
  // Told once: another run with nothing new sends nothing. A held sender
  // is reported as what its next notice waits for.
  report = await shell.deliver();
  assert.equal(sent.length, 1);
  assert.doesNotMatch(report.join("\n"), /notice/);
  shell.apply({ type: "observe", placement: "orchestrator@mbp", hold: true });
  shell.apply({
    type: "update",
    by: "E1",
    taskId: "T1",
    messageId: "W1",
    inReplyTo: "M1",
    kind: "working",
    text: "still thinking",
  });
  shell.apply({
    type: "update",
    by: "E1",
    taskId: "T1",
    messageId: "Q2",
    inReplyTo: "M1",
    kind: "question",
    text: "Second thought: which user?",
  });
  report = await shell.deliver();
  assert.match(report.join("\n"), /T1 notice question\/D1\/Q2 waits: held/);
  assert.equal(sent.length, 1);
  shell.apply({ type: "observe", placement: "orchestrator@mbp", hold: false });
  report = await shell.deliver();
  assert.equal(sent.at(-1)?.key, "N/T1/question/D1/Q2");
  assert.equal(sent.length, 2);
  // The sender answers and the service finishes; the end is told next run.
  for (const event of [
    {
      type: "answer",
      by: "A1",
      taskId: "T1",
      messageId: "A1-1",
      questionId: "Q2",
      text: "The login user.",
    },
    { type: "observe", placement: "environment@mbp", ready: true },
    { type: "attempt", deliveryId: "D1" },
    {
      type: "adapterResult",
      deliveryId: "D1",
      messageId: "A1-1",
      outcome: "accepted",
    },
    {
      type: "update",
      by: "E1",
      taskId: "T1",
      messageId: "R1",
      inReplyTo: "A1-1",
      kind: "completed",
      text: "zsh from the baseline",
    },
  ] as const) {
    const outcome = shell.apply(event);
    assert.equal(outcome.ok, true, outcome.message);
  }
  assert.equal(shell.state.tasks[0]?.status, "completed");
  // The host drops the call: unknown, retried next run because the
  // orchestrator's adapter deduplicates by key.
  refuse = true;
  report = await shell.deliver();
  assert.match(
    report.join("\n"),
    /T1 notice final: mbp unreachable \(socket hang up\)/,
  );
  assert.match(report.join("\n"), /T1\/final: notice unknown/);
  assert.equal(sent.length, 2);
  refuse = false;
  report = await shell.deliver();
  assert.deepEqual(
    sent.map((s) => s.key),
    ["N/T1/question/D1/Q1", "N/T1/question/D1/Q2", "N/T1/final"],
  );
  assert.match(
    sent[2]?.text ?? "",
    /^\[router T1 final\] Your request is completed, told at 1970-01-01T00:00:01\.000Z\. No reply is needed\.\n\nenvironment@mbp completed \(session E1 R1\):\nzsh from the baseline$/,
  );
  await shell.close();
  // The record carries the notices; a new run has nothing more to tell.
  shell = await openShell(config, scripted(script));
  assert.deepEqual(
    shell.state.tasks[0]?.notices.map((n) => [n.key, n.outcome, n.trail]),
    [
      ["question/D1/Q1", "accepted", ["attempting", "accepted"]],
      ["question/D1/Q2", "accepted", ["attempting", "accepted"]],
      [
        "final",
        "accepted",
        ["attempting", "unknown", "attempting", "accepted"],
      ],
    ],
  );
  report = await shell.deliver();
  assert.equal(sent.length, 3);
  assert.doesNotMatch(report.join("\n"), /notice/);
  await shell.close();
});

test("a run that dies inside a notice's send is recovered like a send: unknown on the next open, repeated with the first text", async () => {
  const home = mkdtempSync(join(tmpdir(), "shell-"));
  const config = configFor(home);
  const sent: { key: string; text: string }[] = [];
  const script = {
    send: (key: string, text: string) => {
      sent.push({ key, text });
      return Promise.resolve("accepted" as const);
    },
  };
  let shell = await openShell(config, scripted(script));
  await shell.deliver();
  for (const event of [
    {
      type: "submit",
      by: "A1",
      messageId: "M1",
      text: "Which shell?",
      to: "environment",
      hosts: ["mbp"],
    },
    {
      type: "observe",
      placement: "environment@mbp",
      session: "E1",
      ready: true,
    },
    { type: "attempt", deliveryId: "D1" },
    {
      type: "adapterResult",
      deliveryId: "D1",
      messageId: "M1",
      outcome: "accepted",
    },
    {
      type: "update",
      by: "E1",
      taskId: "T1",
      messageId: "R1",
      inReplyTo: "M1",
      kind: "completed",
      text: "zsh",
    },
    // The attempt is in the record; the process died before the adapter
    // answered.
    {
      type: "noticeAttempt",
      taskId: "T1",
      key: "final",
      text: "[router T1 final] the first wording",
    },
  ] satisfies Event[]) {
    const outcome = shell.apply(event);
    assert.equal(outcome.ok, true, outcome.message);
  }
  await shell.close();
  // The next open marks it unknown; the run repeats it, under the same key
  // and with the recorded text, since the orchestrator's adapter
  // deduplicates.
  shell = await openShell(config, scripted(script));
  assert.equal(shell.state.tasks[0]?.notices[0]?.outcome, "unknown");
  assert.equal(shell.state.boot, 2);
  const report = await shell.deliver();
  assert.deepEqual(sent, [
    { key: "N/T1/final", text: "[router T1 final] the first wording" },
  ]);
  assert.match(report.join("\n"), /T1\/final: notice accepted/);
  assert.deepEqual(shell.state.tasks[0]?.notices[0]?.trail, [
    "attempting",
    "unknown",
    "attempting",
    "accepted",
  ]);
  // The sender's session was not left blocked: a request to it goes out.
  const submitted = shell.apply({
    type: "submit",
    by: "you",
    messageId: "M2",
    text: "Fix it",
    to: "orchestrator",
  });
  assert.equal(submitted.ok, true, submitted.message);
  await shell.deliver();
  assert.equal(sent.at(-1)?.key, "D2/M2");
  await shell.close();
});

test("a hand-back is told with the choice to make, and a failed end with each delivery's last word", async () => {
  const home = mkdtempSync(join(tmpdir(), "shell-"));
  const config = configFor(home);
  const sent: { key: string; text: string }[] = [];
  const unsure = {
    ...scripted({
      send: (key: string, text: string) => {
        sent.push({ key, text });
        return Promise.resolve("accepted" as const);
      },
    }),
    // Jev leans to the service but not enough to dispatch.
    judge: () =>
      Promise.resolve({
        ok: true as const,
        choice: "environment",
        probabilities: { environment: 0.6, incus: 0.4, none: 0 },
        confidence: 0.6,
        model: "jev-test",
        usage: null,
        ms: 1,
      }),
  };
  const shell = await openShell(config, unsure);
  await shell.deliver();
  let outcome = shell.apply({
    type: "submit",
    by: "A1",
    messageId: "M1",
    text: "Which shell is active on mbp?",
  });
  assert.equal(outcome.ok, true, outcome.message);
  let report = await shell.deliver();
  assert.equal(shell.state.tasks[0]?.status, "needs_recipient");
  assert.deepEqual(
    sent.map((s) => s.key),
    ["N/T1/choose/1"],
  );
  assert.equal(
    sent[0]?.text,
    "[router T1 choose/1] The router could not pick a recipient for your request (low confidence; suggested environment, incus). Choose with: router choose --as A1 --task T1 --to <participant>, one of: environment, incus.\n\nWhich shell is active on mbp?",
  );
  assert.match(report.join("\n"), /T1\/choose\/1: notice accepted/);
  // The sender chooses; the choice notice is settled, the service on this
  // host fails, and the end names each delivery's word.
  for (const event of [
    { type: "choose", by: "A1", taskId: "T1", to: "environment" },
    {
      type: "observe",
      placement: "environment@mbp",
      session: "E1",
      ready: true,
    },
    { type: "attempt", deliveryId: "D2" },
    {
      type: "adapterResult",
      deliveryId: "D2",
      messageId: "M1",
      outcome: "accepted",
    },
    {
      type: "update",
      by: "E1",
      taskId: "T1",
      messageId: "R1",
      inReplyTo: "M1",
      kind: "failed",
      text: "no such host",
    },
    { type: "tick", now: 2_000 },
  ] satisfies Event[]) {
    outcome = shell.apply(event);
    assert.equal(outcome.ok, true, outcome.message);
  }
  assert.equal(shell.state.tasks[0]?.status, "failed");
  report = await shell.deliver();
  assert.equal(sent.length, 2);
  assert.match(
    sent[1]?.text ?? "",
    /^\[router T1 final\] Your request is failed \(deadline\), told at 1970-01-01T00:00:01\.000Z\. No reply is needed\.\n\nenvironment@mba expired\n\nenvironment@mbp failed \(session E1 R1\):\nno such host\n\nenvironment@mini expired$/,
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

test("each run hands the telemetry sink one snapshot per served placement, stamped with the run's clock: the daemon's, missing, or unreachable", async () => {
  const home = mkdtempSync(join(tmpdir(), "shell-"));
  const config = configFor(home);
  const written: Telemetry[] = [];
  const options = (observe: NonNullable<Script["observe"]>): ShellOptions => ({
    ...scripted({ observe }),
    telemetry: (t) => written.push(t),
  });
  // A session the daemon knows, mid-turn; the adapter stamps the snapshot
  // with the time the shell hands it.
  let shell = await openShell(
    config,
    options((seen) =>
      Promise.resolve({
        ready: false,
        status: "running",
        pendingPermissions: 0,
        snapshot: { ...snapshot("running"), seen },
      }),
    ),
  );
  await shell.deliver();
  await shell.close();
  // One the daemon does not know, then a host that cannot be reached.
  shell = await openShell(
    config,
    options(() => Promise.resolve(null)),
  );
  await shell.deliver();
  await shell.close();
  shell = await openShell(
    config,
    options(() => Promise.reject(new Error("ssh flake"))),
  );
  await shell.deliver();
  await shell.close();
  assert.deepEqual(
    written.map((t) => [
      t.version,
      t.at,
      Object.entries(t.placements).map(([key, a]) => [
        key,
        a.seen,
        a.status,
        a.turnStartedAt,
        a.error,
      ]),
    ]),
    [
      [
        "jev-router-telemetry/1",
        "1970-01-01T00:00:01.000Z",
        [
          [
            "orchestrator@mbp",
            "1970-01-01T00:00:01.000Z",
            "running",
            "2026-01-01T00:00:00.000Z",
            null,
          ],
        ],
      ],
      [
        "jev-router-telemetry/1",
        "1970-01-01T00:00:01.000Z",
        [
          [
            "orchestrator@mbp",
            "1970-01-01T00:00:01.000Z",
            "missing",
            null,
            null,
          ],
        ],
      ],
      [
        "jev-router-telemetry/1",
        "1970-01-01T00:00:01.000Z",
        [
          [
            "orchestrator@mbp",
            "1970-01-01T00:00:01.000Z",
            "unreachable",
            null,
            "ssh flake",
          ],
        ],
      ],
    ],
  );
  // Telemetry is not part of the record.
  assert.ok(
    !readFileSync(join(home, "journal.jsonl"), "utf8").includes("telemetry"),
  );
  // Without a sink nothing is kept and nothing fails.
  shell = await openShell(config, scripted({}));
  await shell.deliver();
  await shell.close();
  assert.equal(written.length, 3);
});

test("a telemetry write that fails is reported and the run still sends", async () => {
  const home = mkdtempSync(join(tmpdir(), "shell-"));
  const config = configFor(home);
  const sent: string[] = [];
  const shell = await openShell(config, {
    ...scripted({
      send: (key) => {
        sent.push(key);
        return Promise.resolve("accepted");
      },
    }),
    telemetry: () => {
      throw new Error("EISDIR: telemetry.json is a directory");
    },
  });
  shell.apply({
    type: "submit",
    by: "you",
    messageId: "M1",
    text: "Fix it",
    to: "orchestrator",
  });
  const report = await shell.deliver();
  await shell.close();
  assert.deepEqual(sent, ["D1/M1"]);
  assert.ok(
    report.some((line) => line.startsWith("telemetry not written: EISDIR")),
    report.join("\n"),
  );
});

test("a sheet read the adapter could not make is one telemetry line of the report; the observation stands and the run still sends", async () => {
  const home = mkdtempSync(join(tmpdir(), "shell-"));
  const sent: string[] = [];
  const shell = await openShell(
    configFor(home),
    scripted({
      observe: (seen) =>
        Promise.resolve({
          ready: true,
          status: "idle",
          pendingPermissions: 0,
          snapshot: { ...snapshot("idle"), seen },
          notes: ["activity of A1 not read: timeline gone"],
        }),
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
  await shell.close();
  // The send happened, so the observation read ready despite the note.
  assert.deepEqual(sent, ["D1/M1"]);
  assert.deepEqual(
    report.filter((line) => /orchestrator@mbp/.test(line)),
    [
      "orchestrator@mbp: idle",
      "telemetry: orchestrator@mbp: activity of A1 not read: timeline gone",
    ],
  );
});
