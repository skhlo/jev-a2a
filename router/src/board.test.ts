// The board reads the record without touching it: a lock-free journal read,
// a pure model, and an HTML rendering that cannot inject task text.
import test from "node:test";
import assert from "node:assert/strict";
import { mkdtempSync, writeFileSync, readFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import {
  actionEvent,
  boardModel,
  boardState,
  describeNeed,
  identify,
  messageTimes,
  renderBoard,
} from "./board.ts";
import { readJournal, type Entry } from "./journal.ts";
import type { RouterConfig } from "./config.ts";
import type { Event } from "./types.ts";
import base from "./example-config.ts";

const config: RouterConfig = {
  ...base,
  home: "/nowhere",
  hosts: { mbp: { paseo: "ws://x", replyCommand: "router" } },
  agents: { "orchestrator@mbp": "A1" },
  serve: { listen: "127.0.0.1:0", board: "127.0.0.1:0", identities: {} },
  jev: { model: "jev-latest" },
};

const entries = (events: Event[]): Entry[] =>
  events.map((event) => ({ at: "2026-09-30T00:00:00Z", event }));

// One task of each kind a person needs to see: waiting for a recipient,
// asking a question, and finished with a result.
const journal = entries([
  { type: "tick", now: 1 },
  {
    type: "observe",
    placement: "orchestrator@mbp",
    ready: true,
    session: "A1",
  },
  { type: "submit", by: "you", messageId: "M1", text: "Fix <b>the</b> build" },
  {
    type: "judged",
    taskId: "T1",
    choice: "orchestrator",
    probabilities: {
      orchestrator: 0.6,
      knowledge: 0.2,
      environment: 0.1,
      incus: 0.1,
      none: 0,
    },
  },
  {
    type: "submit",
    by: "you",
    messageId: "M2",
    text: "Ask me something",
    to: "orchestrator",
  },
  { type: "attempt", deliveryId: "D1" },
  {
    type: "adapterResult",
    deliveryId: "D1",
    messageId: "M2",
    outcome: "accepted",
  },
  {
    type: "update",
    by: "A1",
    taskId: "T2",
    messageId: "Q1",
    inReplyTo: "M2",
    kind: "question",
    text: "Which branch?",
  },
  {
    type: "submit",
    by: "you",
    messageId: "M3",
    text: "Done quickly",
    to: "orchestrator",
  },
  {
    type: "answer",
    by: "you",
    taskId: "T2",
    messageId: "A1m",
    questionId: "Q1",
    text: "main",
  },
  { type: "observe", placement: "orchestrator@mbp", ready: true },
  { type: "attempt", deliveryId: "D1" },
  {
    type: "adapterResult",
    deliveryId: "D1",
    messageId: "A1m",
    outcome: "accepted",
  },
  {
    type: "update",
    by: "A1",
    taskId: "T2",
    messageId: "W1",
    inReplyTo: "A1m",
    kind: "working",
    text: "on it",
  },
  {
    type: "update",
    by: "A1",
    taskId: "T2",
    messageId: "Q2",
    inReplyTo: "A1m",
    kind: "question",
    text: "Force push?",
  },
  { type: "observe", placement: "orchestrator@mbp", ready: true },
  { type: "attempt", deliveryId: "D2" },
  {
    type: "adapterResult",
    deliveryId: "D2",
    messageId: "M3",
    outcome: "accepted",
  },
  {
    type: "update",
    by: "A1",
    taskId: "T3",
    messageId: "C1",
    inReplyTo: "M3",
    kind: "completed",
    text: "all green",
  },
]);

test("the fixture is a journal: every event was accepted", () => {
  assert.doesNotThrow(() => boardState(config, journal, 50));
  assert.throws(
    () =>
      boardState(
        config,
        [
          ...journal,
          ...entries([
            { type: "choose", by: "you", taskId: "T9", to: "knowledge" },
          ]),
        ],
        50,
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
  const state = boardState(config, journal, 50);
  const model = boardModel(state, config, 50);
  assert.equal(model.at, new Date(50).toISOString());
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
  assert.deepEqual(model.placements, [
    { key: "orchestrator@mbp", ready: false, hold: false, session: "A1" },
  ]);
  assert.deepEqual(
    model.open.map((t) => [t.id, t.status]),
    [
      ["T2", "needs_answer"],
      ["T1", "needs_recipient"],
    ],
  );
  assert.deepEqual(
    model.finished.map((t) => [t.id, t.status]),
    [["T3", "completed"]],
  );
  const t2 = model.open[0];
  assert.ok(t2);
  assert.equal(t2.deliveries[0]?.latest?.text, "Force push?");
  assert.equal(t2.deliveries[0]?.question?.id, "Q2");
  assert.equal(model.log.length, Math.min(20, state.log.length));
});

test("a deadline that passed shows as passed without any write", () => {
  const model = boardModel(boardState(config, journal, 500), config, 500);
  assert.deepEqual(model.open, []);
  assert.equal(
    model.finished.find((t) => t.id === "T1")?.final?.reason,
    "deadline",
  );
});

test("the page escapes task text and leads with what waits on you", () => {
  const model = boardModel(boardState(config, journal, 50), config, 50, {
    M1: "1970-01-01T09:15:00.000Z",
  });
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
      '<span class="dot busy"></span>orchestrator@mbp <span class="muted">busy or away</span>',
    ),
  );
  assert.ok(
    html.includes("you, M1, 09:15</span>Fix &lt;b&gt;the&lt;/b&gt; build"),
  );
  assert.ok(html.includes("orchestrator@mbp, question</span>Force push?"));
  assert.ok(html.includes("orchestrator@mbp, completed</span>all green"));
  assert.ok(html.includes('<span class="time">09:15</span>'));
  // Open threads are expanded, and so is the latest one even if finished;
  // an older finished thread is collapsed to its strip.
  assert.match(html, /id="t-T2" open/);
  assert.match(html, /id="t-T3" open/);
  const older = renderBoard(
    boardModel(boardState(config, journal, 500), config, 500),
  );
  assert.match(older, /id="t-T1"(?! open)/);
  assert.match(older, /id="t-T3" open/);
  assert.ok(older.includes('<h1 class="">Nothing waits on you.</h1>'));
});

test("messageTimes maps submit, update and answer ids to their journal time", () => {
  assert.deepEqual(
    messageTimes(journal),
    Object.fromEntries(
      ["M1", "M2", "Q1", "M3", "A1m", "W1", "Q2", "C1"].map((id) => [
        id,
        "2026-09-30T00:00:00Z",
      ]),
    ),
  );
});

const identities = {
  "me@example.com": ["you", "operator"],
  "guest@example.com": ["you"],
};
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
  const model = boardModel(boardState(config, journal, 50), config, 50);
  const anonymous = renderBoard(model);
  assert.ok(!anonymous.includes("<form"));
  assert.ok(anonymous.includes("Read only"));
  const mine = renderBoard(model, {
    actor: { login: "me@example.com", principals: ["you", "operator"] },
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
  const guest = renderBoard(model, {
    actor: { login: "guest@example.com", principals: ["you"] },
  });
  assert.ok(guest.includes('value="choose"'));
  assert.ok(!guest.includes('value="resolve"'));
});
