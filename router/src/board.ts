// The board: what waits on a person and what the router is doing, read from
// the record. `boardModel` is pure and is what `GET board.json` returns; the
// HTML is one rendering of it: a row of widgets that expand for detail, then
// the record as a session transcript. Nothing here writes.
import { A2A_STATE, currentSend, needsYou, reduce } from "./core.ts";
import { fold } from "./shell.ts";
import type { RouterConfig } from "./config.ts";
import type { Entry } from "./journal.ts";
import type {
  Delivery,
  Event,
  NeedsYouItem,
  Role,
  Send,
  State,
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
  const messageId = (): string =>
    `m-${Date.now().toString(36)}-${Math.random().toString(16).slice(2, 8)}`;
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
            messageId: messageId(),
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

const STYLE = `
:root {
  --bg: #f4f1ea; --card: #fffdf8; --ink: #1d1c1a; --muted: #6f6a61; --line: #e2ddd2;
  --you: #2b6f6a; --you-bg: #dcecea; --agent-bg: #f0ece3;
  --attn: #b8621b; --attn-bg: #fbe9d7; --ok: #3f7d4e; --bad: #b23a3a; --hold: #7a5ea8;
  --mono: ui-monospace, "SF Mono", Menlo, Consolas, monospace;
}
@media (prefers-color-scheme: dark) {
  :root {
    --bg: #15161a; --card: #1e2026; --ink: #e8e6e1; --muted: #9a978f; --line: #2c2f37;
    --you: #7fc7c0; --you-bg: #1f3a39; --agent-bg: #262931;
    --attn: #e6a15c; --attn-bg: #3a2a18; --ok: #7fbf8a; --bad: #e07a7a; --hold: #b39ddb;
  }
}
* { box-sizing: border-box; }
html { background: var(--bg); }
body { margin: 0; color: var(--ink); background: var(--bg);
  font: 15px/1.5 system-ui, -apple-system, "Segoe UI", sans-serif; }
#app { max-width: 60rem; margin: 0 auto; padding: 16px; }
a { color: var(--you); }
.mono { font-family: var(--mono); font-size: .92em; }
.muted { color: var(--muted); }

header { display: flex; align-items: baseline; gap: 12px; flex-wrap: wrap; margin: 4px 0 14px; }
header h1 { font-size: 1.15rem; margin: 0; letter-spacing: .01em; }
header .at { color: var(--muted); font-size: .85rem; }
header .spacer { flex: 1; }

.widgets { display: grid; gap: 12px; grid-template-columns: repeat(auto-fit, minmax(11.5rem, 1fr)); margin-bottom: 22px; }
.widget { background: var(--card); border: 1px solid var(--line); border-radius: 12px; overflow: hidden; }
.widget[open] { grid-column: 1 / -1; }
.widget > summary { list-style: none; cursor: pointer; padding: 12px 14px; display: grid;
  grid-template-columns: auto 1fr; grid-template-rows: auto auto; column-gap: 12px; align-items: baseline; }
.widget > summary::-webkit-details-marker { display: none; }
.widget > summary .num { grid-row: 1 / span 2; font-size: 2rem; font-weight: 650; line-height: 1; align-self: center; font-variant-numeric: tabular-nums; }
.widget > summary .label { font-size: .78rem; text-transform: uppercase; letter-spacing: .08em; color: var(--muted); }
.widget > summary .brief { font-size: .95rem; overflow: hidden; text-overflow: ellipsis; white-space: nowrap; }
.widget[open] > summary .brief { white-space: normal; }
.widget .body { border-top: 1px solid var(--line); padding: 10px 14px 12px; font-size: .92rem; }
.widget .body .label { display: block; font-size: .72rem; text-transform: uppercase; letter-spacing: .08em; margin-top: 6px; }
.widget .body ul { margin: 0; padding-left: 1.1rem; }
.widget .body li { margin: 4px 0; }
.widget .body code { font-family: var(--mono); font-size: .85em; background: var(--agent-bg); padding: 1px 6px; border-radius: 4px; }
.widget.attn { border-color: var(--attn); background: var(--attn-bg); }
.widget.attn .num { color: var(--attn); }
.widget.calm .num { color: var(--ok); }
.dot { display: inline-block; width: .6em; height: .6em; border-radius: 50%; margin-right: .35em; background: var(--muted); vertical-align: baseline; }
.dot.ready { background: var(--ok); }
.dot.busy { background: var(--attn); }
.dot.held { background: var(--hold); }
.agents { display: flex; flex-wrap: wrap; gap: 4px 14px; }
table { border-collapse: collapse; width: 100%; }
td, th { text-align: left; padding: 3px 8px 3px 0; border-bottom: 1px solid var(--line); font-weight: 500; }
th { color: var(--muted); font-size: .78rem; text-transform: uppercase; letter-spacing: .06em; }

.transcript h2 { font-size: .78rem; text-transform: uppercase; letter-spacing: .08em; color: var(--muted); margin: 0 0 8px; }
.thread { border-top: 1px solid var(--line); }
.thread > summary { list-style: none; cursor: pointer; display: flex; gap: 10px; align-items: baseline; padding: 10px 2px; flex-wrap: wrap; }
.thread > summary::-webkit-details-marker { display: none; }
.thread > summary .excerpt { flex: 1 1 16rem; overflow: hidden; text-overflow: ellipsis; white-space: nowrap; }
.thread[open] > summary .excerpt { display: none; }
.chip { font-size: .72rem; text-transform: uppercase; letter-spacing: .06em; padding: 1px 8px; border-radius: 999px; border: 1px solid var(--line); color: var(--muted); white-space: nowrap; }
.chip.attn { border-color: var(--attn); color: var(--attn); }
.chip.ok { border-color: var(--ok); color: var(--ok); }
.chip.bad { border-color: var(--bad); color: var(--bad); }
.thread .id { font-family: var(--mono); font-size: .85rem; color: var(--muted); }
.thread .time { font-size: .8rem; color: var(--muted); margin-left: auto; }
.messages { padding: 2px 0 16px; display: flex; flex-direction: column; gap: 8px; }
.msg { max-width: 82%; padding: 8px 12px; border-radius: 14px; white-space: pre-wrap; word-break: break-word; }
.msg .who { display: block; font-size: .72rem; text-transform: uppercase; letter-spacing: .06em; color: var(--muted); margin-bottom: 2px; }
.msg.you { align-self: flex-end; background: var(--you-bg); border-bottom-right-radius: 4px; }
.msg.you .who { color: var(--you); }
.msg.agent { align-self: flex-start; background: var(--agent-bg); border-bottom-left-radius: 4px; }
.msg.question { border: 1px solid var(--attn); }
.msg.question .who { color: var(--attn); }
.msg.failed { border: 1px solid var(--bad); }
.msg.failed .who { color: var(--bad); }
.sys { align-self: center; font-size: .8rem; color: var(--muted); text-align: center; padding: 0 12px; }
.sys.attn { color: var(--attn); }
.act { display: inline-flex; gap: 6px; flex-wrap: wrap; align-items: center; margin: 4px 0; }
.act input { font: inherit; padding: 4px 8px; border: 1px solid var(--line); border-radius: 8px; background: var(--card); color: var(--ink); min-width: 14rem; }
.act button { font: inherit; font-size: .88rem; padding: 4px 12px; border-radius: 999px; border: 1px solid var(--you); background: var(--you); color: var(--card); cursor: pointer; }
.act button.quiet { background: transparent; color: var(--muted); border-color: var(--line); }
.thread > summary .act { margin-left: 8px; }
.notice { background: var(--you-bg); border-left: 3px solid var(--you); padding: 6px 12px; border-radius: 6px; margin: -6px 0 14px; font-size: .9rem; }
.log { font-family: var(--mono); font-size: .78rem; color: var(--muted); white-space: pre-wrap; }
@media (max-width: 600px) { .msg { max-width: 94%; } .widget[open] { grid-column: auto; } }
`;

// Swap the page in place: expanded widgets and threads keep their state,
// and scroll does not jump. A failed fetch leaves the page as it is.
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

export type RenderOptions = {
  refreshSeconds?: number;
  // Controls are rendered only for a recognised viewer.
  actor?: Actor | null;
  // Outcome of the last action, shown once under the header.
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
  const form = (fields: Record<string, string>, controls: string): string =>
    `<form method="post" action="actions" class="act">${hidden(fields)}${controls}</form>`;
  // The controls that clear a needs-you item, or the command when the viewer
  // cannot act from here.
  const controlsFor = (item: NeedsYouItem): string => {
    if (item.kind === "choose" && can("requester"))
      return (
        form(
          { action: "choose", task: item.taskId },
          item.suggestions
            .map(
              (to) =>
                `<button name="to" value="${esc(to)}">${esc(to)}</button>`,
            )
            .join(""),
        ) +
        form(
          { action: "cancel", task: item.taskId },
          `<button class="quiet">cancel</button>`,
        )
      );
    if (item.kind === "answer" && can("requester"))
      return form(
        { action: "answer", task: item.taskId, question: item.questionId },
        `<input name="text" required placeholder="Your answer" autocomplete="off"><button>Send</button>`,
      );
    if (item.kind === "resolve" && can("operator"))
      return form(
        {
          action: "resolve",
          delivery: item.deliveryId,
          message: item.messageId,
        },
        `<input name="evidence" required placeholder="What you saw" autocomplete="off"><button name="outcome" value="finished">finished</button><button name="outcome" value="not_sent" class="quiet">not sent</button>`,
      );
    return `<code>${esc(commandFor(item))}</code>`;
  };
  const requester = model.needsYou.filter((n) => n.role !== "operator");
  const operator = model.needsYou.filter((n) => n.role === "operator");
  const needItems = requester.flatMap((n) => n.items);
  const stuck = operator.flatMap((n) => n.items);
  const totalNeeds = needItems.length + stuck.length;

  const needsWidget =
    `<details id="w-needs" class="widget ${totalNeeds ? "attn" : "calm"}"${totalNeeds ? " open" : ""}><summary>` +
    `<span class="num">${totalNeeds}</span><span class="label">needs you</span>` +
    `<span class="brief">${totalNeeds ? esc([...needItems, ...stuck].map(describeNeed).join(" · ")) : "Nothing waits on you."}</span>` +
    `</summary><div class="body">` +
    model.needsYou
      .map(
        ({ principal, role, items }) =>
          `<div><span class="label muted">${esc(principal)} · ${esc(role)}</span>` +
          (items.length
            ? `<ul>${items.map((i) => `<li>${esc(describeNeed(i))}<br>${controlsFor(i)}</li>`).join("")}</ul>`
            : `<div class="muted">Nothing waits on ${esc(principal)}.</div>`) +
          `</div>`,
      )
      .join("") +
    `</div></details>`;

  const ready = model.placements.filter((p) => p.ready && !p.hold).length;
  const dot = (p: BoardModel["placements"][number]): string =>
    `<span class="dot ${p.hold ? "held" : p.ready ? "ready" : "busy"}"></span>`;
  const agentsWidget =
    `<details id="w-agents" class="widget"><summary>` +
    `<span class="num">${ready}<span class="muted" style="font-size:.5em">/${model.placements.length}</span></span><span class="label">agents ready</span>` +
    `<span class="brief agents">${model.placements.map((p) => `<span>${dot(p)}${esc(p.key)}</span>`).join("")}</span>` +
    `</summary><div class="body"><table><tr><th>placement</th><th>state</th><th>session</th><th></th></tr>` +
    model.placements
      .map(
        (p) =>
          `<tr><td>${dot(p)}${esc(p.key)}</td><td>${p.hold ? "held by you" : p.ready ? "ready" : "busy or away"}</td><td class="mono">${esc(p.session)}</td>` +
          `<td>${actor ? form({ action: "hold", placement: p.key, hold: p.hold ? "0" : "1" }, `<button class="quiet">${p.hold ? "hand back" : "take"}</button>`) : ""}</td></tr>`,
      )
      .join("") +
    `</table></div></details>`;

  const counts = new Map<string, number>();
  for (const t of model.open)
    counts.set(t.status, (counts.get(t.status) ?? 0) + 1);
  const openWidget =
    `<details id="w-open" class="widget"><summary>` +
    `<span class="num">${model.open.length}</span><span class="label">in flight</span>` +
    `<span class="brief">${model.open.length ? esc([...counts].map(([s, n]) => `${n} ${s.replaceAll("_", " ")}`).join(" · ")) : "No open tasks."}</span>` +
    `</summary><div class="body">` +
    (model.open.length
      ? `<ul>${model.open.map((t) => `<li><a href="#t-${esc(t.id)}" class="mono">${esc(t.id)}</a> <span class="chip ${statusClass(t.status)}">${esc(t.status.replaceAll("_", " "))}</span> ${esc(t.text.slice(0, 80))}</li>`).join("")}</ul>`
      : `<div class="muted">No open tasks.</div>`) +
    `</div></details>`;

  const judged = [...model.open, ...model.finished]
    .filter((t) => t.judgments.length)
    .sort((a, b) => Number(b.id.slice(1)) - Number(a.id.slice(1)));
  const last = judged[0]?.judgments.at(-1);
  const pOf = (j: Task["judgments"][number]): string =>
    j.probabilities ? (j.probabilities[j.choice] ?? 0).toFixed(2) : "invalid";
  const jevWidget =
    `<details id="w-jev" class="widget"><summary>` +
    `<span class="num">${last ? esc(pOf(last)) : "–"}</span><span class="label">jev, last pick</span>` +
    `<span class="brief">${last ? `${esc(judged[0]?.id)} → ${esc(last.choice)}${last.model ? ` <span class="muted">· ${esc(last.model)}</span>` : ""}` : "No judgments yet."}</span>` +
    `</summary><div class="body"><table><tr><th>task</th><th>choice</th><th>p</th><th>runner-up</th></tr>` +
    judged
      .slice(0, 8)
      .map((t) => {
        const j = t.judgments.at(-1);
        if (!j) return "";
        const others = j.probabilities
          ? Object.entries(j.probabilities)
              .filter(([id]) => id !== j.choice)
              .sort((a, b) => b[1] - a[1])[0]
          : undefined;
        return `<tr><td><a href="#t-${esc(t.id)}" class="mono">${esc(t.id)}</a></td><td>${esc(j.choice)}</td><td>${esc(pOf(j))}</td><td class="muted">${others ? `${esc(others[0])} ${others[1].toFixed(2)}` : ""}</td></tr>`;
      })
      .join("") +
    `</table></div></details>`;

  const threads = [...model.finished, ...model.open].sort(
    (a, b) => Number(a.id.slice(1)) - Number(b.id.slice(1)),
  );
  const latestId = threads.at(-1)?.id;
  const thread = (t: TaskView): string => {
    const started = model.times[t.messageId];
    const msgs: string[] = [
      `<div class="msg you"><span class="who">${esc(t.source.split("/")[0])} · ${esc(t.messageId)}</span>${esc(t.text)}</div>`,
    ];
    const lastJudgment = t.judgments.at(-1);
    if (lastJudgment)
      msgs.push(
        `<div class="sys">Jev: ${esc(lastJudgment.choice)} at ${esc(pOf(lastJudgment))}</div>`,
      );
    if (t.routing && !t.final)
      msgs.push(
        t.routing.state === "needs_recipient"
          ? `<div class="sys attn">waiting for you to choose a recipient (${esc(t.routing.reason.replaceAll("_", " "))})</div>` +
              (can("requester")
                ? `<div class="sys">${form({ action: "choose", task: t.id }, t.routing.suggestions.map((to) => `<button name="to" value="${esc(to)}">${esc(to)}</button>`).join(""))}</div>`
                : "")
          : `<div class="sys">asking Jev</div>`,
      );
    for (const d of t.deliveries) {
      for (const s of d.sends) {
        if (s.kind === "answer")
          msgs.push(
            `<div class="msg you"><span class="who">you · answer${s.outcome === "withdrawn" ? " · withdrawn" : s.outcome !== "accepted" ? ` · ${esc(s.outcome)}` : ""}</span>${esc(s.text)}</div>`,
          );
        else if (s.outcome !== "accepted")
          msgs.push(
            `<div class="sys">${esc(d.placement)}: ${esc(s.outcome)}</div>`,
          );
        for (const u of d.updates.filter((u) => u.inReplyTo === s.messageId)) {
          msgs.push(
            `<div class="msg agent ${u.kind === "question" ? "question" : u.kind === "failed" ? "failed" : ""}"><span class="who">${esc(d.placement)} · ${esc(u.kind)}${model.times[u.messageId] ? ` · ${clock(model.times[u.messageId])}` : ""}</span>${esc(u.text)}</div>`,
          );
          if (d.question?.id === u.messageId && !t.final && can("requester"))
            msgs.push(
              `<div class="msg you">${form({ action: "answer", task: t.id, question: u.messageId }, `<input name="text" required placeholder="Your answer" autocomplete="off"><button>Send</button>`)}</div>`,
            );
        }
      }
      if (d.end && !["completed", "failed"].includes(d.end.reason))
        msgs.push(
          `<div class="sys">${esc(d.placement)}: ${esc(d.end.reason.replaceAll("_", " "))}</div>`,
        );
    }
    if (t.final)
      msgs.push(
        `<div class="sys">${esc(t.final.status)} · ${t.final.completed} of ${t.final.of} deliveries${t.final.reason ? ` · ${esc(t.final.reason)}` : ""}</div>`,
      );
    const isOpen = !t.final || t.id === latestId;
    return (
      `<details class="thread" id="t-${esc(t.id)}"${isOpen ? " open" : ""}><summary>` +
      `<span class="id">${esc(t.id)}</span><span class="chip ${statusClass(t.status)}">${esc(t.status.replaceAll("_", " "))}</span>` +
      `<span class="excerpt">${esc(t.text)}</span>` +
      `<span class="muted">→ ${esc(t.recipient ?? "?")}</span>` +
      `<span class="time">${esc(day(started))} ${esc(clock(started))}</span>` +
      (!t.final && can("requester")
        ? form(
            { action: "cancel", task: t.id },
            `<button class="quiet">cancel</button>`,
          )
        : "") +
      `</summary><div class="messages">${msgs.join("")}</div></details>`
    );
  };

  return `<!doctype html>
<html lang="en"><head><meta charset="utf-8">
<meta name="viewport" content="width=device-width, initial-scale=1">
<title>Router</title><style>${STYLE}</style></head><body>
<div id="app" data-refresh="${refreshSeconds}">
<header><h1>Router</h1><span class="at">as of ${esc(model.at.slice(0, 19).replace("T", " "))}Z · live${actor ? ` · ${esc(actor.login)}` : " · read only"}</span><span class="spacer"></span>${latestId ? `<a href="#t-${esc(latestId)}">latest</a>` : ""} <a href="board.json">json</a></header>
${options.notice ? `<div class="notice">${esc(options.notice)}</div>` : ""}
<section class="widgets">${needsWidget}${agentsWidget}${openWidget}${jevWidget}</section>
<section class="transcript"><h2>Record <span class="muted">· last ${model.finished.length} finished and everything open</span></h2>
${threads.length ? threads.map(thread).join("") : `<p class="muted">No tasks recorded.</p>`}
</section>
<details id="w-log" class="widget" style="margin-top:22px"><summary><span class="num">${model.log.at(-1)?.n ?? 0}</span><span class="label">journal</span><span class="brief">${esc(model.log.at(-1)?.text ?? "")}</span></summary><div class="body log">${model.log.map((l) => `${l.n}. ${esc(l.actor)}: ${esc(l.text)}`).join("\n")}</div></details>
</div>
<script>${SCRIPT}</script>
</body></html>
`;
}
