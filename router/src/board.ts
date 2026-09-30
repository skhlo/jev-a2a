// The board: what waits on a person and what the router is doing, read from
// the record. `boardModel` is pure and is what `GET board.json` returns; the
// HTML is one rendering of it, with no client script. Nothing here writes.
import { A2A_STATE, currentSend, needsYou, reduce } from "./core.ts";
import { fold } from "./shell.ts";
import type { RouterConfig } from "./config.ts";
import type { Entry } from "./journal.ts";
import type { Delivery, NeedsYouItem, State, Task, Update } from "./types.ts";

export type DeliveryView = {
  id: string;
  placement: string;
  session: string | null;
  send: { kind: string; messageId: string; outcome: string };
  question: { id: string; text: string } | null;
  latest: Update | null;
  end: Delivery["end"];
};

export type TaskView = {
  id: string;
  status: Task["status"];
  a2a: string;
  source: string;
  messageId: string;
  recipient: string | null;
  text: string;
  routing: Task["routing"];
  final: Task["final"];
  deliveries: DeliveryView[];
};

export type BoardModel = {
  at: string;
  needsYou: { principal: string; role: string; items: NeedsYouItem[] }[];
  // Placements this router serves, as `router status` lists them.
  placements: { key: string; ready: boolean; hold: boolean; session: string }[];
  open: TaskView[];
  finished: TaskView[];
  log: State["log"];
};

const FINISHED_SHOWN = 10;
const LOG_SHOWN = 20;

// The record as of `now`, folded in memory: deadlines that passed since the
// last run show as passed, and the journal is untouched.
export function boardState(
  config: RouterConfig,
  entries: Entry[],
  now: number,
): State {
  return reduce(fold(config, entries), { type: "tick", now });
}

export function boardModel(
  state: State,
  config: RouterConfig,
  now: number,
): BoardModel {
  const tasks = state.tasks.map(taskView).reverse();
  return {
    at: new Date(now).toISOString(),
    needsYou: Object.entries(state.config.principals).map(
      ([principal, role]) => ({
        principal,
        role,
        items: needsYou(state, principal),
      }),
    ),
    placements: Object.entries(state.placements)
      .filter(([key]) => key in config.agents)
      .map(([key, p]) => ({
        key,
        ready: p.ready,
        hold: p.hold,
        session: p.session,
      })),
    open: tasks.filter((t) => !t.final),
    finished: tasks.filter((t) => t.final).slice(0, FINISHED_SHOWN),
    log: state.log.slice(-LOG_SHOWN),
  };
}

function taskView(task: Task): TaskView {
  return {
    id: task.id,
    status: task.status,
    a2a: A2A_STATE[task.status],
    source: `${task.source}/${task.messageId}`,
    messageId: task.messageId,
    recipient: task.recipient,
    text: task.text,
    routing: task.routing,
    final: task.final,
    deliveries: task.deliveries.map((d) => {
      const send = currentSend(d);
      return {
        id: d.id,
        placement: d.placement,
        session: d.session,
        send: {
          kind: send.kind,
          messageId: send.messageId,
          outcome: send.outcome,
        },
        question: d.question,
        latest: d.updates.at(-1) ?? null,
        end: d.end,
      };
    }),
  };
}

// The CLI's wording for a needs-you item, shared with `router needs-you`.
export function describeNeed(item: NeedsYouItem): string {
  switch (item.kind) {
    case "choose":
      return `${item.taskId}: choose a recipient (${item.reason}${item.suggestions.length ? `; suggested ${item.suggestions.join(", ")}` : ""})`;
    case "answer":
      return `${item.taskId}: answer ${item.questionId} "${item.text}"`;
    case "resolve":
      return `${item.deliveryId}: resolve ${item.messageId} (${item.reason})`;
  }
}

const esc = (value: unknown): string =>
  String(value)
    .replaceAll("&", "&amp;")
    .replaceAll("<", "&lt;")
    .replaceAll(">", "&gt;")
    .replaceAll('"', "&quot;");

const STYLE = `
  :root { color-scheme: light dark; --muted: #777; --line: #8884; --warn: #b5651d; }
  body { font: 14px/1.45 system-ui, sans-serif; margin: 0; padding: 16px; max-width: 72rem; }
  h1 { font-size: 1.2rem; margin: 0 0 4px; }
  h2 { font-size: 1rem; margin: 20px 0 6px; }
  .at { color: var(--muted); font-size: .85rem; }
  ul { margin: 0; padding-left: 1.2rem; }
  li { margin: 2px 0; }
  .need { font-weight: 600; }
  .task { border-top: 1px solid var(--line); padding: 8px 0; }
  .task .head { display: flex; gap: .6rem; flex-wrap: wrap; align-items: baseline; }
  .id { font-family: ui-monospace, monospace; }
  .status { border: 1px solid var(--line); border-radius: 4px; padding: 0 .4rem; font-size: .8rem; }
  .status.needs { border-color: var(--warn); color: var(--warn); }
  .muted { color: var(--muted); }
  .text { white-space: pre-wrap; word-break: break-word; margin: 2px 0; }
  .sub { margin-left: 1rem; font-size: .9rem; }
  .log { font-family: ui-monospace, monospace; font-size: .8rem; color: var(--muted); }
`;

export function renderBoard(model: BoardModel, refreshSeconds = 10): string {
  const needs = model.needsYou.map(
    ({ principal, role, items }) =>
      `<h2>Needs ${esc(principal)} <span class="muted">(${esc(role)})</span></h2>` +
      (items.length
        ? `<ul>${items.map((i) => `<li class="need">${esc(describeNeed(i))}</li>`).join("")}</ul>`
        : `<p class="muted">Nothing waits on ${esc(principal)}.</p>`),
  );
  const task = (t: TaskView): string => {
    const needsPerson = ["needs_recipient", "needs_answer"].includes(t.status);
    const head =
      `<div class="head"><span class="id">${esc(t.id)}</span>` +
      `<span class="status${needsPerson ? " needs" : ""}">${esc(t.status)}</span>` +
      `<span class="muted">${esc(t.source)} → ${esc(t.recipient ?? "?")}</span>` +
      (t.final
        ? `<span class="muted">${t.final.completed} of ${t.final.of} completed${t.final.reason ? ` · ${esc(t.final.reason)}` : ""}</span>`
        : "") +
      `</div>`;
    const deliveries = t.deliveries.map((d) => {
      const bits = [
        `<span class="id">${esc(d.id)}</span> ${esc(d.placement)} · ${esc(d.send.kind)} ${esc(d.send.messageId)} ${esc(d.send.outcome)}${d.end ? ` · ended ${esc(d.end.reason)}` : ""}`,
      ];
      if (d.question)
        bits.push(
          `<div class="text">question ${esc(d.question.id)}: ${esc(d.question.text)}</div>`,
        );
      if (d.latest)
        bits.push(
          `<div class="text">${esc(d.latest.kind)}: ${esc(d.latest.text)}</div>`,
        );
      return `<div class="sub">${bits.join("")}</div>`;
    });
    const routing =
      t.routing && t.routing.state !== "judging"
        ? `<div class="sub muted">waiting for a recipient: ${esc(t.routing.reason)}${t.routing.suggestions.length ? `; suggested ${esc(t.routing.suggestions.join(", "))}` : ""}</div>`
        : t.routing
          ? `<div class="sub muted">asking Jev</div>`
          : "";
    return `<div class="task">${head}<div class="text">${esc(t.text)}</div>${routing}${deliveries.join("")}</div>`;
  };
  return `<!doctype html>
<html lang="en"><head><meta charset="utf-8">
<meta name="viewport" content="width=device-width, initial-scale=1">
<meta http-equiv="refresh" content="${refreshSeconds}">
<title>Router board</title><style>${STYLE}</style></head><body>
<h1>Router board</h1>
<div class="at">as of ${esc(model.at)} · refreshes every ${refreshSeconds}s · <a href="board.json">board.json</a></div>
${needs.join("")}
<h2>Placements</h2>
<ul>${model.placements.map((p) => `<li><span class="id">${esc(p.key)}</span>: ${p.ready ? "ready" : "not ready"}${p.hold ? ", held by you" : ""} <span class="muted">· session ${esc(p.session)}</span></li>`).join("")}</ul>
<h2>Open <span class="muted">(${model.open.length})</span></h2>
${model.open.length ? model.open.map(task).join("") : `<p class="muted">No open tasks.</p>`}
<h2>Finished <span class="muted">(last ${model.finished.length})</span></h2>
${model.finished.map(task).join("")}
<h2>Journal tail</h2>
<div class="log">${model.log.map((l) => `<div>${l.n}. ${esc(l.actor)}: ${esc(l.text)}</div>`).join("")}</div>
</body></html>
`;
}
