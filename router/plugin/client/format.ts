// The board's words for the app: the HTML board's rules (src/board-parts.ts,
// src/board-context.ts and src/board-tasks.ts) over the shapes serve's board
// API returns, as the plugin design lays them out (skhlo/designs PR #21,
// jev-a2a v0.14). Pure, so the tests run them in Node. The app evaluates
// this in Hermes, so it keeps to ES2020 built-ins: no replaceAll and no
// Array.at (tsconfig.client.json checks).
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

export const count = (n: number, one: string, many = `${one}s`): string =>
  `${n} ${n === 1 ? one : many}`;

// A status pill's colour: the warning role whenever the task waits on the
// viewer, whatever its status, as the board marks its badge; another
// principal's question waits like a queued task.
export const statusTone = (
  status: TaskHead["status"],
  needsViewer: boolean,
): Tone =>
  needsViewer
    ? "warn"
    : status === "failed"
      ? "danger"
      : status === "completed"
        ? "ok"
        : "muted";

type Waits = NonNullable<Delivery["waits"]>;

// What a waiting delivery waits for, in words (src/board-parts.ts
// waitWords).
export const waitWords = (placement: string, waits: Waits): string => {
  switch (waits.reason) {
    case "queued_behind":
      return `queued behind ${waits.behind ?? DASH}`;
    case "held":
      return `held on ${placement}`;
    case "not_ready":
      return `waits for ${placement} to be ready`;
    case "in_flight":
      return `behind an unconfirmed send on ${placement}`;
    case "session_replaced":
      return `its session on ${placement} was replaced`;
  }
};

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
export type ListRow = { id: string; head: TaskHead | null; items: Item[] };

export type Viewer = {
  items: Item[];
  needs: ListRow[];
  flight: ListRow[];
  done: ListRow[];
  head(id: string): TaskHead | null;
  itemsFor(id: string): Item[];
  // Whether a delivery's open question is the viewer's to answer.
  asksViewer(deliveryId: string): boolean;
  mayCancel(source: string, open: boolean): boolean;
  // Whether a placement is on hold; null for one the board does not list.
  onHold(placement: string): boolean | null;
  // The principal a request is sent as, the actor's first requester.
  requester: string | null;
  identified: boolean;
};

export function viewerOf(s: Summary): Viewer {
  const actor = s.actor;
  const principals = new Set(
    actor ? actor.principals.map((p) => p.principal) : [],
  );
  const signer = (role: string): string | undefined =>
    actor?.principals.find((p) => p.role === role)?.principal;
  const items: Item[] = s.needsYou.flatMap((entry) =>
    entry.items.map((item) => ({
      principal: entry.principal,
      item,
      mine: actor === null || principals.has(entry.principal),
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
  const row = (id: string): ListRow => ({
    id,
    head: head(id),
    items: itemsFor(id),
  });
  const rest = (list: TaskHead[]): ListRow[] =>
    list.filter((h) => !needIds.includes(h.id)).map((h) => row(h.id));
  return {
    items,
    needs: needIds.map(row),
    flight: rest(s.open),
    done: rest(s.finished).slice(0, 10),
    head,
    itemsFor,
    asksViewer: (deliveryId) =>
      items.some(
        (it) =>
          it.mine &&
          it.item.kind === "answer" &&
          it.item.deliveryId === deliveryId,
      ),
    // Only the sender may cancel, and only while the task is open.
    mayCancel: (source, open) =>
      open && actor !== null && sender(source) === signer("requester"),
    onHold: (placement) =>
      s.placements.find((p) => p.key === placement)?.hold ?? null,
    requester: signer("requester") ?? null,
    identified: actor !== null,
  };
}

// What an open delivery is, in the order the row and the delivery pill
// read it (src/board-tasks.ts readingOf): what it waits for, the send while
// it is not accepted, the answer its question got, the latest update, else
// delivered.
type Reading<A, U> =
  | { kind: "waits"; waits: Waits }
  | { kind: "unaccepted" }
  | { kind: "answered"; answer: A }
  | { kind: "updated"; update: U }
  | { kind: "delivered" };
function readingOf<A, U>(
  waits: Waits | null,
  outcome: string,
  answer: A | null,
  update: U | null,
): Reading<A, U> {
  if (waits) return { kind: "waits", waits };
  if (outcome !== "accepted") return { kind: "unaccepted" };
  if (answer !== null) return { kind: "answered", answer };
  if (update !== null) return { kind: "updated", update };
  return { kind: "delivered" };
}

// ---- The list row ----

// Line 2's rule, the HTML board's row sub: what the task waits on or last
// said, then its countdown.
export function rowSub(h: TaskHead, now: number): Part[] {
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
  const r = readingOf(d.waits, d.outcome, d.answered, d.update);
  const text =
    r.kind === "waits"
      ? waitWords(d.placement, r.waits)
      : r.kind === "unaccepted"
        ? `${d.sendKind} ${d.outcome}`
        : r.kind === "answered"
          ? `answered ${time(r.answer.at)} ${r.answer.text}`
          : r.kind === "updated"
            ? r.update.text
            : "delivered, no reply yet";
  return [{ text }, left];
}

// A finished task's verdict: how many deliveries completed, the reason and
// who ended it.
export const verdict = (f: NonNullable<TaskHead["final"]>): Part[] => [
  { text: `${f.completed} of ${count(f.of, "delivery", "deliveries")}` },
  ...(f.reason ? [{ text: label(f.reason) }] : []),
  ...(f.by ? [{ text: `by ${f.by}` }] : []),
];

// Line 2 of a row, its parts joined by " · ": the id, the status (as the
// board's row starts), whom it waits on besides the viewer, the sender's
// placement for an open task another agent sent, the recipient, the sub,
// and "no reply <age>" when stale.
export function rowLine(row: ListRow, now: number): Part[] {
  const others = row.items
    .filter((it) => !it.mine)
    .map((it): Part => ({ text: `waits on ${it.principal}` }));
  const h = row.head;
  if (!h) {
    const it = row.items[0]?.item;
    return [
      { text: row.id },
      ...(it?.kind === "resolve"
        ? [
            { text: it.deliveryId },
            { text: `send ${it.messageId}` },
            { text: label(it.reason) },
          ]
        : []),
    ];
  }
  return [
    { text: h.id },
    { text: label(h.status) },
    ...others,
    ...(h.via !== null && !h.final ? [{ text: `from ${h.via}` }] : []),
    { text: h.recipient ?? "no recipient" },
    ...rowSub(h, now),
    ...(h.stale ? [{ text: h.stale, tone: "warn" as const }] : []),
  ];
}

// A row's dot: the viewer is needed, or the task failed.
export const rowDot = (row: ListRow): Tone | null =>
  row.items.some((it) => it.mine)
    ? "warn"
    : row.head?.status === "failed"
      ? "danger"
      : null;

// ---- The detail ----

// An item the viewer may not act on, as the board reads it without a form.
export function itemWaits({ principal, item }: Item, t: Task | null): string {
  const on = ` · waits on ${principal}`;
  switch (item.kind) {
    case "answer": {
      const d = t?.deliveries.find((x) => x.id === item.deliveryId);
      return `Answer ${d?.placement ?? t?.recipient ?? DASH} on ${item.deliveryId}, question ${item.questionId}${on}`;
    }
    case "choose":
      return `Choose a recipient for ${item.taskId} · ${label(item.reason)}${on}`;
    case "resolve":
      return `Resolve ${item.deliveryId} · send ${item.messageId} · ${label(item.reason)}${on}`;
  }
}

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

// A delivery row's state pill; a question is in the warning role while it
// asks the viewer.
export function deliveryState(d: Delivery, asksViewer: boolean): Part {
  if (d.end) return { text: d.end.reason };
  const r = readingOf(d.waits, d.send.outcome, answered(d) || null, d.latest);
  switch (r.kind) {
    case "waits":
      return { text: waitWords(d.placement, r.waits) };
    case "unaccepted":
      return { text: `${d.send.kind} ${d.send.outcome}` };
    case "answered":
      return { text: "answered" };
    case "updated":
      return {
        text: r.update.kind,
        ...(d.question && asksViewer ? { tone: "warn" } : {}),
      };
    case "delivered":
      return { text: "delivered" };
  }
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

// The conversation in time order: each send with its outcome, each
// update, a delivery's end and who ended it, the routing state, and the
// request itself while nothing was delivered. Same-time lines keep the
// board's order (src/board-tasks.ts thread): sends, the routing line,
// updates, then ends; an end without a time sorts last ("9" follows every
// ISO year).
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
          who: `${from} · ${s.kind} · ${time(times[s.messageId])} · ${s.outcome}`,
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
          text: `${d.id} ended · ${d.end.reason}${d.end.by ? ` · by ${shortSession(d.end.by)}` : ""}${ended ? ` · ${time(ended)}` : ""}`,
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
        : `${j.choice} at ${p.toFixed(2)} is under the threshold ${j.threshold}`;
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
    ? `${why} The adapter reported it accepted, so it counts as sent and cannot be marked not sent; resolving finishes the delivery.`
    : why;
}
