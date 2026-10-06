// The board page's shared parts: the formats every panel writes with, the
// generic parts any panel can take, and the readings of the model that
// more than one panel shows.
import type { DeliveryView, PlacementView, TaskView } from "./board.ts";
import type { UpdateKind } from "./types.ts";

// ---- Formats: the generator's helpers over the same fields ----

export const DASH = "—";

export const esc = (value: unknown): string =>
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

// age(t, at): how long before `at` t was, or a dash without a time.
export const age = (iso: string | null | undefined, at: string): string =>
  iso ? span(Date.parse(at) - Date.parse(iso)) : DASH;

// percent(used, max): a share as a whole percentage.
export const percent = (used: number, max: number): number =>
  Math.round((100 * used) / max);

// hms(t): the clock with its seconds, HH:MM:SSZ, for activity rows, where
// several items share a minute (v0.11).
export const hms = (iso: string | null | undefined): string => {
  const at = instant(iso);
  return at ? `${at.toISOString().slice(11, 19)}Z` : DASH;
};

export const thousands = (value: number): string =>
  value.toLocaleString("en-US");

// left(deadline, at): the countdown to the deadline, or how far past it.
export const left = (deadline: string, at: string): string => {
  const ms = Date.parse(deadline) - Date.parse(at);
  return ms >= 0 ? `${span(ms)} left` : `overdue ${span(ms)}`;
};

export const noun = (n: number, one: string, many = `${one}s`): string =>
  n === 1 ? one : many;

// count(xs): how many, with the noun that reads right for one and for many.
// The design printed the plural for every number.
export const count = (n: number, one: string, many = `${one}s`): string =>
  `${n} ${noun(n, one, many)}`;

// label(status): a router name as words.
export const label = (name: string): string => name.replaceAll("_", " ");

// The full date of a time, to the minute or to the second.
const fullDate = (at: Date, seconds = false): string =>
  `${at
    .toISOString()
    .slice(0, seconds ? 19 : 16)
    .replace("T", " ")}Z`;

// The full date behind a clock or an age, as a title. The design printed
// the clock alone, which is ambiguous for anything older than a day.
export const dated = (iso: string | null | undefined, prefix = ""): string => {
  const at = instant(iso);
  return at ? ` title="${prefix}${fullDate(at)}"` : "";
};

// A time to the second with its date, or a dash.
export const stamp = (iso: string | null): string => {
  const at = instant(iso);
  return at ? fullDate(at, true) : DASH;
};

// Paseo session ids are UUIDs, which wrap a card and widen a table: an
// agent's, or a terminal's after `terminal:`. An id that is one shows its
// first eight characters (after the prefix, which stays), and `fullId` puts
// the whole id in the title attribute of the element that shows it. Other
// ids (the fixture's A1, an operator's login in an end line) are unchanged.
const SESSION =
  /^(terminal:)?([0-9a-f]{8})-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/i;

export const shortId = (id: string): string => {
  const m = SESSION.exec(id);
  return m ? `${m[1] ?? ""}${m[2]}` : id;
};

export const fullId = (id: string): string =>
  SESSION.test(id) ? ` title="${esc(id)}"` : "";

// A clock with its full date as its title.
export const clock = (
  path: string,
  iso: string | null | undefined,
  cls = "num",
) => slot(path, time(iso), cls, "span", dated(iso));
// A clock for a transcript line, or a dash.
export const when = (iso: string | null | undefined): string =>
  iso ? `<span${dated(iso)}>${time(iso)}</span>` : DASH;

// ---- Generic parts ----
//
// Each is named for what it is, so any part of the page can take it: the
// head's chips, the context meter, the rail's usage rows and the usage
// pop-up. Every text passes through esc here or in the caller's slot.

// An element that names the model path it reads.
export const slot = (
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
export const form = (
  fields: Record<string, string>,
  body: string,
  attrs = "",
): string =>
  `<form${attrs} method="post" action="actions">${hidden(fields)}${body}</form>`;

export const href = (taskId: string, hash = ""): string =>
  esc(`?task=${encodeURIComponent(taskId)}${hash}`);

// A chip in the head: a count in bold, then its words, in the `attn` tone
// or none. `words` is markup.
export const chip = (
  path: string,
  figure: string | number,
  words: string,
  tone = "",
): string => slot(path, `<b>${figure}</b> ${words}`, tone);

// meter: a bar filled to `share` percent in a role's tone, with a pace
// tick at `pace` percent and the figure after it (classed num unless the
// figure names its own class); a null share draws the track alone. Small by
// default (the board's context meter and the rail's windows); `wide` takes
// its cell (the pop-up's windows).
export const meter = (m: {
  share: number | null;
  tone?: string;
  wide?: boolean;
  path?: string;
  title?: string;
  pace?: number | null;
  pacePath?: string;
  figure?: { path: string; text: string; cls?: string };
}): string => {
  const fill =
    m.share === null
      ? ""
      : `<i style="width: ${Math.min(100, Math.max(0, m.share))}%"></i>`;
  const tick =
    m.pace === undefined || m.pace === null
      ? ""
      : `<b class="pace" style="left: ${m.pace.toFixed(1)}%"${m.pacePath ? ` data-path="${esc(m.pacePath)}"` : ""}></b>`;
  return `<span class="meter${m.wide ? " wide" : ""}${m.tone ? ` ${m.tone}` : ""}"${m.path ? ` data-path="${esc(m.path)}"` : ""}${m.title ? ` title="${esc(m.title)}"` : ""}><span class="bar${tick ? " paced" : ""}">${fill}${tick}</span>${m.figure ? slot(m.figure.path, m.figure.text, m.figure.cls ?? "num") : ""}</span>`;
};

// pairs: labels and their figures, inline and wrapping, each reading its
// own path. Labels and figures are text.
export const pairs = (
  items: { path: string; label: string; value: string }[],
): string =>
  items.length
    ? `<dl class="pairs">${items.map((i) => `<div data-path="${esc(i.path)}"><dt>${esc(i.label)}</dt><dd>${esc(i.value)}</dd></div>`).join("")}</dl>`
    : "";

// table: a titled table as wide as its content that scrolls sideways in its
// own box, never the page. A column is text, mono (a date, a name a machine
// wrote) or num (mono, right-aligned). A gap row is a missing day: a dash in
// each number, its other cells empty. With `bars`, a bar after each row's
// cells shows its `bar`, 0 to 100. `more` rows wait behind a button that
// names them, in a block the script opens and keeps open by its key (as a
// disclosure's); a page without a script shows them. Cells are text; a null
// one is a dash.
export type Column = { label: string; kind: "text" | "mono" | "num" };

export type Row = { cells: (string | null)[]; gap?: boolean; bar?: number };

export const table = (t: {
  path: string;
  title: string;
  columns: Column[];
  rows: Row[];
  bars?: boolean;
  more?: { key: string; words: string; rows: Row[] };
}): string => {
  const title = `<h4 class="kicker" data-path="${esc(t.path)}">${esc(t.title)}</h4>`;
  if (!t.rows.length) return `${title}<p class="hint">No rows reported.</p>`;
  const cls = (kind: Column["kind"]): string =>
    kind === "text" ? "" : ` class="${kind}"`;
  const row = (r: Row): string => {
    const cells = t.columns
      .map((c, k) => {
        const text = r.cells[k] ?? (r.gap && c.kind !== "num" ? "" : DASH);
        return `<td${cls(c.kind)}>${esc(text)}</td>`;
      })
      .join("");
    const bar = !t.bars
      ? ""
      : r.bar === undefined
        ? "<td></td>"
        : `<td class="bar"><i style="width: ${Math.round(r.bar)}%"></i></td>`;
    return `<tr${r.gap ? ' class="gap"' : ""}>${cells}${bar}</tr>`;
  };
  // A heading is text, right-aligned over numbers.
  const head = `${t.columns.map((c) => `<th${c.kind === "num" ? ' class="num"' : ""}>${esc(c.label)}</th>`).join("")}${t.bars ? "<th></th>" : ""}`;
  const more = t.more?.rows.length ? t.more : null;
  const all = more
    ? `<tr class="all"><td colspan="${t.columns.length + (t.bars ? 1 : 0)}"><button type="button" class="days">${esc(more.words)}</button></td></tr>`
    : "";
  const older = more
    ? `<tbody class="older" data-key="${esc(more.key)}">${more.rows.map(row).join("")}</tbody>`
    : "";
  return `${title}<div class="scroll-x"><table class="data"><thead><tr>${head}</tr></thead><tbody>${t.rows.map(row).join("")}${all}</tbody>${older}</table></div>`;
};

// disclosure: a toggle and the block it opens, keyed so the script keeps
// the block open or shut across refreshes on this device. The server draws
// the block open, so a page without a script shows it; the script shuts
// each block not kept open, at start and after each refresh. `label` and
// `title` are text, `body` markup; `id` ties the toggle to its block.
export const disclosure = (d: {
  key: string;
  id: string;
  path: string;
  label: string;
  title: string;
  blockPath: string;
  body: string;
}): { toggle: string; block: string } => ({
  toggle: `<button type="button" class="toggle" data-path="${esc(d.path)}" aria-expanded="true" aria-controls="${esc(d.id)}" title="${esc(d.title)}">${esc(d.label)}</button>`,
  block: `<div class="more" id="${esc(d.id)}" data-key="${esc(d.key)}" data-path="${esc(d.blockPath)}">${d.body}</div>`,
});

// ---- Readings more than one panel shows ----

// A question stays a delivery's latest update after its answer; the open
// question tells asking from answered.
export const answeredQuestion = (d: {
  question: unknown;
  latest: { kind: UpdateKind } | null;
}): boolean => d.latest?.kind === "question" && !d.question;

// What a waiting delivery waits for, in words: the board's delivery state
// and row, and the Paseo app's (router/plugin/client/format.ts).
export const waitWords = (
  placement: string,
  waits: NonNullable<DeliveryView["waits"]>,
): string => {
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

// A task's first line, for the detail title and the Paseo app's task rows
// (board-api.ts): the design sized the title for the sample's short texts,
// and a real request runs to pages. The full text is in the transcript,
// and in the title attribute.
export const headline = (text: string): string =>
  text
    .split(/\r?\n/)
    .map((line) => line.trim())
    .find((line) => line) ?? text;

// Stale work (v0.12): minutes past which a send without a reply, a turn and
// a running tool read as stale, and the share of the context window from
// which it does. The generator's thresholds.
const STALE_MINUTES = { reply: 30, turn: 15, tool: 5 };

export const CONTEXT_WARN = 80;

// Whether `iso` is more than `minutes` before `at`.
const older = (
  iso: string | null | undefined,
  minutes: number,
  at: string,
): boolean => !!iso && Date.parse(at) - Date.parse(iso) > minutes * 60_000;

// Whether a delivery's current send reached the session and has had no
// reply since: accepted (a send still pending or attempting is a wait,
// which the row and card already name), and either no update at all or a
// question since answered. The design counts only "no update at all"; an
// answered question is unreplied too, as its card says "no reply yet". A
// resolve ends the delivery, so an ended one is never asked.
const unreplied = (
  d: { question: unknown; latest: { kind: UpdateKind } | null },
  outcome: string,
): boolean => outcome === "accepted" && (!d.latest || answeredQuestion(d));

// stale(p, at): the first of "no reply <age>" (the delivery's current send
// is unreplied past STALE_MINUTES.reply), "turn <age>", "tool <age>" (the
// tail's last item a running tool) and "context <n>%" (CONTEXT_WARN or
// more), else null.
export const stale = (
  p: PlacementView,
  at: string,
  times: Record<string, string>,
): string | null => {
  const d = p.delivery;
  const sent = d ? times[d.messageId] : undefined;
  if (d && unreplied(d, d.outcome) && older(sent, STALE_MINUTES.reply, at))
    return `no reply ${age(sent, at)}`;
  const a = p.agent;
  if (!a) return null;
  if (a.status === "running" && older(a.turnStartedAt, STALE_MINUTES.turn, at))
    return `turn ${age(a.turnStartedAt, at)}`;
  const last = a.activity?.items.at(-1);
  if (
    last?.kind === "tool_call" &&
    last.status === "running" &&
    older(last.at, STALE_MINUTES.tool, at)
  )
    return `tool ${age(last.at, at)}`;
  const pct = a.context ? percent(a.context.used, a.context.max) : 0;
  return pct >= CONTEXT_WARN ? `context ${pct}%` : null;
};

// stale_task(t, at): "no reply <age>" for an open task with an unended
// delivery whose current send is unreplied past STALE_MINUTES.reply.
export const staleTask = (
  t: TaskView,
  at: string,
  times: Record<string, string>,
): string | null => {
  if (t.final) return null;
  for (const d of t.deliveries) {
    const sent = times[d.send.messageId];
    if (
      !d.end &&
      unreplied(d, d.send.outcome) &&
      older(sent, STALE_MINUTES.reply, at)
    )
      return `no reply ${age(sent, at)}`;
  }
  return null;
};
