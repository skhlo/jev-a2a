// The board reads the record without touching it: a lock-free journal read,
// a pure model, and an HTML rendering that cannot inject task text.
import test from "node:test";
import assert from "node:assert/strict";
import { mkdtempSync, writeFileSync, readFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import {
  actionEvent,
  BOARD_VERSION,
  boardModel,
  boardState,
  describeNeed,
  identify,
  messageTimes,
  renderBoard,
  taskLog,
} from "./board.ts";
import { config, journal, NOW } from "./board-fixture.ts";
import { boardSample, SAMPLE_PATH } from "./board-sample.ts";
import { readJournal, type Entry } from "./journal.ts";
import type { Event } from "./types.ts";

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

test("readJournal skips a line still being written", () => {
  const home = mkdtempSync(join(tmpdir(), "board-"));
  const path = join(home, "journal.jsonl");
  const line = JSON.stringify({ at: "t", event: { type: "tick", now: 1 } });
  writeFileSync(path, `${line}\n${line}\n${line.slice(0, 10)}`);
  assert.equal(readJournal(home).length, 2);
  writeFileSync(path, `${line}\n${line}\n${line}\n`);
  assert.equal(readJournal(home).length, 3);
  assert.deepEqual(readJournal(mkdtempSync(join(tmpdir(), "board-"))), []);
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
    'T2: answer Q2 "Force push?"',
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
        latest: { kind: "question", at: "2026-09-30T09:31:00.000Z" },
      },
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
        latest: { kind: "working", at: "2026-09-30T09:44:00.000Z" },
      },
    },
    {
      key: "environment@mbp",
      participant: "environment",
      host: "mbp",
      session: "E1",
      ready: true,
      hold: true,
      delivery: null,
    },
  ]);
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
      latest: null,
    },
  );
});

// The fixture's journal with one more shell run after its last event and
// before the board is read.
const extended = (...events: Event[]): Entry[] => {
  const at = "2026-09-30T09:44:30.000Z";
  return [
    ...journal,
    { at, event: { type: "tick", now: Date.parse(at) } },
    ...events.map((event) => ({ at, event })),
  ];
};
const submitted = (messageId: string, to: string, hosts?: string[]): Event => ({
  type: "submit",
  by: "you",
  messageId,
  text: `Job ${messageId}`,
  to,
  ...(hosts ? { hosts } : {}),
});

test("a waiting delivery says why; a queued one names the head of its queue", () => {
  const entries = extended(
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
  const entries = extended(submitted("M5", "environment", ["mbp"]), {
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

test("the page escapes task text and leads with what waits on you", () => {
  const model = boardModel(
    boardState(config, journal, NOW),
    config,
    NOW,
    times,
  );
  const html = renderBoard(model, { refreshSeconds: 7 });
  assert.ok(html.includes("Fix &lt;b&gt;the&lt;/b&gt; build"));
  assert.ok(!html.includes("<b>the</b>"));
  assert.ok(html.includes('data-refresh="7"'));
  // The headline counts both items; each strip says what and why.
  assert.ok(html.includes('<h1 class="attn">Two things wait on you.</h1>'));
  assert.ok(html.includes("<strong>needs a recipient</strong>"));
  assert.ok(html.includes("Jev was not sure enough to send it."));
  assert.ok(html.includes("<strong>asks you</strong>"));
  assert.ok(html.includes('<div class="quote">Force push?</div>'));
  // Without a viewer, the strips carry the command instead of buttons.
  assert.ok(html.includes("router answer --task T2 --question Q2 --text"));
  assert.ok(html.includes("router choose --task T1 --to orchestrator"));
  // The rail and the transcript.
  assert.ok(
    html.includes(
      '<span class="dot busy"></span>knowledge@mini <span class="muted">busy or away</span>',
    ),
  );
  assert.ok(
    html.includes(
      '<span class="dot held"></span>environment@mbp <span class="muted">held</span>',
    ),
  );
  assert.ok(
    html.includes(
      'title="message M1"><span class="who">you, 09:02</span>Fix &lt;b&gt;the&lt;/b&gt; build',
    ),
  );
  // A single delivery is named by its placement alone; ids stay in tooltips.
  assert.ok(!html.includes("(D1)"));
  assert.ok(
    html.includes("orchestrator@mbp, question, 09:31</span>Force push?"),
  );
  assert.ok(
    html.includes("orchestrator@mbp, completed, 09:38</span>all green"),
  );
  assert.ok(html.includes('<span class="time">09:02</span>'));
  // Jev's pick sits on the strip, and in full inside the thread.
  assert.ok(
    html.includes(
      'no recipient yet<span class="muted">, Jev orchestrator 0.60</span>',
    ),
  );
  assert.ok(
    html.includes("Jev picked orchestrator at 0.60, runner-up knowledge 0.20"),
  );
  assert.ok(!html.includes('id="w-jev"'));
  // Open threads are expanded, and so is the latest one even if finished;
  // an older finished thread is collapsed to its strip.
  assert.match(html, /id="t-T2" open/);
  assert.match(html, /id="t-T3"(?! open)/);
  const older = renderBoard(
    boardModel(boardState(config, journal, LATER), config, LATER),
  );
  assert.match(older, /id="t-T1"(?! open)/);
  assert.match(older, /id="t-T4" open/);
  assert.ok(older.includes('<h1 class="">Nothing waits on you.</h1>'));
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

test("controls appear only for a recognised viewer; the notice is escaped", () => {
  const state = boardState(config, journal, NOW);
  const model = (login: string | null) =>
    boardModel(state, config, NOW, times, login ? viewer(login) : null);
  const anonymous = renderBoard(model(null));
  assert.ok(!anonymous.includes("<form"));
  assert.ok(anonymous.includes("Read only"));
  const mine = renderBoard(model("me@example.com"), {
    notice: "<script>x</script> done",
  });
  assert.ok(mine.includes("Acting as me@example.com"));
  assert.ok(mine.includes("<span>&lt;script&gt;x&lt;/script&gt; done</span>"));
  assert.ok(
    mine.includes(
      '<input type="hidden" name="action" value="choose"><input type="hidden" name="task" value="T1"><button name="to" value="orchestrator">Send to orchestrator</button>',
    ),
  );
  assert.ok(
    mine.includes(
      '<input type="hidden" name="action" value="answer"><input type="hidden" name="task" value="T2"><input type="hidden" name="question" value="Q2">',
    ),
  );
  assert.ok(mine.includes("<button>Send answer</button>"));
  assert.ok(mine.includes('<button class="danger">Cancel T2</button>'));
  assert.ok(mine.includes('onsubmit="return confirm(&quot;Cancel T2?'));
  assert.ok(
    mine.includes(
      '<input type="hidden" name="action" value="hold"><input type="hidden" name="placement" value="orchestrator@mbp"><input type="hidden" name="hold" value="1"><button class="quiet">Hold</button>',
    ),
  );
  assert.ok(!mine.includes("router choose --task T1"));
  // No form sits inside a summary, which would also toggle it.
  for (const m of mine.matchAll(/<summary>([^]*?)<\/summary>/g))
    assert.ok(!m[1]?.includes("<form"), m[1] ?? "");
  // A requester-only viewer gets no resolve controls.
  const guest = renderBoard(model("guest@example.com"));
  assert.ok(guest.includes('value="choose"'));
  assert.ok(!guest.includes('value="resolve"'));
});
