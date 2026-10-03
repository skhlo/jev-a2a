// The board's page: the v0.7 console of the board design (skhlo/designs, tag
// jev-a2a-v0.7, scripts/gen-jev-a2a-board.py), drawn on the server from the
// view model and the viewer. The template translates the generator's HTML
// functions and carries its CSS: every slot keeps the data-path the design
// gives it, rows keep data-task and groups data-group, so the live page can
// be compared with the design mechanically. Forms post to the board's
// actions endpoint with its own fields. The page reads and posts without a
// script; the script keeps a person's state across refreshes and adds the
// theme switch, the filter, the keys and the peek.
import type {
  BoardModel,
  DeliveryView,
  PlacementView,
  TaskView,
} from "./board.ts";
import type {
  Judgment,
  NeedsYouItem,
  Role,
  SendOutcome,
  StuckReason,
} from "./types.ts";

// ---- Formats: the generator's helpers over the same fields ----

const DASH = "—";

const esc = (value: unknown): string =>
  String(value)
    .replaceAll("&", "&amp;")
    .replaceAll("<", "&lt;")
    .replaceAll(">", "&gt;")
    .replaceAll('"', "&quot;");

const instant = (iso: string | null | undefined): Date | null => {
  const ms = iso ? Date.parse(iso) : NaN;
  return Number.isNaN(ms) ? null : new Date(ms);
};

// time(t): the clock as HH:MMZ, or a dash without a time.
export const time = (iso: string | null | undefined): string => {
  const at = instant(iso);
  return at ? `${at.toISOString().slice(11, 16)}Z` : DASH;
};

// A stretch of time in its largest unit, floored: 45s, 14m, 2h 05m, 3d.
const span = (ms: number): string => {
  const s = Math.abs(Math.trunc(ms / 1000));
  if (s < 60) return `${s}s`;
  if (s < 3600) return `${Math.floor(s / 60)}m`;
  if (s < 86400) {
    const h = Math.floor(s / 3600);
    const m = Math.floor((s % 3600) / 60);
    return m ? `${h}h ${String(m).padStart(2, "0")}m` : `${h}h`;
  }
  return `${Math.floor(s / 86400)}d`;
};

// age(t, at): how long before `at` t was, or a dash without a time.
export const age = (iso: string | null | undefined, at: string): string =>
  iso ? span(Date.parse(at) - Date.parse(iso)) : DASH;

// left(deadline, at): the countdown to the deadline, or how far past it.
export const left = (deadline: string, at: string): string => {
  const ms = Date.parse(deadline) - Date.parse(at);
  return ms >= 0 ? `${span(ms)} left` : `overdue ${span(ms)}`;
};

const noun = (n: number, one: string, many = `${one}s`): string =>
  n === 1 ? one : many;

// count(xs): how many, with the noun that reads right for one and for many.
// The design printed the plural for every number.
export const count = (n: number, one: string, many = `${one}s`): string =>
  `${n} ${noun(n, one, many)}`;

// label(status): a router name as words.
export const label = (name: string): string => name.replaceAll("_", " ");

// The full date behind a clock or an age, as a title. The design printed
// the clock alone, which is ambiguous for anything older than a day.
const dated = (iso: string | null | undefined): string => {
  const at = instant(iso);
  return at
    ? ` title="${at.toISOString().slice(0, 16).replace("T", " ")}Z"`
    : "";
};

// A task's first line, for the detail title: the design sized the title for
// the sample's short texts, and a real request runs to pages. The full text
// is in the transcript, and in the title attribute.
const headline = (text: string): string =>
  text
    .split(/\r?\n/)
    .map((line) => line.trim())
    .find((line) => line) ?? text;

// Paseo session ids are UUIDs, which wrap a card and widen a table. An id
// that is one shows its first eight characters, and `fullId` puts the whole
// id in the title attribute of the element that shows it. Other ids (the
// fixture's A1, an operator's login in an end line) are unchanged.
const UUID = /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/i;
const shortId = (id: string): string => (UUID.test(id) ? id.slice(0, 8) : id);
const fullId = (id: string): string =>
  UUID.test(id) ? ` title="${esc(id)}"` : "";

// An element that names the model path it reads.
const slot = (
  path: string,
  html: string,
  cls = "",
  tag = "span",
  attrs = "",
): string =>
  `<${tag}${cls ? ` class="${cls}"` : ""} data-path="${esc(path)}"${attrs}>${html}</${tag}>`;

const hidden = (fields: Record<string, string>): string =>
  Object.entries(fields)
    .map(([k, v]) => `<input type="hidden" name="${esc(k)}" value="${esc(v)}">`)
    .join("");

// A form for the actions endpoint, with the fields actionEvent reads. The
// URL is relative because Tailscale Serve strips the board's mount path.
const form = (
  fields: Record<string, string>,
  body: string,
  attrs = "",
): string =>
  `<form${attrs} method="post" action="actions">${hidden(fields)}${body}</form>`;

const href = (taskId: string, hash = ""): string =>
  esc(`?task=${encodeURIComponent(taskId)}${hash}`);

// What a waiting delivery waits for, in words.
const waitText = (
  placement: string,
  waits: NonNullable<DeliveryView["waits"]>,
): string => {
  switch (waits.reason) {
    case "queued_behind":
      return `queued behind ${esc(waits.behind ?? DASH)}`;
    case "held":
      return `held on ${esc(placement)}`;
    case "not_ready":
      return `waits for ${esc(placement)} to be ready`;
    case "in_flight":
      return `behind an unconfirmed send on ${esc(placement)}`;
    case "session_replaced":
      return `its session on ${esc(placement)} was replaced`;
  }
};

// Jev's judgment as one line. An invalid judgment has no probabilities, so
// it shows the choice alone; the generator formatted a missing probability
// and failed.
const jevLine = (j: Judgment): string => {
  const table = j.probabilities ?? {};
  const p = table[j.choice];
  const runnerUp = Object.entries(table)
    .filter(([id]) => id !== j.choice)
    .sort(([a, x], [b, y]) => y - x || (a < b ? 1 : a > b ? -1 : 0))[0];
  const verdict =
    !j.valid || p === undefined
      ? `Jev: ${esc(j.choice)}, judgment invalid`
      : p >= j.threshold
        ? `Jev picked ${esc(j.choice)} at ${p.toFixed(2)}`
        : `Jev: ${esc(j.choice)} at ${p.toFixed(2)} is under the threshold ${j.threshold}`;
  // A runner-up that rounds to 0.00 says nothing.
  const second =
    runnerUp && runnerUp[1].toFixed(2) !== "0.00"
      ? `, runner-up ${esc(runnerUp[0])} ${runnerUp[1].toFixed(2)}`
      : "";
  return `${verdict}${second}${j.model ? ` · ${esc(j.model)}` : ""}`;
};

const CHOSEN_BY: Record<NonNullable<TaskView["chosenBy"]>, string> = {
  judgment: "chosen by Jev",
  address: "named on the request",
  sender: "chosen by the sender",
};

// A card's dot: the session's state. `wait` is a question for another
// principal, which waits like one for the viewer, in grey.
type Dot = "ask" | "wait" | "work" | "held" | "ready" | "off";
// The rail's order: asking, working or delivered, held, ready, not ready;
// the model's order within a state.
const RANK: Record<Dot, number> = {
  ask: 0,
  wait: 0,
  work: 1,
  held: 2,
  ready: 3,
  off: 4,
};

// A delivery with no update yet is delivered once the session accepted its
// send. It is pinned at the attempt, so before the outcome arrives the page
// says what the send is (attempting, unknown, pending); the design's sample
// never held such a send.
const sentWords = (outcome: SendOutcome, delivered: string): string =>
  outcome === "accepted" ? delivered : `${esc(outcome)}, no reply yet`;

// Why a delivery needs an operator, as the resolve form says it.
const RESOLVE_WHY: Record<StuckReason, string> = {
  task_ended: "The task ended before the router could confirm this send.",
  session_replaced:
    "The session that took this send is gone, so the router cannot confirm it.",
  unknown_send: "The router has no record of this send reaching the session.",
};

const ASKING: TaskView["status"][] = [
  "needs_answer",
  "needs_recipient",
  "uncertain",
];

export const THEMES = ["flexoki", "one-dark"] as const;
const THEME_NAMES: Record<(typeof THEMES)[number], string> = {
  flexoki: "Flexoki",
  "one-dark": "One Dark",
};

export type RenderOptions = {
  refreshSeconds?: number;
  // Outcome of the last action, shown until dismissed.
  notice?: string | null;
  // The selected task, from the page's `task` query parameter.
  task?: string | null;
  // The palette, from the router-theme cookie. Anything but a palette name
  // gets the default, so the cookie cannot put text into the page.
  theme?: string | null;
};

// A needs-you item with its place in the model and what the viewer may do.
type Item = {
  path: string;
  group: number;
  principal: string;
  item: NeedsYouItem;
  // It counts for the viewer: the viewer holds its principal. Without a
  // viewer the page shows every principal's items, read only.
  mine: boolean;
  // The viewer's post for it is signed as its principal, so the actions
  // endpoint accepts it.
  act: boolean;
};

// The page for `model` as its actor sees it. Pure: the model, the viewer in
// it and the options decide every byte.
export function renderBoard(
  model: BoardModel,
  options: RenderOptions = {},
): string {
  const { actor, at, times } = model;
  const refreshSeconds = options.refreshSeconds ?? 10;
  const theme = THEMES.find((name) => name === options.theme) ?? THEMES[0];
  const roleOf = (principal: string): Role | undefined =>
    actor?.principals.find((p) => p.principal === principal)?.role;
  const operator = actor?.principals.some((p) => p.role === "operator");
  // The principal a post is signed as. A post does not name one: the
  // actions endpoint takes the viewer's first principal in the role the
  // action needs, so the page offers forms for that principal's items only.
  const signer = (role: Role): string | undefined =>
    actor?.principals.find((p) => p.role === role)?.principal;

  const tasks = new Map<string, { path: string; task: TaskView }>();
  model.open.forEach((task, i) =>
    tasks.set(task.id, { path: `open[${i}]`, task }),
  );
  model.finished.forEach((task, i) =>
    tasks.set(task.id, { path: `finished[${i}]`, task }),
  );
  const items: Item[] = model.needsYou.flatMap((entry, group) =>
    entry.items.map((item, k) => ({
      path: `needsYou[${group}].items[${k}]`,
      group,
      principal: entry.principal,
      item,
      mine: actor === null || roleOf(entry.principal) !== undefined,
      act:
        entry.principal ===
        signer(item.kind === "resolve" ? "operator" : "requester"),
    })),
  );
  const itemsFor = (taskId: string): Item[] =>
    items.filter((it) => it.item.taskId === taskId);
  const answers = (deliveryId: string) =>
    items.flatMap((it) =>
      it.item.kind === "answer" && it.item.deliveryId === deliveryId
        ? [{ ...it, item: it.item }]
        : [],
    );
  const asksViewer = (deliveryId: string): boolean =>
    answers(deliveryId).some((it) => it.mine);
  // The open questions that wait on the viewer, by id.
  const asking = new Set(
    items.flatMap((it) =>
      it.mine && it.item.kind === "answer" ? [it.item.questionId] : [],
    ),
  );

  // One group per task. Needs you holds each task with an item of the
  // viewer's, finished or not; In flight and Done hold the rest.
  const needs = new Map<string, Item>();
  for (const it of items)
    if (it.mine && !needs.has(it.item.taskId)) needs.set(it.item.taskId, it);
  const rest = (list: TaskView[], name: string) =>
    list.flatMap((task, i) =>
      needs.has(task.id) ? [] : [{ task, path: `${name}[${i}]` }],
    );
  const flight = rest(model.open, "open");
  const done = rest(model.finished, "finished");
  const requested = options.task ?? "";
  const selected =
    tasks.has(requested) || needs.has(requested)
      ? requested
      : ([...needs.keys()][0] ??
        model.open[0]?.id ??
        model.finished[0]?.id ??
        null);

  const source = (t: TaskView): string =>
    t.source.slice(0, t.source.lastIndexOf("/"));
  // Only the sender may cancel, and only while the task is open. The core
  // refuses a task whose work may have reached a participant, and says so.
  const mayCancel = (t: TaskView): boolean =>
    !t.final && source(t) === signer("requester");
  // A row's class and dot. Blue means the viewer is needed: a task that
  // waits on someone else's decision waits like a queued one.
  const taskClass = (t: TaskView): [string, string] =>
    needs.has(t.id)
      ? ["ask", "ask"]
      : t.final
        ? [t.status === "canceled" ? "done canceled" : "done", "done"]
        : ASKING.includes(t.status) || t.status === "queued"
          ? ["held", "wait"]
          : ["work", "work"];

  const clock = (path: string, iso: string | null | undefined, cls = "num") =>
    slot(path, time(iso), cls, "span", dated(iso));
  const ago = (
    path: string,
    iso: string | null | undefined,
    cls: string,
    text = age(iso, at),
  ) => slot(path, text, cls, "span", dated(iso));
  const when = (iso: string | null | undefined): string =>
    iso ? `<span${dated(iso)}>${time(iso)}</span>` : DASH;
  const verdict = (path: string, f: NonNullable<TaskView["final"]>): string =>
    slot(
      `${path}.final`,
      `${f.completed} of ${count(f.of, "delivery", "deliveries")}`,
    ) +
    (f.reason
      ? ` · ${slot(`${path}.final.reason`, esc(label(f.reason)))}`
      : "") +
    (f.by ? ` · by ${slot(`${path}.final.by`, esc(f.by))}` : "");

  // ---- Nav ----

  const pill = (path: string, n: number, words: string, cls = ""): string =>
    slot(path, `<b>${n}</b> ${words}`, cls);
  const held = model.placements.filter((p) => p.hold).length;
  const agentCount = model.placements.length;
  const nav = `<header class="nav">
  <span class="brand">Router</span>
  <span class="who">${
    actor
      ? `${slot("actor.login", esc(actor.login))} · ${slot("actor.principals[]", actor.principals.map((p) => `${esc(p.principal)}${p.role === p.principal ? "" : ` (${esc(p.role)})`}`).join(", "))}`
      : slot("actor", "reading only · not identified")
  }</span>
  <span class="counts">${pill("count(needsYou[].items)", needs.size, noun(needs.size, "needs you", "need you"), needs.size ? "attn" : "")}${pill("count(open[] not in needsYou)", flight.length, "in flight")}${pill("count(placements[].hold)", held, "held")}${pill("count(placements)", agentCount, noun(agentCount, "agent"))}</span>
  <span class="spacer"></span>
  <span class="tick">built ${clock("time(at)", at, "")} · ${slot("version", esc(model.version))}</span>
  <span class="themes" role="group" aria-label="Theme">${THEMES.map((name) => `<button type="button" data-theme="${name}"${name === theme ? ' class="on" aria-pressed="true"' : ' aria-pressed="false"'}>${THEME_NAMES[name]}</button>`).join("")}</span>
  <nav><a class="active" href="./">Board</a><a href="board.json">JSON</a></nav>
</header>`;

  // ---- Agents ----

  const dotOf = (p: PlacementView): Dot => {
    const d = p.delivery;
    if (d)
      return d.latest?.kind === "question"
        ? asksViewer(d.id)
          ? "ask"
          : "wait"
        : "work";
    return p.hold ? "held" : p.ready ? "ready" : "off";
  };
  const rank = (p: PlacementView): number => RANK[dotOf(p)];

  // A card: its dot, then the body's lines; `idle` is the collapsed card of
  // a session with no delivery.
  const cardShell = (
    path: string,
    cls: string,
    dot: Dot,
    body: string,
  ): string =>
    `    <div class="card${cls}" tabindex="0" data-path="${path}">
      <span class="dot ${dot}" data-path="${path}.delivery.latest.kind, ${path}.ready, ${path}.hold"></span>
      <div class="body">
${body}
      </div>
    </div>`;
  const lever = (levers: string[]): string =>
    levers.length ? `        <div class="lever">${levers.join("")}</div>` : "";

  const card = (p: PlacementView, i: number): string => {
    const path = `placements[${i}]`;
    const d = p.delivery;
    const latest = d?.latest ?? null;
    const dot = dotOf(p);
    const asks = dot === "ask";
    const holdLever = operator
      ? form(
          { action: "hold", placement: p.key, hold: p.hold ? "0" : "1" },
          slot(`${path}.hold`, p.hold ? "Release" : "Hold", "btn sm", "button"),
        )
      : "";
    const name = slot(`${path}.key`, esc(p.key));
    if (!d) {
      // Idle: no delivery pinned to the session. The card collapses to its
      // name, dot, state and lever.
      const what =
        dot === "held"
          ? `${slot(`${path}.hold`, "held")} · no open delivery`
          : dot === "ready"
            ? `${slot(`${path}.ready`, "ready")} · no open delivery`
            : slot(`${path}.ready`, "not ready");
      return cardShell(
        path,
        ` idle${dot === "off" ? " off" : ""}`,
        dot,
        `        <div class="name">${name}</div>
        <div class="what">${what}</div>
${lever(holdLever ? [holdLever] : [])}`,
      );
    }
    const task = slot(
      `${path}.delivery.taskId`,
      esc(d.taskId),
      "id",
      "a",
      ` href="${href(d.taskId)}"`,
    );
    const what = latest
      ? `${latest.kind === "question" ? "asks" : esc(latest.kind)} on ${task}`
      : `${slot(`${path}.delivery.outcome`, d.outcome === "accepted" ? "delivered" : esc(d.outcome))} on ${task}`;
    const excerpt = ` · ${slot(`${path}.delivery.excerpt`, esc(d.excerpt))}`;
    const rig =
      slot(`${path}.host`, esc(p.host), "tag") +
      slot(
        `${path}.session`,
        `session ${esc(shortId(p.session))}`,
        "tag",
        "span",
        fullId(p.session),
      ) +
      slot(`${path}.ready`, p.ready ? "ready" : "not ready", "tag") +
      (p.hold ? slot(`${path}.hold`, "held", "tag") : "");
    const latestAt = `${path}.delivery.latest.at`;
    const stats = latest
      ? `<span class="k">last update</span>${slot(`${path}.delivery.latest.kind`, esc(latest.kind), asks ? "ask" : "")}${clock(`time(${latestAt})`, latest.at)}${latest.at ? ago(`age(${latestAt}, at)`, latest.at, "num", `· ${age(latest.at, at)} ago`) : ""}`
      : slot(
          d.outcome === "accepted"
            ? `${path}.delivery.latest`
            : `${path}.delivery.outcome`,
          sentWords(d.outcome, "delivered, no reply yet"),
          "k",
        );
    const corner = latest?.at
      ? ago(`age(${latestAt}, at)`, latest.at, "age num")
      : "";
    const levers = [
      ...answers(d.id)
        .filter((it) => it.act)
        .map((it) =>
          slot(
            it.path,
            `Answer ${esc(it.item.taskId)}`,
            "btn sm accent",
            "a",
            ` href="${href(it.item.taskId, `#answer-${it.item.deliveryId}`)}"`,
          ),
        ),
      holdLever,
    ].filter(Boolean);
    return cardShell(
      path,
      asks ? " warm" : "",
      dot,
      `        <div class="name">${name}${corner}</div>
        <div class="what${asks ? " ask" : ""}">${what}${excerpt}</div>
        <div class="rig">${rig}</div>
        <div class="stats">${stats}</div>
${lever(levers)}`,
    );
  };

  const tail = model.log.slice(-4);
  const start = model.log.length - tail.length;
  const agents = `<aside class="panel agents" aria-label="Agents">
  <h2 class="col-h"><span class="kicker">Agents</span>${slot("count(placements)", count(agentCount, "placement"), "n")}</h2>
  <div class="scroll"><div class="cards">
${model.placements
  .map((p, i): [PlacementView, number] => [p, i])
  .sort(([a], [b]) => rank(a) - rank(b))
  .map(([p, i]) => card(p, i))
  .join("\n")}
  </div></div>
  <div class="foot"><div><span class="kicker">Router log</span> · ${slot("count(log)", `last ${model.log.length}`)}</div>${tail.map((e, i) => `<div data-path="log[${start + i}]"><b>${esc(e.actor)}</b> ${esc(e.text)}</div>`).join("")}</div>
</aside>`;

  // ---- Tasks ----

  // A task delivery with no update yet, in the row and the table: delivered
  // once its send was accepted, else the send as it stands.
  const sendState = (dp: string, d: DeliveryView, delivered: string): string =>
    d.send.outcome === "accepted"
      ? slot(`${dp}.latest`, delivered)
      : slot(`${dp}.send`, `${esc(d.send.kind)} ${esc(d.send.outcome)}`);

  // The second line of a row: what the task waits on or last said.
  const sub = (path: string, t: TaskView): string => {
    if (t.status === "needs_recipient" && t.routing?.reason) {
      const last = t.judgments.length - 1;
      const j = t.judgments[last];
      const p = j?.probabilities?.[j.choice];
      const jev = j
        ? ` · Jev ${slot(`${path}.judgments[${last}].choice`, esc(j.choice))}${p === undefined ? "" : ` ${p.toFixed(2)}`}`
        : "";
      return slot(`${path}.routing.reason`, esc(label(t.routing.reason))) + jev;
    }
    if (t.status === "needs_answer") {
      const i = t.deliveries.findIndex((d) => d.question);
      const question = t.deliveries[i]?.question;
      if (question)
        return slot(
          `${path}.deliveries[${i}].question.text`,
          esc(question.text),
        );
    }
    if (t.final) return verdict(path, t.final);
    const countdown = slot(`left(${path}.deadline, at)`, left(t.deadline, at));
    const i = t.deliveries.length - 1;
    const d = t.deliveries[i];
    const dp = `${path}.deliveries[${i}]`;
    if (!d) return countdown;
    if (d.latest)
      return `${slot(`${dp}.latest.text`, esc(d.latest.text))} · ${countdown}`;
    if (d.waits)
      return `${slot(`${dp}.waits`, waitText(d.placement, d.waits))} · ${countdown}`;
    return `${sendState(dp, d, "delivered, no reply yet")} · ${countdown}`;
  };

  // The peek: the task's open question with a reply box, rendered in its row
  // and hidden until the script opens it beside the row.
  const peek = (t: TaskView, path: string): string => {
    const it = itemsFor(t.id).flatMap((x) =>
      x.item.kind === "answer" ? [{ ...x, item: x.item }] : [],
    )[0];
    if (!it) return "";
    const { item } = it;
    const di = t.deliveries.findIndex((d) => d.id === item.deliveryId);
    const d = t.deliveries[di];
    const placement = d
      ? slot(`${path}.deliveries[${di}].placement`, esc(d.placement))
      : esc(t.recipient ?? DASH);
    const asked = times[item.questionId];
    const open = `<a class="btn sm ghost" href="${href(item.taskId)}">Open task</a>`;
    const reply = it.act
      ? form(
          { action: "answer", task: item.taskId, question: item.questionId },
          `<textarea name="text" required placeholder="Reply here without opening the task" aria-label="Your answer to ${esc(item.taskId)}"></textarea>
        <div class="row"><span class="hint"><kbd class="k">↵</kbd> send · <kbd class="k">→</kbd> open task · <kbd class="k">esc</kbd> close</span><span class="spacer"></span>${open}<button class="btn sm accent">Send</button></div>`,
        )
      : `<div class="row"><span class="hint"><kbd class="k">→</kbd> open task · <kbd class="k">esc</kbd> close</span><span class="spacer"></span>${open}</div>`;
    return `
      <div class="peek" role="dialog" aria-label="Peek ${esc(item.taskId)}" data-path="${it.path}" hidden>
        <div class="top"><span class="badge${it.mine ? " ask" : ""}">question</span><span class="id">${slot(`${it.path}.taskId`, esc(item.taskId))} · ${slot(`${it.path}.deliveryId`, esc(item.deliveryId))} · ${placement}</span><span class="spacer"></span>${ago(`age(times[${it.path}.questionId], at)`, asked, "hint", `waiting ${age(asked, at)}`)}</div>
        <div class="q${it.mine ? "" : " wait"}">${slot(`${it.path}.text`, esc(item.text))}</div>
        ${reply}
      </div>`;
  };

  const rowHead = (id: string, path: string, cls: string): string => {
    const on = id === selected;
    return `    <div class="task ${cls}${on ? " selected" : ""}" data-path="${path}" data-task="${esc(id)}"${on ? ' aria-current="true"' : ""}>`;
  };

  const row = (t: TaskView, path: string): string => {
    const [cls, dot] = taskClass(t);
    // Items of principals the viewer does not hold read as waiting on them.
    const others = new Map(
      itemsFor(t.id)
        .filter((it) => !it.mine)
        .map((it) => [it.principal, it.group]),
    );
    const waitsOn = [...others]
      .map(
        ([principal, g]) =>
          `waits on ${slot(`needsYou[${g}].principal`, esc(principal))} · `,
      )
      .join("");
    return `${rowHead(t.id, path, cls)}
      <span class="dot ${dot}" data-path="${path}.status"></span>
      <div class="line1">${slot(`${path}.id`, esc(t.id), "id", "a", ` href="${href(t.id)}"`)}${slot(`${path}.text`, esc(t.text), "excerpt")}</div>
      ${ago(`age(times[${path}.messageId], at)`, times[t.messageId], "age num")}
      <div class="line2">${slot(`${path}.status`, esc(label(t.status)), "state")}<span class="sub">${waitsOn}${sub(path, t)}</span>${slot(`${path}.recipient`, t.recipient ? esc(t.recipient) : "no recipient", "to")}</div>${peek(t, path)}
    </div>`;
  };

  // An item whose task is older than the finished tasks the model keeps
  // (only a resolve item can be): the item is all the page knows of it.
  const orphanRow = ({ item, path }: Item): string =>
    `${rowHead(item.taskId, path, "ask")}
      <span class="dot ask"></span>
      <div class="line1"><a class="id" href="${href(item.taskId)}">${esc(item.taskId)}</a><span class="excerpt">Not among the last finished tasks</span></div>
      <span class="age num"></span>
      <div class="line2"><span class="state">${esc(item.kind)}</span><span class="sub">${item.kind === "resolve" ? `${esc(item.deliveryId)} · send ${esc(item.messageId)} · ${esc(label(item.reason))}` : ""}</span></div>
    </div>`;

  const group = (name: string, kicker: string, n: string, rows: string[]) =>
    `  <div class="group" data-group="${name}">
    <h3><span class="chev">▾</span>${kicker}${n}</h3>
${rows.join("\n") || '    <div class="empty">nothing</div>'}
  </div>`;
  const tasksPanel = `<section class="panel tasks" aria-label="Tasks">
  <h2 class="col-h"><span class="kicker">Tasks</span><span class="n">${slot("count(open)", String(model.open.length))} open · ${slot("count(finished)", String(model.finished.length))} finished</span><span class="spacer"></span><a href="board.json">JSON</a></h2>
  <div class="filter"><span>⌕</span><input placeholder="Filter: text, id, recipient, state" aria-label="Filter tasks" autocomplete="off"><kbd>/</kbd></div>
  <div class="scroll">
${group(
  "needs-you",
  `<span class="kicker${needs.size ? " attn" : ""}">Needs you</span>`,
  slot("count(needsYou[].items)", String(needs.size), "n"),
  [...needs.values()].map((it) => {
    const found = tasks.get(it.item.taskId);
    return found ? row(found.task, found.path) : orphanRow(it);
  }),
)}
${group(
  "in-flight",
  '<span class="kicker">In flight</span>',
  slot("count(open[] not in needsYou)", String(flight.length), "n"),
  flight.map(({ task, path }) => row(task, path)),
)}
${group(
  "done",
  '<span class="kicker">Done</span>',
  slot("count(finished)", `last ${done.length}`, "n"),
  done.map(({ task, path }) => row(task, path)),
)}
  </div>
</section>`;

  // ---- Detail ----

  // The task as a transcript: sends and updates in message-time order, Jev
  // and ends as system lines.
  const thread = (path: string, t: TaskView): string => {
    const sender = esc(source(t));
    const asked = times[t.messageId];
    const lines: { key: string; order: number; html: string }[] = [];
    t.deliveries.forEach((d, di) => {
      const dp = `${path}.deliveries[${di}]`;
      d.sends.forEach((s, si) => {
        const iso = times[s.messageId];
        lines.push({
          key: iso ?? "",
          order: 0,
          html: `<div class="msg you" data-path="${dp}.sends[${si}]"><span class="who">${sender} · ${esc(s.kind)} · ${when(iso)} · ${esc(s.outcome)}</span>${esc(s.text)}</div>`,
        });
      });
      // A question is blue while it waits on the viewer. The design coloured
      // every question, answered or another principal's.
      d.updates.forEach((u, ui) => {
        const iso = times[u.messageId];
        lines.push({
          key: iso ?? "",
          order: 1,
          html: `<div class="msg agent${asking.has(u.messageId) ? " question" : ""}" data-path="${dp}.updates[${ui}]"><span class="who">${esc(d.placement)} · ${esc(u.kind)} · ${when(iso)}</span>${esc(u.text)}</div>`,
        });
      });
      if (d.end) {
        const iso = d.end.messageId ? times[d.end.messageId] : undefined;
        lines.push({
          key: iso ?? "9",
          order: 2,
          html: `<div class="sys" data-path="${dp}.end">${esc(d.id)} ended · ${esc(d.end.reason)}${d.end.by ? ` · by ${slot(`${dp}.end.by`, esc(shortId(d.end.by)), "", "span", fullId(d.end.by))}` : ""}${iso ? ` · ${when(iso)}` : ""}</div>`,
        });
      }
    });
    t.judgments.forEach((j, ji) =>
      lines.push({
        key: asked ?? "",
        order: 0.5,
        html: `<div class="sys" data-path="${path}.judgments[${ji}]">${jevLine(j)}</div>`,
      }),
    );
    // While Jev judges there is no reason yet; the generator failed on it.
    if (t.routing)
      lines.push({
        key: asked ?? "",
        order: 0.6,
        html: `<div class="sys" data-path="${path}.routing">${esc(label(t.routing.state))}${t.routing.reason ? ` · ${esc(label(t.routing.reason))}` : ""}${t.routing.suggestions.length ? ` · suggested ${esc(t.routing.suggestions.join(", "))}` : ""}</div>`,
      });
    // Before any delivery the request exists only on the task itself.
    if (!t.deliveries.length)
      lines.push({
        key: asked ?? "",
        order: 0,
        html: `<div class="msg you" data-path="${path}.text"><span class="who">${sender} · request · ${when(asked)}</span>${esc(t.text)}</div>`,
      });
    lines.sort((a, b) =>
      a.key < b.key ? -1 : a.key > b.key ? 1 : a.order - b.order,
    );
    return lines.map((line) => line.html).join("\n    ");
  };

  // One form per item of the task the viewer may act on, under the thread.
  // An item the viewer may not act on shows what it waits for, without a
  // form, so a page without a viewer has no form at all.
  const itemForm = (
    it: Item,
    t: TaskView | undefined,
    path: string,
  ): string => {
    const as = ` · ${it.act ? "as" : "waits on"} ${slot("needsYou[].principal", esc(it.principal))}`;
    const readOnly = (to: string): string =>
      `  <div class="form ro" data-path="${it.path}"><div class="to">${to}</div></div>`;
    const shell = ` class="form" data-path="${it.path}"`;
    const { item } = it;
    switch (item.kind) {
      case "answer": {
        const d = t?.deliveries.find((x) => x.id === item.deliveryId);
        const to = `Answer <b>${esc(d?.placement ?? t?.recipient ?? DASH)}</b> on ${slot(`${it.path}.deliveryId`, esc(item.deliveryId), "mono")}, question ${slot(`${it.path}.questionId`, esc(item.questionId), "mono")}${as}`;
        if (!it.act) return readOnly(to);
        return `  ${form(
          { action: "answer", task: item.taskId, question: item.questionId },
          `
    <div class="to">${to}</div>
    <textarea name="text" required placeholder="Your answer reaches the session as its next turn" aria-label="Your answer to ${esc(item.taskId)}"></textarea>
    <div class="row"><span class="hint">The task stays open until the agent replies completed.</span><span class="spacer"></span><kbd class="k">⌘↩</kbd><button class="btn accent" type="submit">Send answer</button></div>
  `,
          `${shell} id="answer-${esc(item.deliveryId)}"`,
        )}`;
      }
      case "choose": {
        const last = (t?.judgments.length ?? 0) - 1;
        const probabilities = t?.judgments[last]?.probabilities ?? {};
        const to = `Choose a recipient for <b>${slot(`${it.path}.taskId`, esc(item.taskId))}</b> · ${slot(`${it.path}.reason`, esc(label(item.reason)))}${as}`;
        if (!it.act) return readOnly(to);
        const buttons = item.suggestions
          .map((s, si) => {
            const p = probabilities[s];
            return `<button class="btn${si === 0 ? " accent" : ""}" type="submit" name="to" value="${esc(s)}" data-path="${it.path}.suggestions[${si}]">${esc(s)}${p === undefined ? "" : slot(`${path}.judgments[${last}].probabilities.${s}`, p.toFixed(2), "p")}</button>`;
          })
          .join("");
        // Without suggestions (Jev's answer was unusable or Jev was not
        // reached) the sender names the participant.
        const choices =
          buttons ||
          `<input name="to" required placeholder="Participant id" aria-label="Recipient for ${esc(item.taskId)}" autocomplete="off"><button class="btn accent" type="submit">Send</button>`;
        const cancel =
          t && mayCancel(t)
            ? `<button class="btn danger" type="submit" form="cancel-${esc(t.id)}">Cancel task</button>`
            : "";
        return `  ${form(
          { action: "choose", task: item.taskId },
          `
    <div class="to">${to}</div>
    <div class="choices">${choices}</div>
    <div class="row"><span class="hint">${buttons ? "Jev's order with its probabilities; the first is its choice." : "Jev suggested no one; name the participant."}</span><span class="spacer"></span>${cancel}</div>
  `,
          shell,
        )}`;
      }
      case "resolve": {
        const to = `Resolve <b>${slot(`${it.path}.deliveryId`, esc(item.deliveryId), "mono")}</b> · send ${slot(`${it.path}.messageId`, esc(item.messageId), "mono")} · ${slot(`${it.path}.reason`, esc(label(item.reason)))}${as}`;
        if (!it.act) return readOnly(to);
        // Only the outcomes the router accepts are offered, and a sentence
        // says why: an accepted send counts as sent, so it can only end as
        // finished.
        const di =
          t?.deliveries.findIndex((d) => d.id === item.deliveryId) ?? -1;
        const accepted = t?.deliveries[di]?.send.outcome === "accepted";
        const finished = `<button class="btn" type="submit" name="outcome" value="finished">Mark finished</button>`;
        const notSent = `<button class="btn danger" type="submit" name="outcome" value="not_sent">Mark not sent</button>`;
        const why = `${RESOLVE_WHY[item.reason]}${accepted ? ` ${slot(`${path}.deliveries[${di}].send.outcome`, "The adapter reported it accepted, so it counts as sent and cannot be marked not sent.")}` : ""}`;
        return `  ${form(
          {
            action: "resolve",
            delivery: item.deliveryId,
            message: item.messageId,
          },
          `
    <div class="to">${to}</div>
    <textarea name="evidence" required placeholder="What you saw in the session" aria-label="Evidence for ${esc(item.deliveryId)}"></textarea>
    <div class="row"><span class="hint">${why}</span><span class="spacer"></span>${finished}${accepted ? "" : notSent}</div>
  `,
          shell,
        )}`;
      }
    }
  };

  const detail = (): string => {
    if (selected === null)
      return `<section class="panel detail" aria-label="No task">
  <div class="scroll"><div class="thread"><div class="sys">No tasks recorded yet.</div></div></div>
</section>`;
    const found = tasks.get(selected);
    const forms = itemsFor(selected)
      .map((it) => itemForm(it, found?.task, found?.path ?? ""))
      .join("\n");
    if (!found)
      return `<section class="panel detail" aria-label="Task ${esc(selected)}" data-task="${esc(selected)}">
  <div class="head"><div class="title"><h2><span class="id">${esc(selected)}</span><span>Not among the last finished tasks</span></h2></div></div>
  <div class="scroll">
${forms}
  </div>
</section>`;
    const { path, task: t } = found;
    const [cls] = taskClass(t);
    const cancel = mayCancel(t)
      ? `<span class="actions">${form(
          { action: "cancel", task: t.id },
          slot(`${path}.id`, "Cancel", "btn sm danger", "button"),
          ` id="cancel-${esc(t.id)}" onsubmit="return confirm(${esc(JSON.stringify(`Cancel ${t.id}? Work already sent keeps running; the router stops tracking it.`))})"`,
        )}</span>`
      : "";
    const deadline = `deadline ${clock(`time(${path}.deadline)`, t.deadline)}`;
    const deliveries = t.deliveries.map((d, di) => {
      const dp = `${path}.deliveries[${di}]`;
      const state = d.end
        ? slot(`${dp}.end.reason`, esc(d.end.reason))
        : d.latest
          ? slot(
              `${dp}.latest.kind`,
              esc(d.latest.kind),
              `badge${d.latest.kind === "question" && asksViewer(d.id) ? " ask" : ""}`,
            )
          : d.waits
            ? slot(`${dp}.waits`, waitText(d.placement, d.waits))
            : sendState(dp, d, "delivered");
      const last = d.latest
        ? clock(
            `time(times[${dp}.latest.messageId])`,
            times[d.latest.messageId],
          )
        : DASH;
      return `<tr data-path="${dp}"><td>${slot(`${dp}.id`, esc(d.id), "mono")}</td><td>${slot(`${dp}.placement`, esc(d.placement), "mono")}</td><td>${slot(`${dp}.send`, `${esc(d.send.kind)} ${esc(d.send.messageId)} · ${esc(d.send.outcome)}`, "mono")}</td><td>${state}</td><td>${last}</td><td>${slot(`${dp}.session`, d.session ? esc(shortId(d.session)) : DASH, "mono", "span", d.session ? fullId(d.session) : "")}</td></tr>`;
    });
    const judgments = t.judgments.map((j, ji) => {
      const jp = `${path}.judgments[${ji}]`;
      const table =
        Object.entries(j.probabilities ?? {})
          .sort((a, b) => b[1] - a[1])
          .map(([id, p]) => `${esc(id)} ${p.toFixed(2)}`)
          .join(", ") || DASH;
      return `<tr data-path="${jp}"><td>${slot(`${jp}.choice`, esc(j.choice), "mono")}</td><td>${slot(`${jp}.probabilities`, table, "mono")}</td><td>${slot(`${jp}.model`, esc(j.model ?? DASH), "mono")}</td><td>${slot(`${jp}.valid`, j.valid ? "valid" : "invalid")}</td><td>${slot(`${jp}.threshold`, j.threshold.toFixed(2), "num")}</td></tr>`;
    });
    const log = t.log
      .map((e) => `${String(e.n).padStart(3)} ${e.actor}: ${e.text}`)
      .join("\n");
    return `<section class="panel detail" aria-label="Task ${esc(t.id)}" data-path="${path}" data-task="${esc(t.id)}">
  <div class="head">
    <div class="title"><h2 title="${esc(t.text)}">${slot(`${path}.id`, esc(t.id), "id")}${slot(`first_line(${path}.text)`, esc(headline(t.text)))}</h2>${slot(`${path}.status`, esc(label(t.status)), `badge${cls === "ask" ? " ask" : ""}`)}${cancel}</div>
    <div class="meta">
      <span>to ${slot(`${path}.recipient`, t.recipient ? esc(t.recipient) : DASH, "mono")} · ${slot(`${path}.chosenBy`, t.chosenBy ? CHOSEN_BY[t.chosenBy] : "no recipient yet")}</span>
      <span>from ${slot(`${path}.source`, esc(t.source), "mono")} at ${clock(`time(times[${path}.messageId])`, times[t.messageId])}</span>
      <span>${t.final ? `${deadline} · ${verdict(path, t.final)}` : `${deadline} · ${slot(`left(${path}.deadline, at)`, left(t.deadline, at), "num")}`}</span>
      <span>${slot(`${path}.a2a`, esc(t.a2a), "mono")}</span>
    </div>
  </div>
  <div class="scroll">
  <div class="thread">
    ${thread(path, t)}
  </div>
${forms}
  <div class="facts">
${
  deliveries.length
    ? `    <div><h3 class="kicker">Deliveries</h3>
      <table><tr><th>Delivery</th><th>Placement</th><th>Send</th><th>State</th><th>Last reply</th><th>Session</th></tr>${deliveries.join("")}</table></div>`
    : `    <div class="hint" data-path="${path}.deliveries">No delivery yet.</div>`
}
${
  judgments.length
    ? `    <div><h3 class="kicker">Jev</h3>
      <table><tr><th>Choice</th><th>Probabilities</th><th>Model</th><th></th><th>Threshold</th></tr>${judgments.join("")}</table></div>`
    : ""
}
    <div class="code" data-path="${path}.log"><div class="top"><span>log · ${esc(t.id)} · ${count(t.log.length, "line")}</span></div><pre>${esc(log)}</pre></div>
  </div>
  </div>
</section>`;
  };

  const notice = options.notice
    ? `<div class="notice" role="status"><span>${esc(options.notice)}</span><a href="./${selected ? href(selected) : ""}">Dismiss</a></div>`
    : "";

  return `<!doctype html>
<html lang="en" data-theme="${theme}"><head><meta charset="utf-8">
<meta name="viewport" content="width=device-width, initial-scale=1">
<title>Router</title>
<style>${STYLE}</style></head>
<body>
<!-- Rendered from the ${esc(model.version)} view model. Every slot's data-path names
     what it reads, as in the board design v0.7: a plain path indexes the
     model, and time(), age(), left() and count() are formats over it. -->
${notice}
<div id="app" data-refresh="${refreshSeconds}">
${nav}
<main class="bento">
${agents}
${tasksPanel}
${detail()}
</main>
<footer class="keys">
  <span><kbd>j</kbd>/<kbd>k</kbd> move</span><span><kbd>space</kbd> peek</span><span><kbd>↵</kbd> open</span><span><kbd>a</kbd> answer</span><span><kbd>c</kbd> cancel</span><span><kbd>h</kbd> hold</span><span><kbd>/</kbd> filter</span><span><kbd>?</kbd> keys</span>
  <span class="spacer"></span>
  <span>refreshes every ${refreshSeconds}s</span>
</footer>
</div>
<div class="help" role="dialog" aria-label="Keys" hidden><dl>
  <dt>j / k</dt><dd>Move between task rows</dd>
  <dt>space</dt><dd>Peek at a row's question and reply beside it</dd>
  <dt>↵</dt><dd>Open the task; in the peek, send the reply (⇧↵ breaks the line)</dd>
  <dt>→</dt><dd>Open the task of the open peek</dd>
  <dt>a</dt><dd>Answer the open question</dd>
  <dt>c</dt><dd>Cancel the selected task</dd>
  <dt>h</dt><dd>Hold or release the focused agent, or the selected task's</dd>
  <dt>/</dt><dd>Filter the task rows</dd>
  <dt>⌘↩ or Ctrl ↩</dt><dd>Send the form you are typing in</dd>
  <dt>esc</dt><dd>Close the peek or this list</dd>
</dl></div>
<script>${SCRIPT}</script>
</body></html>
`;
}

// ---- CSS: the generator's, then what the live page adds ----

const STYLE = `
/* Tokens. Hierarchy comes from weight and surface, one accent means "needs you", hairlines separate. */
:root {
  --body: -apple-system, BlinkMacSystemFont, "SF Pro Text", "Segoe UI", system-ui, "Apple SD Gothic Neo", "Noto Sans KR", sans-serif;
  --mono: ui-monospace, "SF Mono", Menlo, Consolas, "Liberation Mono", monospace;
  --std: cubic-bezier(.4, 0, .2, 1); --emph: cubic-bezier(.2, 0, 0, 1); --t-fast: 150ms; --t-mid: 200ms;
  --fs: 13px; --fs-mono: 11.5px; --fs-small: 12px; --pad: 12px; --row-pad: 7px 10px; --card-gap: 8px;
}
/* Flexoki dark: bg black, bg-2 base-950, ui base-900/850/800, tx base-200/500/700, accent blue-400. */
:root, html[data-theme="flexoki"] {
  --canvas: #100F0F; --surface: #1C1B1A; --surface-2: #282726; --text: #CECDC3; --text-2: #878580; --text-3: #575653;
  --hair: #282726; --hair-soft: #1F1E1D; --hair-strong: #403E3C;
  --wash: rgba(206,205,195,.05); --press: rgba(206,205,195,.10);
  --accent: #4385BE; --accent-soft: rgba(67,133,190,.16); --accent-line: rgba(67,133,190,.4); --on-accent: #FFFCF0;
  --shadow: rgba(0,0,0,.45);
}
/* Flexoki light: bg paper, bg-2 base-50, ui base-100/150/200, tx black/base-600/base-300, accent blue-600. */
@media (prefers-color-scheme: light) {
  html[data-theme="flexoki"] {
    --canvas: #FFFCF0; --surface: #F2F0E5; --surface-2: #E6E4D9; --text: #100F0F; --text-2: #6F6E69; --text-3: #B7B5AC;
    --hair: #E6E4D9; --hair-soft: #ECEAE0; --hair-strong: #CECDC3;
    --wash: rgba(16,15,15,.04); --press: rgba(16,15,15,.08);
    --accent: #205EA6; --accent-soft: rgba(32,94,166,.10); --accent-line: rgba(32,94,166,.35); --on-accent: #FFFCF0;
    --shadow: rgba(16,15,15,.18);
  }
}
/* One Dark, from Zed's assets/themes/one/one.json: editor.background, surface, border.variant, border, text, text.muted, text.placeholder, element.active, text.accent. */
html[data-theme="one-dark"] {
  --canvas: #282C33; --surface: #2F343E; --surface-2: #363C46; --text: #DCE0E5; --text-2: #A9AFBC; --text-3: #878A98;
  --hair: #363C46; --hair-soft: #30353F; --hair-strong: #464B57;
  --wash: rgba(220,224,229,.05); --press: #454A56;
  --accent: #74ADE8; --accent-soft: rgba(116,173,232,.14); --accent-line: rgba(116,173,232,.4); --on-accent: #282C33;
  --shadow: rgba(0,0,0,.45);
}
@media (prefers-reduced-motion: reduce) { * { transition-duration: 0ms !important; animation: none !important; } }

* { box-sizing: border-box; }
html, body { height: 100%; background: var(--canvas); color: var(--text); }
body { margin: 0; font: 400 var(--fs)/1.5 var(--body); overflow: hidden; }
a { color: var(--text); text-decoration: underline; text-decoration-color: var(--hair-strong); text-underline-offset: 3px; }
a:hover { text-decoration-color: var(--text); }
button, input, select, textarea { font: inherit; color: inherit; }
:focus-visible { outline: 2px solid var(--text); outline-offset: 2px; }
h1, h2, h3, p { margin: 0; }
.mono { font-family: var(--mono); font-size: .92em; }
.num { font-variant-numeric: tabular-nums; }
.id { font-family: var(--mono); font-size: var(--fs-mono); font-weight: 500; color: var(--text-2); }

/* Frame: nav, bento, key line; the bento fills what is left and its panels scroll inside. */
#app { position: relative; height: 100vh; display: grid; grid-template-rows: 52px 1fr 40px; }
.nav { display: flex; align-items: center; gap: 14px; padding: 0 20px; background: var(--canvas); border-bottom: 1px solid var(--hair); }
.nav .brand { font-weight: 500; font-size: 17px; letter-spacing: -.2px; }
.nav .who { font-size: var(--fs-small); color: var(--text-3); }
.nav .counts { display: flex; gap: 6px; margin-left: 4px; }
.nav .counts span { font-family: var(--mono); font-size: var(--fs-mono); font-weight: 500; letter-spacing: .3px; padding: 4px 10px; border-radius: 100px; border: 1px solid var(--hair); color: var(--text-2); white-space: nowrap; }
.nav .counts span b { font-weight: 500; color: var(--text); margin-right: 4px; }
.nav .counts .attn { background: var(--accent-soft); border-color: transparent; color: var(--accent); }
.nav .counts .attn b { color: var(--accent); }
.nav .spacer, .row .spacer, .col-h .spacer, .keys .spacer { flex: 1; }
.nav .tick { font-family: var(--mono); font-size: var(--fs-mono); color: var(--text-3); }
.nav nav { display: flex; gap: 4px; align-items: center; }
.nav nav a { font-family: var(--mono); font-size: var(--fs-mono); font-weight: 500; color: var(--text-2); padding: 6px 11px; border-radius: 8px; text-decoration: none; transition: background var(--t-fast) var(--std), color var(--t-fast) var(--std); }
.nav nav a:hover { background: var(--wash); color: var(--text); }
.nav nav a.active { background: var(--press); color: var(--text); }
.themes { display: flex; border: 1px solid var(--hair); border-radius: 100px; padding: 2px; margin-right: 6px; }
.themes button { font-family: var(--mono); font-size: var(--fs-mono); font-weight: 500; color: var(--text-2); background: transparent; border: 0; border-radius: 100px; padding: 3px 10px; cursor: pointer; transition: background var(--t-fast) var(--std), color var(--t-fast) var(--std); }
.themes button:hover { color: var(--text); }
.themes button.on { background: var(--press); color: var(--text); }

.bento { min-height: 0; width: 100%; max-width: 1600px; margin: 0 auto; padding: 10px 12px; display: grid; grid-template-columns: 3fr 4fr 5fr; gap: 10px; }
.panel { position: relative; min-height: 0; overflow: hidden; background: var(--surface); border: 1px solid var(--hair); border-radius: 12px; display: flex; flex-direction: column; }
.scroll { min-height: 0; overflow-y: auto; flex: 1; scrollbar-width: thin; scrollbar-color: var(--hair-strong) transparent; }
.kicker { font-family: var(--mono); font-size: var(--fs-mono); font-weight: 500; letter-spacing: .6px; text-transform: uppercase; color: var(--text-3); }
.kicker.attn { color: var(--accent); }
.col-h { display: flex; align-items: baseline; gap: 10px; padding: 14px 16px 8px; }
.col-h .n { font-family: var(--mono); font-size: var(--fs-mono); font-weight: 500; color: var(--text-3); }
.col-h a { font-family: var(--mono); font-size: var(--fs-mono); font-weight: 500; color: var(--text-2); }

/* Dots: one accent for what needs you; everything else is a shape in the text colour. */
.dot { display: inline-block; width: 8px; height: 8px; border-radius: 50%; background: var(--text-3); flex: 0 0 8px; margin-top: 6px; }
.dot.ask, .dot.fail { background: var(--accent); box-shadow: 0 0 0 3px var(--accent-soft); }
.dot.work { background: var(--text); animation: pulse 2s var(--std) infinite; }
@keyframes pulse { 0%, 100% { opacity: 1; } 50% { opacity: .35; } }
.dot.ready, .dot.wait { background: transparent; box-shadow: inset 0 0 0 1.5px var(--text-2); }
.dot.wait { box-shadow: inset 0 0 0 1.5px var(--text-3); }
.dot.held { background: transparent; box-shadow: inset 0 0 0 1.5px var(--text-2); position: relative; }
.dot.held::after { content: ""; position: absolute; inset: 2px 3px; border-left: 1.5px solid var(--text-2); border-right: 1.5px solid var(--text-2); }
.dot.off { background: transparent; box-shadow: inset 0 0 0 1.5px var(--text-3); }
.dot.done { background: var(--text-3); }
.badge { display: inline-block; font-family: var(--mono); font-size: var(--fs-mono); font-weight: 500; letter-spacing: .3px; line-height: 1.2; padding: 3px 8px; border-radius: 100px; border: 1px solid var(--hair); color: var(--text-2); white-space: nowrap; }
.badge.ask { background: var(--accent-soft); border-color: transparent; color: var(--accent); }
.tag { display: inline-block; font-family: var(--mono); font-size: calc(var(--fs-mono) - 1px); font-weight: 500; padding: 1px 6px; border-radius: 4px; border: 1px solid var(--hair-soft); color: var(--text-3); white-space: nowrap; }

.btn { font-family: var(--body); font-size: var(--fs-small); font-weight: 500; line-height: 1.2; padding: 6px 12px; border-radius: 100px; border: 1px solid transparent; background: var(--wash); color: var(--text); cursor: pointer; white-space: nowrap; transition: background var(--t-fast) var(--std); }
.btn:hover { background: var(--press); }
.btn.accent { background: var(--accent); color: var(--on-accent); }
.btn.accent:hover { filter: brightness(1.08); }
.btn.danger { background: transparent; color: var(--text-2); border-color: var(--hair); }
.btn.danger:hover { color: var(--text); background: var(--wash); }
.btn.ghost { background: transparent; border-color: var(--hair); }
.btn.sm { font-size: calc(var(--fs-small) - 1px); padding: 4px 10px; }

/* Agents: one card per placement. */
.cards { display: grid; gap: var(--card-gap); padding: 0 10px 10px; }
.card { border: 1px solid var(--hair); border-radius: 10px; padding: var(--pad); display: flex; gap: 10px; cursor: pointer; transition: background var(--t-fast) var(--std), border-color var(--t-fast) var(--std); }
.card:hover { background: var(--wash); border-color: var(--hair-strong); }
.card.warm { background: var(--accent-soft); border-color: var(--accent-line); }
.card.off { opacity: .7; }
.card.idle { padding: 9px var(--pad); }
.card.idle .body { grid-template-columns: 1fr auto; align-items: center; }
.card.idle .lever { margin-top: 0; }
.card.focused { outline: 2px solid var(--text); outline-offset: 2px; }
.card .body { flex: 1; min-width: 0; display: grid; gap: 3px; }
.card .name { font-weight: 500; font-size: var(--fs); letter-spacing: -.1px; display: flex; align-items: baseline; gap: 8px; }
.card .name .age { margin-left: auto; font-family: var(--mono); font-weight: 500; font-size: var(--fs-mono); color: var(--text-3); }
.card .what { font-size: var(--fs-small); color: var(--text-2); overflow: hidden; text-overflow: ellipsis; white-space: nowrap; }
.card .what.ask { color: var(--accent); }
.card .what .id { color: inherit; font-size: inherit; }
.card .rig { display: flex; gap: 4px; flex-wrap: wrap; }
.card .stats { display: flex; gap: 6px; align-items: baseline; font-family: var(--mono); font-size: var(--fs-mono); color: var(--text-2); white-space: nowrap; }
.card .stats .k { color: var(--text-3); }
.card .stats .ask { color: var(--accent); }
.card .lever { margin-top: 6px; display: flex; gap: 6px; }
.agents .foot { padding: 10px 16px 12px; border-top: 1px solid var(--hair); font-family: var(--mono); font-size: var(--fs-mono); line-height: 1.6; color: var(--text-3); display: grid; gap: 1px; }
.agents .foot div { overflow: hidden; text-overflow: ellipsis; white-space: nowrap; }
.agents .foot b { font-weight: 500; color: var(--text-2); }

/* Tasks: three groups, rows of two lines. */
.filter { margin: 0 10px 4px; display: flex; align-items: center; gap: 8px; height: 34px; padding: 0 12px; border: 1px solid var(--hair); border-radius: 100px; background: var(--canvas); color: var(--text-3); font-size: var(--fs-small); }
.filter input { flex: 1; border: 0; background: transparent; padding: 0; min-width: 0; }
.filter kbd, kbd.k { font-family: var(--mono); font-size: calc(var(--fs-mono) - 1px); border: 1px solid var(--hair); border-radius: 4px; padding: 1px 5px; color: var(--text-3); }
textarea::placeholder, .filter input::placeholder { color: var(--text-3); }
.group { margin-top: 6px; }
.group > h3 { display: flex; align-items: baseline; gap: 8px; padding: 6px 16px 4px; cursor: pointer; }
.group > h3 .n { font-family: var(--mono); font-size: var(--fs-mono); color: var(--text-3); }
.group > h3 .chev { font-family: var(--mono); color: var(--text-3); transition: transform var(--t-fast) var(--std); display: inline-block; }
.group.collapsed > h3 .chev { transform: rotate(-90deg); }
.group.collapsed .task { display: none; }
.group .empty { padding: 2px 16px 6px; font-size: var(--fs-small); color: var(--text-3); }
.task { position: relative; display: grid; grid-template-columns: 8px 1fr auto; column-gap: 10px; margin: 0 10px; padding: var(--row-pad); border-radius: 8px; cursor: pointer; border: 1px solid transparent; transition: background var(--t-fast) var(--std); }
.task:hover { background: var(--wash); }
.task.selected { background: var(--press); border-color: var(--hair-strong); }
.task.focused { outline: 2px solid var(--text); outline-offset: 1px; }
.task .line1 { grid-column: 2; display: flex; gap: 8px; align-items: baseline; min-width: 0; }
.task .line1 .excerpt { flex: 1; min-width: 0; overflow: hidden; text-overflow: ellipsis; white-space: nowrap; font-size: var(--fs); color: var(--text); }
.task .age { grid-column: 3; grid-row: 1; font-family: var(--mono); font-size: var(--fs-mono); color: var(--text-3); white-space: nowrap; }
.task .line2 { grid-column: 2 / -1; display: flex; gap: 8px; align-items: baseline; font-size: var(--fs-small); color: var(--text-2); min-width: 0; margin-top: 1px; }
.task .line2 .state { font-family: var(--mono); font-size: var(--fs-mono); font-weight: 500; letter-spacing: .3px; white-space: nowrap; color: var(--text-2); }
.task .line2 .sub { flex: 1; min-width: 0; overflow: hidden; text-overflow: ellipsis; white-space: nowrap; }
.task .line2 .to { font-family: var(--mono); font-size: var(--fs-mono); color: var(--text-3); white-space: nowrap; }
.task.ask .state, .task.fail .state { color: var(--accent); }
.task.done .excerpt { color: var(--text-2); }
.task.done.canceled .state { color: var(--text-3); }

/* Detail: head, transcript, the one form the viewer can act with, then the facts. */
.detail .head { padding: 14px 18px 12px; border-bottom: 1px solid var(--hair); }
.detail .head .title { display: flex; align-items: center; gap: 10px; flex-wrap: wrap; }
.detail .head h2 { flex: 1 1 0; min-width: 0; display: -webkit-box; -webkit-box-orient: vertical; -webkit-line-clamp: 2; line-clamp: 2; overflow: hidden; overflow-wrap: anywhere; font-size: calc(var(--fs) + 4px); font-weight: 500; letter-spacing: -.3px; line-height: 1.25; }
.detail .head h2 .id { color: var(--text-3); margin-right: 6px; }
.detail .head .meta { margin-top: 4px; display: flex; gap: 12px; flex-wrap: wrap; font-size: var(--fs-small); color: var(--text-2); }
.detail .head .actions { display: flex; gap: 6px; margin-left: auto; }
.thread { padding: 14px 18px 4px; display: flex; flex-direction: column; gap: 8px; }
.msg { max-width: 90%; padding: 8px 12px; border-radius: 10px; white-space: pre-wrap; word-break: break-word; font-size: var(--fs); line-height: 1.5; color: var(--text-2); border: 1px solid var(--hair); }
.msg .who { display: block; font-family: var(--mono); font-size: var(--fs-mono); font-weight: 500; letter-spacing: .3px; color: var(--text-3); margin-bottom: 3px; }
.msg.you { align-self: flex-end; background: var(--surface-2); color: var(--text); border-bottom-right-radius: 4px; }
.msg.you .who { color: var(--text-2); }
.msg.agent { align-self: flex-start; border-bottom-left-radius: 4px; }
.msg.question { background: var(--accent-soft); border-color: var(--accent-line); color: var(--text); }
.msg.question .who { color: var(--accent); }
.sys { align-self: center; font-family: var(--mono); font-size: var(--fs-mono); color: var(--text-3); text-align: center; }
.form { margin: 6px 18px 12px; padding: 10px 12px; border: 1px solid var(--accent-line); border-radius: 12px; display: grid; gap: 6px; }
.form .to { font-size: var(--fs-small); color: var(--text-2); }
.form .to b { color: var(--accent); font-weight: 500; }
.form textarea, .peek textarea { width: 100%; min-height: 52px; resize: vertical; padding: 8px 10px; border: 1px solid var(--hair); border-radius: 10px; background: var(--canvas); color: var(--text); font-size: var(--fs); }
.form textarea:focus, .peek textarea:focus { outline: 2px solid var(--text); outline-offset: 0; border-color: transparent; }
.row { display: flex; gap: 8px; align-items: center; }
.hint { font-size: var(--fs-mono); color: var(--text-3); }
.choices { display: flex; gap: 6px; flex-wrap: wrap; }
.choices .btn { display: inline-flex; gap: 6px; align-items: baseline; }
.choices .btn .p { font-family: var(--mono); font-size: var(--fs-mono); color: var(--text-3); }
.choices .btn.accent .p { color: var(--on-accent); opacity: .8; }
.facts { padding: 0 18px 16px; display: grid; gap: 12px; }
.facts h3 { margin-bottom: 4px; }
table { border-collapse: collapse; width: 100%; font-size: var(--fs-small); }
td, th { text-align: left; padding: 5px 10px 5px 0; border-bottom: 1px solid var(--hair-soft); vertical-align: middle; }
th { font-family: var(--mono); font-size: var(--fs-mono); font-weight: 500; letter-spacing: .3px; color: var(--text-3); white-space: nowrap; }
td:last-child, th:last-child { text-align: right; padding-right: 0; }
.code { border: 1px solid var(--hair); border-radius: 10px; background: var(--canvas); overflow: hidden; }
.code .top { display: flex; align-items: center; gap: 6px; padding: 6px 10px; border-bottom: 1px solid var(--hair-soft); }
.code .top span { font-family: var(--mono); font-size: var(--fs-mono); color: var(--text-3); }
.code pre { margin: 0; padding: 8px 12px; font-family: var(--mono); font-size: var(--fs-mono); line-height: 1.6; color: var(--text-2); white-space: pre-wrap; }

.keys { display: flex; gap: 16px; align-items: center; padding: 0 20px; border-top: 1px solid var(--hair); background: var(--canvas); font-family: var(--mono); font-size: var(--fs-mono); color: var(--text-3); }
.keys kbd { font-family: var(--mono); font-weight: 500; color: var(--text-2); }

/* The peek: the one overlay, and the one place a shadow is allowed. */
.peek { position: fixed; z-index: 60; width: 420px; padding: 14px; border-radius: 12px; background: var(--surface-2); border: 1px solid var(--hair-strong); box-shadow: 0 24px 48px var(--shadow); display: grid; gap: 8px; cursor: default; animation: rise var(--t-fast) var(--std) both; }
.peek::before { content: ""; position: absolute; left: -6px; top: 22px; width: 10px; height: 10px; background: var(--surface-2); border-left: 1px solid var(--hair-strong); border-bottom: 1px solid var(--hair-strong); transform: rotate(45deg); }
.peek .top { display: flex; align-items: center; gap: 8px; }
.peek .top .spacer { flex: 1; }
.peek .q { white-space: pre-wrap; font-size: var(--fs); color: var(--text); line-height: 1.5; padding: 8px 10px; border-radius: 8px; background: var(--accent-soft); border: 1px solid var(--accent-line); }
@keyframes rise { from { opacity: 0; transform: translateY(6px); } to { opacity: 1; transform: none; } }
/* The live page. A row opens its task through the link on its id, stretched
   over the row, so rows work without a script; the row shows its focus. */
.task[hidden], .peek[hidden], .help[hidden] { display: none; }
.task a.id { text-decoration: none; }
.task a.id::after { content: ""; position: absolute; inset: 0; border-radius: 8px; }
.task a.id:focus-visible { outline: none; }
.task:has(a.id:focus-visible) { outline: 2px solid var(--text); outline-offset: 1px; }
a.btn, .card a.id { text-decoration: none; }
.card a.id:hover { text-decoration: underline; }
.lever form, .actions form, .peek form { display: contents; }
/* Blue is the viewer's: an item that waits on someone else, or that the
   viewer cannot act on here, drops it. */
.form.ro { border-color: var(--hair); }
.form.ro .to b { color: var(--text); }
.peek .q.wait { background: transparent; border-color: var(--hair-strong); }
.choices input { flex: 1; min-width: 10rem; padding: 6px 12px; border: 1px solid var(--hair); border-radius: 100px; background: var(--canvas); color: var(--text); }
.notice { position: fixed; z-index: 70; top: 60px; left: 50%; transform: translateX(-50%); display: flex; gap: 12px; align-items: baseline; max-width: calc(100vw - 32px); padding: 8px 14px; border-radius: 10px; background: var(--surface-2); border: 1px solid var(--hair-strong); font-size: var(--fs-small); }
.help { position: fixed; z-index: 60; right: 20px; bottom: 48px; padding: 12px 16px; border-radius: 12px; background: var(--surface-2); border: 1px solid var(--hair-strong); font-size: var(--fs-small); }
.help dl { margin: 0; display: grid; grid-template-columns: auto 1fr; gap: 4px 14px; }
.help dt { font-family: var(--mono); font-size: var(--fs-mono); color: var(--text); }
.help dd { margin: 0; color: var(--text-2); }
/* The design is drawn for a desktop; a narrow screen gets one column that
   scrolls as a page. */
@media (max-width: 900px) {
  body { overflow: auto; }
  #app { height: auto; min-height: 100vh; grid-template-rows: auto 1fr auto; }
  .nav, .keys { flex-wrap: wrap; padding: 8px 14px; }
  .bento { grid-template-columns: 1fr; }
  .panel, .scroll { overflow: visible; }
}
`;

// ---- Script: reads the rendered page and its data attributes only ----

// The page works without it. It keeps what a person is doing across
// refreshes and adds the theme switch, the filter, the keys and the peek.
const SCRIPT = `
const root = document.documentElement;
const $ = (selector, from = document) => from.querySelector(selector);
const $$ = (selector, from = document) => [...from.querySelectorAll(selector)];
const stored = (store, key, fallback) => {
  try { return JSON.parse(store.getItem(key)) ?? fallback; } catch { return fallback; }
};
const selected = () => $(".detail")?.dataset.task;

// Theme: the server paints the cookie's palette. A palette chosen on this
// device wins and goes into both stores, so the next page paints it first.
const THEMES = ["flexoki", "one-dark"];
const paint = () => $$(".themes button").forEach((b) => {
  b.classList.toggle("on", b.dataset.theme === root.dataset.theme);
  b.setAttribute("aria-pressed", String(b.dataset.theme === root.dataset.theme));
});
const theme = (name) => {
  root.dataset.theme = name;
  localStorage.setItem("router-theme", name);
  document.cookie = "router-theme=" + name + "; max-age=31536000; samesite=lax";
  paint();
};
const saved = localStorage.getItem("router-theme");
if (THEMES.includes(saved) && saved !== root.dataset.theme) theme(saved);
$$(".themes button").forEach((b) => b.addEventListener("click", () => theme(b.dataset.theme)));

// Collapsed groups, by data-group, on this device.
const fold = () => {
  const shut = [].concat(stored(localStorage, "router-collapsed", []));
  $$(".group").forEach((g) => g.classList.toggle("collapsed", shut.includes(g.dataset.group)));
};

// Drafts, by the data-path of the form or peek they are typed in, kept with
// the fields that name their item: a draft never fills another item's form
// when the paths shift.
const DRAFTED = "form textarea, form input[name=to]";
const draftKey = (field) => "router-draft " + field.closest("[data-path]").dataset.path + " " + field.name;
const itemOf = (field) => $$("input[type=hidden]", field.form).map((i) => i.value).join(" ");
const drafts = () => $$(DRAFTED).forEach((field) => {
  const draft = stored(sessionStorage, draftKey(field), null);
  if (draft?.item === itemOf(field) && !field.value && field !== document.activeElement) field.value = draft.text;
});

// The filter narrows the rows by what they show and by their ids.
const filter = () => {
  const words = ($(".filter input")?.value ?? "").trim().toLowerCase();
  $$(".task").forEach((row) => {
    const text = [row.dataset.task, row.dataset.path, ...$$(".line1, .line2", row).map((e) => e.textContent)];
    row.hidden = !text.join(" ").toLowerCase().includes(words);
  });
};

// The peek opens beside its row, above the panels.
const peek = () => $(".peek:not([hidden])");
const openPeek = (p) => {
  peek()?.setAttribute("hidden", "");
  p.hidden = false;
  const r = p.parentElement.getBoundingClientRect();
  p.style.left = Math.max(8, Math.min(r.right + 16, innerWidth - p.offsetWidth - 8)) + "px";
  p.style.top = Math.max(8, Math.min(r.top - 8, innerHeight - p.offsetHeight - 8)) + "px";
};
const closePeek = () => {
  const p = peek();
  p.hidden = true;
  $("a.id", p.parentElement)?.focus();
};

// Every few seconds the page fetches itself for the selected task and swaps
// the nav counts and the three panels. A panel holding the focus stays as
// it is, unless the focus is on a row or a card the new panel has too. The
// notice is outside the swapped parts.
const PARTS = [".nav .counts", ".nav .tick", ".agents", ".tasks", ".detail"];
const refresh = async (id = selected()) => {
  if (document.hidden) return;
  let doc;
  try {
    const r = await fetch(location.pathname + (id ? "?task=" + encodeURIComponent(id) : ""), { cache: "no-store", headers: { accept: "text/html" } });
    if (!r.ok) return;
    doc = new DOMParser().parseFromString(await r.text(), "text/html");
  } catch { return; }
  const focus = document.activeElement;
  const row = focus?.matches(".task a.id") ? focus.closest(".task").dataset.task : null;
  const card = focus?.matches(".card") ? focus.dataset.path : null;
  const open = peek();
  const peeked = open && '.task[data-task="' + CSS.escape(open.parentElement.dataset.task) + '"] .peek[data-path="' + CSS.escape(open.dataset.path) + '"]';
  const words = $(".filter input")?.value ?? "";
  for (const part of PARTS) {
    const old = $(part);
    const next = $(part, doc);
    if (!old || !next || (old.contains(focus) && !row && !card)) continue;
    const top = $(".scroll", old)?.scrollTop ?? 0;
    old.replaceWith(next);
    const scroll = $(".scroll", next);
    if (scroll) scroll.scrollTop = top;
  }
  if (row) $('.task[data-task="' + CSS.escape(row) + '"] a.id')?.focus();
  if (card) $('.card[data-path="' + CSS.escape(card) + '"]')?.focus();
  if (peeked && !peek() && $(peeked)) openPeek($(peeked));
  const input = $(".filter input");
  if (input && input !== focus) input.value = words;
  if (selected() && selected() !== new URLSearchParams(location.search).get("task")) history.replaceState(null, "", "?task=" + encodeURIComponent(selected()));
  fold();
  filter();
  drafts();
};
setInterval(refresh, Number($("#app").dataset.refresh) * 1000);

document.addEventListener("input", (e) => {
  const field = e.target;
  if (field.matches(".filter input")) return filter();
  if (!field.matches(DRAFTED)) return;
  if (field.value) sessionStorage.setItem(draftKey(field), JSON.stringify({ item: itemOf(field), text: field.value }));
  else sessionStorage.removeItem(draftKey(field));
});

// A post ends its drafts, and the page it returns to reopens its task.
document.addEventListener("submit", (e) => {
  if (e.defaultPrevented) return;
  $$("textarea, input[name=to]", e.target).forEach((field) => sessionStorage.removeItem(draftKey(field)));
  sessionStorage.setItem("router-task", selected() ?? "");
});

document.addEventListener("click", (e) => {
  if (e.target.closest(".notice a")) {
    e.preventDefault();
    $(".notice").remove();
    history.replaceState(null, "", selected() ? "?task=" + encodeURIComponent(selected()) : location.pathname);
    return;
  }
  const head = e.target.closest(".group > h3");
  if (!head) return;
  const name = head.parentElement.dataset.group;
  const shut = [].concat(stored(localStorage, "router-collapsed", [])).filter((n) => n !== name);
  if (!head.parentElement.classList.contains("collapsed")) shut.push(name);
  localStorage.setItem("router-collapsed", JSON.stringify(shut));
  fold();
});

// The keys the footer names. Each returns whether it did something.
const typing = (el) => el?.matches("input, textarea, select");
const move = (step) => {
  const links = $$(".group:not(.collapsed) .task:not([hidden]) a.id");
  const at = links.indexOf(document.activeElement);
  const next = at < 0 ? $(".task[aria-current] a.id") ?? links[0] : links[Math.min(links.length - 1, Math.max(0, at + step))];
  next?.focus();
  return Boolean(next);
};
const press = (el) => {
  el?.click();
  return Boolean(el);
};
const KEYS = {
  j: () => move(1),
  k: () => move(-1),
  " ": (row) => {
    const p = row && $(".peek", row);
    if (!p) return false;
    if (p === peek()) closePeek(); else openPeek(p);
    return true;
  },
  ArrowRight: (row) => {
    if (!row || !row.contains(peek())) return false;
    location.assign($("a.id", row).href);
    return true;
  },
  a: () => {
    const field = peek() ? $("textarea", peek()) : $(".detail form[id^='answer-'] textarea");
    field?.focus();
    return Boolean(field);
  },
  c: () => press($(".detail .actions button")),
  // The focused agent, or the one working on the selected task.
  h: (row, el) => {
    const card = el?.closest(".card") ?? $$(".card").find((c) => $("a.id", c)?.textContent === selected());
    return press(card && $("button[data-path$='.hold']", card));
  },
  "/": () => { $(".filter input")?.focus(); return true; },
  "?": () => { $(".help").hidden = !$(".help").hidden; return true; },
};
document.addEventListener("keydown", (e) => {
  // A key that ends an IME composition (a Hangul syllable, a kana
  // conversion) belongs to the text; Safari marks it only by keyCode 229.
  if (e.isComposing || e.keyCode === 229) return;
  const el = document.activeElement;
  if (e.key === "Escape") {
    if (!$(".help").hidden) $(".help").hidden = true;
    else if (peek()) closePeek();
    else if (typing(el)) el.blur();
    return;
  }
  if (e.key === "Enter" && el?.matches("form textarea")) {
    // ⌘↩ sends the form; in the peek ↵ alone sends and ⇧↵ breaks the line.
    if (e.metaKey || e.ctrlKey || (el.closest(".peek") && !e.shiftKey)) {
      e.preventDefault();
      el.form.requestSubmit();
    }
    return;
  }
  if (typing(el) || e.metaKey || e.ctrlKey || e.altKey) return;
  const row = el?.matches(".task a.id") ? el.closest(".task") : null;
  if (KEYS[e.key]?.(row, el)) e.preventDefault();
});

// An action returns to the bare page with its notice; reopen the task it
// was taken on.
const back = sessionStorage.getItem("router-task");
sessionStorage.removeItem("router-task");
const params = new URLSearchParams(location.search);
if (back && params.has("notice") && !params.has("task") && back !== selected() && $('.task[data-task="' + CSS.escape(back) + '"]')) {
  history.replaceState(null, "", "?task=" + encodeURIComponent(back) + "&notice=" + encodeURIComponent(params.get("notice")));
  refresh(back);
}
paint();
fold();
filter();
drafts();
`;
