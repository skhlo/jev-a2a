// The tasks column and the task detail of the board page: the task list
// in its three groups, each row with its peek, and the selected task with
// its forms, transcript and record.
import type { DeliveryView, TaskView } from "./board.ts";
import type { NeedsItem, PageContext } from "./board-context.ts";
import {
  age,
  answeredQuestion,
  clock,
  count,
  DASH,
  dated,
  esc,
  form,
  fullId,
  href,
  label,
  left,
  shortId,
  slot,
  staleTask,
  when,
} from "./board-parts.ts";
import type { Judgment, StuckReason } from "./types.ts";

// A task's first line, for the detail title: the design sized the title for
// the sample's short texts, and a real request runs to pages. The full text
// is in the transcript, and in the title attribute.
export const headline = (text: string): string =>
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
export const answerOf = (
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
const sub = ({ at, times }: PageContext, path: string, t: TaskView): string => {
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
      return slot(`${path}.deliveries[${i}].question.text`, esc(question.text));
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
const peek = (
  { at, times, itemsFor, ago }: PageContext,
  t: TaskView,
  path: string,
): string => {
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

const rowHead = (
  { selected }: PageContext,
  id: string,
  path: string,
  cls: string,
): string => {
  const on = id === selected;
  return `    <div class="task ${cls}${on ? " selected" : ""}" data-path="${path}" data-task="${esc(id)}"${on ? ' aria-current="true"' : ""}>`;
};

const row = (page: PageContext, t: TaskView, path: string): string => {
  const { at, times, itemsFor, taskClass, ago } = page;
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
  return `${rowHead(page, t.id, path, cls)}
      <span class="dot ${dot}" data-path="${path}.status"></span>
      <div class="line1">${slot(`${path}.id`, esc(t.id), "id", "a", ` href="${href(t.id)}"`)}${slot(`${path}.text`, esc(t.text), "excerpt")}</div>
      ${ago(`age(times[${path}.messageId], at)`, times[t.messageId], "age num")}
      <div class="line2">${slot(`${path}.status`, esc(label(t.status)), "state")}<span class="sub">${waitsOn}${sub(page, path, t)}</span><span class="route">${from}${slot(`${path}.recipient`, t.recipient ? esc(t.recipient) : "no recipient", "to", "span", t.recipient ? ` title="${esc(t.recipient)}"` : "")}${late ? slot(`stale_task(${path}, at)`, esc(late), "stale role-warn num") : ""}</span></div>${peek(page, t, path)}
    </div>`;
};

// An item whose task is older than the finished tasks the model keeps
// (only a resolve item can be): the item is all the page knows of it.
const orphanRow = (page: PageContext, { item, path }: NeedsItem): string =>
  `${rowHead(page, item.taskId, path, "ask")}
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

// The task as a transcript: sends and updates in message-time order, Jev
// and ends as system lines.
const thread = (
  { times, source, asking }: PageContext,
  path: string,
  t: TaskView,
): string => {
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
  { mayCancel }: PageContext,
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
      const di = t?.deliveries.findIndex((d) => d.id === item.deliveryId) ?? -1;
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

export function tasksPanel(page: PageContext): string {
  const { model, needs, tasks, flight, done } = page;
  return `<section class="panel tasks" aria-label="Tasks" data-part="tasks">
  <h2 class="col-h"><span class="kicker">Tasks</span><span class="n">${slot("count(open)", String(model.open.length))} open · ${slot("count(finished)", String(model.finished.length))} finished</span></h2>
  <div class="filter"><span>⌕</span><input placeholder="Filter: text, id, recipient, state" aria-label="Filter tasks" autocomplete="off"><kbd>/</kbd></div>
  <div class="scroll">
${group(
  "needs-you",
  `<span class="kicker${needs.size ? " attn" : ""}">Needs you</span>`,
  slot("count(needsYou[].items)", String(needs.size), "n"),
  [...needs.values()].map((it) => {
    const found = tasks.get(it.item.taskId);
    return found ? row(page, found.task, found.path) : orphanRow(page, it);
  }),
)}
${group(
  "in-flight",
  '<span class="kicker">In flight</span>',
  slot("count(open[] not in needsYou)", String(flight.length), "n"),
  flight.map(({ task, path }) => row(page, task, path)),
)}
${group(
  "done",
  '<span class="kicker">Done</span>',
  slot("count(finished)", `last ${done.length}`, "n"),
  done.map(({ task, path }) => row(page, task, path)),
)}
  </div>
</section>`;
}

export function taskDetail(page: PageContext): string {
  const {
    at,
    times,
    tasks,
    selected,
    itemsFor,
    taskClass,
    mayCancel,
    source,
    asksViewer,
  } = page;
  if (selected === null)
    return `<section class="panel detail" aria-label="No task" data-part="detail">
  <div class="scroll"><div class="thread"><div class="sys">No tasks recorded yet.</div></div></div>
</section>`;
  const found = tasks.get(selected);
  const forms = itemsFor(selected)
    .map((it) => itemForm(page, it, found?.task, found?.path ?? ""))
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
      ? clock(`time(times[${dp}.latest.messageId])`, times[d.latest.messageId])
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
    ${thread(page, path, t)}
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
}
