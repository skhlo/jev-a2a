// The board page: the v0.6 design drawn from the view model and the viewer,
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
  config,
  extend,
  journal,
  NOW,
  replacedJournal,
} from "./board-fixture.ts";
import { dataPaths } from "./design-paths.ts";
import type { Entry } from "./journal.ts";
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

test("every data-path of the v0.6 design is rendered for the fixture or dropped with a reason", () => {
  const lines = (name: string): string[] =>
    readFileSync(join(import.meta.dirname, "..", "design", name), "utf8")
      .split("\n")
      .filter((line) => line && !line.startsWith("#"));
  const design = lines("v0.6-paths.txt");
  // The committed list is the extraction's output: distinct and sorted.
  assert.ok(design.length > 100);
  assert.deepEqual(design, [...new Set(design)].sort());
  const dropped = new Map(
    lines("v0.6-dropped.txt").map((line): [string, string] => {
      const at = line.lastIndexOf(" | ");
      return at < 0 ? [line, ""] : [line.slice(0, at), line.slice(at + 3)];
    }),
  );
  // The design's three pages select T2, T4 and T1; render each task.
  const me = model(ME);
  const rendered = new Set(
    ["T1", "T2", "T3", "T4"].flatMap((task) =>
      dataPaths(renderBoard(me, { task })),
    ),
  );
  assert.deepEqual(
    design.filter((path) => !rendered.has(path) && !dropped.has(path)),
    [],
    "v0.6 paths neither rendered nor in design/v0.6-dropped.txt",
  );
  for (const [path, reason] of dropped) {
    assert.ok(reason.trim(), `${path} is dropped without a reason`);
    assert.ok(design.includes(path), `${path} is not a v0.6 path`);
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
  assert.equal(
    textOf(html, "placements[2].delivery"),
    "no delivery pinned to this session",
  );
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
  assert.ok(
    detailOf(html).indexOf("Force push?") <
      detailOf(html).indexOf('<form class="form"'),
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
    question: "Q2",
  });
  assert.deepEqual(answer?.inputs, ["text"]);
  assert.ok(guest.includes(">Answer T2</a>"));
  assert.ok(!guest.includes('value="resolve"'));
  assert.ok(!guest.includes('value="hold"'));
  assert.match(
    guest,
    /waits on <span data-path="needsYou\[1\]\.principal">operator<\/span>/,
  );
  const guestT4 = page(GUEST, { task: "T4" }, replacedJournal);
  assert.ok(!guestT4.includes('value="resolve"'));
  assert.ok(guestT4.includes('class="form ro"'));

  // An operator: the resolve form and the hold levers.
  const me = page(ME, { task: "T4" }, replacedJournal);
  assert.deepEqual(groups(me)["needs-you"], ["T1", "T2", "T4"]);
  const resolve = formFor(me, "resolve");
  assert.deepEqual(resolve?.fields, {
    action: "resolve",
    delivery: "D3",
    message: "M4",
  });
  assert.deepEqual(resolve?.inputs, ["evidence"]);
  assert.deepEqual(resolve?.buttons, [
    ["outcome", "finished"],
    ["outcome", "not_sent"],
  ]);
  assert.deepEqual(
    formsIn(me)
      .filter((f) => f.fields.action === "hold")
      .map((f) => [f.fields.placement, f.fields.hold]),
    [
      ["orchestrator@mbp", "1"],
      ["knowledge@mini", "1"],
      ["environment@mbp", "0"],
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
  assert.ok(!teamFirst.includes("<form"));
  assert.match(strip(detailOf(teamFirst)), /question Q2 · waits on you/);
  const youFirst = renderBoard(modelFor(["you", "team"], roles), {
    task: "T2",
  });
  assert.deepEqual(formFor(youFirst, "answer")?.fields, {
    action: "answer",
    task: "T2",
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
