// The board page: the v0.9 design drawn from the view model and the viewer,
// a pure function of both. The tests read what a viewer or the design agent
// reads: text, data-paths, and the forms with their fields.
import test from "node:test";
import assert from "node:assert/strict";
import { readFileSync } from "node:fs";
import { join } from "node:path";
import {
  actionEvent,
  boardModel,
  boardState,
  identify,
  messageTimes,
  type BoardModel,
} from "./board.ts";
import {
  age,
  count,
  label,
  left,
  renderBoard,
  time,
  type RenderOptions,
} from "./board-page.ts";
import {
  answeredJournal,
  attemptingJournal,
  config,
  deliveredJournal,
  extend,
  journal,
  NOW,
  replacedJournal,
  sampleJournal,
  telemetry,
  viaJournal,
} from "./board-fixture.ts";
import { dataPaths } from "./design-paths.ts";
import type { Entry } from "./journal.ts";
import { emptySnapshot } from "./telemetry.ts";
import type { Role } from "./types.ts";

// Past every deadline in the fixture.
const LATER = NOW + 3 * 60 * 60_000;
const AT = new Date(NOW).toISOString();
const ME = "me@example.com";
const GUEST = "guest@example.com";

// The model of `entries` at `now` as `login` sees it; null is nobody.
const model = (
  login: string | null,
  entries: Entry[] = journal,
  now = NOW,
): BoardModel =>
  boardModel(
    boardState(config, entries, now),
    config,
    now,
    messageTimes(entries),
    login
      ? identify({ "tailscale-user-login": login }, config.serve.identities)
      : null,
  );
const page = (
  login: string | null,
  options: RenderOptions = {},
  entries: Entry[] = journal,
  now = NOW,
): string => renderBoard(model(login, entries, now), options);

const strip = (html: string): string => html.replace(/<[^>]+>/g, "");
const escape = (text: string): string =>
  text.replace(/[.*+?^${}()|[\]\\]/g, "\\$&");
// The text of each element that reads `path`.
const textsOf = (html: string, path: string, tag = "span"): string[] =>
  [
    ...html.matchAll(
      new RegExp(
        `<${tag}\\b[^>]*data-path="${escape(path)}"[^>]*>([^]*?)</${tag}>`,
        "g",
      ),
    ),
  ].map((m) => strip(m[1] ?? ""));
const textOf = (html: string, path: string, tag = "span"): string | undefined =>
  textsOf(html, path, tag)[0];
// The task ids in each group of the task column.
const groups = (html: string): Record<string, string[]> => {
  const column = html.slice(
    html.indexOf('class="panel tasks"'),
    html.indexOf('class="panel detail"'),
  );
  return Object.fromEntries(
    column
      .split('<div class="group')
      .slice(1)
      .map((chunk) => [
        chunk.match(/data-group="([^"]+)"/)?.[1] ?? "",
        [
          ...chunk.matchAll(
            /<div class="task [^"]*"[^>]* data-task="([^"]+)"/g,
          ),
        ].map((m) => m[1] ?? ""),
      ]),
  );
};
const detailOf = (html: string): string =>
  html.slice(html.indexOf('class="panel detail"'), html.indexOf("</main>"));
const selectedOf = (html: string): string | undefined =>
  detailOf(html).match(/data-task="([^"]+)"/)?.[1];

// Each form: its attributes, its fields, and the buttons that submit it.
type Form = {
  attrs: string;
  fields: Record<string, string>;
  buttons: [string, string][];
  inputs: string[];
};
const formsIn = (html: string): Form[] =>
  [...html.matchAll(/<form([^>]*)>([^]*?)<\/form>/g)].map((m) => {
    const body = m[2] ?? "";
    return {
      attrs: m[1] ?? "",
      fields: Object.fromEntries(
        [
          ...body.matchAll(
            /<input type="hidden" name="([^"]+)" value="([^"]*)">/g,
          ),
        ].map((f) => [f[1], f[2]]),
      ),
      buttons: [...body.matchAll(/<button(?![^>]*\sform=)[^>]*>/g)].map(
        (b): [string, string] => [
          b[0].match(/name="([^"]+)"/)?.[1] ?? "",
          b[0].match(/value="([^"]*)"/)?.[1] ?? "",
        ],
      ),
      inputs: [
        ...body.matchAll(
          /<(?:textarea|input(?! type="hidden"))[^>]*name="([^"]+)"/g,
        ),
      ].map((f) => f[1] ?? ""),
    };
  });
const formFor = (html: string, action: string, field = "", value = "") =>
  formsIn(html).find(
    (f) => f.fields.action === action && (!field || f.fields[field] === value),
  );

test("the formats: clocks, ages, countdowns, counts and labels as the design fixed them", () => {
  const ago = (seconds: number) =>
    age(new Date(NOW - seconds * 1000).toISOString(), AT);
  const until = (seconds: number) =>
    left(new Date(NOW + seconds * 1000).toISOString(), AT);
  assert.equal(time(AT), "09:45Z");
  assert.equal(time("2026-09-30T23:05:59.999Z"), "23:05Z");
  assert.equal(time(null), "—");
  assert.equal(time(undefined), "—");
  assert.deepEqual(
    [0, 45, 60, 14 * 60, 3599, 3600, 7500, 7259, 86399, 86400, 194400].map(ago),
    [
      "0s",
      "45s",
      "1m",
      "14m",
      "59m",
      "1h",
      "2h 05m",
      "2h",
      "23h 59m",
      "1d",
      "2d",
    ],
  );
  // A time after `at` shows its distance; no time shows a dash.
  assert.equal(ago(-90), "1m");
  assert.equal(age(null, AT), "—");
  assert.deepEqual([25 * 60, 65 * 60, 0, -30, -2 * 86400].map(until), [
    "25m left",
    "1h 05m left",
    "0s left",
    "overdue 30s",
    "overdue 2d",
  ]);
  // Nouns read right for one and for many; the design printed "1 agents".
  assert.deepEqual(
    [
      count(1, "agent"),
      count(3, "agent"),
      count(0, "line"),
      count(1, "delivery", "deliveries"),
      count(2, "delivery", "deliveries"),
    ],
    ["1 agent", "3 agents", "0 lines", "1 delivery", "2 deliveries"],
  );
  assert.deepEqual(
    ["needs_recipient", "low_confidence", "routing_unavailable", "working"].map(
      label,
    ),
    ["needs recipient", "low confidence", "routing unavailable", "working"],
  );
});

test("every data-path of the v0.9 design is rendered for the fixture or dropped with a reason", () => {
  const lines = (name: string): string[] =>
    readFileSync(join(import.meta.dirname, "..", "design", name), "utf8")
      .split("\n")
      .filter((line) => line && !line.startsWith("#"));
  const listed = lines("v0.9-paths.txt");
  // The committed list is the extraction's output: distinct and sorted.
  assert.ok(listed.length > 100);
  assert.deepEqual(listed, [...new Set(listed)].sort());
  // The design's sample is synthetic and larger than the fixture, so paths
  // compare without their indexes: open[].deliveries[].latest.
  const shape = (path: string): string => path.replaceAll(/\[\d+\]/g, "[]");
  const design = [...new Set(listed.map(shape))].sort();
  const dropped = new Map(
    lines("v0.9-dropped.txt").map((line): [string, string] => {
      const at = line.lastIndexOf(" | ");
      return at < 0 ? [line, ""] : [line.slice(0, at), line.slice(at + 3)];
    }),
  );
  // The design's pages select an answer, a long working task, a choice, a
  // resolve and a task another agent sent; render each task of the fixture,
  // the record with the replaced session for the resolve form, the record
  // before T4's first reply, and the sample's record with T5.
  const records = [
    journal,
    replacedJournal,
    deliveredJournal,
    answeredJournal,
    attemptingJournal,
    sampleJournal,
  ].map((entries) => model(ME, entries));
  const rendered = new Set(
    ["T1", "T2", "T3", "T4", "T5"]
      .flatMap((task) =>
        records.flatMap((m) => dataPaths(renderBoard(m, { task }))),
      )
      .map(shape),
  );
  assert.deepEqual(
    design.filter((path) => !rendered.has(path) && !dropped.has(path)),
    [],
    "v0.9 paths neither rendered nor in design/v0.9-dropped.txt",
  );
  for (const [path, reason] of dropped) {
    assert.ok(reason.trim(), `${path} is dropped without a reason`);
    assert.ok(design.includes(path), `${path} is not a v0.9 path`);
    assert.ok(!rendered.has(path), `${path} is rendered after all`);
  }
});

test("the fixture's board: what needs you, what is in flight, what is done", () => {
  const html = page(ME, { task: "T2" });
  assert.deepEqual(textsOf(html, "count(needsYou[].items)"), [
    "2 need you",
    "2",
  ]);
  assert.equal(textOf(html, "count(open[] not in needsYou)"), "1 in flight");
  assert.equal(textOf(html, "count(placements[].hold)"), "1 held");
  assert.equal(textOf(html, "count(placements)"), "3 agents");
  assert.deepEqual(groups(html), {
    "needs-you": ["T1", "T2"],
    "in-flight": ["T4"],
    done: ["T3"],
  });
  // Each agent says what its session is doing and when it last updated.
  assert.match(
    html,
    /<span class="dot ask" data-path="placements\[0\][^"]*"><\/span>/,
  );
  assert.ok(
    html.includes(
      'asks on <a class="id" data-path="placements[0].delivery.taskId" href="?task=T2">T2</a>',
    ),
  );
  assert.ok(html.includes("working on <a"));
  assert.equal(textOf(html, "age(placements[1].delivery.latest.at, at)"), "1m");
  // The held placement has no delivery: its card is idle and says so.
  assert.match(
    html,
    /<div class="card idle" tabindex="0" data-path="placements\[2\]">/,
  );
  assert.match(strip(html), /environment@mbp\s*held · no open delivery/);
  assert.ok(!html.includes('data-path="placements[2].session"'));
  // The rows read as the design wrote them.
  assert.equal(textOf(html, "open[2].routing.reason"), "low confidence");
  assert.equal(
    textOf(html, "open[1].deliveries[0].question.text"),
    "Force push?",
  );
  assert.equal(textOf(html, "left(open[0].deadline, at)"), "55m left");
  assert.equal(textOf(html, "finished[0].final"), "1 of 1 delivery");
  // The selected task's conversation in time order, then its answer form.
  assert.deepEqual(
    [
      ...detailOf(html).matchAll(
        /<div class="(?:msg[^"]*|sys)"[^>]*>([^]*?)<\/div>/g,
      ),
    ].map((m) => strip(m[1] ?? "")),
    [
      "you · request · 09:10Z · acceptedAsk me something",
      "orchestrator@mbp · question · 09:14ZWhich branch?",
      "you · answer · 09:16Z · acceptedmain",
      "orchestrator@mbp · working · 09:20Zon it",
      "orchestrator@mbp · question · 09:31ZForce push?",
    ],
  );
  // v0.8: the viewer's form comes before the transcript, under the head.
  const detailHtml = detailOf(html);
  assert.ok(
    detailHtml.indexOf('<form class="form"') <
      detailHtml.indexOf('<div class="thread">'),
  );
  assert.ok(
    detailHtml.indexOf('<div class="head">') <
      detailHtml.indexOf('<form class="form"'),
  );
  assert.equal(textOf(html, "time(open[1].deadline)"), "10:10Z");
  assert.equal(textOf(html, "left(open[1].deadline, at)"), "25m left");
  // Jev's line in the thread, above and below the threshold.
  assert.ok(
    page(ME, { task: "T4" }).includes(
      "Jev picked knowledge at 0.94, runner-up orchestrator 0.03 · jev-1.13.0",
    ),
  );
  assert.ok(
    page(ME, { task: "T1" }).includes(
      "Jev: orchestrator at 0.60 is under the threshold 0.9, runner-up knowledge 0.20 · jev-1.13.0",
    ),
  );
});

test("forms and levers follow the viewer's principals and roles", () => {
  // Nobody identified: every principal's items, read only, and no form.
  const nobody = page(null, {}, replacedJournal);
  assert.ok(!nobody.includes("<form"));
  assert.equal(textOf(nobody, "actor"), "reading only · not identified");
  assert.deepEqual(groups(nobody)["needs-you"], ["T1", "T2", "T4"]);
  assert.ok(nobody.includes('class="form ro"'));
  assert.ok(!nobody.includes(">Answer T2<"));
  assert.ok(!nobody.includes("<textarea"));
  const nobodyT4 = page(null, { task: "T4" }, replacedJournal);
  assert.match(
    strip(detailOf(nobodyT4)),
    /Resolve D3 · send M4 · session replaced · waits on operator/,
  );

  // A requester: its own items as forms; the operator's read as waiting.
  const guest = page(GUEST, { task: "T1" }, replacedJournal);
  assert.deepEqual(groups(guest), {
    "needs-you": ["T1", "T2"],
    "in-flight": ["T4"],
    done: ["T3"],
  });
  const choose = formFor(guest, "choose");
  assert.deepEqual(choose?.fields, { action: "choose", task: "T1" });
  assert.deepEqual(choose?.buttons, [
    ["to", "orchestrator"],
    ["to", "knowledge"],
    ["to", "environment"],
    ["to", "incus"],
  ]);
  const cancel = formFor(guest, "cancel");
  assert.deepEqual(cancel?.fields, { action: "cancel", task: "T1" });
  assert.match(
    cancel?.attrs ?? "",
    /onsubmit="return confirm\(&quot;Cancel T1\?/,
  );
  const answer = formFor(
    page(GUEST, { task: "T2" }, replacedJournal),
    "answer",
  );
  assert.deepEqual(answer?.fields, {
    action: "answer",
    task: "T2",
    delivery: "D1",
    question: "Q2",
  });
  assert.deepEqual(answer?.inputs, ["text"]);
  assert.ok(guest.includes(">Answer T2</a>"));
  assert.ok(!guest.includes('value="resolve"'));
  // A hold says a person is typing in the session: any identified viewer
  // may set it (v0.9); nobody identified gets no lever.
  assert.ok(guest.includes('value="hold"'));
  assert.ok(!page(null, { task: "T2" }).includes('value="hold"'));
  assert.match(
    guest,
    /waits on <span data-path="needsYou\[1\]\.principal">operator<\/span>/,
  );
  const guestT4 = page(GUEST, { task: "T4" }, replacedJournal);
  assert.ok(!guestT4.includes('value="resolve"'));
  assert.ok(guestT4.includes('class="form ro"'));

  // An operator: the resolve form, next to the hold levers every login has.
  const me = page(ME, { task: "T4" }, replacedJournal);
  assert.deepEqual(groups(me)["needs-you"], ["T1", "T2", "T4"]);
  const resolve = formFor(me, "resolve");
  assert.deepEqual(resolve?.fields, {
    action: "resolve",
    delivery: "D3",
    message: "M4",
  });
  assert.deepEqual(resolve?.inputs, ["evidence"]);
  // The send was accepted, so the router takes only finished; the form says
  // why, and names the reason the delivery is stuck.
  assert.deepEqual(resolve?.buttons, [["outcome", "finished"]]);
  assert.match(
    strip(me),
    /The session that took this send is gone, so the router cannot confirm it\. The adapter reported it accepted, so it counts as sent and cannot be marked not sent; resolving finishes the delivery\./,
  );
  assert.ok(me.includes('data-path="open[0].deliveries[0].send.outcome"'));
  assert.deepEqual(
    formsIn(me)
      .filter((f) => f.fields.action === "hold")
      .map((f) => [f.fields.placement, f.fields.hold]),
    // The rail orders by state: the asking card, the held one, then the
    // idle one with the replaced session.
    [
      ["orchestrator@mbp", "1"],
      ["environment@mbp", "0"],
      ["knowledge@mini", "1"],
    ],
  );
  // Every form posts to the actions endpoint, and none nests in another.
  for (const html of [guest, me])
    for (const m of html.matchAll(/<form([^>]*)>([^]*?)<\/form>/g)) {
      assert.match(m[1] ?? "", /method="post" action="actions"/);
      assert.ok(!m[2]?.includes("<form"));
    }
});

// The fixture's model as a login holding `principals` sees it, with these
// roles for the principals.
const modelFor = (
  principals: string[],
  roles: Record<string, Role> = config.principals ?? {},
): BoardModel => {
  const configured = { ...config, principals: roles };
  return boardModel(
    boardState(configured, journal, NOW),
    configured,
    NOW,
    messageTimes(journal),
    { login: "x@example.com", principals },
  );
};

test("blue marks only what waits on the viewer", () => {
  const questions = (html: string): string[] =>
    [
      ...detailOf(html).matchAll(
        /<div class="msg agent question"[^>]*>([^]*?)<\/div>/g,
      ),
    ].map((m) => strip(m[1] ?? ""));
  // The open question, not the one answered at 09:16.
  const me = page(ME, { task: "T2" });
  assert.deepEqual(questions(me), [
    "orchestrator@mbp · question · 09:31ZForce push?",
  ]);
  assert.ok(me.includes('<div class="q">'));
  assert.ok(!me.includes('<div class="q wait">'));
  // Nobody identified: every item counts, as in the Needs you group.
  assert.deepEqual(questions(page(null, { task: "T2" })), questions(me));
  // An operator: the requester's question waits on the requester.
  const operator = renderBoard(modelFor(["operator"]), { task: "T2" });
  assert.match(operator, /<div class="task held[^"]*" data-path="open\[1\]"/);
  assert.deepEqual(questions(operator), []);
  assert.ok(operator.includes('<div class="q wait">'));
  assert.ok(!operator.includes('<div class="q">'));
  assert.match(strip(detailOf(operator)), /question Q2 · waits on you/);
  // The Needs you header is blue only while something waits on the viewer.
  assert.ok(me.includes('<span class="kicker attn">Needs you</span>'));
  const idle = renderBoard(
    modelFor(["team"], { ...config.principals, team: "requester" }),
  );
  assert.ok(idle.includes('<span class="kicker">Needs you</span>'));
  assert.ok(!idle.includes("kicker attn"));
});

test("a login with two principals in one role gets forms for the one its posts are signed as", () => {
  const roles: Record<string, Role> = {
    ...config.principals,
    team: "requester",
  };
  // A post names no principal: it is signed as the first requester listed.
  const signed = actionEvent(
    new URLSearchParams({
      action: "answer",
      task: "T2",
      question: "Q2",
      text: "no",
    }),
    { login: "x@example.com", principals: ["team", "you"] },
    roles,
  );
  assert.equal(
    signed.ok && "by" in signed.event ? signed.event.by : null,
    "team",
  );
  // So the items of `you` read as waiting on it, with no form to refuse.
  const teamFirst = renderBoard(modelFor(["team", "you"], roles), {
    task: "T2",
  });
  assert.deepEqual(groups(teamFirst)["needs-you"], ["T1", "T2"]);
  // Only the hold levers, which any identified viewer gets.
  assert.deepEqual(
    formsIn(teamFirst).filter((f) => f.fields.action !== "hold"),
    [],
  );
  assert.match(strip(detailOf(teamFirst)), /question Q2 · waits on you/);
  const youFirst = renderBoard(modelFor(["you", "team"], roles), {
    task: "T2",
  });
  assert.deepEqual(formFor(youFirst, "answer")?.fields, {
    action: "answer",
    task: "T2",
    delivery: "D1",
    question: "Q2",
  });
  assert.ok(formFor(youFirst, "cancel"));
  assert.match(strip(detailOf(youFirst)), /question Q2 · as you/);
});

test("a valid record never breaks the page: Jev still judging, or a judgment without probabilities", () => {
  const judging = extend({
    type: "submit",
    by: "you",
    messageId: "M5",
    text: "Plan the week",
  });
  const html = page(ME, { task: "T5" }, judging);
  assert.deepEqual(textsOf(html, "open[0].status"), ["", "routing", "routing"]);
  assert.equal(textOf(html, "open[0].routing", "div"), "judging");
  const invalid = extend(
    { type: "submit", by: "you", messageId: "M5", text: "Plan the week" },
    {
      type: "judged",
      taskId: "T5",
      choice: "orchestrator",
      probabilities: { orchestrator: 2 },
      model: "jev-1.13.0",
    },
  );
  const shown = page(ME, { task: "T5" }, invalid);
  assert.equal(
    textOf(shown, "open[0].judgments[0]", "div"),
    "Jev: orchestrator, judgment invalid · jev-1.13.0",
  );
  assert.equal(textOf(shown, "open[0].judgments[0].probabilities"), "—");
  assert.equal(textOf(shown, "open[0].judgments[0].valid"), "invalid");
  // With nothing suggested, the sender names the recipient.
  assert.deepEqual(formFor(shown, "choose")?.inputs, ["to"]);
});

test("the rail orders cards by state and keeps the model's order within one", () => {
  // Cards come asking, working, held, ready, not ready, whatever the
  // model's order; the fixture's order reversed still renders ask, work, held.
  const me = model(ME);
  const order = (html: string): string[] =>
    [
      ...html.matchAll(
        /<div class="card[^"]*" tabindex="0" data-path="placements\[(\d)\]">/g,
      ),
    ].map((m) => m[1] ?? "");
  const reversed = renderBoard(
    { ...me, placements: [...me.placements].reverse() },
    { task: "T2" },
  );
  assert.deepEqual(order(reversed), ["2", "1", "0"]);
  // Two held placements keep the model's order between them.
  const held = me.placements[2];
  assert.ok(held?.hold);
  const twoHeld = renderBoard(
    {
      ...me,
      placements: [{ ...held, key: "environment@mini" }, ...me.placements],
    },
    { task: "T2" },
  );
  assert.deepEqual(order(twoHeld), ["1", "2", "0", "3"]);
});

test("the nav names a role only when it differs from its principal", () => {
  assert.equal(
    textOf(page(ME), "actor.principals[]"),
    "you (requester), operator",
  );
  assert.equal(textOf(page(GUEST), "actor.principals[]"), "you (requester)");
});

test("a delivery without a reply reads as delivered once its send was accepted, else as the send", () => {
  // Before T4's first reply its delivery is accepted: the card, the row and
  // the table say delivered.
  const quiet = page(ME, { task: "T4" }, deliveredJournal);
  assert.match(
    strip(quiet),
    /knowledge@mini\s*delivered on T4 · Summarize the review pipeline notes/,
  );
  assert.equal(
    textOf(quiet, "placements[1].delivery.latest"),
    "delivered, no reply yet",
  );
  assert.equal(
    textOf(quiet, "open[0].deliveries[0].latest"),
    "delivered, no reply yet",
  );
  assert.equal(textsOf(quiet, "open[0].deliveries[0].latest")[1], "delivered");
  assert.ok(!quiet.includes("none yet"));

  // While a send is still attempting the delivery is pinned but not
  // delivered: the page says what the send is, from the placement's own
  // outcome field. The environment participant has several placements; D5
  // is the one on mbp.
  const inFlight = page(ME, { task: "T5" }, attemptingJournal);
  assert.match(strip(inFlight), /environment@mbp\s*attempting on T5 · Rebuild/);
  assert.deepEqual(textsOf(inFlight, "placements[2].delivery.outcome"), [
    "attempting",
    "attempting, no reply yet",
  ]);
  assert.ok(!inFlight.includes('data-path="placements[2].delivery.latest"'));
  assert.deepEqual(textsOf(inFlight, "open[0].deliveries[1].send"), [
    "request M5 · attempting",
    "request attempting",
  ]);
  assert.ok(!inFlight.includes("delivered"));
  // The card does not need the task: a delivery whose task is older than
  // the finished tasks the model keeps still reads from its own outcome.
  const unlisted = model(ME, attemptingJournal);
  unlisted.open = unlisted.open.filter((t) => t.id !== "T5");
  assert.match(
    strip(renderBoard(unlisted)),
    /environment@mbp\s*attempting on T5 · Rebuild/,
  );
});

test("a task a participant sent lists the notices it was told; a person's task has no such table", () => {
  const html = page(ME, { task: "T5" }, viaJournal);
  assert.equal(textOf(html, "open[0].source"), "orchestrator/M5");
  assert.equal(textOf(detailOf(html), "open[0].via"), "orchestrator@mbp");
  assert.match(strip(html), /Notices to\s*orchestrator@mbp/);
  assert.equal(textOf(html, "open[0].notices[0].key"), "question/D4/Q5");
  assert.equal(textOf(html, "open[0].notices[0].kind"), "question");
  assert.equal(textOf(html, "open[0].notices[0].session"), "A1");
  assert.equal(textOf(html, "open[0].notices[0].outcome"), "accepted");
  // The requester is not asked to answer the sender's question.
  assert.ok(!html.includes('name="questionId" value="Q5"'));
  // A notice that stopped standing before it was told reads as withdrawn.
  const at = viaJournal.at(-1)?.at ?? AT;
  const moved = page(ME, { task: "T5" }, [
    ...viaJournal.slice(0, -1),
    {
      at,
      event: {
        type: "noticeResult",
        taskId: "T5",
        key: "question/D4/Q5",
        outcome: "not_sent",
      },
    },
    { at, event: { type: "observe", placement: "incus@lab01", session: "L2" } },
  ]);
  assert.equal(textOf(moved, "open[0].notices[0].outcome"), "withdrawn");
  // A notice is listed from the moment it is owed, before any attempt;
  // with nothing owed yet there is no table, as in the design. A person's
  // task has none either.
  const owed = page(ME, { task: "T5" }, viaJournal.slice(0, -2));
  assert.equal(textOf(owed, "open[0].notices[0].outcome"), "pending");
  assert.equal(textOf(owed, "open[0].notices[0].session"), "—");
  const quiet = page(ME, { task: "T5" }, viaJournal.slice(0, -3));
  assert.ok(!quiet.includes("Notices to"));
  assert.equal(textOf(detailOf(quiet), "open[0].via"), "orchestrator@mbp");
  const person = page(ME, { task: "T2" });
  assert.ok(!person.includes("Notices to"));
  assert.ok(!person.includes('data-path="open[1].via"'));
});

test("v0.9: via in the head, from <via> on an open row, the notices table after the deliveries, withdrawn muted", () => {
  // The sample's T5 is finished: the head names the sender's placement, the
  // notices table follows the deliveries with the design's columns, and a
  // withdrawn outcome carries its class.
  const done = page(ME, { task: "T5" }, sampleJournal);
  const head = done.match(/<div class="meta">([^]*?)<\/div>/)?.[1] ?? "";
  assert.match(
    strip(head),
    /from orchestrator\/M5 via orchestrator@mbp at 09:44Z/,
  );
  const facts = strip(done.slice(done.indexOf('<div class="facts">')));
  assert.match(
    facts,
    /Deliveries[^]*Notices to\s*orchestrator@mbp\s*Notice\s*Kind\s*Session\s*Outcome[^]*Jev/,
  );
  assert.ok(
    done.includes(
      '<span class="outcome withdrawn" data-path="finished[0].notices[0].outcome">withdrawn</span>',
    ),
  );
  assert.ok(
    done.includes(
      '<span class="outcome accepted" data-path="finished[0].notices[1].outcome">accepted</span>',
    ),
  );
  // Finished: no "from" on its row.
  assert.ok(!done.includes('data-path="finished[0].via">from'));
  // Open: the row says from <via> before the recipient. The design spares
  // the sender its own placement, but a person is never a participant (a
  // principal may not share a participant's id), so every viewer sees it.
  const open = page(ME, {}, viaJournal);
  assert.ok(
    open.includes(
      '<span class="to" data-path="open[0].via">from orchestrator@mbp</span><span class="to" data-path="open[0].recipient">incus</span>',
    ),
  );
  assert.ok(
    page(null, {}, viaJournal).includes('data-path="open[0].via">from'),
  );
});

test("an answered question reads as working on the card and as the answer in the row", () => {
  // While T2's question is open the card shows the question, not the
  // request.
  const asking = page(ME, { task: "T2" });
  assert.equal(
    textOf(asking, "placements[0].delivery.question.text"),
    "Force push?",
  );
  assert.ok(!asking.includes('data-path="placements[0].delivery.excerpt"'));
  // After the answer the question is still the latest update, but the
  // session works again: the card and its dot say so, the stats line names
  // the answer's time, and the row quotes the answer instead of the
  // question. Nothing waits on the viewer.
  const html = page(ME, { task: "T2" }, answeredJournal);
  assert.match(
    html,
    /<div class="card" tabindex="0" data-path="placements\[0\]">\s*<span class="dot work"/,
  );
  // The corner age is the answer's, not the question's.
  assert.match(
    strip(html),
    /orchestrator@mbp\s*29m\s*working on T2 · Ask me something/,
  );
  assert.ok(
    html.includes(
      'data-path="age(times[placements[0].delivery.messageId], at)"',
    ),
  );
  assert.match(strip(html), /answered\s*09:16Z\s*· no reply yet/);
  assert.ok(
    html.includes('data-path="time(times[placements[0].delivery.messageId])"'),
  );
  assert.equal(textOf(html, "open[1].deliveries[0].latest.text"), undefined);
  assert.match(strip(html), /working\s*answered 09:16Z main · 25m left/);
  assert.equal(textOf(html, "open[1].deliveries[0].sends[1].text"), "main");
  assert.deepEqual(groups(html)["needs-you"], ["T1"]);
  // A resolve clears the question too; with no answer sent, the row keeps
  // the question's text rather than quoting the request as an answer.
  const resolved = model(ME, answeredJournal);
  const d1 = resolved.open.find((t) => t.id === "T2")?.deliveries[0];
  assert.ok(d1);
  d1.send = { ...d1.send, messageId: "M2" };
  const row = renderBoard(resolved, { task: "T2" });
  assert.ok(!strip(row).includes("answered 09:16Z"));
  assert.equal(
    textOf(row, "open[1].deliveries[0].latest.text"),
    "Which branch?",
  );
});

test("v0.8 layout: the form precedes the transcript, the rail log holds every line, the table says answered", () => {
  const html = page(ME, { task: "T2" }, answeredJournal);
  // Every log line the model carries is in the rail's bottom-anchored block.
  const m = model(ME, answeredJournal);
  const block = html.slice(
    html.indexOf('<div class="lines"><div class="tail">'),
    html.indexOf("</aside>"),
  );
  assert.equal(
    [...block.matchAll(/data-path="log\[(\d+)\]"/g)].length,
    m.log.length,
  );
  assert.ok(block.includes('data-path="log[0]"'));
  assert.equal(textOf(html, "count(log)"), `last ${m.log.length}`);
  // The deliveries table reads answered for the answered question.
  const table = detailOf(html).slice(detailOf(html).indexOf("<table>"));
  assert.deepEqual(textsOf(table, "open[1].deliveries[0].send"), [
    "answer A1m · accepted",
    "answered",
  ]);
  // An answer whose send has not landed reads as its outcome, on the card
  // and in the row and table, before anything says answered.
  const pending = model(ME, answeredJournal);
  const card = pending.placements[0]?.delivery;
  const d1 = pending.open.find((t) => t.id === "T2")?.deliveries[0];
  assert.ok(card && d1);
  card.outcome = "pending";
  d1.send = { ...d1.send, outcome: "pending" };
  const unlanded = renderBoard(pending, { task: "T2" });
  assert.match(
    strip(unlanded),
    /orchestrator@mbp\s*pending on T2 · Ask me something/,
  );
  assert.equal(
    textsOf(unlanded, "placements[0].delivery.outcome")[1],
    "pending, no reply yet",
  );
  assert.ok(!strip(unlanded).includes("answered 09:16Z"));
  // The row's sub-line and the table's State cell both read the send.
  assert.deepEqual(textsOf(unlanded, "open[1].deliveries[0].send"), [
    "answer pending",
    "answer A1m · pending",
    "answer pending",
  ]);
  // The table's badge is blue only while the question is open and asks the
  // viewer; after the answer there is no badge at all.
  const open = page(ME, { task: "T2" });
  assert.ok(
    open.includes(
      '<span class="badge ask" data-path="open[1].deliveries[0].latest.kind">question</span>',
    ),
  );
  assert.ok(!html.includes('data-path="open[1].deliveries[0].latest.kind"'));
});

test("a runner-up that rounds to 0.00 is not named", () => {
  const sure = extend(
    { type: "submit", by: "you", messageId: "M5", text: "Plan the week" },
    {
      type: "judged",
      taskId: "T5",
      choice: "orchestrator",
      probabilities: {
        orchestrator: 0.996,
        knowledge: 0.001,
        environment: 0.001,
        incus: 0.001,
        none: 0.001,
      },
      model: "jev-1.13.0",
    },
  );
  assert.equal(
    textOf(page(ME, { task: "T5" }, sure), "open[0].judgments[0]", "div"),
    "Jev picked orchestrator at 1.00 · jev-1.13.0",
  );
});

test("the resolve form offers both outcomes for a send that was not accepted, and names the reason", () => {
  // T5's send came back unknown and its deadline passed: the router cannot
  // confirm it, so the operator may mark it finished or not sent.
  const stuck = extend(
    {
      type: "submit",
      by: "you",
      messageId: "M5",
      text: "Deploy",
      to: "orchestrator",
    },
    { type: "attempt", deliveryId: "D4" },
    {
      type: "adapterResult",
      deliveryId: "D4",
      messageId: "M5",
      outcome: "unknown",
    },
  );
  const html = page(ME, { task: "T5" }, stuck, LATER);
  const resolve = formFor(html, "resolve", "delivery", "D4");
  assert.deepEqual(resolve?.buttons, [
    ["outcome", "finished"],
    ["outcome", "not_sent"],
  ]);
  assert.match(
    strip(html),
    /task ended · as operator.*The task ended before the router could confirm this send\./s,
  );
  assert.ok(!html.includes("cannot be marked not sent"));
  assert.ok(
    !html.includes('data-path="finished[0].deliveries[0].send.outcome"'),
  );
  // The item alone, when its task is older than the model keeps.
  const older = model(ME, stuck, LATER);
  older.finished = older.finished.filter((t) => t.id !== "T5");
  const orphan = renderBoard(older, { task: "T5" });
  assert.deepEqual(formFor(orphan, "resolve", "delivery", "D4")?.buttons, [
    ["outcome", "finished"],
    ["outcome", "not_sent"],
  ]);
  // Each reason has its sentence.
  const item = older.needsYou
    .flatMap((g) => g.items)
    .find((it) => it.kind === "resolve");
  assert.ok(item?.kind === "resolve");
  item.reason = "unknown_send";
  assert.match(
    strip(renderBoard(older, { task: "T5" })),
    /The router has no record of this send reaching the session\./,
  );
});

test("a finished task shows its verdict, not a countdown", () => {
  const html = page(ME, { task: "T3" });
  const detail = detailOf(html);
  assert.ok(!html.includes("left(finished["));
  assert.ok(
    !/ left|overdue/.test(
      strip(detail.slice(0, detail.indexOf("</div>\n  </div>"))),
    ),
  );
  assert.match(strip(detail), /deadline 10:15Z · 1 of 1 delivery/);
  // After every deadline nothing is open, so the newest finished is selected.
  const later = page(null, {}, journal, LATER);
  assert.equal(selectedOf(later), "T4");
  assert.equal(textOf(later, "finished[3].final"), "0 of 0 deliveries");
  assert.equal(textOf(later, "finished[3].final.reason"), "deadline");
});

test("a task sits in one group, counted once", () => {
  // T5's send was unconfirmed when its deadline passed: the operator must
  // resolve it, so it waits in Needs you and not in Done.
  const stuck = extend(
    {
      type: "submit",
      by: "you",
      messageId: "M5",
      text: "Deploy",
      to: "orchestrator",
    },
    { type: "attempt", deliveryId: "D4" },
    {
      type: "adapterResult",
      deliveryId: "D4",
      messageId: "M5",
      outcome: "unknown",
    },
  );
  const html = page(ME, {}, stuck, LATER);
  assert.deepEqual(groups(html), {
    "needs-you": ["T5"],
    "in-flight": [],
    done: ["T4", "T3", "T2", "T1"],
  });
  assert.deepEqual(textsOf(html, "count(needsYou[].items)"), [
    "1 needs you",
    "1",
  ]);
  assert.equal(selectedOf(html), "T5");
  assert.ok(formFor(html, "resolve", "delivery", "D4"));
  // Once T5 is older than the finished tasks the model keeps, its item
  // still waits in Needs you and can still be resolved.
  const older = model(ME, stuck, LATER);
  older.finished = older.finished.filter((t) => t.id !== "T5");
  const orphan = renderBoard(older, { task: "T5" });
  assert.deepEqual(groups(orphan)["needs-you"], ["T5"]);
  assert.match(strip(orphan), /T5Not among the last finished tasks/);
  assert.equal(selectedOf(orphan), "T5");
  assert.ok(formFor(orphan, "resolve", "delivery", "D4"));
  // Two items on one task count it once.
  const twice = model(ME);
  const you = twice.needsYou[0];
  assert.ok(you);
  you.items.push(...you.items);
  const doubled = renderBoard(twice);
  assert.deepEqual(textsOf(doubled, "count(needsYou[].items)"), [
    "2 need you",
    "2",
  ]);
  assert.deepEqual(groups(doubled)["needs-you"], ["T1", "T2"]);
});

test("the selected task comes from the URL, else Needs you, else the first open task", () => {
  assert.equal(selectedOf(page(ME)), "T1");
  const t4 = page(ME, { task: "T4" });
  assert.equal(selectedOf(t4), "T4");
  assert.match(t4, /data-task="T4" aria-current="true"/);
  assert.equal(selectedOf(page(ME, { task: "T99" })), "T1");
  const odd = page(ME, { task: '"><b>x' });
  assert.equal(selectedOf(odd), "T1");
  assert.ok(!odd.includes('"><b>x'));
  const quiet = model(ME);
  for (const entry of quiet.needsYou) entry.items = [];
  assert.equal(selectedOf(renderBoard(quiet)), "T4");
});

test("a queued row says what it waits for; a canceled row says who canceled it", () => {
  const queued = extend(
    {
      type: "submit",
      by: "you",
      messageId: "M5",
      text: "Check",
      to: "environment",
      hosts: ["mbp"],
    },
    {
      type: "submit",
      by: "you",
      messageId: "M6",
      text: "One",
      to: "orchestrator",
    },
    {
      type: "submit",
      by: "you",
      messageId: "M7",
      text: "Two",
      to: "orchestrator",
    },
  );
  const html = page(ME, { task: "T7" }, queued);
  assert.equal(
    textOf(html, "open[2].deliveries[0].waits"),
    "held on environment@mbp",
  );
  assert.deepEqual(textsOf(html, "open[0].deliveries[0].waits"), [
    "queued behind D5",
    "queued behind D5",
  ]);
  assert.equal(textOf(html, "open[1].deliveries[0].send"), "request pending");
  const canceled = extend(
    {
      type: "submit",
      by: "you",
      messageId: "M5",
      text: "Check",
      to: "environment",
      hosts: ["mbp"],
    },
    { type: "cancel", by: "you", taskId: "T5" },
  );
  const done = page(ME, {}, canceled);
  assert.ok(groups(done).done?.includes("T5"));
  assert.match(strip(done), /0 of 1 delivery · sender · by you/);
  assert.equal(textOf(done, "finished[0].final.by"), "you");
});

test("the page escapes what it shows, takes only a known palette, and dates its clocks", () => {
  const html = page(ME, {
    task: "T1",
    notice: "<script>x</script> done",
    refreshSeconds: 7,
  });
  assert.ok(html.includes("Fix &lt;b&gt;the&lt;/b&gt; build"));
  assert.ok(!html.includes("<b>the</b>"));
  assert.ok(html.includes("<span>&lt;script&gt;x&lt;/script&gt; done</span>"));
  // The notice is outside the parts a refresh swaps.
  assert.ok(html.indexOf('class="notice"') < html.indexOf('id="app"'));
  assert.ok(html.includes('<div id="app" data-refresh="7">'));
  assert.ok(
    html.includes(
      'data-path="time(at)" title="2026-09-30 09:45Z">09:45Z</span>',
    ),
  );
  assert.ok(html.includes('<html lang="en" data-theme="flexoki">'));
  const dark = page(ME, { theme: "one-dark" });
  assert.ok(dark.includes('<html lang="en" data-theme="one-dark">'));
  assert.ok(
    dark.includes('data-theme="one-dark" class="on" aria-pressed="true"'),
  );
  const forged = page(ME, { theme: '"><script>alert(1)</script>' });
  assert.ok(forged.includes('<html lang="en" data-theme="flexoki">'));
  assert.ok(!forged.includes("alert(1)"));
});

test("a real record: a long request keeps a short title and session ids are short", () => {
  // The live record's requests run to pages and its sessions are UUIDs; the
  // design was sized for the sample's short text and two-letter sessions.
  const session = "cef0c5d5-3548-40dd-aba4-2c2397bd47f2";
  const text =
    "  Round 3b: visual review of the live board against v0.6.\r\n\r\nWhere: the tailnet.\n" +
    "x".repeat(2000);
  const real = extend(
    { type: "observe", placement: "knowledge@mini", session },
    { type: "submit", by: "you", messageId: "M5", text },
  );
  const html = page(ME, { task: "T5" }, real);
  const detail = detailOf(html);
  // The title is the first line, trimmed; the whole text is its tooltip and
  // the transcript still carries it in full.
  assert.equal(
    textOf(detail, "first_line(open[0].text)"),
    "Round 3b: visual review of the live board against v0.6.",
  );
  const tooltip = detail.match(/<h2 title="([^"]*)">/);
  assert.equal(tooltip?.[1]?.length, text.length);
  assert.ok(detail.includes(`${"x".repeat(2000)}</`));
  // The fixture's short ids stay as they are.
  assert.equal(textOf(html, "placements[0].session"), "session A1");
  // A delivery sent to that session shows eight characters of the UUID on
  // the card; once the session ends it, the table and the end line show the
  // short id with the same tooltip.
  const sent = extend(
    { type: "observe", placement: "knowledge@mini", session, ready: true },
    {
      type: "submit",
      by: "you",
      messageId: "M5",
      text: "Plan",
      to: "knowledge",
    },
    { type: "attempt", deliveryId: "D4" },
    {
      type: "adapterResult",
      deliveryId: "D4",
      messageId: "M5",
      outcome: "accepted",
    },
    {
      type: "update",
      by: session,
      taskId: "T5",
      messageId: "R5",
      inReplyTo: "M5",
      kind: "completed",
      text: "done",
    },
  );
  const sentHtml = page(ME, { task: "T5" }, sent.slice(0, -1));
  assert.ok(
    sentHtml.includes(
      `<span class="tag" data-path="placements[1].session" title="${session}">session cef0c5d5</span>`,
    ),
  );
  const table = page(ME, { task: "T5" }, sent);
  const detailT5 = detailOf(table);
  assert.ok(
    detailT5.includes(
      `<span class="mono" data-path="finished[0].deliveries[0].session" title="${session}">cef0c5d5</span>`,
    ),
  );
  assert.ok(
    detailT5.includes(
      `D4 ended · completed · by <span data-path="finished[0].deliveries[0].end.by" title="${session}">cef0c5d5</span>`,
    ),
  );
});

test("telemetry: each card says what the router last saw of its session; nothing without a snapshot", () => {
  const seen = renderBoard(
    boardModel(
      boardState(config, sampleJournal, NOW),
      config,
      NOW,
      messageTimes(sampleJournal),
      identify({ "tailscale-user-login": ME }, config.serve.identities),
      telemetry,
    ),
  );
  const cards = [...seen.matchAll(/<div class="agent">([^]*?)<\/div>/g)].map(
    (m) =>
      strip(m[1] ?? "")
        .replaceAll(/\s+/g, " ")
        .trim(),
  );
  assert.deepEqual(cards, [
    // Mid-turn, with the turn's age and the harness tags.
    "running for 29s·context 31% 61.4k/200k·claude/claude-opus-5-5·high·auto·$4.18·seen 10s ago",
    // Stopped at a permission prompt: named, in the accent.
    "running for 4m·permission·waiting on Bash·context 32% 88.2k/272k·codex/gpt-5.5·medium·default·$11.02·seen 10s ago",
    // Idle; a finished turn is not an alarm.
    "idle·context 86% 172k/200k·claude/claude-sonnet-5-5·low·acceptEdits·$9.61·seen 9s ago",
  ]);
  assert.ok(
    seen.includes(
      '<span class="warn" data-path="placements[1].agent.permissions[]">waiting on Bash</span>',
    ),
  );
  assert.ok(
    seen.includes(
      '<span class="pair" data-path="placements[2].agent.context" title="171500 of 200000 tokens">context 86% <span class="k">172k/200k</span></span>',
    ),
  );
  // The column header dates the snapshots.
  assert.match(strip(seen), /Agents\s*3 placements · seen 9s ago/);
  // Without telemetry: no line, no date.
  const none = page(ME);
  assert.ok(!none.includes('class="agent"'));
  assert.ok(!none.includes("telemetryAt"));
  // An unreachable host says so, with the failure escaped; a session the
  // daemon does not know is missing; a placement the file lacks has no line.
  const down = renderBoard(
    boardModel(boardState(config, journal, NOW), config, NOW, {}, null, {
      ...telemetry,
      placements: {
        "knowledge@mini": emptySnapshot(
          telemetry.at,
          "unreachable",
          "ssh: connect to host <mini> port 22: timed out",
        ),
        "environment@mbp": emptySnapshot(telemetry.at, "missing"),
      },
    }),
  );
  const states = [...down.matchAll(/<div class="agent">([^]*?)<\/div>/g)].map(
    (m) =>
      strip(m[1] ?? "")
        .replaceAll(/\s+/g, " ")
        .trim(),
  );
  assert.deepEqual(states, [
    "unreachable·ssh: connect to host &lt;mini&gt; port 22: timed out·seen 9s ago",
    "missing·seen 9s ago",
  ]);
  assert.ok(!down.includes('data-path="placements[0].agent'));
});
