// The board's page: the v0.13 console of the board design (skhlo/designs, tag
// jev-a2a-v0.13, commit 4a0b0ab, scripts/gen-jev-a2a-board.py), drawn on the
// server from the view model and the viewer. The template translates the
// generator's HTML functions and carries its CSS: every slot keeps the
// data-path the design gives it, rows keep data-task and groups data-group,
// so the live page can be compared with the design mechanically. Forms post
// to the board's actions endpoint with its own fields. The page reads and
// posts without a script; the script keeps a person's state across
// refreshes and adds the filter, the keys, the peek, the sheet, the usage
// pop-up, opening a task in place, the full router log and the help with
// its theme switch.
import type { BoardModel, DeliveryView, TaskView } from "./board.ts";
import type { Judgment, StuckReason } from "./types.ts";
import { pageContext, type NeedsItem } from "./board-context.ts";
import {
  age,
  answeredQuestion,
  clock,
  chip,
  count,
  DASH,
  dated,
  esc,
  form,
  fullId,
  href,
  label,
  left,
  noun,
  shortId,
  slot,
  staleTask,
  stamp,
  time,
  when,
} from "./board-parts.ts";
import { SCRIPT } from "./board-script.ts";
import { usageParts } from "./board-usage.ts";
import { agentsPanel, placementSheets } from "./board-agents.ts";
import { STYLE } from "./board-style.ts";

// ---- Formats: the generator's helpers over the same fields ----

// The nav tick's title: when the model was built and the telemetry taken,
// to the second, and the contract (v0.12). The design gives the clocks
// alone; a telemetry file can be a day old.
const built = (model: BoardModel): string =>
  `built ${stamp(model.at)} · ${model.telemetryAt ? `telemetry ${stamp(model.telemetryAt)}` : "no telemetry"} · ${model.version}`;

// A task's first line, for the detail title: the design sized the title for
// the sample's short texts, and a real request runs to pages. The full text
// is in the transcript, and in the title attribute.
const headline = (text: string): string =>
  text
    .split(/\r?\n/)
    .map((line) => line.trim())
    .find((line) => line) ?? text;

// short(id) as the design applies it to a send's message id (v0.13): an id
// over twelve characters shows its first eight, the whole id as its title.
const shortSlot = (path: string, id: string): string =>
  id.length > 12
    ? slot(path, esc(id.slice(0, 8)), "", "span", ` title="${esc(id)}"`)
    : slot(path, esc(id));

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

// The answer a delivery's question got, when its current send is one and
// no question is open: a question stays the latest update after its
// answer, and a resolve clears the question too, so both are checked.
const answerOf = (
  d: DeliveryView,
): { k: number; send: DeliveryView["sends"][number] } | null => {
  const k = d.sends.findIndex((s) => s.messageId === d.send.messageId);
  const send = d.sends[k];
  return answeredQuestion(d) && send?.kind === "answer" ? { k, send } : null;
};

// Why a delivery needs an operator, as the resolve form says it.
const RESOLVE_WHY: Record<StuckReason, string> = {
  task_ended: "The task ended before the router could confirm this send.",
  session_replaced:
    "The session that took this send is gone, so the router cannot confirm it.",
  unknown_send: "The router has no record of this send reaching the session.",
};

const THEMES = ["flexoki", "one-dark"] as const;
const THEME_NAMES: Record<(typeof THEMES)[number], string> = {
  flexoki: "Flexoki",
  "one-dark": "One Dark",
};

// The help (v0.13): the keys in two columns, the pop-up's under their own
// kicker, then the theme switch. The design names ⌘↩ alone; the script takes
// Ctrl ↩ as well. u and the pop-up's keys show while the model carries
// usage.
const HELP_KEYS: [string, string][] = [
  ["↑ / ↓", "move"],
  ["↵ / →", "open"],
  ["← / esc", "back, close"],
  ["space", "peek"],
  ["s", "sheet"],
  ["a", "answer"],
  ["c", "cancel"],
  ["p", "hold / release"],
  ["r", "router log"],
  ["u", "usage"],
  ["/", "filter"],
  ["?", "keys"],
  ["⌘↩", "send the form (or Ctrl ↩)"],
];
const HELP_USAGE_KEYS: [string, string][] = [
  ["↑ / ↓", "accounts"],
  ["→ / ↵", "open details"],
  ["←", "close details"],
];

type Theme = (typeof THEMES)[number];

// The palette a cookie names, else the default, so the cookie cannot put
// text into the page.
const themeOf = (name: string | null | undefined): Theme =>
  THEMES.find((t) => t === name) ?? THEMES[0];

export type RenderOptions = {
  refreshSeconds?: number;
  // Outcome of the last action, shown until dismissed.
  notice?: string | null;
  // The selected task, from the page's `task` query parameter.
  task?: string | null;
  // The palette, from the router-theme cookie. Anything but a palette name
  // gets the default, so the cookie cannot put text into the page.
  theme?: string | null;
  // Whether the usage pop-up is drawn open, from the page's `usage` query
  // parameter: how a page without a script opens it.
  usage?: boolean;
};

// A finished task's verdict: how many deliveries completed, under `first`
// (the row's slot, or the head's with the deadline), then the reason and
// who ended it.
const verdict = (
  path: string,
  f: NonNullable<TaskView["final"]>,
  first = (words: string) => slot(`${path}.final`, words),
): string =>
  first(`${f.completed} of ${count(f.of, "delivery", "deliveries")}`) +
  (f.reason ? ` · ${slot(`${path}.final.reason`, esc(label(f.reason)))}` : "") +
  (f.by ? ` · by ${slot(`${path}.final.by`, esc(f.by))}` : "");

// The page for `model` as its actor sees it. Pure: the model, the viewer in
// it and the options decide every byte.
export function renderBoard(
  model: BoardModel,
  options: RenderOptions = {},
): string {
  const refreshSeconds = options.refreshSeconds ?? 10;
  const page = pageContext(model, options.task);
  const {
    actor,
    at,
    times,
    tasks,
    needs,
    flight,
    done,
    selected,
    asking,
    itemsFor,
    asksViewer,
    source,
    mayCancel,
    taskClass,
    ago,
  } = page;

  // ---- Nav ----

  // v0.12, which v0.13 keeps: who ellipsizes with the whole text as its
  // title; the tick reads "updated <time>" with the build, the telemetry and
  // the contract in its title; the theme switch is in the help. The links
  // are relative, as Tailscale Serve strips the page's mount path. The empty
  // .br breaks the head's line on a narrow screen (v0.13).
  const held = model.placements.filter((p) => p.hold).length;
  const agentCount = model.placements.length;
  const principals =
    actor?.principals
      .map(
        (p) => `${p.principal}${p.role === p.principal ? "" : ` (${p.role})`}`,
      )
      .join(", ") ?? "";
  const who = actor
    ? `${actor.login} · ${principals}`
    : "reading only · not identified";
  const nav = `<header class="nav">
  <span class="brand">Router</span>
  <span class="who" title="${esc(who)}">${
    actor
      ? `${slot("actor.login", esc(actor.login))} · ${slot("actor.principals[]", esc(principals))}`
      : slot("actor", esc(who))
  }</span>
  <span class="br"></span>
  <span class="counts">${chip("count(needsYou[].items)", needs.size, noun(needs.size, "needs you", "need you"), needs.size ? "attn" : "")}${chip("count(open[] not in needsYou)", flight.length, "in flight")}${chip("count(placements[].hold)", held, "held")}${chip("count(placements)", agentCount, noun(agentCount, "agent"))}</span>
  <span class="spacer"></span>
  ${slot("time(at)", `updated ${time(at)}`, "tick", "span", ` title="${esc(built(model))}"`)}
  <nav><a class="active" href="./">Board</a><a href="board.json">JSON</a></nav>
</header>`;

  // ---- Usage (v0.13) ----

  // The rail's section and the pop-up, while the model carries usage.
  const usage = model.usage;
  const drawnUsage = usage
    ? usageParts(usage, at, selected, Boolean(options.usage))
    : null;

  // ---- Tasks ----

  // What an open task delivery is, in the order the row and the table read
  // it: what it waits for (the router's own reason), the send while it is
  // not accepted, the answer its question got, the latest update, else
  // delivered with no reply yet.
  type Reading =
    | { kind: "waits"; waits: NonNullable<DeliveryView["waits"]> }
    | { kind: "unaccepted" }
    | { kind: "answered"; k: number; send: DeliveryView["sends"][number] }
    | { kind: "updated"; latest: NonNullable<DeliveryView["latest"]> }
    | { kind: "delivered" };
  const readingOf = (d: DeliveryView): Reading => {
    if (d.waits) return { kind: "waits", waits: d.waits };
    if (d.send.outcome !== "accepted") return { kind: "unaccepted" };
    const answer = answerOf(d);
    if (answer) return { kind: "answered", ...answer };
    if (d.latest) return { kind: "updated", latest: d.latest };
    return { kind: "delivered" };
  };
  const sendSlot = (dp: string, d: DeliveryView): string =>
    slot(`${dp}.send`, `${esc(d.send.kind)} ${esc(d.send.outcome)}`);

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
    const r = readingOf(d);
    const words =
      r.kind === "waits"
        ? slot(`${dp}.waits`, waitText(d.placement, r.waits))
        : r.kind === "unaccepted"
          ? sendSlot(dp, d)
          : r.kind === "answered"
            ? `answered ${clock(`time(times[${dp}.sends[${r.k}].messageId])`, times[r.send.messageId])} ${slot(`${dp}.sends[${r.k}].text`, esc(r.send.text))}`
            : r.kind === "updated"
              ? slot(`${dp}.latest.text`, esc(r.latest.text))
              : slot(`${dp}.latest`, "delivered, no reply yet");
    return `${words} · ${countdown}`;
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
          {
            action: "answer",
            task: item.taskId,
            delivery: item.deliveryId,
            question: item.questionId,
          },
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
    // An open task another agent sent names its sender's placement before
    // the recipient (v0.9: unless the viewer is the sender, which a person
    // never is, since a principal may not share a participant's id).
    const from =
      t.via !== null && t.final === null
        ? slot(
            `${path}.via`,
            `from ${esc(t.via)}`,
            "to",
            "span",
            ` title="from ${esc(t.via)}"`,
          )
        : "";
    // Work that waits too long ends the line, in the warning role (v0.12).
    const late = staleTask(t, at, times);
    return `${rowHead(t.id, path, cls)}
      <span class="dot ${dot}" data-path="${path}.status"></span>
      <div class="line1">${slot(`${path}.id`, esc(t.id), "id", "a", ` href="${href(t.id)}"`)}${slot(`${path}.text`, esc(t.text), "excerpt")}</div>
      ${ago(`age(times[${path}.messageId], at)`, times[t.messageId], "age num")}
      <div class="line2">${slot(`${path}.status`, esc(label(t.status)), "state")}<span class="sub">${waitsOn}${sub(path, t)}</span><span class="route">${from}${slot(`${path}.recipient`, t.recipient ? esc(t.recipient) : "no recipient", "to", "span", t.recipient ? ` title="${esc(t.recipient)}"` : "")}${late ? slot(`stale_task(${path}, at)`, esc(late), "stale role-warn num") : ""}</span></div>${peek(t, path)}
    </div>`;
  };

  // An item whose task is older than the finished tasks the model keeps
  // (only a resolve item can be): the item is all the page knows of it.
  const orphanRow = ({ item, path }: NeedsItem): string =>
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
  const tasksPanel = `<section class="panel tasks" aria-label="Tasks" data-part="tasks">
  <h2 class="col-h"><span class="kicker">Tasks</span><span class="n">${slot("count(open)", String(model.open.length))} open · ${slot("count(finished)", String(model.finished.length))} finished</span></h2>
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

  // One form per item of the task the viewer may act on, above the thread.
  // An item the viewer may not act on shows what it waits for, without a
  // form, so a page without a viewer has no form at all.
  const itemForm = (
    it: NeedsItem,
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
          {
            action: "answer",
            task: item.taskId,
            delivery: item.deliveryId,
            question: item.questionId,
          },
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
        const why = `${RESOLVE_WHY[item.reason]}${accepted ? ` ${slot(`${path}.deliveries[${di}].send.outcome`, "The adapter reported it accepted, so it counts as sent and cannot be marked not sent; resolving finishes the delivery.")}` : ""}`;
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
      return `<section class="panel detail" aria-label="No task" data-part="detail">
  <div class="scroll"><div class="thread"><div class="sys">No tasks recorded yet.</div></div></div>
</section>`;
    const found = tasks.get(selected);
    const forms = itemsFor(selected)
      .map((it) => itemForm(it, found?.task, found?.path ?? ""))
      .join("\n");
    if (!found)
      return `<section class="panel detail" aria-label="Task ${esc(selected)}" data-part="detail" data-task="${esc(selected)}">
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
    // v0.12: the head is one line. The message id is the title of "from
    // ... at", the deadline the title of the countdown or the verdict, the
    // a2a token the title of the status badge.
    const deadline = dated(t.deadline, "deadline ");
    const from = `<span data-path="${path}.messageId" title="${esc(`message ${t.messageId} · ${t.source}`)}">from ${slot(`${path}.source`, esc(source(t)), "mono")}${t.via === null ? "" : ` via ${slot(`${path}.via`, esc(t.via), "mono")}`} at ${clock(`time(times[${path}.messageId])`, times[t.messageId])}</span>`;
    const end = t.final
      ? verdict(path, t.final, (words) =>
          slot(
            `${path}.final, time(${path}.deadline)`,
            words,
            "end",
            "span",
            deadline,
          ),
        )
      : slot(
          `left(${path}.deadline, at), time(${path}.deadline)`,
          left(t.deadline, at),
          "num end",
          "span",
          deadline,
        );
    const deliveries = t.deliveries.map((d, di) => {
      const dp = `${path}.deliveries[${di}]`;
      const r = d.end ? null : readingOf(d);
      const state = d.end
        ? slot(`${dp}.end.reason`, esc(d.end.reason))
        : r?.kind === "waits"
          ? slot(`${dp}.waits`, waitText(d.placement, r.waits))
          : r?.kind === "unaccepted"
            ? sendSlot(dp, d)
            : r?.kind === "answered"
              ? slot(`${dp}.send`, "answered")
              : r?.kind === "updated"
                ? slot(
                    `${dp}.latest.kind`,
                    esc(r.latest.kind),
                    `badge${d.question && asksViewer(d.id) ? " ask" : ""}`,
                  )
                : slot(`${dp}.latest`, "delivered");
      const last = d.latest
        ? clock(
            `time(times[${dp}.latest.messageId])`,
            times[d.latest.messageId],
          )
        : DASH;
      // v0.13: the send in three slots, its message id through short().
      const send = `${slot(`${dp}.send.kind`, esc(d.send.kind))} ${shortSlot(`${dp}.send.messageId`, d.send.messageId)} · ${slot(`${dp}.send.outcome`, esc(d.send.outcome))}`;
      return `<tr data-path="${dp}"><td class="key">${slot(`${dp}.id`, esc(d.id), "mono")}</td><td class="key">${slot(`${dp}.placement`, esc(d.placement), "mono")}</td><td data-label="Send"><span class="mono">${send}</span></td><td class="key">${state}</td><td data-label="Last reply">${last}</td><td data-label="Session">${slot(`${dp}.session`, d.session ? esc(shortId(d.session)) : DASH, "mono", "span", d.session ? fullId(d.session) : "")}</td></tr>`;
    });
    // What a participant sender was told at the placement it sent from.
    const notices = t.notices.map((n, ni) => {
      const np = `${path}.notices[${ni}]`;
      return `<tr data-path="${np}"><td class="key">${slot(`${np}.key`, esc(n.key), "mono")}</td><td data-label="Kind">${slot(`${np}.kind`, esc(n.kind))}</td><td data-label="Session">${slot(`${np}.session`, n.session ? esc(shortId(n.session)) : DASH, "mono", "span", n.session ? fullId(n.session) : "")}</td><td class="key">${slot(`${np}.outcome`, esc(n.outcome), `outcome ${esc(n.outcome)}`)}</td></tr>`;
    });
    const judgments = t.judgments.map((j, ji) => {
      const jp = `${path}.judgments[${ji}]`;
      const table =
        Object.entries(j.probabilities ?? {})
          .sort((a, b) => b[1] - a[1])
          .map(([id, p]) => `${esc(id)} ${p.toFixed(2)}`)
          .join(", ") || DASH;
      return `<tr data-path="${jp}"><td class="key">${slot(`${jp}.choice`, esc(j.choice), "mono")}</td><td data-label="Probabilities">${slot(`${jp}.probabilities`, table, "mono")}</td><td data-label="Model">${slot(`${jp}.model`, esc(j.model ?? DASH), "mono")}</td><td class="key">${slot(`${jp}.valid`, j.valid ? "valid" : "invalid")}</td><td data-label="Threshold">${slot(`${jp}.threshold`, j.threshold.toFixed(2), "num")}</td></tr>`;
    });
    const log = t.log
      .map((e) => `${String(e.n).padStart(3)} ${e.actor}: ${e.text}`)
      .join("\n");
    return `<section class="panel detail" aria-label="Task ${esc(t.id)}" data-part="detail" data-path="${path}" data-task="${esc(t.id)}">
  <div class="head">
    <div class="title"><h2 title="${esc(t.text)}">${slot(`${path}.id`, esc(t.id), "id")}${slot(`first_line(${path}.text)`, esc(headline(t.text)))}</h2>${slot(`${path}.status, ${path}.a2a`, esc(label(t.status)), `badge${cls === "ask" ? " ask" : ""}`, "span", ` title="${esc(t.a2a)}"`)}${cancel}</div>
    <div class="meta">to ${slot(`${path}.recipient`, t.recipient ? esc(t.recipient) : DASH, "mono")} · ${slot(`${path}.chosenBy`, t.chosenBy ? CHOSEN_BY[t.chosenBy] : "no recipient yet")} · ${from} · ${end}</div>
  </div>
  <div class="scroll">
${forms}
  <div class="thread">
    ${thread(path, t)}
  </div>
  <div class="facts">
${
  deliveries.length
    ? `    <div><h3 class="kicker">Deliveries</h3>
      <table class="rec"><tr><th>Delivery</th><th>Placement</th><th>Send</th><th>State</th><th>Last reply</th><th>Session</th></tr>${deliveries.join("")}</table></div>`
    : `    <div class="hint" data-path="${path}.deliveries">No delivery yet.</div>`
}
${
  t.via === null || !notices.length
    ? ""
    : `    <div><h3 class="kicker">Notices to ${slot(`${path}.via`, esc(t.via), "mono")}</h3>
      <table class="rec"><tr><th>Notice</th><th>Kind</th><th>Session</th><th>Outcome</th></tr>${notices.join("")}</table></div>`
}
${
  judgments.length
    ? `    <div><h3 class="kicker">Jev</h3>
      <table class="rec"><tr><th>Choice</th><th>Probabilities</th><th>Model</th><th></th><th>Threshold</th></tr>${judgments.join("")}</table></div>`
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

  // The help and the key line (v0.13). u and the pop-up's keys are there
  // while the model carries usage; the footer's r and ? take a tap, for a
  // screen without a keyboard.
  const helpKeys: [string, string][] = HELP_KEYS.flatMap(
    ([key, does]): [string, string][] =>
      key !== "u"
        ? [[key, does]]
        : !usage
          ? []
          : [
              [
                key,
                drawnUsage?.rail
                  ? `${does}, or click an account under the agents`
                  : does,
              ],
            ],
  );
  const keyRows = (keys: [string, string][]): string =>
    keys
      .map(([key, does]) => `<kbd>${esc(key)}</kbd><span>${esc(does)}</span>`)
      .join("");
  const theme = themeOf(options.theme);

  return `<!doctype html>
<html lang="en" data-theme="${theme}"><head><meta charset="utf-8">
<meta name="viewport" content="width=device-width, initial-scale=1">
<title>Router</title>
<style>${STYLE}</style>
</head>
<body>
<!-- Rendered from the ${esc(model.version)} view model. Every slot's data-path names
     what it reads, as in the board design v0.13: a plain path indexes the
     model, and time(), hms(), age(), left(), count(), percent(), diff(),
     counts(), repo() and pace() are formats over it; stale() and
     stale_task() name work that waits too long. -->
${notice}
<div id="app" data-refresh="${refreshSeconds}">
${nav}
<main class="bento">
${agentsPanel(page, drawnUsage?.rail ?? "")}
${tasksPanel}
${detail()}
${placementSheets(page)}
</main>
<footer class="keys">
  <span><kbd>↑↓</kbd> move</span><span><kbd>↵</kbd> open</span><span><kbd>space</kbd> peek</span><span><kbd>s</kbd> sheet</span><span><kbd>a</kbd> answer</span><span><kbd>c</kbd> cancel</span><span><kbd>p</kbd> hold</span><span data-key="r" role="button"><kbd>r</kbd> log</span>${usage ? "<span><kbd>u</kbd> usage</span>" : ""}<span><kbd>/</kbd> filter</span><span data-key="?" role="button"><kbd>?</kbd> keys</span>
  <span class="spacer"></span>
  <span>refreshes every ${refreshSeconds}s</span>
</footer>
</div>
${drawnUsage ? `${drawnUsage.popup}\n` : ""}<div class="help" role="dialog" aria-label="Keys" hidden>
  <div class="top"><span class="kicker">Keys</span><span class="spacer"></span><kbd class="k">?</kbd></div>
  <div class="grid">${keyRows(helpKeys)}${usage ? `<span class="sub kicker">In usage</span>${keyRows(HELP_USAGE_KEYS)}` : ""}</div>
  <div class="theme"><span>theme</span><span class="themes" role="group" aria-label="Theme">${THEMES.map((name) => `<button type="button" data-theme="${name}"${name === theme ? ' class="on" aria-pressed="true"' : ' aria-pressed="false"'}>${THEME_NAMES[name]}</button>`).join("")}</span></div>
</div>
<script>${SCRIPT}</script>
</body></html>
`;
}
