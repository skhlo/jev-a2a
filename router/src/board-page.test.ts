// The board page: the v0.12 design drawn from the view model and the viewer,
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
  type PlacementView,
} from "./board.ts";
import {
  age,
  count,
  counts,
  diff,
  hms,
  label,
  left,
  renderBoard,
  repo,
  stale,
  staleTask,
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
import { sampleModel } from "./board-sample.ts";
import { shots } from "./board-shots.ts";
import type { Entry } from "./journal.ts";
import {
  emptySnapshot,
  type AgentSnapshot,
  type Telemetry,
} from "./telemetry.ts";
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
  seen: Telemetry | null = null,
): BoardModel =>
  boardModel(
    boardState(config, entries, now),
    config,
    now,
    messageTimes(entries),
    login
      ? identify({ "tailscale-user-login": login }, config.serve.identities)
      : null,
    seen,
  );
const page = (
  login: string | null,
  options: RenderOptions = {},
  entries: Entry[] = journal,
  now = NOW,
): string => renderBoard(model(login, entries, now), options);

const strip = (html: string): string => html.replace(/<[^>]+>/g, "");
// The page without its sheets (v0.11), which repeat each card's levers and
// tags; and the sheets alone.
const rail = (html: string): string =>
  html.replace(/<aside class="sheet"[^]*?<\/aside>/g, "");
const sheets = (html: string): string[] =>
  [...html.matchAll(/<aside class="sheet"[^]*?<\/aside>/g)].map((m) => m[0]);
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
// Whether the page's style holds a rule.
const STYLE_HAS = (html: string, rule: string): boolean =>
  (html.match(/<style>([^]*?)<\/style>/)?.[1] ?? "").includes(rule);
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
  // v0.11: seconds for activity rows; the diff with the minus sign and
  // thousands; the non-zero counts as words in the object's order.
  assert.equal(hms("2026-09-30T09:43:48.000Z"), "09:43:48Z");
  assert.equal(hms(null), "—");
  assert.equal(diff(4176, 1700), "+4,176 −1,700");
  assert.equal(diff(0, 0), "+0 −0");
  assert.equal(
    counts({ running: 2, completed: 1200, failed: 0, canceled: 1 }),
    "2 running · 1,200 completed · 1 canceled",
  );
  assert.equal(counts({ running: 0, completed: 0 }), "");
  // v0.12: a remote as owner/repo, from a web address, the scp form or an
  // ssh URL; a bare name and a path as they are, less a trailing .git; a URL
  // with no path keeps its host, as the generator does. The page escapes
  // what repo returns.
  assert.deepEqual(
    [
      "https://github.com/me/jev-a2a.git",
      "git@github.com:me/dotfiles.git",
      "ssh://git@github.com:22/me/repo.git",
      "https://gitlab.example/group/sub/project",
      "jev-a2a",
      "/srv/git/repo.git",
      "https://github.com",
      "",
      'https://evil.example/"><script>alert(1)</script>.git',
    ].map(repo),
    [
      "me/jev-a2a",
      "me/dotfiles",
      "me/repo",
      "group/sub/project",
      "jev-a2a",
      "/srv/git/repo",
      "github.com",
      "",
      '"><script>alert(1)</script>',
    ],
  );
});

test("every data-path of the v0.12 design is rendered for the fixture or dropped with a reason", () => {
  const lines = (name: string): string[] =>
    readFileSync(join(import.meta.dirname, "..", "design", name), "utf8")
      .split("\n")
      .filter((line) => line && !line.startsWith("#"));
  const listed = lines("v0.12-paths.txt");
  // The committed list is the extraction's output: distinct and sorted.
  assert.ok(listed.length > 100);
  assert.deepEqual(listed, [...new Set(listed)].sort());
  // The design's sample is synthetic and larger than the fixture, so paths
  // compare without their indexes: open[].deliveries[].latest.
  const shape = (path: string): string => path.replaceAll(/\[\d+\]/g, "[]");
  const design = [...new Set(listed.map(shape))].sort();
  const dropped = new Map(
    lines("v0.12-dropped.txt").map((line): [string, string] => {
      const at = line.lastIndexOf(" | ");
      return at < 0 ? [line, ""] : [line.slice(0, at), line.slice(at + 3)];
    }),
  );
  // The design's pages select an answer, a long working task, a choice, a
  // resolve and a task another agent sent; render each task of the fixture,
  // the record with the replaced session for the resolve form, the record
  // before T4's first reply, and the sample's record with T5 and its
  // telemetry, once more with a session the daemon does not know.
  const missing: Telemetry = {
    ...telemetry,
    placements: {
      ...telemetry.placements,
      "environment@mbp": emptySnapshot(telemetry.at, "missing"),
    },
  };
  const records = [
    ...[
      journal,
      replacedJournal,
      deliveredJournal,
      answeredJournal,
      attemptingJournal,
    ].map((entries) => model(ME, entries)),
    model(ME, sampleJournal, NOW, telemetry),
    model(ME, sampleJournal, NOW, missing),
  ];
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
    "v0.12 paths neither rendered nor in design/v0.12-dropped.txt",
  );
  for (const [path, reason] of dropped) {
    assert.ok(reason.trim(), `${path} is dropped without a reason`);
    assert.ok(design.includes(path), `${path} is not a v0.12 path`);
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
  assert.equal(textOf(html, "count(placements)"), "4 agents");
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
  assert.ok(!rail(html).includes('data-path="placements[2].session"'));
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
  // v0.12: the countdown carries the deadline as its title.
  assert.ok(
    html.includes(
      '<span class="num end" data-path="left(open[1].deadline, at), time(open[1].deadline)" title="deadline 2026-09-30 10:10Z">25m left</span>',
    ),
  );
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
    formsIn(rail(me))
      .filter((f) => f.fields.action === "hold")
      .map((f) => [f.fields.placement, f.fields.hold]),
    // The rail orders by state: the asking card, the held one, the ready
    // one, then the idle one with the replaced session.
    [
      ["orchestrator@mbp", "1"],
      ["environment@mbp", "0"],
      ["environment@mini", "1"],
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
  assert.deepEqual(textsOf(html, "open[0].status"), ["", "routing"]);
  assert.equal(textOf(html, "open[0].status, open[0].a2a"), "routing");
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
  // model's order; the fixture's order reversed still renders ask, work,
  // held, ready.
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
  assert.deepEqual(order(reversed), ["3", "2", "1", "0"]);
  // Two held placements keep the model's order between them.
  const held = me.placements[2];
  assert.ok(held?.hold);
  const twoHeld = renderBoard(
    {
      ...me,
      placements: [{ ...held, key: "environment@mba" }, ...me.placements],
    },
    { task: "T2" },
  );
  assert.deepEqual(order(twoHeld), ["1", "2", "0", "3", "4"]);
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
  // The head names the sender; its message is the title of "from ... at".
  assert.equal(textOf(html, "open[0].source"), "orchestrator");
  assert.ok(
    html.includes(
      '<span data-path="open[0].messageId" title="message M5 · orchestrator/M5">from ',
    ),
  );
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
  assert.match(strip(head), /from orchestrator via orchestrator@mbp at 09:44Z/);
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
  // v0.12: the deadline is the verdict's title.
  assert.match(strip(detail), /from you at 09:15Z · 1 of 1 delivery/);
  assert.ok(
    detail.includes(
      '<span class="end" data-path="finished[0].final, time(finished[0].deadline)" title="deadline 2026-09-30 10:15Z">1 of 1 delivery</span>',
    ),
  );
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
      '<span class="tick" data-path="time(at)" title="built 2026-09-30 09:45:00Z · no telemetry · jev-router-board/1">updated 09:45Z</span>',
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

test("v0.10 health: each card closes with the status line, the snapshot's age on a card with a delivery, and the lever; the meter; no telemetry without a snapshot", () => {
  const seen = rail(renderBoard(model(ME, sampleJournal, NOW, telemetry)));
  const rows = [...seen.matchAll(/<div class="tele">([^]*?)<\/div>/g)].map(
    (m) =>
      strip(m[1] ?? "")
        .replaceAll(/\s+/g, " ")
        .trim(),
  );
  assert.deepEqual(rows, [
    // Mid-turn, with the turn's age; the Answer link and Hold in the row.
    "running 29s · seen 10sAnswer T2Hold",
    // Stopped at a permission prompt: the names, in the accent; two
    // subagents run (v0.11).
    "asks permission: Bash · 2 subagents · seen 10sHold",
    // Busy on a prompt the router did not send, with one subagent; no
    // delivery, so no seen age (v0.12).
    "running 55s · 1 subagentHold",
    // Idle after a finished turn: how long ago it ended, then its window
    // as stale (v0.12); the idle card carries its meter in this row.
    "idle 21m · context 86%86%Release",
  ]);
  assert.ok(
    seen.includes(
      '<span class="ask" data-path="placements[1].agent.permissions[].name" title="Run rg over the vault">asks permission: Bash</span>',
    ),
  );
  // The meter: a bar with the share, in the warning role from 80% (v0.12),
  // the counts and cost as its tooltip; in the name row of a card that is
  // not collapsed.
  assert.ok(
    seen.includes(
      '<span class="meter warn" data-path="placements[2].agent.context, placements[2].agent.usage" title="171,500 of 200,000 tokens in context · since the session started: input 880, cached 1,204,000, output 44,120 · $9.61"><span class="bar"><i style="width: 86%"></i></span><span class="num" data-path="percent(placements[2].agent.context.used, placements[2].agent.context.max)">86%</span></span>',
    ),
  );
  assert.match(
    seen,
    /<div class="name"><span class="key" data-path="placements\[0\]\.key" role="button" aria-haspopup="dialog" title="Open the sheet \(s\)">orchestrator@mbp<\/span><span class="meter" data-path="placements\[0\]\.agent\.context, placements\[0\]\.agent\.usage"[^>]*><span class="bar"><i style="width: 31%"><\/i><\/span><span class="num" data-path="percent\(placements\[0\]\.agent\.context\.used, placements\[0\]\.agent\.context\.max\)">31%<\/span><\/span><span class="age num"/,
  );
  // Without telemetry: "no telemetry" on each card and in the tick's
  // title; the lever still closes the card.
  const none = rail(page(ME));
  assert.match(
    none,
    /class="tick" data-path="time\(at\)" title="[^"]*· no telemetry ·/,
  );
  assert.equal(
    [...none.matchAll(/<div class="tele">/g)].length,
    none.match(/<div class="card[ "]/g)?.length,
  );
  assert.match(
    none,
    /<span class="k" data-path="placements\[2\]\.agent">no telemetry<\/span><\/span><span class="lever">/,
  );
  // Error, missing and unreachable: the status dotted, the error (or a
  // sentence) as its tooltip, escaped; an attention of error on another
  // status adds a dotted "error".
  const down = renderBoard(
    model(ME, journal, NOW, {
      ...telemetry,
      placements: {
        "knowledge@mini": emptySnapshot(
          telemetry.at,
          "unreachable",
          "ssh: connect to host <mini> port 22: timed out",
        ),
        "environment@mbp": emptySnapshot(telemetry.at, "missing"),
        "orchestrator@mbp": {
          ...emptySnapshot(telemetry.at, "missing"),
          status: "idle",
          attention: "error",
          error: "context overflow",
        },
      },
    }),
  );
  assert.ok(
    down.includes(
      '<span class="err" data-path="placements[1].agent.status, placements[1].agent.error" title="ssh: connect to host &lt;mini&gt; port 22: timed out">unreachable</span>',
    ),
  );
  assert.ok(
    down.includes(
      '<span class="err" data-path="placements[2].agent.status, placements[2].agent.error" title="the daemon does not know this agent">missing</span>',
    ),
  );
  assert.ok(
    down.includes(
      '<span data-path="placements[0].agent.status">idle</span> · <span class="err" data-path="placements[0].agent.attention, placements[0].agent.error" title="context overflow">error</span>',
    ),
  );
  // A placement the file lacks reads "no telemetry" while the others have
  // a snapshot.
  const some = renderBoard(
    model(ME, journal, NOW, {
      ...telemetry,
      placements: { "knowledge@mini": emptySnapshot(telemetry.at, "missing") },
    }),
  );
  assert.ok(
    some.includes(
      '<span class="k" data-path="placements[0].agent">no telemetry</span>',
    ),
  );
  assert.ok(some.includes('data-path="placements[1].agent.status, '));
  // Edges: a permission wins over an error status; running without a turn
  // start has no age; no cost reported and no usage shape the tooltip; no
  // context, no meter; exactly 80% turns the meter warn.
  const idle = telemetry.placements["environment@mbp"];
  assert.ok(idle?.usage);
  const usage = idle.usage;
  const edges = renderBoard(
    model(ME, journal, NOW, {
      ...telemetry,
      placements: {
        "orchestrator@mbp": {
          ...idle,
          status: "error",
          error: "boom",
          permissions: [{ id: "p", name: "Edit", title: null, kind: "tool" }],
          context: { used: 160_000, max: 200_000 },
          usage: { ...usage, costUsd: null },
        },
        "knowledge@mini": {
          ...idle,
          status: "running",
          attention: null,
          turnStartedAt: null,
          context: { used: 10, max: 100 },
          usage: null,
        },
        "environment@mbp": { ...idle, context: null },
      },
    }),
  );
  assert.ok(
    edges.includes(
      '<span class="ask" data-path="placements[0].agent.permissions[].name" title="Edit">asks permission: Edit</span>',
    ),
  );
  assert.ok(
    edges.includes(
      '<span class="meter warn" data-path="placements[0].agent.context, placements[0].agent.usage" title="160,000 of 200,000 tokens in context · since the session started: input 880, cached 1,204,000, output 44,120 · no cost reported">',
    ),
  );
  assert.match(
    edges,
    /<span data-path="placements\[1\]\.agent\.status">running<\/span> · <span class="seen num"/,
  );
  assert.ok(
    edges.includes(
      '<span class="meter" data-path="placements[1].agent.context, placements[1].agent.usage" title="10 of 100 tokens in context">',
    ),
  );
  assert.ok(!edges.includes('data-path="placements[2].agent.context'));
});

test("v0.11 sheet: one per placement, hidden; the head repeats the card; Checkout as a grid, Subagents as a tree, Activity as a feed; null reads not read, empty reads none; every string escaped", () => {
  const html = renderBoard(model(ME, sampleJournal, NOW, telemetry));
  const all = sheets(html);
  assert.deepEqual(
    all.map((s) => s.match(/<aside class="sheet"[^>]*>/)?.[0]),
    [
      '<aside class="sheet" role="dialog" aria-label="orchestrator@mbp" data-path="placements[0]" data-key="orchestrator@mbp" hidden>',
      '<aside class="sheet" role="dialog" aria-label="knowledge@mini" data-path="placements[1]" data-key="knowledge@mini" hidden>',
      '<aside class="sheet" role="dialog" aria-label="environment@mbp" data-path="placements[2]" data-key="environment@mbp" hidden>',
      '<aside class="sheet" role="dialog" aria-label="environment@mini" data-path="placements[3]" data-key="environment@mini" hidden>',
    ],
  );
  const [o, k, e] = all;
  assert.ok(o && k && e);
  // The head: dot, name, meter, the status line with the seen age apart,
  // the levers, then the tags with host and session.
  assert.ok(
    o.includes(
      '<div class="name"><span class="dot ask" data-path="placements[0].delivery.latest.kind, placements[0].ready, placements[0].hold"></span><h2><span data-path="placements[0].key">orchestrator@mbp</span></h2><span class="meter" data-path="placements[0].agent.context, placements[0].agent.usage"',
    ),
  );
  assert.ok(
    o.includes(
      '<span class="seen num" data-path="age(placements[0].agent.seen, at)" title="2026-09-30 09:44Z">seen 10s</span></span><span class="lever"><a class="btn sm accent" data-path="needsYou[0].items[0]" href="?task=T2#answer-D1">Answer T2</a><form',
    ),
  );
  assert.ok(
    o.includes(
      '<span class="tag" data-path="placements[0].host">mbp</span><span class="tag" data-path="placements[0].session">session A1</span></div>',
    ),
  );
  // Checkout: the grid's rows for a dirty worktree ahead of its base with
  // an open pull request whose checks fail.
  const kv = (s: string): [string, string][] =>
    [...s.matchAll(/<dt>([^<]*)<\/dt><dd>([^]*?)<\/dd>/g)].map((m) => [
      m[1] ?? "",
      strip(m[2] ?? "").replaceAll(/\s+/g, " "),
    ]);
  assert.deepEqual(kv(o), [
    ["project", "A2A"],
    ["workspace", "feat-noticesworktree"],
    ["directory", "/home/me/Projects/jev-a2a/.paseo/worktrees/feat-notices"],
    ["branch", "feat/noticesme/jev-a2adirtyahead 3 · behind 0"],
    ["diff", "+412 −96"],
    [
      "pull request",
      "#21 feat(router): notices to participant sendersopenconflicts",
    ],
    ["checks", "checks failing·review pending"],
    ["status", "runningactive 20s"],
  ]);
  // v0.12: the remote as owner/repo, the whole URL as its title.
  assert.ok(
    o.includes(
      '<span class="mono muted remote" data-path="repo(placements[0].agent.checkout.remote)" title="https://github.com/me/jev-a2a.git">me/jev-a2a</span>',
    ),
  );
  assert.ok(
    o.includes(
      '<a class="pr" data-path="placements[0].agent.checkout.pr.number, placements[0].agent.checkout.pr.title, placements[0].agent.checkout.pr.url" href="https://github.com/me/jev-a2a/pull/21" title="#21 feat(router): notices to participant senders">#21 feat(router): notices to participant senders</a>',
    ),
  );
  assert.ok(
    o.includes(
      '<span class="role-warn" data-path="placements[0].agent.checkout.dirty">dirty</span>',
    ),
  );
  assert.ok(
    o.includes(
      '<span class="role-err" data-path="placements[0].agent.checkout.pr.checks">checks failing</span>',
    ),
  );
  assert.ok(
    o.includes(
      '<span class="num" data-path="diff(placements[0].agent.checkout.diff.additions, placements[0].agent.checkout.diff.deletions)">+412 −96</span>',
    ),
  );
  // A plain checkout: no diff, no pull request, the kind as words.
  assert.deepEqual(kv(k), [
    ["project", "vault"],
    ["workspace", "mainlocal checkout"],
    ["directory", "/Users/agent/vault"],
    ["branch", "main"],
    ["diff", "no diff"],
    ["pull request", "no pull request"],
    ["status", "needs inputactive 4m"],
  ]);
  // Subagents: counts, then none running; or the tree with the child
  // under its parent.
  assert.ok(
    o.includes(
      '<p class="counts-line" data-path="counts(placements[0].agent.subagents.counts)">3 completed</p><p class="none" data-path="placements[0].agent.subagents.running">none running</p>',
    ),
  );
  assert.ok(
    k.includes(
      '<p class="counts-line" data-path="counts(placements[1].agent.subagents.counts)">2 running · 5 completed · 1 canceled</p><div class="subs"><div class="subagent" data-path="placements[1].agent.subagents.running[0]"><span class="dot work" data-path="placements[1].agent.subagents.running[0].status" title="running"></span><span class="title" data-path="placements[1].agent.subagents.running[0].title" title="toolu_01sweep">worker</span>',
    ),
  );
  assert.ok(
    k.includes(
      '<div class="kids" data-path="placements[1].agent.subagents.running[].parent"><div class="subagent" data-path="placements[1].agent.subagents.running[1]">',
    ),
  );
  assert.ok(
    k.includes(
      '<span class="when" data-path="age(placements[1].agent.subagents.running[1].startedAt, at)" title="2026-09-30 09:40Z">started 4m</span>',
    ),
  );
  // The card's status line counts them (v0.11's one card change).
  assert.ok(
    rail(html).includes(
      '<span data-path="count(placements[1].agent.subagents.running)">2 subagents</span> · <span class="seen num"',
    ),
  );
  // Activity: turns in the heading; each row its seconds, kind word, tool
  // and status, text; the last row, a running tool, is current, its mark
  // the pulse dot in the text colour (v0.12).
  assert.ok(
    o.includes(
      '<h3><span class="kicker">Activity · last 8</span><span class="n" data-path="placements[0].agent.activity.turns">1 turn</span></h3>',
    ),
  );
  assert.ok(
    o.includes(
      '<div class="item" data-path="placements[0].agent.activity.items[2]"><span class="mark"></span><span class="at" data-path="hms(placements[0].agent.activity.items[2].at)" title="2026-09-30 09:44Z">09:44:35Z</span><span class="kind" data-path="placements[0].agent.activity.items[2].kind">tool</span><span class="what"><span class="tool" data-path="placements[0].agent.activity.items[2].tool">Read</span><span class="status" data-path="placements[0].agent.activity.items[2].status">completed</span><span class="text" data-path="placements[0].agent.activity.items[2].text" title="research/lab-images.md">research/lab-images.md</span></span></div>',
    ),
  );
  assert.ok(
    o.includes(
      '<div class="item now" data-path="placements[0].agent.activity.items[4]" aria-current="true"><span class="mark work"></span><span class="at" data-path="hms(placements[0].agent.activity.items[4].at)" title="2026-09-30 09:44Z">09:44:40Z</span><span class="kind" data-path="placements[0].agent.activity.items[4].kind">tool</span><span class="what"><span class="tool" data-path="placements[0].agent.activity.items[4].tool">Bash</span><span class="status running" data-path="placements[0].agent.activity.items[4].status">running</span>',
    ),
  );
  assert.ok(
    o.includes(
      '<span class="kind" data-path="placements[0].agent.activity.items[1].kind">reasoning</span>',
    ),
  );
  // Not read on a live session: no reason added.
  assert.ok(
    e.includes(
      '<p class="none" data-path="placements[2].agent.subagents">subagents not read</p>',
    ),
  );
  assert.ok(
    e.includes(
      '<p class="none" data-path="placements[2].agent.activity">activity not read</p>',
    ),
  );
  assert.ok(
    e.includes(
      '<span class="muted" data-path="placements[2].agent.checkout.branch">detached</span>',
    ),
  );

  // A closed session and a missing one: not read with the reason; a null
  // agent's sheet has the three sections not read and no tags.
  const closed = telemetry.placements["environment@mbp"];
  const sheetsOf = (t: Telemetry): string[] =>
    sheets(renderBoard(model(ME, sampleJournal, NOW, t)));
  const cold = sheetsOf({
    ...telemetry,
    placements: {
      ...telemetry.placements,
      "environment@mbp": {
        ...emptySnapshot(telemetry.at, "missing"),
        ...closed,
        status: "closed",
        attention: null,
        context: null,
        usage: null,
      },
      "knowledge@mini": emptySnapshot(telemetry.at, "missing"),
    },
  });
  assert.ok(
    cold[2]?.includes(
      '<p class="none" data-path="placements[2].agent.subagents">subagents not read · session not live</p>',
    ),
  );
  assert.ok(
    cold[2]?.includes(
      '<p class="none" data-path="placements[2].agent.activity">activity not read · session not live</p>',
    ),
  );
  assert.ok(
    cold[2]?.includes(
      '<span data-path="placements[2].agent.status">closed</span>',
    ),
  );
  assert.ok(
    cold[1]?.includes(
      '<p class="none" data-path="placements[1].agent.checkout">checkout not read</p>',
    ),
  );
  assert.ok(
    cold[1]?.includes(
      '<p class="none" data-path="placements[1].agent.subagents">subagents not read · session not live</p>',
    ),
  );
  const none = sheets(page(ME));
  assert.equal(none.length, 4);
  assert.ok(
    none[0]?.includes(
      '<span class="line"><span class="k" data-path="placements[0].agent">no telemetry</span></span>',
    ),
  );
  assert.ok(
    none[0]?.includes(
      '<div class="rig"><span class="tag" data-path="placements[0].host">mbp</span>',
    ),
  );
  assert.ok(none[0]?.includes("checkout not read</p>"));

  // Empty reads: no subagents at all, an empty tail, a pull request that is
  // a draft with conflicts and no review, a non-web URL that is not a link,
  // a parent that is not running (the child sits at the top level), and
  // hostile strings.
  const sharp = telemetry.placements["orchestrator@mbp"];
  const open = sharp?.checkout?.pr;
  const first = telemetry.placements["knowledge@mini"]?.subagents?.running[1];
  assert.ok(sharp?.checkout && open && first);
  const [odd, quiet] = sheetsOf({
    ...telemetry,
    placements: {
      "orchestrator@mbp": {
        ...sharp,
        checkout: {
          ...sharp.checkout,
          project: "<p>",
          workspace: "<w>",
          directory: "/tmp/<d>",
          branch: "<b>x</b>",
          remote: "git@<r>",
          dirty: false,
          ahead: 0,
          behind: 2,
          diff: null,
          pr: {
            ...open,
            title: '"><i>',
            url: "javascript:alert(1)",
            state: "<S>",
            draft: false,
            mergeable: "CONFLICTING",
            checks: null,
            review: null,
          },
          activityAt: null,
        },
        subagents: {
          counts: { running: 1, completed: 0, failed: 0, canceled: 0 },
          running: [
            {
              ...first,
              id: "<id>",
              title: "<x>",
              description: '"',
              parent: "gone",
            },
          ],
        },
        activity: {
          turns: 0,
          items: [
            {
              at: null,
              kind: "tool_call",
              text: "echo '<script>alert(1)</script>' & \"done\"",
              tool: "<Bash>",
              status: "failed",
            },
            {
              at: "2026-09-30T09:44:40.000Z",
              kind: "error",
              text: "boom",
              tool: null,
              status: null,
            },
            {
              at: "2026-09-30T09:44:41.000Z",
              kind: "compaction",
              text: "completed",
              tool: null,
              status: null,
            },
          ],
        },
      },
      "knowledge@mini": {
        ...sharp,
        subagents: {
          counts: { running: 0, completed: 0, failed: 0, canceled: 0 },
          running: [],
        },
        activity: { turns: 0, items: [] },
      },
    },
  });
  assert.ok(odd && quiet);
  // The strip leaves the entities: the markup never became tags.
  assert.deepEqual(kv(odd), [
    ["project", "&lt;p&gt;"],
    ["workspace", "&lt;w&gt;worktree"],
    ["directory", "/tmp/&lt;d&gt;"],
    ["branch", "&lt;b&gt;x&lt;/b&gt;git@&lt;r&gt;ahead 0 · behind 2"],
    ["diff", "no diff"],
    ["pull request", "#21 &quot;&gt;&lt;i&gt;&lt;s&gt;conflicts"],
    ["checks", "checks unknown"],
    ["status", "running"],
  ]);
  assert.ok(
    odd.includes(
      'data-path="placements[0].agent.checkout.directory" title="/tmp/&lt;d&gt;"',
    ),
  );
  assert.ok(!odd.includes("javascript:"));
  assert.ok(
    odd.includes(
      '<span class="pr" data-path="placements[0].agent.checkout.pr.number, placements[0].agent.checkout.pr.title, placements[0].agent.checkout.pr.url" title="#21 &quot;&gt;&lt;i&gt;">#21 &quot;&gt;&lt;i&gt;</span>',
    ),
  );
  assert.ok(
    odd.includes(
      '<span class="role-warn" data-path="placements[0].agent.checkout.pr.mergeable">conflicts</span>',
    ),
  );
  assert.ok(
    odd.includes(
      '<div class="subs"><div class="subagent" data-path="placements[0].agent.subagents.running[0]">',
    ),
  );
  assert.ok(!odd.includes('class="kids"'));
  assert.ok(
    odd.includes(
      '<span class="title" data-path="placements[0].agent.subagents.running[0].title" title="&lt;id&gt;">&lt;x&gt;</span><span class="desc" data-path="placements[0].agent.subagents.running[0].description" title="&quot;">&quot;</span>',
    ),
  );
  // No hostile tag survives once the page's own tags are taken out.
  assert.ok(
    !/<(p|w|d|r|s|id|x)>/i.test(
      odd.replace(
        /<\/?(p|dd|dt|dl|div|span|a|h2|h3|section|aside|button|form|input)\b[^>]*>/g,
        "",
      ),
    ),
  );
  assert.ok(
    odd.includes(
      '<div class="item" data-path="placements[0].agent.activity.items[0]"><span class="mark"></span><span class="at" data-path="hms(placements[0].agent.activity.items[0].at)">—</span><span class="kind" data-path="placements[0].agent.activity.items[0].kind">tool</span><span class="what"><span class="tool" data-path="placements[0].agent.activity.items[0].tool">&lt;Bash&gt;</span><span class="status role-err" data-path="placements[0].agent.activity.items[0].status">failed</span><span class="text" data-path="placements[0].agent.activity.items[0].text" title="echo \'&lt;script&gt;alert(1)&lt;/script&gt;\' &amp; &quot;done&quot;">echo \'&lt;script&gt;alert(1)&lt;/script&gt;\' &amp; &quot;done&quot;</span></span></div>',
    ),
  );
  assert.ok(!odd.includes("<script>alert"));
  assert.ok(
    odd.includes(
      '<div class="item error" data-path="placements[0].agent.activity.items[1]">',
    ),
  );
  assert.ok(
    odd.includes(
      '<div class="item quiet" data-path="placements[0].agent.activity.items[2]">',
    ),
  );
  assert.ok(
    odd.includes(
      '<span class="kind" data-path="placements[0].agent.activity.items[2].kind">compaction</span>',
    ),
  );
  // No turns among the items: the heading leaves the count out (v0.12).
  assert.ok(
    odd.includes('<h3><span class="kicker">Activity · last 8</span></h3>'),
  );
  assert.ok(!odd.includes("0 turns"));
  assert.ok(!odd.includes('data-path="placements[0].agent.activity.turns"'));
  assert.ok(
    quiet.includes(
      '<p class="none" data-path="placements[1].agent.subagents">none</p>',
    ),
  );
  assert.ok(
    quiet.includes(
      '<p class="none" data-path="placements[1].agent.activity.items">none</p>',
    ),
  );
  // The card's line carries no count when none run; the footer and the help
  // name the key.
  assert.ok(
    !rail(html).includes("count(placements[0].agent.subagents.running)"),
  );
  assert.ok(html.includes("<span><kbd>s</kbd> sheet</span>"));
  assert.ok(html.includes("<kbd>s</kbd><span>sheet</span>"));
});

// v0.12: a placement for stale(), with a delivery whose current send is M2.
const placement = (over: Partial<PlacementView> = {}): PlacementView => ({
  key: "orchestrator@mbp",
  participant: "orchestrator",
  host: "mbp",
  session: "A1",
  ready: true,
  hold: false,
  delivery: null,
  agent: null,
  ...over,
});
const sentAgo = (seconds: number): string =>
  new Date(NOW - seconds * 1000).toISOString();
const pinned = (
  latest: { kind: "question" | "working"; at: string } | null,
  question: { id: string; text: string; at: string | null } | null = null,
): PlacementView["delivery"] => ({
  id: "D1",
  taskId: "T2",
  excerpt: "Ask me something",
  messageId: "M2",
  outcome: "accepted",
  question,
  latest,
});
const running = (over: Partial<AgentSnapshot> = {}): PlacementView =>
  placement({
    agent: { ...emptySnapshot(AT, "missing"), status: "running", ...over },
  });
type Item = NonNullable<AgentSnapshot["activity"]>["items"][number];
const tail = (
  status: Item["status"],
  seconds: number,
  after: Item[] = [],
): AgentSnapshot["activity"] => ({
  turns: 1,
  items: [
    {
      at: sentAgo(seconds),
      kind: "tool_call",
      text: "ls",
      tool: "Bash",
      status,
    },
    ...after,
  ],
});

test("v0.12 stale: the generator's thresholds, strictly past, the first rule that applies", () => {
  const sent = (seconds: number) => ({ M2: sentAgo(seconds) });
  const quiet = placement({ delivery: pinned(null) });
  // No reply past 30 minutes: not at 30, from a second past.
  assert.equal(stale(quiet, AT, sent(30 * 60)), null);
  assert.equal(stale(quiet, AT, sent(30 * 60 + 1)), "no reply 30m");
  // An update is a reply, however old the send.
  const replied = pinned({ kind: "working", at: sentAgo(40 * 60) });
  assert.equal(
    stale(placement({ delivery: replied }), AT, sent(45 * 60)),
    null,
  );
  // A question still open waits on a person, not on the session; once
  // answered, the answer is the current send and has no reply yet (the
  // page reads that as unreplied too; the design does not).
  const question = { id: "Q2", text: "Force push?", at: sentAgo(40 * 60) };
  const asked = pinned({ kind: "question", at: sentAgo(40 * 60) }, question);
  assert.equal(stale(placement({ delivery: asked }), AT, sent(45 * 60)), null);
  const answered = pinned({ kind: "question", at: sentAgo(40 * 60) });
  assert.equal(
    stale(placement({ delivery: answered }), AT, sent(31 * 60)),
    "no reply 31m",
  );
  // A clock that does not read is not stale.
  assert.equal(stale(quiet, AT, { M2: "<b>soon</b>" }), null);
  assert.equal(stale(quiet, AT, {}), null);
  // A turn past 15 minutes, only while running.
  assert.equal(
    stale(running({ turnStartedAt: sentAgo(15 * 60) }), AT, {}),
    null,
  );
  assert.equal(
    stale(running({ turnStartedAt: sentAgo(15 * 60 + 1) }), AT, {}),
    "turn 15m",
  );
  assert.equal(
    stale(running({ status: "idle", turnStartedAt: sentAgo(3600) }), AT, {}),
    null,
  );
  // A tool running past 5 minutes, when it is the tail's last item.
  assert.equal(
    stale(running({ activity: tail("running", 5 * 60) }), AT, {}),
    null,
  );
  assert.equal(
    stale(running({ activity: tail("running", 5 * 60 + 1) }), AT, {}),
    "tool 5m",
  );
  assert.equal(
    stale(running({ activity: tail("completed", 3600) }), AT, {}),
    null,
  );
  const later: Item = {
    at: sentAgo(30),
    kind: "assistant_message",
    text: "done",
    tool: null,
    status: null,
  };
  assert.equal(
    stale(running({ activity: tail("running", 3600, [later]) }), AT, {}),
    null,
  );
  // The context window from 80%.
  const window = (used: number) => running({ context: { used, max: 200_000 } });
  assert.equal(stale(window(158_000), AT, {}), null);
  assert.equal(stale(window(160_000), AT, {}), "context 80%");
  // The first that applies: reply, turn, tool, context.
  const all = {
    turnStartedAt: sentAgo(20 * 60),
    activity: tail("running", 10 * 60),
    context: { used: 190_000, max: 200_000 },
  };
  assert.equal(
    stale({ ...running(all), delivery: pinned(null) }, AT, sent(40 * 60)),
    "no reply 40m",
  );
  assert.equal(stale(running(all), AT, {}), "turn 20m");
  assert.equal(
    stale(running({ ...all, turnStartedAt: sentAgo(60) }), AT, {}),
    "tool 10m",
  );
  assert.equal(
    stale(
      running({ ...all, turnStartedAt: sentAgo(60), activity: null }),
      AT,
      {},
    ),
    "context 95%",
  );
  // A placement with no telemetry is stale only for want of a reply.
  assert.equal(
    stale(placement({ delivery: pinned(null) }), AT, sent(31 * 60)),
    "no reply 31m",
  );

  // stale_task: an open task with an unended delivery whose current send
  // has no reply past 30 minutes. T4's request went at 09:40 and has no
  // reply before 09:44.
  const t4 = (now: number) => {
    const m = model(ME, deliveredJournal, now);
    const t = [...m.open, ...m.finished].find((x) => x.id === "T4");
    assert.ok(t);
    return staleTask(t, m.at, m.times);
  };
  assert.equal(t4(NOW + 25 * 60_000), null);
  assert.equal(t4(NOW + 25 * 60_000 + 1000), "no reply 30m");
  // Finished, it is not stale.
  assert.equal(t4(LATER), null);
  // T2's answer went at 09:16 and has no reply.
  const t2 = (now: number) => {
    const m = model(ME, answeredJournal, now);
    const t = m.open.find((x) => x.id === "T2");
    assert.ok(t);
    return staleTask(t, m.at, m.times);
  };
  assert.equal(t2(NOW + 60_000), null);
  assert.equal(t2(NOW + 61_000), "no reply 30m");
  // With replies since its answer, T2 in the fixture is not stale.
  const fixture = model(ME);
  const replies = fixture.open.find((x) => x.id === "T2");
  assert.ok(replies);
  assert.equal(staleTask(replies, fixture.at, fixture.times), null);
});

test("v0.12 stale on the page: in the warning role at the end of a card's status line, of the sheet head's, and of a row's second line", () => {
  // The sample: environment@mbp's window at 86% (the meter turns warn);
  // T1's request, 43 minutes old, has no reply.
  const html = renderBoard(sampleModel(), { task: "T2" });
  const late =
    '<span class="role-warn num" data-path="stale(placements[2], at)">context 86%</span>';
  assert.ok(
    rail(html).includes(
      `<span data-path="placements[2].agent.status">idle</span> <span class="num" data-path="age(placements[2].agent.attentionAt, at)" title="2026-09-30 09:23Z">21m</span> · ${late}</span><span class="meter warn"`,
    ),
  );
  const head = sheets(html)[2] ?? "";
  assert.ok(
    head.includes(
      `${late} · <span class="seen num" data-path="age(placements[2].agent.seen, at)" title="2026-09-30 09:44Z">seen 9s</span></span>`,
    ),
  );
  assert.ok(
    html.includes(
      '<span class="to" data-path="open[3].recipient">orchestrator</span><span class="stale role-warn num" data-path="stale_task(open[3], at)">no reply 43m</span></div>',
    ),
  );
  // No other row or card is stale.
  assert.equal(html.match(/role-warn num" data-path="stale/g)?.length, 3);
  // A delivery with no reply on a card: T4's, 31 minutes on, without
  // telemetry.
  const quiet = page(ME, { task: "T4" }, deliveredJournal, NOW + 26 * 60_000);
  assert.ok(
    rail(quiet).includes(
      '<span class="k" data-path="placements[1].agent">no telemetry</span> · <span class="role-warn num" data-path="stale(placements[1], at)">no reply 31m</span></span>',
    ),
  );
  assert.ok(
    quiet.includes(
      '<span class="to" data-path="open[0].recipient">knowledge</span><span class="stale role-warn num" data-path="stale_task(open[0], at)">no reply 31m</span>',
    ),
  );
  // The row's phrase is only for an open task.
  assert.ok(!page(ME, {}, journal, LATER).includes('data-path="stale_task('));
});

test("v0.12 busy: a session running with no delivery and no hold ranks after the work and reads busy; a held one stays held; not ready is for the rest", () => {
  const order = (html: string): string[] =>
    [
      ...html.matchAll(
        /<div class="card[^"]*" tabindex="0" data-path="placements\[(\d)\]">/g,
      ),
    ].map((m) => m[1] ?? "");
  const sample = sampleModel();
  const html = renderBoard(sample, { task: "T2" });
  // Asking, working, busy, held.
  assert.deepEqual(order(html), ["0", "1", "3", "2"]);
  assert.ok(
    html.includes(
      `    <div class="card" tabindex="0" data-path="placements[3]">
      <span class="dot busy" data-path="placements[3].delivery.latest.kind, placements[3].ready, placements[3].hold, placements[3].agent.status"></span>
      <div class="body">
        <div class="name"><span class="key" data-path="placements[3].key" role="button" aria-haspopup="dialog" title="Open the sheet (s)">environment@mini</span><span class="meter" data-path="placements[3].agent.context, placements[3].agent.usage"`,
    ),
  );
  assert.ok(
    html.includes(
      `<div class="what busy"><span data-path="placements[3].agent.status">busy</span></div>
        <div class="tele"><span class="line"><span data-path="placements[3].agent.status">running</span> <span class="num" data-path="age(placements[3].agent.turnStartedAt, at)" title="2026-09-30 09:44Z">55s</span> · <span data-path="count(placements[3].agent.subagents.running)">1 subagent</span></span><span class="lever">`,
    ),
  );
  // The sheet's head repeats the dot.
  assert.ok(
    (sheets(html)[3] ?? "").includes(
      '<span class="dot busy" data-path="placements[3].delivery.latest.kind, placements[3].ready, placements[3].hold"></span>',
    ),
  );
  // Busy comes before held whatever the model's order.
  assert.deepEqual(
    order(
      renderBoard({ ...sample, placements: [...sample.placements].reverse() }),
    ),
    ["3", "2", "0", "1"],
  );
  const with_ = (key: string, over: Partial<PlacementView>): BoardModel => ({
    ...sample,
    placements: sample.placements.map((p) =>
      p.key === key ? { ...p, ...over } : p,
    ),
  });
  // Held and running stays held.
  const heldAgent = sample.placements[2]?.agent;
  assert.ok(heldAgent);
  const heldRunning = renderBoard(
    with_("environment@mbp", { agent: { ...heldAgent, status: "running" } }),
  );
  assert.match(
    heldRunning,
    /<div class="card idle" tabindex="0" data-path="placements\[2\]">\s*<span class="dot held"/,
  );
  // Neither ready nor running reads not ready; ready and idle reads ready.
  const busyAgent = sample.placements[3]?.agent;
  assert.ok(busyAgent);
  const idle = { ...busyAgent, status: "idle" as const };
  assert.ok(
    renderBoard(with_("environment@mini", { agent: idle })).includes(
      '<div class="what"><span data-path="placements[3].ready">not ready</span></div>',
    ),
  );
  assert.ok(
    renderBoard(
      with_("environment@mini", { agent: idle, ready: true }),
    ).includes(
      '<div class="what"><span data-path="placements[3].ready">ready</span> · no open delivery</div>',
    ),
  );
  // Without telemetry nothing is busy.
  assert.ok(!page(ME).includes("dot busy"));
});

test("v0.12 cards: no tags row (the sheet keeps the tags); the seen age only on a card with a delivery", () => {
  const html = renderBoard(sampleModel(), { task: "T2" });
  const cards = rail(html);
  assert.ok(!cards.includes('class="rig"'));
  assert.ok(!cards.includes('class="tag"'));
  assert.ok(
    (sheets(html)[1] ?? "").includes(
      '<div class="rig"><span class="tag" data-path="placements[1].agent.provider, placements[1].agent.model">codex/gpt-5.5</span><span class="tag" data-path="placements[1].agent.thinking" title="thinking medium">medium</span><span class="tag" data-path="placements[1].agent.mode" title="mode default">default</span><span class="tag" data-path="placements[1].host">mini</span><span class="tag" data-path="placements[1].session">session K1</span></div>',
    ),
  );
  // Seen on the two cards with a delivery, not on the busy or held one; the
  // sheet's head always shows it.
  assert.deepEqual(
    [
      ...cards.matchAll(
        /data-path="age\(placements\[(\d)\]\.agent\.seen, at\)"/g,
      ),
    ].map((m) => m[1]),
    ["0", "1"],
  );
  assert.equal(
    sheets(html).filter((s) => s.includes('class="seen num"')).length,
    4,
  );
});

test("v0.12 nav: who truncates with its whole text as title, the tick reads updated with the build, telemetry and contract as title, one JSON link, no theme switch", () => {
  const html = renderBoard(sampleModel(), { task: "T2" });
  const nav = html.slice(
    html.indexOf('<header class="nav">'),
    html.indexOf("</header>"),
  );
  assert.ok(
    nav.includes(
      '<span class="who" title="me@example.com · you (requester), operator"><span data-path="actor.login">me@example.com</span> · <span data-path="actor.principals[]">you (requester), operator</span></span>',
    ),
  );
  assert.ok(
    nav.includes(
      '<span class="tick" data-path="time(at)" title="built 2026-09-30 09:45:00Z · telemetry 2026-09-30 09:44:51Z · jev-router-board/1">updated 09:45Z</span>',
    ),
  );
  assert.ok(!nav.includes("themes"));
  assert.equal(html.match(/href="board\.json"/g)?.length, 1);
  assert.ok(nav.includes('<a href="board.json">JSON</a>'));
  assert.ok(
    STYLE_HAS(
      html,
      ".nav .who { flex: 0 1 auto; min-width: 0; max-width: 260px; overflow: hidden; text-overflow: ellipsis; white-space: nowrap;",
    ),
  );
  // Nobody identified: the same words as title.
  assert.ok(
    page(null).includes(
      '<span class="who" title="reading only · not identified"><span data-path="actor">reading only · not identified</span></span>',
    ),
  );
});

test("v0.12 head: one line, with the message, the deadline and the a2a token as titles", () => {
  const html = page(ME, { task: "T2" });
  assert.ok(
    detailOf(html).includes(
      '<div class="meta">to <span class="mono" data-path="open[1].recipient">orchestrator</span> · <span data-path="open[1].chosenBy">named on the request</span> · <span data-path="open[1].messageId" title="message M2 · you/M2">from <span class="mono" data-path="open[1].source">you</span> at <span class="num" data-path="time(times[open[1].messageId])" title="2026-09-30 09:10Z">09:10Z</span></span> · <span class="num end" data-path="left(open[1].deadline, at), time(open[1].deadline)" title="deadline 2026-09-30 10:10Z">25m left</span></div>',
    ),
  );
  assert.ok(
    html.includes(
      '<span class="badge ask" data-path="open[1].status, open[1].a2a" title="TASK_STATE_INPUT_REQUIRED">needs answer</span>',
    ),
  );
  // The token line is gone.
  assert.ok(!html.includes('data-path="open[1].a2a"'));
  assert.ok(!strip(detailOf(html)).includes("TASK_STATE"));
  // A canceled task's verdict keeps its reason and who ended it after the
  // count, which carries the deadline.
  const canceled = page(
    ME,
    { task: "T5" },
    extend(
      {
        type: "submit",
        by: "you",
        messageId: "M5",
        text: "Check",
        to: "environment",
        hosts: ["mbp"],
      },
      { type: "cancel", by: "you", taskId: "T5" },
    ),
  );
  assert.match(
    detailOf(canceled),
    /<span class="end" data-path="finished\[0\]\.final, time\(finished\[0\]\.deadline\)" title="deadline 2026-09-30 10:44Z">0 of 1 delivery<\/span> · <span data-path="finished\[0\]\.final\.reason">sender<\/span> · by <span data-path="finished\[0\]\.final\.by">you<\/span><\/div>/,
  );
});

test("v0.12 log and help: the log collapses to its newest line and l opens it; the help lists the keys in a grid and ends with the theme switch", () => {
  const html = renderBoard(sampleModel(), { task: "T2", theme: "one-dark" });
  const m = sampleModel();
  assert.ok(
    html.includes(
      `<div class="foot"><div><span class="kicker">Router log</span> · <span data-path="count(log)">last ${m.log.length}</span> · <kbd class="k">l</kbd></div><div class="lines"><div class="tail">`,
    ),
  );
  // Every line is in the page; the style shows the newest until l opens it.
  assert.ok(html.includes(`data-path="log[${m.log.length - 1}]"`));
  assert.ok(
    STYLE_HAS(
      html,
      ".agents .foot:not(.open) .tail > div:not(:last-child) { display: none; }",
    ),
  );
  assert.ok(
    html.includes(
      "<span><kbd>h</kbd> hold</span><span><kbd>l</kbd> log</span>",
    ),
  );
  const help = html.slice(
    html.indexOf('<div class="help"'),
    html.indexOf("<script>"),
  );
  assert.ok(
    help.startsWith(
      '<div class="help" role="dialog" aria-label="Keys" hidden>\n  <div class="top"><span class="kicker">Keys</span><span class="spacer"></span><kbd class="k">?</kbd></div>',
    ),
  );
  assert.deepEqual(
    [...help.matchAll(/<kbd>([^<]*)<\/kbd><span>([^<]*)<\/span>/g)].map(
      (k) => `${k[1]} ${k[2]}`,
    ),
    [
      "j / k move",
      "space peek",
      "↵ open",
      "→ open the peek's task",
      "s sheet",
      "a answer",
      "c cancel",
      "h hold / release",
      "l router log",
      "/ filter",
      "⌘↩ send the form (or Ctrl ↩)",
      "esc close",
    ],
  );
  assert.ok(
    help.includes(
      '<div class="theme"><span>theme</span><span class="themes" role="group" aria-label="Theme"><button type="button" data-theme="flexoki" aria-pressed="false">Flexoki</button><button type="button" data-theme="one-dark" class="on" aria-pressed="true">One Dark</button></span></div>\n</div>',
    ),
  );
  // The page's script binds l and parses.
  const script = html.slice(
    html.indexOf("<script>") + 8,
    html.lastIndexOf("</script>"),
  );
  assert.ok(script.includes("  l: toggleLog,"));
  assert.doesNotThrow(() => new Function(script));
});

test("v0.12 escapes what it adds: the remote and its title, the who title, the message title", () => {
  const m = sampleModel();
  const sharp = m.placements[0]?.agent;
  const checkout = sharp?.checkout;
  assert.ok(sharp && checkout && m.actor);
  const hostile = '"><script>alert(1)</script>';
  const odd: BoardModel = {
    ...m,
    actor: { ...m.actor, login: `x${hostile}@example.com` },
    placements: m.placements.map((p, i) =>
      i === 0
        ? {
            ...p,
            agent: {
              ...sharp,
              checkout: { ...checkout, remote: `https://h/${hostile}.git` },
            },
          }
        : p,
    ),
  };
  const t2 = odd.open.find((t) => t.id === "T2");
  assert.ok(t2);
  t2.source = `you/${hostile}`;
  const html = renderBoard(odd, { task: "T2" });
  assert.ok(!html.includes("<script>alert"));
  const safe = "&quot;&gt;&lt;script&gt;alert(1)&lt;/script&gt;";
  assert.ok(
    html.includes(
      `<span class="mono muted remote" data-path="repo(placements[0].agent.checkout.remote)" title="https://h/${safe}.git">${safe}</span>`,
    ),
  );
  assert.ok(
    html.includes(
      `<span class="who" title="x${safe}@example.com · you (requester), operator">`,
    ),
  );
  assert.ok(html.includes(`title="message M2 · you/${safe}">from`));
});

test("the README's screenshots: the sample board, and the same page with one sheet shown", () => {
  const pages = shots();
  assert.deepEqual(Object.keys(pages), ["board", "board-sheet"]);
  assert.equal(
    sheets(pages.board ?? "").filter((s) => !s.includes(" hidden>")).length,
    0,
  );
  assert.deepEqual(
    sheets(pages["board-sheet"] ?? "")
      .filter((s) => !s.includes(" hidden>"))
      .map((s) => s.match(/data-key="([^"]*)"/)?.[1]),
    ["orchestrator@mbp"],
  );
});
