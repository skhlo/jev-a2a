// The board's words for the app: the HTML board's rules (src/board-parts.ts,
// src/board-context.ts and src/board-tasks.ts) over the shapes serve's board
// API returns, as the plugin design (v0.14) lays them out. Pure, so the tests
// run them in Node. The app evaluates this in Hermes, so it keeps to ES2020
// built-ins: no replaceAll and no Array.at.
import type { FullTask, Summary } from "../shared/rpc.ts";

type TaskHead = Summary["open"][number];
type NeedsYouItem = Summary["needsYou"][number]["items"][number];
type Task = FullTask["task"];
type Delivery = Task["deliveries"][number];

const DASH = "—";

// A word's colour role: muted context, warning (needs a person), danger
// (failed or overdue) or success (completed).
export type Tone = "muted" | "warn" | "danger" | "ok";
export type Part = { text: string; tone?: Tone };

const instant = (iso: string | null | undefined): number =>
  iso ? Date.parse(iso) : NaN;

// time(t): the clock as HH:MMZ, or a dash without a time.
export const time = (iso: string | null | undefined): string => {
  const at = instant(iso);
  return Number.isNaN(at)
    ? DASH
    : `${new Date(at).toISOString().slice(11, 16)}Z`;
};

// A stretch of time in its largest unit, floored: 45s, 14m, 2h 05m, 3d.
export const span = (ms: number): string => {
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

// age(t, now): how long before now t was, or a dash without a time.
export const age = (iso: string | null | undefined, now: number): string => {
  const at = instant(iso);
  return Number.isNaN(at) ? DASH : span(now - at);
};

// left(deadline, now): the countdown to the deadline, or how far past it.
export const countdown = (deadline: string, now: number): Part => {
  const ms = instant(deadline) - now;
  return ms >= 0
    ? { text: `${span(ms)} left` }
    : { text: `overdue ${span(ms)}`, tone: "danger" };
};

// label(status): a router name as words.
export const label = (name: string): string => name.replace(/_/g, " ");

// A request's first non-empty line.
export const firstLine = (text: string): string =>
  text
    .split(/\r?\n/)
    .map((line) => line.trim())
    .find((line) => line) ?? text;

// short(id): a message id over twelve characters shows its first eight.
const short = (id: string): string => (id.length > 12 ? id.slice(0, 8) : id);

// A Paseo session id is a UUID, maybe after `terminal:`; it shows its first
// eight characters after the prefix. Other ids are unchanged.
const SESSION =
  /^(terminal:)?([0-9a-f]{8})-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/i;
export const shortSession = (id: string): string => {
  const m = SESSION.exec(id);
  return m ? `${m[1] ?? ""}${m[2]}` : id;
};

export const count = (n: number, one: string, many: string): string =>
  `${n} ${n === 1 ? one : many}`;

const STATUS_TONE: Partial<Record<TaskHead["status"], Tone>> = {
  needs_answer: "warn",
  needs_recipient: "warn",
  uncertain: "warn",
  failed: "danger",
  completed: "ok",
};
export const statusTone = (status: TaskHead["status"]): Tone =>
  STATUS_TONE[status] ?? "muted";

const OUTCOME_TONE: Record<string, Tone> = {
  rejected: "danger",
  failed: "danger",
};
const outcomeTone = (outcome: string): Tone => OUTCOME_TONE[outcome] ?? "muted";

// The principal that sent a task: its source without the message id.
const sender = (source: string): string =>
  source.slice(0, source.lastIndexOf("/"));

// ---- The viewer ----

// A needs-you item with what the viewer may do. `mine`: the viewer holds
// its principal (without a viewer every item counts, read only). `act`:
// the app signs the action as this principal, the actor's first in the
// role the action needs, so serve accepts it.
export type Item = {
  principal: string;
  item: NeedsYouItem;
  mine: boolean;
  act: boolean;
};

// An item's own identity, so a form starts afresh for a new question or
// send on the same delivery.
export const itemKey = (item: NeedsYouItem): string =>
  item.kind === "answer"
    ? `answer/${item.questionId}`
    : item.kind === "resolve"
      ? `resolve/${item.deliveryId}/${item.messageId}`
      : `choose/${item.taskId}`;

// One row of the list. A needs-you item whose task is older than the
// finished tasks the board keeps (only a resolve can be) has no head.
export type Row = { id: string; head: TaskHead | null; items: Item[] };

export type Viewer = {
  items: Item[];
  needs: Row[];
  flight: Row[];
  done: Row[];
  head(id: string): TaskHead | null;
  itemsFor(id: string): Item[];
  mayCancel(source: string, open: boolean): boolean;
  // Whether a placement is held; null for one the board does not list.
  held(placement: string): boolean | null;
  identified: boolean;
};

export function viewerOf(s: Summary): Viewer {
  const actor = s.actor;
  const held = new Set(actor ? actor.principals.map((p) => p.principal) : []);
  const signer = (role: string): string | undefined =>
    actor?.principals.find((p) => p.role === role)?.principal;
  const items: Item[] = s.needsYou.flatMap((entry) =>
    entry.items.map((item) => ({
      principal: entry.principal,
      item,
      mine: actor === null || held.has(entry.principal),
      act:
        actor !== null &&
        entry.principal ===
          signer(item.kind === "resolve" ? "operator" : "requester"),
    })),
  );
  const heads = new Map<string, TaskHead>();
  for (const h of [...s.open, ...s.finished]) heads.set(h.id, h);
  const head = (id: string): TaskHead | null => heads.get(id) ?? null;
  const itemsFor = (id: string): Item[] =>
    items.filter((it) => it.item.taskId === id);
  const needIds: string[] = [];
  for (const it of items)
    if (it.mine && !needIds.includes(it.item.taskId))
      needIds.push(it.item.taskId);
  const row = (id: string): Row => ({
    id,
    head: head(id),
    items: itemsFor(id),
  });
  const rest = (list: TaskHead[]): Row[] =>
    list.filter((h) => !needIds.includes(h.id)).map((h) => row(h.id));
  return {
    items,
    needs: needIds.map(row),
    flight: rest(s.open),
    done: rest(s.finished).slice(0, 10),
    head,
    itemsFor,
    // Only the sender may cancel, and only while the task is open.
    mayCancel: (source, open) =>
      open && actor !== null && sender(source) === signer("requester"),
    held: (placement) =>
      s.placements.find((p) => p.key === placement)?.hold ?? null,
    identified: actor !== null,
  };
}

// ---- The list row ----

// Line 2's rule, the HTML board's row sub: what the task waits on or last
// said, then its countdown.
function sub(h: TaskHead, now: number): Part[] {
  if (h.status === "needs_recipient" && h.reason) {
    const j = h.judgment;
    const p = j?.probability;
    const jev = j
      ? ` · Jev ${j.choice}${p === null || p === undefined ? "" : ` ${p.toFixed(2)}`}`
      : "";
    return [{ text: label(h.reason) + jev }];
  }
  if (h.status === "needs_answer" && h.question) return [{ text: h.question }];
  if (h.final) return verdict(h.final);
  const left = countdown(h.deadline, now);
  const d = h.latest;
  if (!d) return [left];
  if (d.outcome !== "accepted")
    return [
      { text: `${d.sendKind} ${d.outcome}`, tone: outcomeTone(d.outcome) },
      left,
    ];
  if (d.answered)
    return [
      { text: `answered ${time(d.answered.at)} ${d.answered.text}` },
      left,
    ];
  if (d.update) return [{ text: d.update.text }, left];
  return [{ text: "delivered, no reply yet" }, left];
}

// A finished task's verdict: how many deliveries completed, the reason and
// who ended it.
export const verdict = (f: NonNullable<TaskHead["final"]>): Part[] => [
  { text: `${f.completed} of ${count(f.of, "delivery", "deliveries")}` },
  ...(f.reason ? [{ text: label(f.reason) }] : []),
  ...(f.by ? [{ text: `by ${f.by}` }] : []),
];

// Line 2 of a row, its parts joined by " · ": the id, whom it waits on
// besides the viewer, the sender's placement for an open task another agent
// sent, the recipient, the sub, and "no reply <age>" when stale.
export function rowLine(row: Row, now: number): Part[] {
  const waits = row.items
    .filter((it) => !it.mine)
    .map((it): Part => ({ text: `waits on ${it.principal}` }));
  const h = row.head;
  if (!h) {
    const it = row.items[0]?.item;
    return [
      { text: row.id },
      ...(it?.kind === "resolve"
        ? [{ text: `${it.deliveryId} · send ${it.messageId}` }]
        : []),
    ];
  }
  return [
    { text: h.id },
    ...waits,
    ...(h.via !== null && !h.final ? [{ text: `from ${h.via}` }] : []),
    { text: h.recipient ?? "no recipient" },
    ...sub(h, now),
    ...(h.stale ? [{ text: h.stale, tone: "warn" as const }] : []),
  ];
}

// A row's dot: the viewer is needed, or the task failed.
export const rowDot = (row: Row): Tone | null =>
  row.items.some((it) => it.mine)
    ? "warn"
    : row.head?.status === "failed"
      ? "danger"
      : null;

// ---- The detail ----

const CHOSEN_BY: Record<NonNullable<Task["chosenBy"]>, string> = {
  judgment: "chosen by Jev",
  address: "named on the request",
  sender: "chosen by the sender",
};

// The head's meta line: id, recipient, how it was chosen, who sent it and
// when, then the countdown or the verdict.
export function metaLine({ task: t, times }: FullTask, now: number): Part[] {
  const via = t.via ? ` via ${t.via}` : "";
  return [
    { text: t.id },
    ...(t.recipient ? [{ text: `to ${t.recipient}` }] : []),
    { text: t.chosenBy ? CHOSEN_BY[t.chosenBy] : "no recipient yet" },
    {
      text: `from ${sender(t.source)}${via} at ${time(times[t.messageId])}`,
    },
    ...(t.final ? verdict(t.final) : [countdown(t.deadline, now)]),
  ];
}

// The answer a delivery's question got, when its current send is one and
// no question is open (src/board-parts.ts answerOf).
const answered = (d: Delivery): boolean =>
  d.latest?.kind === "question" &&
  !d.question &&
  d.sends.find((s) => s.messageId === d.send.messageId)?.kind === "answer";

// A delivery row's state pill.
export function deliveryState(d: Delivery): Part {
  if (d.end) return { text: label(d.end.reason) };
  if (d.send.outcome !== "accepted")
    return {
      text: `${d.send.kind} ${d.send.outcome}`,
      tone: outcomeTone(d.send.outcome),
    };
  if (answered(d)) return { text: "answered" };
  if (d.latest)
    return { text: d.latest.kind, ...(d.question ? { tone: "warn" } : {}) };
  return { text: "delivered" };
}

// A delivery row's second line.
export function deliveryLine(d: Delivery, times: Record<string, string>) {
  const last = d.latest
    ? ` · last reply ${time(times[d.latest.messageId])}`
    : "";
  return `${d.id} · ${d.send.kind} ${short(d.send.messageId)} · ${d.send.outcome} · session ${d.session ? shortSession(d.session) : DASH}${last}`;
}

// One line of the conversation: a message with who sent it, or a line the
// router wrote (`who` null).
export type Said = { key: string; who: string | null; text: string };

// The conversation in time order: each send and update, a delivery's end,
// the routing state, and the request itself while nothing was delivered.
export function conversation({ task: t, times }: FullTask): Said[] {
  const from = sender(t.source);
  const lines: { at: string; order: number; said: Said }[] = [];
  const at = (id: string | undefined): string => (id && times[id]) || "";
  for (const d of t.deliveries) {
    for (const s of d.sends)
      lines.push({
        at: at(s.messageId),
        order: 0,
        said: {
          key: `${d.id}/${s.messageId}`,
          who: `${from} · ${s.kind} · ${time(times[s.messageId])}`,
          text: s.text,
        },
      });
    for (const u of d.updates)
      lines.push({
        at: at(u.messageId),
        order: 1,
        said: {
          key: `${d.id}/${u.messageId}`,
          who: `${d.placement} · ${u.kind} · ${time(times[u.messageId])}`,
          text: u.text,
        },
      });
    if (d.end) {
      const ended = at(d.end.messageId);
      lines.push({
        at: ended || "9",
        order: 2,
        said: {
          key: `${d.id}/end`,
          who: null,
          text: `${d.id} ended · ${label(d.end.reason)}${ended ? ` · ${time(ended)}` : ""}`,
        },
      });
    }
  }
  if (t.routing)
    lines.push({
      at: at(t.messageId),
      order: 0.5,
      said: {
        key: "routing",
        who: null,
        text: [
          label(t.routing.state),
          ...(t.routing.reason ? [label(t.routing.reason)] : []),
          ...(t.routing.suggestions.length
            ? [`suggested ${t.routing.suggestions.join(", ")}`]
            : []),
        ].join(" · "),
      },
    });
  if (!t.deliveries.length)
    lines.push({
      at: at(t.messageId),
      order: 0,
      said: {
        key: "request",
        who: `${from} · request · ${time(times[t.messageId])}`,
        text: t.text,
      },
    });
  return lines
    .sort((a, b) => (a.at === b.at ? a.order - b.order : a.at < b.at ? -1 : 1))
    .map((l) => l.said);
}

// Jev's judgment as a verdict and its table of probabilities.
export function judgmentLines(j: Task["judgments"][number]): {
  verdict: string;
  table: string;
} {
  const probabilities = j.probabilities ?? {};
  const p = probabilities[j.choice];
  const verdict =
    !j.valid || p === undefined
      ? `${j.choice}, judgment invalid`
      : p >= j.threshold
        ? `Picked ${j.choice} at ${p.toFixed(2)}`
        : `${j.choice} at ${p.toFixed(2)} is under the threshold ${j.threshold.toFixed(2)}`;
  const table = Object.entries(probabilities)
    .filter(([, v]) => v.toFixed(2) !== "0.00")
    .sort(([, a], [, b]) => b - a)
    .map(([k, v]) => `${k} ${v.toFixed(2)}`)
    .join(", ");
  return { verdict, table: [table, j.model].filter(Boolean).join(" · ") };
}

// Why a delivery needs an operator, as the resolve form says it.
export function resolveWhy(
  reason: Extract<NeedsYouItem, { kind: "resolve" }>["reason"],
  outcome: string | null,
): string {
  const why = {
    task_ended: "The task ended before the router could confirm this send.",
    session_replaced:
      "The session that took this send is gone, so the router cannot confirm it.",
    unknown_send: "The router has no record of this send reaching the session.",
  }[reason];
  return outcome === "accepted"
    ? `${why} The adapter reported it accepted, so it counts as sent; resolving finishes the delivery.`
    : why;
}
