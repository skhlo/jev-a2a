// The board reads the record without touching it: a lock-free journal read,
// a pure model, and the actions its page posts. board-page.test.ts covers
// the page itself.
import test from "node:test";
import assert from "node:assert/strict";
import { readFileSync, writeFileSync } from "node:fs";
import { join } from "node:path";
import { scratch } from "./test-scratch.ts";
import {
  actionEvent,
  BOARD_VERSION,
  boardModel,
  boardState,
  describeNeed,
  identify,
  messageTimes,
  taskLog,
} from "../src/board.ts";
import {
  answeredJournal,
  config,
  extend,
  journal,
  NOW,
  telemetry,
  viaJournal,
} from "../src/board-fixture.ts";
import { boardSample, sampleModel, SAMPLE_PATH } from "../src/board-sample.ts";
import { readJournal, type Entry } from "../src/journal.ts";
import type { Event } from "../src/types.ts";

// Past every deadline in the fixture.
const LATER = NOW + 3 * 60 * 60_000;
const times = messageTimes(journal);
const identities = config.serve.identities;
const viewer = (login: string) =>
  identify({ "tailscale-user-login": login }, identities);

test("the fixture is a journal: every event was accepted", () => {
  assert.doesNotThrow(() => boardState(config, journal, NOW));
  assert.throws(
    () =>
      boardState(
        config,
        [
          ...journal,
          {
            at: "2026-09-30T09:45:00.000Z",
            event: { type: "choose", by: "you", taskId: "T9", to: "knowledge" },
          },
        ],
        NOW,
      ),
    /Journal replay rejected/,
  );
});

test("readJournal skips a line still being written", (t) => {
  const home = scratch(t, "board-");
  const path = join(home, "journal.jsonl");
  const line = JSON.stringify({ at: "t", event: { type: "tick", now: 1 } });
  writeFileSync(path, `${line}\n${line}\n${line.slice(0, 10)}`);
  assert.equal(readJournal(home).length, 2);
  writeFileSync(path, `${line}\n${line}\n${line}\n`);
  assert.equal(readJournal(home).length, 3);
  assert.deepEqual(readJournal(scratch(t, "board-")), []);
  assert.equal(readFileSync(path, "utf8").split("\n").length, 4);
});

test("the model lists what waits on a person and the open and finished tasks", () => {
  const state = boardState(config, journal, NOW);
  const model = boardModel(state, config, NOW);
  assert.equal(model.at, new Date(NOW).toISOString());
  const you = model.needsYou.find((n) => n.principal === "you");
  assert.ok(you);
  assert.deepEqual(you.items.map(describeNeed), [
    "T1: choose a recipient (low_confidence; suggested orchestrator, knowledge, environment, incus)",
    'T2: answer Q2 on D1 "Force push?"',
  ]);
  assert.deepEqual(
    model.needsYou.find((n) => n.principal === "operator")?.items,
    [],
  );
  assert.deepEqual(
    model.placements.map((p) => [p.key, p.ready, p.hold, p.session]),
    [
      ["orchestrator@mbp", true, false, "A1"],
      ["knowledge@mini", false, false, "K1"],
      ["environment@mbp", true, true, "E1"],
      ["environment@mini", true, false, "E2"],
    ],
  );
  assert.deepEqual(
    model.open.map((t) => [t.id, t.status]),
    [
      ["T4", "working"],
      ["T2", "needs_answer"],
      ["T1", "needs_recipient"],
    ],
  );
  assert.deepEqual(
    model.finished.map((t) => [t.id, t.status]),
    [["T3", "completed"]],
  );
  const t2 = model.open.find((t) => t.id === "T2");
  assert.ok(t2);
  assert.equal(t2.deliveries[0]?.latest?.text, "Force push?");
  assert.equal(t2.deliveries[0]?.question?.id, "Q2");
  assert.equal(model.log.length, Math.min(20, state.log.length));
});

test("the model names its contract and carries what a template binds to", () => {
  const state = boardState(config, journal, NOW);
  const anonymous = boardModel(state, config, NOW, times);
  assert.equal(anonymous.version, BOARD_VERSION);
  assert.equal(BOARD_VERSION, "jev-router-board/1");
  assert.equal(anonymous.actor, null);
  // The viewer: its login and the role of each principal it may act as.
  const model = boardModel(state, config, NOW, times, viewer("me@example.com"));
  assert.deepEqual(model.actor, {
    login: "me@example.com",
    principals: [
      { principal: "you", role: "requester" },
      { principal: "operator", role: "operator" },
    ],
  });
  // Each placement with the open delivery pinned to its session and the
  // latest update on it. D2, newer on orchestrator@mbp, has ended.
  assert.deepEqual(model.placements, [
    {
      key: "orchestrator@mbp",
      participant: "orchestrator",
      host: "mbp",
      session: "A1",
      ready: true,
      hold: false,
      delivery: {
        id: "D1",
        taskId: "T2",
        excerpt: "Ask me something",
        messageId: "A1m",
        outcome: "accepted",
        question: {
          id: "Q2",
          text: "Force push?",
          at: "2026-09-30T09:31:00.000Z",
        },
        latest: { kind: "question", at: "2026-09-30T09:31:00.000Z" },
      },
      agent: null,
    },
    {
      key: "knowledge@mini",
      participant: "knowledge",
      host: "mini",
      session: "K1",
      ready: false,
      hold: false,
      delivery: {
        id: "D3",
        taskId: "T4",
        excerpt: "Summarize the review pipeline notes",
        messageId: "M4",
        outcome: "accepted",
        question: null,
        latest: { kind: "working", at: "2026-09-30T09:44:00.000Z" },
      },
      agent: null,
    },
    {
      key: "environment@mbp",
      participant: "environment",
      host: "mbp",
      session: "E1",
      ready: true,
      hold: true,
      delivery: null,
      agent: null,
    },
    {
      key: "environment@mini",
      participant: "environment",
      host: "mini",
      session: "E2",
      ready: true,
      hold: false,
      delivery: null,
      agent: null,
    },
  ]);
  // Without telemetry there is no time; with it, each served placement
  // carries its snapshot and the model the time they were taken.
  assert.equal(model.telemetryAt, null);
  const seen = boardModel(state, config, NOW, times, null, telemetry);
  assert.equal(seen.telemetryAt, telemetry.at);
  assert.deepEqual(
    seen.placements.map((p) => [p.key, p.agent?.status, p.agent?.model]),
    [
      ["orchestrator@mbp", "running", "claude-opus-5-5"],
      ["knowledge@mini", "running", "gpt-5.5"],
      ["environment@mbp", "idle", "claude-sonnet-5-5"],
      ["environment@mini", "running", "claude-sonnet-5-5"],
    ],
  );
  // A snapshot for a placement the router does not serve is not shown.
  const environment = telemetry.placements["environment@mbp"];
  assert.ok(environment);
  const extra = boardModel(state, config, NOW, times, null, {
    ...telemetry,
    placements: { "scratch@mbp": environment },
  });
  assert.deepEqual(
    extra.placements.map((p) => p.agent),
    [null, null, null, null],
  );
  const task = (id: string) => {
    const found = [...model.open, ...model.finished].find((t) => t.id === id);
    assert.ok(found, id);
    return found;
  };
  // The deadline, and how the recipient was named.
  assert.deepEqual(
    ["T1", "T2", "T3", "T4"].map((id) => [
      id,
      task(id).chosenBy,
      task(id).deadline,
    ]),
    [
      ["T1", null, "2026-09-30T10:02:00.000Z"],
      ["T2", "address", "2026-09-30T10:10:00.000Z"],
      ["T3", "address", "2026-09-30T10:15:00.000Z"],
      ["T4", "judgment", "2026-09-30T10:40:00.000Z"],
    ],
  );
  // The judgment as recorded: the whole table and the model that decided.
  assert.deepEqual(task("T4").judgments, [
    {
      choice: "knowledge",
      probabilities: {
        orchestrator: 0.03,
        knowledge: 0.94,
        environment: 0.01,
        incus: 0.01,
        none: 0.01,
      },
      model: "jev-1.13.0",
      valid: true,
      threshold: 0.9,
    },
  ]);
  // Each task's own lines in the log, and the time of each message.
  assert.deepEqual(
    task("T4").log.map((entry) => entry.text),
    [
      "T4 recorded for you/M4. The caller may disconnect.",
      "T4: Jev selected knowledge at 0.94.",
    ],
  );
  assert.deepEqual(
    task("T2").log.map((entry) => entry.text),
    [
      "T2 recorded for you/M2. The caller may disconnect.",
      "T2: answer A1m queued for the pinned session A1.",
    ],
  );
  assert.equal(model.times.Q2, "2026-09-30T09:31:00.000Z");
});

test("a placement's delivery tells an open question from an answered one", () => {
  // After T2's first answer the question is still the latest update, the
  // current send is the answer, and no question is open.
  const times = messageTimes(answeredJournal);
  const model = boardModel(
    boardState(config, answeredJournal, NOW),
    config,
    NOW,
    times,
  );
  assert.deepEqual(
    model.placements.find((p) => p.key === "orchestrator@mbp")?.delivery,
    {
      id: "D1",
      taskId: "T2",
      excerpt: "Ask me something",
      messageId: "A1m",
      outcome: "accepted",
      question: null,
      latest: { kind: "question", at: "2026-09-30T09:14:00.000Z" },
    },
  );
  assert.equal(model.needsYou.flatMap((g) => g.items).length, 1);
});

test("a task a participant sent names the placement it hears back at and what it was told", () => {
  const m = boardModel(
    boardState(config, viaJournal, NOW),
    config,
    NOW,
    messageTimes(viaJournal),
  );
  const t5 = m.open.find((t) => t.id === "T5");
  assert.equal(t5?.source, "orchestrator/M5");
  assert.equal(t5?.via, "orchestrator@mbp");
  assert.deepEqual(t5?.notices, [
    {
      key: "question/D4/Q5",
      kind: "question",
      session: "A1",
      outcome: "accepted",
    },
  ]);
  // A person's requests carry neither.
  for (const t of m.open.filter((t) => t.id !== "T5"))
    assert.deepEqual([t.via, t.notices], [null, []], t.id);
  // The sender's open question is its own to answer, not the requester's.
  assert.ok(!m.needsYou.flatMap((g) => g.items).some((i) => i.taskId === "T5"));
});

test("a placement shows its newest open delivery, even for an older task", () => {
  // T1 waited for a recipient. Sent to orchestrator now, its D4 is the
  // newest delivery on session A1, where T2's D1 is still open.
  const at = "2026-09-30T09:44:30.000Z";
  const late: Entry[] = [
    { at, event: { type: "tick", now: Date.parse(at) } },
    {
      at,
      event: { type: "choose", by: "you", taskId: "T1", to: "orchestrator" },
    },
    { at, event: { type: "attempt", deliveryId: "D4" } },
    {
      at,
      event: {
        type: "adapterResult",
        deliveryId: "D4",
        messageId: "M1",
        outcome: "accepted",
      },
    },
  ];
  const model = boardModel(
    boardState(config, [...journal, ...late], NOW),
    config,
    NOW,
    times,
  );
  const t2 = model.open.find((t) => t.id === "T2");
  assert.equal(t2?.deliveries[0]?.end, null);
  assert.deepEqual(
    model.placements.find((p) => p.key === "orchestrator@mbp")?.delivery,
    {
      id: "D4",
      taskId: "T1",
      excerpt: "Fix <b>the</b> build",
      messageId: "M1",
      outcome: "accepted",
      question: null,
      latest: null,
    },
  );
  // Before the adapter answers, the pinned delivery carries the send as it
  // stands.
  const attempting = boardModel(
    boardState(config, [...journal, ...late.slice(0, -1)], NOW),
    config,
    NOW,
    times,
  );
  assert.equal(
    attempting.placements.find((p) => p.key === "orchestrator@mbp")?.delivery
      ?.outcome,
    "attempting",
  );
});

const submitted = (messageId: string, to: string, hosts?: string[]): Event => ({
  type: "submit",
  by: "you",
  messageId,
  text: `Job ${messageId}`,
  to,
  ...(hosts ? { hosts } : {}),
});

test("a waiting delivery says why; a queued one names the head of its queue", () => {
  const entries = extend(
    // environment@mbp is held; knowledge@mini is busy with T4.
    submitted("M5", "environment", ["mbp"]),
    submitted("M6", "knowledge"),
    // orchestrator@mbp is idle: D6 goes next, D7 and D8 queue behind it.
    submitted("M7", "orchestrator"),
    submitted("M8", "orchestrator"),
    submitted("M9", "orchestrator"),
  );
  const model = boardModel(boardState(config, entries, NOW), config, NOW);
  const waits = (taskId: string) =>
    model.open.find((t) => t.id === taskId)?.deliveries[0]?.waits;
  assert.deepEqual(
    ["T5", "T6", "T7", "T8", "T9"].map((id) => [id, waits(id)]),
    [
      ["T5", { reason: "held", behind: null }],
      ["T6", { reason: "not_ready", behind: null }],
      ["T7", null],
      ["T8", { reason: "queued_behind", behind: "D6" }],
      // Behind the head of the queue, not the delivery just before it.
      ["T9", { reason: "queued_behind", behind: "D6" }],
    ],
  );
  // Sent, answered or ended deliveries do not wait.
  assert.deepEqual(
    [...model.open, ...model.finished]
      .filter((t) => ["T2", "T3", "T4"].includes(t.id))
      .map((t) => t.deliveries[0]?.waits),
    [null, null, null],
  );
});

test("a canceled task names who canceled it; other ends name nobody", () => {
  const entries = extend(submitted("M5", "environment", ["mbp"]), {
    type: "cancel",
    by: "you",
    taskId: "T5",
  });
  const model = boardModel(boardState(config, entries, NOW), config, NOW);
  assert.deepEqual(model.finished.find((t) => t.id === "T5")?.final, {
    status: "canceled",
    reason: "sender",
    completed: 0,
    of: 1,
    by: "you",
  });
  assert.equal(model.finished.find((t) => t.id === "T3")?.final?.by, null);
  const later = boardModel(boardState(config, journal, LATER), config, LATER);
  assert.equal(later.finished.find((t) => t.id === "T1")?.final?.by, null);
});

test("a task's log holds its own id, not a longer one that starts the same", () => {
  const log = [
    { n: 1, actor: "Router", text: "T1 recorded for you/M1." },
    { n: 2, actor: "Router", text: "T12 recorded for you/M12." },
    { n: 3, actor: "Jev", text: "T1: no confident owner." },
  ];
  assert.deepEqual(
    taskLog(log, "T1").map((entry) => entry.n),
    [1, 3],
  );
});

test("a deadline that passed shows as passed without any write", () => {
  const model = boardModel(boardState(config, journal, LATER), config, LATER);
  assert.deepEqual(model.open, []);
  assert.equal(
    model.finished.find((t) => t.id === "T1")?.final?.reason,
    "deadline",
  );
});

test("the committed sample is what the generator writes from the fixture", () => {
  assert.equal(
    readFileSync(SAMPLE_PATH, "utf8"),
    boardSample(),
    "src/board.sample.json is stale: run `pnpm exec node src/board-sample.ts` in router/.",
  );
});

test("the sample holds a participant-sent task with a notice in each state the design binds", () => {
  const model = sampleModel();
  const sent = [...model.open, ...model.finished].filter((t) => t.via);
  assert.deepEqual(
    sent.map((t) => [
      t.id,
      t.via,
      t.judgments.map((j) => j.valid),
      t.notices.map((n) => [n.key, n.session, n.outcome]),
    ]),
    [
      [
        "T5",
        "orchestrator@mbp",
        [true],
        [
          ["choose/1", null, "withdrawn"],
          ["question/D4/Q5", "A1", "accepted"],
          ["final", null, "pending"],
        ],
      ],
    ],
  );
});

test("the sample holds a snapshot per placement in the states the design binds", () => {
  const model = sampleModel();
  assert.equal(model.telemetryAt, telemetry.at);
  assert.deepEqual(
    model.placements.map((p) => [
      p.key,
      p.agent?.status,
      p.agent?.turnStartedAt !== null,
      p.agent?.permissions.map((q) => q.name),
      p.agent?.attention,
    ]),
    [
      ["orchestrator@mbp", "running", true, [], null],
      ["knowledge@mini", "running", true, ["Bash"], "permission"],
      ["environment@mbp", "idle", false, [], "finished"],
      ["environment@mini", "running", true, [], null],
    ],
  );
});

test("the sample's sheet holds the states the design binds: a dirty worktree with a failing pull request and a tail ending in a running call; open subagents, one nested; a checkout alone", () => {
  const agents = Object.fromEntries(
    sampleModel().placements.map((p) => [p.key, p.agent]),
  );
  const o = agents["orchestrator@mbp"];
  assert.equal(o?.checkout?.kind, "worktree");
  assert.equal(o?.checkout?.dirty, true);
  assert.ok(o?.checkout?.diff && o.checkout.diff.additions > 0);
  assert.equal(o?.checkout?.pr?.state, "OPEN");
  assert.equal(o?.checkout?.pr?.checks, "failure");
  assert.deepEqual(o?.subagents?.running, []);
  assert.ok(o?.subagents && o.subagents.counts.completed > 0);
  assert.deepEqual(o?.activity?.items.at(-1)?.status, "running");
  assert.equal(o?.activity?.items.at(-1)?.tool, "Bash");
  const k = agents["knowledge@mini"];
  assert.equal(k?.checkout?.pr, null);
  assert.equal(k?.subagents?.counts.running, 2);
  assert.deepEqual(
    k?.subagents?.running.map((r) => r.parent !== null),
    [false, true],
  );
  assert.equal(k?.subagents?.running[1]?.parent, k?.subagents?.running[0]?.id);
  assert.equal(k?.activity?.items.at(-1)?.status, "running");
  const e = agents["environment@mbp"];
  assert.equal(e?.checkout?.kind, "directory");
  assert.equal(e?.subagents, null);
  assert.equal(e?.activity, null);
});

test("the sample holds what v0.12 binds: a session mid-turn with no delivery, a request with no reply past 30 minutes, a window past 80% and a remote as a web address", () => {
  const model = sampleModel();
  const placement = (key: string) => {
    const found = model.placements.find((p) => p.key === key);
    assert.ok(found, key);
    return found;
  };
  const busy = placement("environment@mini");
  assert.deepEqual(
    [busy.delivery, busy.hold, busy.agent?.status],
    [null, false, "running"],
  );
  // T1 waited for a recipient; once chosen, its delivery has no reply, 43
  // minutes after the request.
  const d = model.open.find((t) => t.id === "T1")?.deliveries[0];
  assert.ok(d);
  assert.deepEqual([d.latest, d.end], [null, null]);
  assert.equal(
    Date.parse(model.at) - Date.parse(model.times[d.send.messageId] ?? ""),
    43 * 60_000,
  );
  const context = placement("environment@mbp").agent?.context;
  assert.ok(context && context.used / context.max >= 0.8);
  assert.match(
    placement("orchestrator@mbp").agent?.checkout?.remote ?? "",
    /^https:\/\//,
  );
  // A choice still waits on you.
  assert.deepEqual(
    model.needsYou
      .find((n) => n.principal === "you")
      ?.items.map((it) => [it.kind, it.taskId]),
    [
      ["answer", "T2"],
      ["choose", "T6"],
    ],
  );
});

test("the sample holds usage in the states the usage section and pop-up bind: a current subscription with history, a stale one kept after a failed refresh, a balance, and a key without management data", () => {
  const usage = sampleModel().usage;
  assert.ok(usage);
  assert.equal(usage.every, 120);
  assert.equal(usage.at, "2026-09-30T09:44:30.000Z");
  assert.deepEqual(
    usage.accounts.map((a) => [a.id, a.kind, a.status]),
    [
      ["codex", "subscription", "ready"],
      ["claude", "subscription", "stale"],
      ["deepseek", "api", "ready"],
      ["openrouter", "api", "ready"],
    ],
  );
  const [codex, claude, , openrouter] = usage.accounts;
  // Codex: windows with lengths and resets, a zero kept as zero, and a
  // daily history with a gap.
  assert.deepEqual(
    codex?.reading?.windows.map((w) => [w.usedPercent, w.minutes]),
    [
      [41, 300],
      [78, 10080],
    ],
  );
  assert.deepEqual(codex?.reading?.details[0]?.status, "ready");
  // Claude: the last reading and its time are kept beside the error; a
  // window past 90%, one at zero, and one whose reset has passed since.
  assert.ok(claude?.error && claude.reading);
  assert.equal(claude.reading.observedAt, "2026-09-30T09:31:30.000Z");
  assert.deepEqual(
    claude.reading.windows.map((w) => w.usedPercent),
    [92, 64, 0, 12],
  );
  assert.ok(
    Date.parse(claude.reading.windows[3]?.resetsAt ?? "") <
      Date.parse(usage.at ?? ""),
  );
  // OpenRouter without a management key: the key's figures and a notice,
  // and the account balance named as not read.
  assert.match(openrouter?.reading?.notice ?? "", /management key/);
  assert.deepEqual(openrouter?.reading?.metrics[0], {
    label: "Account balance",
    value: "No management key",
    unit: null,
  });
});

test("messageTimes maps submit, update and answer ids to their journal time", () => {
  assert.deepEqual(
    messageTimes(journal),
    Object.fromEntries(
      [
        ["M1", "09:02"],
        ["M2", "09:10"],
        ["Q1", "09:14"],
        ["M3", "09:15"],
        ["A1m", "09:16"],
        ["W1", "09:20"],
        ["Q2", "09:31"],
        ["C1", "09:38"],
        ["M4", "09:40"],
        ["W2", "09:44"],
      ].map(([id, clock]) => [id, `2026-09-30T${clock}:00.000Z`]),
    ),
  );
});

const roles = { you: "requester", operator: "operator" } as const;

test("identify: Serve's login header, mapped to principals, or nothing", () => {
  assert.equal(identify({}, identities), null);
  assert.equal(
    identify({ "tailscale-user-login": "nobody@example.com" }, identities),
    null,
  );
  assert.equal(
    identify({ "tailscale-user-login": "me@example.com" }, {}),
    null,
  );
  // A login every object answers to is mapped to nothing.
  for (const login of [
    "constructor",
    "toString",
    "__proto__",
    "hasOwnProperty",
  ])
    assert.equal(
      identify({ "tailscale-user-login": login }, identities),
      null,
      login,
    );
  assert.deepEqual(
    identify({ "tailscale-user-login": "me@example.com" }, identities),
    {
      login: "me@example.com",
      principals: ["you", "operator"],
    },
  );
});

test("actionEvent: each form becomes its event, signed by the principal the role needs", () => {
  const me = { login: "me@example.com", principals: ["you", "operator"] };
  const guest = { login: "guest@example.com", principals: ["you"] };
  const of = (body: string, actor = me) =>
    actionEvent(new URLSearchParams(body), actor, roles);
  assert.deepEqual(of("action=choose&task=T1&to=knowledge"), {
    ok: true,
    event: { type: "choose", by: "you", taskId: "T1", to: "knowledge" },
  });
  const answer = of("action=answer&task=T2&question=Q2&text=main+please");
  assert.ok(answer.ok && answer.event.type === "answer");
  if (answer.ok && answer.event.type === "answer") {
    assert.equal(answer.event.text, "main please");
    assert.equal(answer.event.by, "you");
    assert.equal(answer.event.deliveryId, null);
    assert.match(answer.event.messageId, /^m-/);
  }
  assert.deepEqual(of("action=cancel&task=T1"), {
    ok: true,
    event: { type: "cancel", by: "you", taskId: "T1" },
  });
  assert.deepEqual(
    of(
      "action=resolve&delivery=D1&message=M1&outcome=finished&evidence=saw+it",
    ),
    {
      ok: true,
      event: {
        type: "resolve",
        by: "operator",
        deliveryId: "D1",
        messageId: "M1",
        outcome: "finished",
        evidence: "saw it",
      },
    },
  );
  assert.deepEqual(of("action=hold&placement=orchestrator%40mbp&hold=1"), {
    ok: true,
    event: { type: "observe", placement: "orchestrator@mbp", hold: true },
  });
  // A hold needs no role: a requester-only login may set one.
  assert.deepEqual(
    of("action=hold&placement=orchestrator%40mbp&hold=1", guest),
    {
      ok: true,
      event: { type: "observe", placement: "orchestrator@mbp", hold: true },
    },
  );
  assert.deepEqual(of("action=hold&placement=orchestrator%40mbp&hold=0"), {
    ok: true,
    event: { type: "observe", placement: "orchestrator@mbp", hold: false },
  });
  // Refusals: no principal in the needed role, missing fields, bad values.
  assert.deepEqual(
    of(
      "action=resolve&delivery=D1&message=M1&outcome=finished&evidence=x",
      guest,
    ),
    {
      ok: false,
      message: "guest@example.com has no operator principal.",
    },
  );
  assert.deepEqual(of("action=choose&task=T1"), {
    ok: false,
    message: "Missing to.",
  });
  assert.deepEqual(of("action=answer&task=T2&question=Q2&text=+"), {
    ok: false,
    message: "Missing text.",
  });
  assert.deepEqual(
    of("action=resolve&delivery=D1&message=M1&outcome=maybe&evidence=x"),
    {
      ok: false,
      message: "Outcome is finished or not_sent.",
    },
  );
  assert.deepEqual(of("action=submit&text=hi"), {
    ok: false,
    message: 'Unknown action "submit".',
  });
});
