// The board: what waits on a person and what the router is doing, read from
// the record. `boardModel` is pure and is what `GET board.json` returns; the
// HTML is one rendering of it: a sentence about what waits on you with the
// strips that clear it, a status rail, then the record as a session
// transcript. Nothing here writes.
import { randomBytes } from "node:crypto";
import { A2A_STATE, currentSend, needsYou, reduce } from "./core.ts";
import { fold } from "./shell.ts";
import type { RouterConfig } from "./config.ts";
import type { Entry } from "./journal.ts";
import type {
  Delivery,
  Event,
  NeedsYouItem,
  Role,
  RoutingReason,
  Send,
  State,
  StuckReason,
  Task,
  Update,
} from "./types.ts";

export type DeliveryView = {
  id: string;
  placement: string;
  session: string | null;
  send: { kind: string; messageId: string; outcome: string };
  sends: Pick<Send, "messageId" | "kind" | "text" | "outcome">[];
  question: { id: string; text: string } | null;
  updates: Update[];
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
  judgments: Task["judgments"];
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
  // When each message was recorded, by message id; display only.
  times: Record<string, string>;
  log: State["log"];
};

const FINISHED_SHOWN = 10;
const LOG_SHOWN = 20;
const TASK_LOG_SHOWN = 8;

// The record as of `now`, folded in memory: deadlines that passed since the
// last run show as passed, and the journal is untouched.
export function boardState(
  config: RouterConfig,
  entries: Entry[],
  now: number,
): State {
  return reduce(fold(config, entries), { type: "tick", now });
}

export function messageTimes(entries: Entry[]): Record<string, string> {
  const times: Record<string, string> = {};
  for (const { at, event } of entries)
    if (
      ["submit", "update", "answer"].includes(String(event.type)) &&
      typeof event.messageId === "string"
    )
      times[event.messageId] = at;
  return times;
}

export function boardModel(
  state: State,
  config: RouterConfig,
  now: number,
  times: Record<string, string> = {},
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
    times,
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
    judgments: task.judgments,
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
        sends: d.sends.map(({ messageId, kind, text, outcome }) => ({
          messageId,
          kind,
          text,
          outcome,
        })),
        question: d.question,
        updates: d.updates,
        latest: d.updates.at(-1) ?? null,
        end: d.end,
      };
    }),
  };
}

// A task's last lines in the router's log, shared with `router status
// <task>`. The id is matched as a whole word, so T1 does not collect the
// lines of T12.
export function taskLog(log: State["log"], taskId: string): State["log"] {
  const word = new RegExp(`\\b${taskId}\\b`);
  return log.filter((entry) => word.test(entry.text)).slice(-TASK_LOG_SHOWN);
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

// What to type to clear an item.
function commandFor(item: NeedsYouItem): string {
  switch (item.kind) {
    case "choose":
      return `router choose --task ${item.taskId} --to ${item.suggestions[0] ?? "<participant>"}`;
    case "answer":
      return `router answer --task ${item.taskId} --question ${item.questionId} --text "..."`;
    case "resolve":
      return `router resolve --delivery ${item.deliveryId} --message ${item.messageId} --outcome finished|not_sent --evidence "..."`;
  }
}

// Who is looking, as Tailscale Serve reports it, and which principals the
// configuration lets that login act as. Null when the request did not come
// through Serve or the login is not mapped: the page then only reads.
export type Actor = { login: string; principals: string[] };

export function identify(
  headers: Record<string, string | string[] | undefined>,
  identities: Record<string, string[]>,
): Actor | null {
  const login = headers["tailscale-user-login"];
  if (typeof login !== "string" || !login) return null;
  const principals = identities[login];
  return principals?.length ? { login, principals } : null;
}

// Message ids the router mints for answers: time-ordered, unique enough.
export const newMessageId = (): string =>
  `m-${Date.now().toString(36)}-${randomBytes(3).toString("hex")}`;

export type ActionResult =
  { ok: true; event: Event } | { ok: false; message: string };

// A form post from the page as the event it stands for. `by` is the actor's
// principal in the role the action needs; the core enforces the rest.
export function actionEvent(
  form: URLSearchParams,
  actor: Actor,
  roles: Record<string, Role>,
): ActionResult {
  const field = (name: string): string => form.get(name)?.trim() ?? "";
  const as = (role: Role): string | null =>
    actor.principals.find((p) => roles[p] === role) ?? null;
  const need = (role: Role): string | ActionResult => {
    const by = as(role);
    return (
      by ?? { ok: false, message: `${actor.login} has no ${role} principal.` }
    );
  };
  const required = (...names: string[]): ActionResult | null => {
    const missing = names.filter((n) => !field(n));
    return missing.length
      ? { ok: false, message: `Missing ${missing.join(", ")}.` }
      : null;
  };
  switch (field("action")) {
    case "choose": {
      const by = need("requester");
      if (typeof by !== "string") return by;
      return (
        required("task", "to") ?? {
          ok: true,
          event: { type: "choose", by, taskId: field("task"), to: field("to") },
        }
      );
    }
    case "answer": {
      const by = need("requester");
      if (typeof by !== "string") return by;
      return (
        required("task", "question", "text") ?? {
          ok: true,
          event: {
            type: "answer",
            by,
            taskId: field("task"),
            messageId: newMessageId(),
            questionId: field("question"),
            text: field("text"),
          },
        }
      );
    }
    case "cancel": {
      const by = need("requester");
      if (typeof by !== "string") return by;
      return (
        required("task") ?? {
          ok: true,
          event: { type: "cancel", by, taskId: field("task") },
        }
      );
    }
    case "resolve": {
      const by = need("operator");
      if (typeof by !== "string") return by;
      const outcome = field("outcome");
      if (outcome !== "finished" && outcome !== "not_sent")
        return { ok: false, message: "Outcome is finished or not_sent." };
      return (
        required("delivery", "message", "evidence") ?? {
          ok: true,
          event: {
            type: "resolve",
            by,
            deliveryId: field("delivery"),
            messageId: field("message"),
            outcome,
            evidence: field("evidence"),
          },
        }
      );
    }
    case "hold":
      return (
        required("placement") ?? {
          ok: true,
          event: {
            type: "observe",
            placement: field("placement"),
            hold: field("hold") === "1",
          },
        }
      );
    default:
      return { ok: false, message: `Unknown action "${field("action")}".` };
  }
}

const esc = (value: unknown): string =>
  String(value)
    .replaceAll("&", "&amp;")
    .replaceAll("<", "&lt;")
    .replaceAll(">", "&gt;")
    .replaceAll('"', "&quot;");

const clock = (iso: string | undefined): string =>
  iso ? iso.slice(11, 16) : "";

const day = (iso: string | undefined): string => (iso ? iso.slice(5, 10) : "");

// Design tokens. One saturated hue (indigo) stands for you; the rest of the
// color is traffic-signal state: amber waits on you, green is ready or done,
// red failed, violet held. Type is IBM Plex Sans KR when the device has it
// (one family for Latin and Hangul), else the platform's Hangul-capable
// sans; nothing is fetched from a third party for a private page.
const STYLE = `
:root {
  --bg: #F6F7F4; --surface: #FFFFFF; --ink: #16181D; --muted: #626873; --line: #D9DCE0;
  --you: #2F4C9A; --you-tint: #E6EAF6; --agent-tint: #EEF0F2;
  --amber: #B57A00; --amber-tint: #FBF1D6; --green: #2F7A45; --red: #B3372F; --violet: #6B4FA5;
  --sans: "IBM Plex Sans KR", "IBM Plex Sans", "Apple SD Gothic Neo", "Noto Sans KR", system-ui, sans-serif;
  --mono: "IBM Plex Mono", ui-monospace, Menlo, monospace;
}
@media (prefers-color-scheme: dark) {
  :root {
    --bg: #0F1220; --surface: #171B2C; --ink: #E6E8EE; --muted: #9AA0AE; --line: #2A3045;
    --you: #8FA6E8; --you-tint: #223058; --agent-tint: #20253A;
    --amber: #E4B04A; --amber-tint: #3A2E12; --green: #6FBF86; --red: #E07C74; --violet: #B39DE8;
  }
}
* { box-sizing: border-box; }
html { background: var(--bg); }
body { margin: 0; color: var(--ink); background: var(--bg); font: 400 15px/1.55 var(--sans); }
#app { max-width: 64rem; margin: 0 auto; padding: 20px 16px 48px; }
a { color: var(--you); text-underline-offset: 2px; }
button, input { font: inherit; }
:focus-visible { outline: 2px solid var(--you); outline-offset: 2px; }
.mono { font-family: var(--mono); font-size: .9em; }
.muted { color: var(--muted); }
.id { font-family: var(--mono); font-size: .86rem; color: var(--muted); }

/* Top line: what this is, who is looking, where to go. */
.top { display: flex; gap: 16px; align-items: baseline; flex-wrap: wrap; margin-bottom: 28px; font-size: .9rem; color: var(--muted); }
.top .brand { color: var(--ink); font-weight: 600; font-size: 1rem; }
.top .spacer { flex: 1; }
.top nav { display: flex; gap: 14px; }

/* Hero: one sentence about you, then the strips that need you. */
.hero h1 { font-size: clamp(1.6rem, 4vw, 2.1rem); font-weight: 500; line-height: 1.2; margin: 0 0 6px; letter-spacing: -.01em; }
.hero h1.attn { color: var(--amber); }
.hero .lead { margin: 0 0 18px; color: var(--muted); max-width: 40rem; }
.bay { list-style: none; margin: 0 0 8px; padding: 0; display: flex; flex-direction: column; gap: 10px; }
.need { background: var(--amber-tint); border-left: 3px solid var(--amber); border-radius: 6px; padding: 12px 14px; }
.need .what { display: flex; gap: 10px; align-items: baseline; flex-wrap: wrap; }
.need .why { color: var(--muted); font-size: .9rem; margin: 2px 0 8px; }
.need .quote { margin: 4px 0 8px; padding-left: 10px; border-left: 2px solid var(--line); white-space: pre-wrap; word-break: break-word; }
.need code { font-family: var(--mono); font-size: .86em; background: var(--surface); padding: 2px 6px; border-radius: 4px; }

/* Forms: buttons say what happens. */
.act { display: flex; gap: 8px; flex-wrap: wrap; align-items: center; }
.act + .act { margin-top: 6px; }
.act input { min-height: 44px; padding: 6px 12px; border: 1px solid var(--line); border-radius: 6px; background: var(--surface); color: var(--ink); flex: 1 1 14rem; }
.act button { min-height: 44px; padding: 6px 16px; border-radius: 6px; border: 1px solid var(--you); background: var(--you); color: var(--surface); cursor: pointer; }
.act button.quiet { background: transparent; color: var(--ink); border-color: var(--line); }
.act button.danger { background: transparent; color: var(--red); border-color: var(--red); }
@media (prefers-color-scheme: dark) { .act button { color: var(--bg); } }

/* Status rail: three expandable rows. */
.rail { margin: 28px 0 32px; border-top: 1px solid var(--line); }
.row { border-bottom: 1px solid var(--line); }
.row > summary { list-style: none; cursor: pointer; display: flex; gap: 12px; align-items: baseline; padding: 12px 4px; flex-wrap: wrap; min-height: 44px; }
.row > summary::-webkit-details-marker { display: none; }
.row > summary .k { flex: 0 0 7rem; color: var(--muted); }
.row > summary .v { flex: 1 1 16rem; }
.row > summary .more { color: var(--muted); font-size: .85rem; }
.row[open] > summary .more { visibility: hidden; }
.row .body { padding: 2px 4px 16px; font-size: .92rem; }
.row .body ul { margin: 0; padding-left: 1.1rem; }
.dot { display: inline-block; width: .55em; height: .55em; border-radius: 50%; margin-right: .4em; background: var(--muted); }
.dot.ready { background: var(--green); }
.dot.busy { background: var(--amber); }
.dot.held { background: var(--violet); }
.agents { display: inline-flex; flex-wrap: wrap; gap: 4px 18px; }
table { border-collapse: collapse; width: 100%; }
td, th { text-align: left; padding: 6px 10px 6px 0; border-bottom: 1px solid var(--line); vertical-align: middle; }
th { color: var(--muted); font-weight: 500; font-size: .85rem; }
td .act button { min-height: 36px; padding: 2px 12px; }

/* Record: tasks are strips; open one and it is a conversation. */
.record h2 { font-size: 1.05rem; font-weight: 600; margin: 0 0 2px; }
.record .sub { margin: 0 0 10px; color: var(--muted); font-size: .9rem; }
.thread { border-top: 1px solid var(--line); }
.thread:last-of-type { border-bottom: 1px solid var(--line); }
.thread > summary { list-style: none; cursor: pointer; display: grid; grid-template-columns: 3.4rem 3rem auto 1fr auto; gap: 10px; align-items: baseline; padding: 10px 4px; min-height: 44px; }
.thread > summary::-webkit-details-marker { display: none; }
.thread > summary .time { font-size: .85rem; color: var(--muted); font-variant-numeric: tabular-nums; }
.thread > summary .excerpt { overflow: hidden; text-overflow: ellipsis; white-space: nowrap; }
.thread[open] > summary .excerpt { white-space: normal; color: var(--muted); }
.thread > summary .to { color: var(--muted); font-size: .9rem; white-space: nowrap; }
.chip { font-size: .8rem; padding: 1px 8px; border-radius: 4px; background: var(--agent-tint); color: var(--muted); white-space: nowrap; }
.chip.attn { background: var(--amber-tint); color: var(--amber); }
.chip.ok { color: var(--green); }
.chip.bad { color: var(--red); }
.messages { padding: 4px 4px 18px; display: flex; flex-direction: column; gap: 8px; }
.tools { display: flex; justify-content: flex-end; }
.msg { max-width: 80%; padding: 8px 12px; border-radius: 8px; white-space: pre-wrap; word-break: break-word; }
.msg .who { display: block; font-size: .8rem; color: var(--muted); margin-bottom: 2px; }
.msg.you { align-self: flex-end; background: var(--you-tint); border-bottom-right-radius: 2px; }
.msg.you .who { color: var(--you); }
.msg.agent { align-self: flex-start; background: var(--agent-tint); border-bottom-left-radius: 2px; }
.msg.question { box-shadow: inset 0 0 0 1px var(--amber); }
.msg.question .who { color: var(--amber); }
.msg.failed { box-shadow: inset 0 0 0 1px var(--red); }
.msg.failed .who { color: var(--red); }
.sys { align-self: center; font-size: .85rem; color: var(--muted); text-align: center; }
.sys.attn { color: var(--amber); }

.notice { max-width: 64rem; margin: 0 auto; padding: 12px 16px 0; }
.notice div { background: var(--you-tint); border-left: 3px solid var(--you); padding: 8px 12px; border-radius: 6px; font-size: .92rem; display: flex; gap: 12px; }
.notice a { margin-left: auto; white-space: nowrap; }
.log .body { font-family: var(--mono); font-size: .8rem; color: var(--muted); white-space: pre-wrap; }
@media (max-width: 640px) {
  .msg { max-width: 94%; }
  .thread > summary { grid-template-columns: 3.4rem 3rem auto 1fr; }
  .thread > summary .to { grid-column: 2 / -1; }
  .row > summary .k { flex-basis: 100%; }
  .sessions td:nth-child(3), .sessions th:nth-child(3) { display: none; }
}
`;

// Swap the page in place: expanded rows and threads keep their state, and
// scroll does not jump. The notice sits outside #app, so it stays until
// dismissed. A failed fetch leaves the page as it is.
const SCRIPT = `
const refresh = async () => {
  try {
    const r = await fetch(location.pathname, { cache: "no-store", headers: { accept: "text/html" } });
    if (!r.ok) return;
    const doc = new DOMParser().parseFromString(await r.text(), "text/html");
    const was = new Map([...document.querySelectorAll("details[id]")].map((d) => [d.id, d.open]));
    for (const d of doc.querySelectorAll("details[id]")) if (was.has(d.id)) d.open = was.get(d.id);
    document.getElementById("app").replaceWith(doc.getElementById("app"));
  } catch {}
};
setInterval(refresh, Number(document.getElementById("app").dataset.refresh) * 1000);
`;

const statusClass = (status: TaskView["status"]): string =>
  ["needs_recipient", "needs_answer", "uncertain"].includes(status)
    ? "attn"
    : status === "completed"
      ? "ok"
      : ["failed", "canceled", "partial"].includes(status)
        ? "bad"
        : "";

const plain = (value: string): string => value.replaceAll("_", " ");

const COUNT_WORDS = [
  "Nothing",
  "One thing",
  "Two things",
  "Three things",
  "Four things",
  "Five things",
  "Six things",
  "Seven things",
  "Eight things",
  "Nine things",
];

const ROUTING_WHY: Record<RoutingReason, string> = {
  no_owner: "Jev found no owner among your participants.",
  low_confidence: "Jev was not sure enough to send it.",
  invalid_judgment: "Jev's answer could not be used.",
  routing_unavailable: "Jev could not be reached.",
};

const STUCK_WHY: Record<StuckReason, string> = {
  task_ended: "The task ended before this send was confirmed.",
  session_replaced: "The session it was pinned to has been replaced.",
  unknown_send: "The send's outcome is unknown and cannot be retried.",
};

export type RenderOptions = {
  refreshSeconds?: number;
  // Controls are rendered only for a recognised viewer.
  actor?: Actor | null;
  // Outcome of the last action, shown until dismissed.
  notice?: string | null;
};

export function renderBoard(
  model: BoardModel,
  options: RenderOptions = {},
): string {
  const refreshSeconds = options.refreshSeconds ?? 10;
  const actor = options.actor ?? null;
  const roles = new Map(model.needsYou.map((n) => [n.principal, n.role]));
  const can = (role: string): boolean =>
    actor !== null && actor.principals.some((p) => roles.get(p) === role);
  const hidden = (fields: Record<string, string>): string =>
    Object.entries(fields)
      .map(
        ([k, v]) => `<input type="hidden" name="${esc(k)}" value="${esc(v)}">`,
      )
      .join("");
  const form = (
    fields: Record<string, string>,
    controls: string,
    confirm?: string,
  ): string =>
    `<form method="post" action="actions" class="act"${confirm ? ` onsubmit="return confirm(${esc(JSON.stringify(confirm))})"` : ""}>${hidden(fields)}${controls}</form>`;
  const cancelForm = (taskId: string): string =>
    form(
      { action: "cancel", task: taskId },
      `<button class="danger">Cancel ${esc(taskId)}</button>`,
      `Cancel ${taskId}? Work already sent keeps running; the router stops tracking it.`,
    );
  const tasks = new Map(
    [...model.open, ...model.finished].map((t) => [t.id, t]),
  );

  // One strip per thing that waits on you: what, why, and the buttons.
  const strip = (item: NeedsYouItem): string => {
    const task = tasks.get(item.taskId);
    const quote = task
      ? `<div class="quote">${esc(task.text.length > 240 ? `${task.text.slice(0, 240)}…` : task.text)}</div>`
      : "";
    if (item.kind === "choose") {
      const controls = can("requester")
        ? form(
            { action: "choose", task: item.taskId },
            item.suggestions
              .map(
                (to) =>
                  `<button name="to" value="${esc(to)}">Send to ${esc(to)}</button>`,
              )
              .join(""),
          ) + cancelForm(item.taskId)
        : `<code>${esc(commandFor(item))}</code>`;
      return (
        `<li class="need"><div class="what"><a class="id" href="#t-${esc(item.taskId)}">${esc(item.taskId)}</a><strong>needs a recipient</strong></div>` +
        `<div class="why">${esc(ROUTING_WHY[item.reason])}${item.suggestions.length ? ` Its ranking: ${esc(item.suggestions.join(", "))}.` : ""}</div>` +
        quote +
        controls +
        `</li>`
      );
    }
    if (item.kind === "answer") {
      const controls = can("requester")
        ? form(
            { action: "answer", task: item.taskId, question: item.questionId },
            `<input name="text" required placeholder="Your answer" autocomplete="off" aria-label="Your answer to ${esc(item.taskId)}"><button>Send answer</button>`,
          )
        : `<code>${esc(commandFor(item))}</code>`;
      return (
        `<li class="need"><div class="what"><a class="id" href="#t-${esc(item.taskId)}">${esc(item.taskId)}</a><strong>asks you</strong></div>` +
        `<div class="quote">${esc(item.text)}</div>` +
        controls +
        `</li>`
      );
    }
    const controls = can("operator")
      ? form(
          {
            action: "resolve",
            delivery: item.deliveryId,
            message: item.messageId,
          },
          `<input name="evidence" required placeholder="What you saw in the session" autocomplete="off" aria-label="Evidence for ${esc(item.deliveryId)}"><button name="outcome" value="finished">Mark finished</button><button name="outcome" value="not_sent" class="quiet">Mark not sent</button>`,
        )
      : `<code>${esc(commandFor(item))}</code>`;
    return (
      `<li class="need"><div class="what"><a class="id" href="#t-${esc(item.taskId)}">${esc(item.deliveryId)}</a><strong>needs your confirmation</strong></div>` +
      `<div class="why">${esc(STUCK_WHY[item.reason])} Check the session, then record what happened to message ${esc(item.messageId)}.</div>` +
      quote +
      controls +
      `</li>`
    );
  };

  const items = model.needsYou.flatMap((n) => n.items);
  const headline = `${COUNT_WORDS[items.length] ?? `${items.length} things`} ${items.length > 1 ? "wait" : "waits"} on you.`;
  const hero =
    `<section class="hero" id="needs"><h1 class="${items.length ? "attn" : ""}">${esc(headline)}</h1>` +
    (items.length
      ? `<ol class="bay">${items.map(strip).join("")}</ol>`
      : `<p class="lead">${model.open.length ? "Everything open is with its agent." : "New work starts with <code>router submit</code>, or in a session."}</p>`) +
    `</section>`;

  // Status rail.
  const dot = (p: BoardModel["placements"][number]): string =>
    `<span class="dot ${p.hold ? "held" : p.ready ? "ready" : "busy"}"></span>`;
  const stateOf = (p: BoardModel["placements"][number]): string =>
    p.hold ? "held" : p.ready ? "ready" : "busy or away";
  const agentsRow =
    `<details id="w-agents" class="row"><summary><span class="k">Agents</span><span class="v agents">${model.placements.map((p) => `<span>${dot(p)}${esc(p.key)} <span class="muted">${esc(stateOf(p))}</span></span>`).join("")}</span><span class="more">details</span></summary>` +
    `<div class="body"><table class="sessions"><tr><th>Placement</th><th>State</th><th>Session</th>${actor ? "<th></th>" : ""}</tr>` +
    model.placements
      .map(
        (p) =>
          `<tr><td>${dot(p)}${esc(p.key)}</td><td>${esc(stateOf(p))}</td><td class="mono">${esc(p.session)}</td>` +
          (actor
            ? `<td>${form({ action: "hold", placement: p.key, hold: p.hold ? "0" : "1" }, `<button class="quiet">${p.hold ? "Release" : "Hold"}</button>`)}</td>`
            : "") +
          `</tr>`,
      )
      .join("") +
    `</table><p class="muted">Hold keeps the router from sending to a session while you work in it; queued work goes out on release.</p></div></details>`;

  const counts = new Map<string, number>();
  for (const t of model.open)
    counts.set(t.status, (counts.get(t.status) ?? 0) + 1);
  const openRow =
    `<details id="w-open" class="row"><summary><span class="k">In flight</span><span class="v">${model.open.length ? esc([...counts].map(([s, n]) => `${n} ${plain(s)}`).join(", ")) : "nothing"}</span><span class="more">${model.open.length ? "list" : ""}</span></summary>` +
    `<div class="body">${
      model.open.length
        ? `<ul>${model.open.map((t) => `<li><a class="id" href="#t-${esc(t.id)}">${esc(t.id)}</a> <span class="chip ${statusClass(t.status)}">${esc(plain(t.status))}</span> ${esc(t.text.slice(0, 90))}</li>`).join("")}</ul>`
        : `<p class="muted">No open tasks.</p>`
    }</div></details>`;

  const pOf = (j: Task["judgments"][number]): string =>
    j.probabilities ? (j.probabilities[j.choice] ?? 0).toFixed(2) : "invalid";
  const runnerUp = (j: Task["judgments"][number]): string => {
    const other = j.probabilities
      ? Object.entries(j.probabilities)
          .filter(([id]) => id !== j.choice)
          .sort((x, y) => y[1] - x[1])[0]
      : undefined;
    return other ? `${other[0]} ${other[1].toFixed(2)}` : "";
  };

  // The record: strips that open into conversations.
  const threads = [...model.finished, ...model.open].sort(
    (a, b) => Number(a.id.slice(1)) - Number(b.id.slice(1)),
  );
  const latestId = threads.at(-1)?.id;
  const today = model.at.slice(0, 10);
  const when = (iso: string | undefined): string =>
    !iso ? "" : iso.slice(0, 10) === today ? clock(iso) : day(iso);
  const thread = (t: TaskView): string => {
    const msgs: string[] = [];
    // The delivery id only earns its place when a task fans out.
    const who = (d: DeliveryView): string =>
      t.deliveries.length > 1
        ? `${esc(d.placement)} (${esc(d.id)})`
        : esc(d.placement);
    if (!t.final && can("requester"))
      msgs.push(`<div class="tools">${cancelForm(t.id)}</div>`);
    msgs.push(
      `<div class="msg you" title="message ${esc(t.messageId)}"><span class="who">${esc(t.source.split("/")[0])}${model.times[t.messageId] ? `, ${clock(model.times[t.messageId])}` : ""}</span>${esc(t.text)}</div>`,
    );
    const lastJudgment = t.judgments.at(-1);
    if (lastJudgment)
      msgs.push(
        `<div class="sys">Jev picked ${esc(lastJudgment.choice)} at ${esc(pOf(lastJudgment))}${runnerUp(lastJudgment) ? `, runner-up ${esc(runnerUp(lastJudgment))}` : ""}${lastJudgment.model ? `, ${esc(lastJudgment.model)}` : ""}</div>`,
      );
    if (t.routing && !t.final)
      msgs.push(
        t.routing.state === "needs_recipient"
          ? `<div class="sys attn"><a href="#needs">Waiting for you to choose a recipient</a></div>`
          : `<div class="sys">Asking Jev</div>`,
      );
    for (const d of t.deliveries) {
      for (const s of d.sends) {
        if (s.kind === "answer")
          msgs.push(
            `<div class="msg you" title="message ${esc(s.messageId)}"><span class="who">you, answer${s.outcome === "withdrawn" ? ", withdrawn" : s.outcome !== "accepted" ? `, ${esc(s.outcome)}` : ""}${model.times[s.messageId] ? `, ${clock(model.times[s.messageId])}` : ""}</span>${esc(s.text)}</div>`,
          );
        else if (s.outcome !== "accepted")
          msgs.push(
            `<div class="sys">${esc(d.placement)}: ${esc(plain(s.outcome))}</div>`,
          );
        for (const u of d.updates.filter((u) => u.inReplyTo === s.messageId)) {
          msgs.push(
            `<div class="msg agent ${u.kind === "question" ? "question" : u.kind === "failed" ? "failed" : ""}" title="message ${esc(u.messageId)}"><span class="who">${who(d)}, ${esc(u.kind)}${model.times[u.messageId] ? `, ${clock(model.times[u.messageId])}` : ""}</span>${esc(u.text)}</div>`,
          );
          if (d.question?.id === u.messageId && !t.final)
            msgs.push(
              `<div class="sys attn"><a href="#needs">Waiting for your answer</a></div>`,
            );
        }
      }
      if (d.end && !["completed", "failed"].includes(d.end.reason))
        msgs.push(
          `<div class="sys">${esc(d.placement)}: ${esc(plain(d.end.reason))}</div>`,
        );
    }
    if (t.final)
      msgs.push(
        `<div class="sys">${esc(t.final.status)}, ${t.final.completed} of ${t.final.of} deliveries${t.final.reason ? `, ${esc(plain(t.final.reason))}` : ""}</div>`,
      );
    const isOpen = !t.final || t.id === latestId;
    return (
      `<details class="thread" id="t-${esc(t.id)}"${isOpen ? " open" : ""}><summary>` +
      `<span class="time">${esc(when(model.times[t.messageId]))}</span>` +
      `<span class="id">${esc(t.id)}</span>` +
      `<span class="chip ${statusClass(t.status)}">${esc(plain(t.status))}</span>` +
      `<span class="excerpt">${esc(t.text)}</span>` +
      `<span class="to">${t.recipient ? `to ${esc(t.recipient)}` : t.final ? "no recipient" : "no recipient yet"}${lastJudgment ? `<span class="muted">, Jev ${lastJudgment.choice === t.recipient ? "" : `${esc(lastJudgment.choice)} `}${esc(pOf(lastJudgment))}</span>` : ""}</span>` +
      `</summary><div class="messages">${msgs.join("")}</div></details>`
    );
  };

  return `<!doctype html>
<html lang="en"><head><meta charset="utf-8">
<meta name="viewport" content="width=device-width, initial-scale=1">
<title>Router</title>
<style>${STYLE}</style></head><body>
${options.notice ? `<div class="notice"><div><span>${esc(options.notice)}</span><a href="./">Dismiss</a></div></div>` : ""}
<div id="app" data-refresh="${refreshSeconds}">
<header class="top"><span class="brand">Router</span><span>${actor ? `Acting as ${esc(actor.login)}` : "Read only"}</span><span>Updated ${esc(clock(model.at))}Z</span><span class="spacer"></span><nav>${latestId ? `<a href="#t-${esc(latestId)}">Jump to latest</a>` : ""}<a href="board.json">JSON</a></nav></header>
${hero}
<section class="rail">${agentsRow}${openRow}</section>
<section class="record"><h2>Record</h2><p class="sub">The last ${model.finished.length} finished and everything open. Open a strip to read the exchange.</p>
${threads.length ? threads.map(thread).join("") : `<p class="muted">No tasks recorded yet.</p>`}
</section>
<section class="rail"><details id="w-log" class="row log"><summary><span class="k">Log</span><span class="v">${esc(model.log.at(-1)?.text ?? "")}</span><span class="more">last ${model.log.length}</span></summary><div class="body">${model.log.map((l) => `${l.n}. ${esc(l.actor)}: ${esc(l.text)}`).join("\n")}</div></details></section>
</div>
<script>${SCRIPT}</script>
</body></html>
`;
}
