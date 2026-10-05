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
import type {
  BoardModel,
  DeliveryView,
  PlacementView,
  TaskView,
} from "./board.ts";
import type { AgentSnapshot, AgentStatus, Checkout } from "./telemetry.ts";
import type {
  Judgment,
  NeedsYouItem,
  Role,
  StuckReason,
  UpdateKind,
} from "./types.ts";
import {
  LABEL,
  WINDOW_SUFFIX,
  type AccountView,
  type ColumnFormat,
  type DataTable,
  type Metric,
  type ReadingView,
  type UsageView,
  type WindowView,
} from "./usage.ts";

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

// percent(used, max): a share as a whole percentage.
const percent = (used: number, max: number): number =>
  Math.round((100 * used) / max);

// hms(t): the clock with its seconds, HH:MM:SSZ, for activity rows, where
// several items share a minute (v0.11).
export const hms = (iso: string | null | undefined): string => {
  const at = instant(iso);
  return at ? `${at.toISOString().slice(11, 19)}Z` : DASH;
};

const thousands = (value: number): string => value.toLocaleString("en-US");

// diff(additions, deletions): "+a −d", the minus sign U+2212.
export const diff = (additions: number, deletions: number): string =>
  `+${thousands(additions)} −${thousands(deletions)}`;

// counts(obj): the non-zero counts with their key names as words, in the
// object's order, joined by " · ".
export const counts = (obj: Record<string, number>): string =>
  Object.entries(obj)
    .filter(([, value]) => value)
    .map(([key, value]) => `${thousands(value)} ${label(key)}`)
    .join(" · ");

// The router reads subagents and activity only for a live session.
const live = (a: AgentSnapshot | null): boolean =>
  a !== null && (a.status === "idle" || a.status === "running");

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

// The full date of a time, to the minute or to the second.
const fullDate = (at: Date, seconds = false): string =>
  `${at
    .toISOString()
    .slice(0, seconds ? 19 : 16)
    .replace("T", " ")}Z`;

// The full date behind a clock or an age, as a title. The design printed
// the clock alone, which is ambiguous for anything older than a day.
const dated = (iso: string | null | undefined, prefix = ""): string => {
  const at = instant(iso);
  return at ? ` title="${prefix}${fullDate(at)}"` : "";
};

// A time to the second with its date, or a dash.
const stamp = (iso: string | null): string => {
  const at = instant(iso);
  return at ? fullDate(at, true) : DASH;
};

// The nav tick's title: when the model was built and the telemetry taken,
// to the second, and the contract (v0.12). The design gives the clocks
// alone; a telemetry file can be a day old.
const built = (model: BoardModel): string =>
  `built ${stamp(model.at)} · ${model.telemetryAt ? `telemetry ${stamp(model.telemetryAt)}` : "no telemetry"} · ${model.version}`;

// repo(url): a remote as owner/repo: the scheme and host (or the scp form's
// user@host:) and a trailing .git stripped; anything else as it is (v0.12).
export const repo = (url: string): string => {
  let rest = url;
  const scheme = rest.indexOf("://");
  if (scheme >= 0) {
    rest = rest.slice(scheme + 3);
    rest = rest.slice(rest.indexOf("/") + 1);
  } else if (rest.includes("@") && rest.includes(":"))
    rest = rest.slice(rest.indexOf(":") + 1);
  return rest.endsWith(".git") ? rest.slice(0, -4) : rest;
};

// ---- Usage formats (v0.13): the account part of the model ----

// dh(ms): a reset in days and hours, "2d 10h" (and "2d 0h"), "16h" under a
// day, "<1h" under an hour.
export const dh = (ms: number): string => {
  const s = Math.max(0, Math.trunc(ms / 1000));
  const d = Math.floor(s / 86400);
  const h = Math.floor((s % 86400) / 3600);
  return d ? `${d}d ${h}h` : h ? `${h}h` : "<1h";
};

// A money amount in its currency: cents, or a sub-cent amount to its
// precision.
const currencyText = (value: number, currency: string): string =>
  new Intl.NumberFormat("en-US", {
    style: "currency",
    currency,
    currencyDisplay: currency === "USD" ? "narrowSymbol" : "symbol",
    minimumFractionDigits: 2,
    maximumFractionDigits: Math.abs(value) < 0.01 && value !== 0 ? 4 : 2,
  }).format(value);

// amount(value, unit): money in its currency, a count with its unit (agreeing
// with one), words as they are, and a dash for a value not reported.
export const amount = (
  value: string | number | null | undefined,
  unit: string | null,
): string => {
  if (value === null || value === undefined) return DASH;
  if (typeof value === "string") return value;
  if (!Number.isFinite(value)) return DASH;
  if (unit === "USD" || unit === "CNY") return currencyText(value, unit);
  if (!unit) return thousands(value);
  return `${thousands(value)} ${value === 1 && unit.endsWith("s") ? unit.slice(0, -1) : unit}`;
};

// A window's label without the word the normalizers end it with.
const windowName = (label: string): string =>
  label.endsWith(WINDOW_SUFFIX) ? label.slice(0, -WINDOW_SUFFIX.length) : label;

// wshort(w): a window's length as the rail writes it: "7D" in whole days,
// else "5H" in whole hours, else minutes.
export const wshort = (minutes: number): string =>
  minutes % 1440 === 0
    ? `${minutes / 1440}D`
    : minutes % 60 === 0
      ? `${minutes / 60}H`
      : `${minutes}M`;

// A reading's windows, which say nothing of now while its allowance is
// unavailable: a reading of history alone.
const windowsOf = (r: ReadingView | null): WindowView[] =>
  r && r.allowance !== "unavailable" ? r.windows : [];

// shown_windows(a): the windows of an account's rail row, with their index
// in the reading: account-wide (no " · " scope in the label), with a length,
// longest first, so 7D comes before 5H.
const shownWindows = (r: ReadingView | null): { k: number; w: WindowView }[] =>
  windowsOf(r)
    .map((w, k) => ({ k, w }))
    .filter(({ w }) => w.minutes && !w.label.includes(" · "))
    .sort((a, b) => (b.w.minutes ?? 0) - (a.w.minutes ?? 0));

// passed(w, at): the window's reset is known and at or before `at`. Its
// share is history then: no band, no pace, no time left.
const passed = (w: WindowView, at: string): boolean =>
  w.resetsAt !== null && Date.parse(w.resetsAt) <= Date.parse(at);

// The length of the window whose reset a rail row shows: always the week's,
// as the design fixed it; an account without one shows no reset.
const WEEK_MINUTES = 7 * 1440;

// The figures a balance leads with or shows on its key's row; the rest go to
// the account's details.
const LEADING: string[] = [LABEL.accountBalance, LABEL.balance];
const BESIDE: string[] = [LABEL.keyRemaining, LABEL.keyLimit];

// A day-keyed table lists its latest fourteen days; the rest wait behind
// "all n days".
const DAYS_SHOWN = 14;

// How a table column draws: counts and amounts as numerals, dates and names
// a machine wrote in mono, words as text.
const COLUMN_KIND: Record<ColumnFormat, Column["kind"]> = {
  number: "num",
  USD: "num",
  date: "mono",
  name: "mono",
};

// The providers' marks in the rail, by account id: Simple Icons 16.34.0
// (CC0), "claude" and "openai", on a 24×24 view box in currentColor. The
// marks themselves belong to their owners. A map, so a lookup finds
// only these and never a property every object inherits.
const MARKS = new Map<string, string>([
  [
    "claude",
    "m4.7144 15.9555 4.7174-2.6471.079-.2307-.079-.1275h-.2307l-.7893-.0486-2.6956-.0729-2.3375-.0971-2.2646-.1214-.5707-.1215-.5343-.7042.0546-.3522.4797-.3218.686.0608 1.5179.1032 2.2767.1578 1.6514.0972 2.4468.255h.3886l.0546-.1579-.1336-.0971-.1032-.0972L6.973 9.8356l-2.55-1.6879-1.3356-.9714-.7225-.4918-.3643-.4614-.1578-1.0078.6557-.7225.8803.0607.2246.0607.8925.686 1.9064 1.4754 2.4893 1.8336.3643.3035.1457-.1032.0182-.0728-.164-.2733-1.3539-2.4467-1.445-2.4893-.6435-1.032-.17-.6194c-.0607-.255-.1032-.4674-.1032-.7285L6.287.1335 6.6997 0l.9957.1336.419.3642.6192 1.4147 1.0018 2.2282 1.5543 3.0296.4553.8985.2429.8318.091.255h.1579v-.1457l.1275-1.706.2368-2.0947.2307-2.6957.0789-.7589.3764-.9107.7468-.4918.5828.2793.4797.686-.0668.4433-.2853 1.8517-.5586 2.9021-.3643 1.9429h.2125l.2429-.2429.9835-1.3053 1.6514-2.0643.7286-.8196.85-.9046.5464-.4311h1.0321l.759 1.1293-.34 1.1657-1.0625 1.3478-.8804 1.1414-1.2628 1.7-.7893 1.36.0729.1093.1882-.0183 2.8535-.607 1.5421-.2794 1.8396-.3157.8318.3886.091.3946-.3278.8075-1.967.4857-2.3072.4614-3.4364.8136-.0425.0304.0486.0607 1.5482.1457.6618.0364h1.621l3.0175.2247.7892.522.4736.6376-.079.4857-1.2142.6193-1.6393-.3886-3.825-.9107-1.3113-.3279h-.1822v.1093l1.0929 1.0686 2.0035 1.8092 2.5075 2.3314.1275.5768-.3218.4554-.34-.0486-2.2039-1.6575-.85-.7468-1.9246-1.621h-.1275v.17l.4432.6496 2.3436 3.5214.1214 1.0807-.17.3521-.6071.2125-.6679-.1214-1.3721-1.9246L14.38 17.959l-1.1414-1.9428-.1397.079-.674 7.2552-.3156.3703-.7286.2793-.6071-.4614-.3218-.7468.3218-1.4753.3886-1.9246.3157-1.53.2853-1.9004.17-.6314-.0121-.0425-.1397.0182-1.4328 1.9672-2.1796 2.9446-1.7243 1.8456-.4128.164-.7164-.3704.0667-.6618.4008-.5889 2.386-3.0357 1.4389-1.882.929-1.0868-.0062-.1579h-.0546l-6.3385 4.1164-1.1293.1457-.4857-.4554.0608-.7467.2307-.2429 1.9064-1.3114Z",
  ],
  [
    "codex",
    "M22.2819 9.8211a5.9847 5.9847 0 0 0-.5157-4.9108 6.0462 6.0462 0 0 0-6.5098-2.9A6.0651 6.0651 0 0 0 4.9807 4.1818a5.9847 5.9847 0 0 0-3.9977 2.9 6.0462 6.0462 0 0 0 .7427 7.0966 5.98 5.98 0 0 0 .511 4.9107 6.051 6.051 0 0 0 6.5146 2.9001A5.9847 5.9847 0 0 0 13.2599 24a6.0557 6.0557 0 0 0 5.7718-4.2058 5.9894 5.9894 0 0 0 3.9977-2.9001 6.0557 6.0557 0 0 0-.7475-7.0729zm-9.022 12.6081a4.4755 4.4755 0 0 1-2.8764-1.0408l.1419-.0804 4.7783-2.7582a.7948.7948 0 0 0 .3927-.6813v-6.7369l2.02 1.1686a.071.071 0 0 1 .038.052v5.5826a4.504 4.504 0 0 1-4.4945 4.4944zm-9.6607-4.1254a4.4708 4.4708 0 0 1-.5346-3.0137l.142.0852 4.783 2.7582a.7712.7712 0 0 0 .7806 0l5.8428-3.3685v2.3324a.0804.0804 0 0 1-.0332.0615L9.74 19.9502a4.4992 4.4992 0 0 1-6.1408-1.6464zM2.3408 7.8956a4.485 4.485 0 0 1 2.3655-1.9728V11.6a.7664.7664 0 0 0 .3879.6765l5.8144 3.3543-2.0201 1.1685a.0757.0757 0 0 1-.071 0l-4.8303-2.7865A4.504 4.504 0 0 1 2.3408 7.872zm16.5963 3.8558L13.1038 8.364 15.1192 7.2a.0757.0757 0 0 1 .071 0l4.8303 2.7913a4.4944 4.4944 0 0 1-.6765 8.1042v-5.6772a.79.79 0 0 0-.407-.667zm2.0107-3.0231l-.142-.0852-4.7735-2.7818a.7759.7759 0 0 0-.7854 0L9.409 9.2297V6.8974a.0662.0662 0 0 1 .0284-.0615l4.8303-2.7866a4.4992 4.4992 0 0 1 6.6802 4.66zM8.3065 12.863l-2.02-1.1638a.0804.0804 0 0 1-.038-.0567V6.0742a4.4992 4.4992 0 0 1 7.3757-3.4537l-.142.0805L8.704 5.459a.7948.7948 0 0 0-.3927.6813zm1.0976-2.3654l2.602-1.4998 2.6069 1.4998v2.9994l-2.5974 1.4997-2.6067-1.4997Z",
  ],
]);

// A task's first line, for the detail title: the design sized the title for
// the sample's short texts, and a real request runs to pages. The full text
// is in the transcript, and in the title attribute.
const headline = (text: string): string =>
  text
    .split(/\r?\n/)
    .map((line) => line.trim())
    .find((line) => line) ?? text;

// Paseo session ids are UUIDs, which wrap a card and widen a table: an
// agent's, or a terminal's after `terminal:`. An id that is one shows its
// first eight characters (after the prefix, which stays), and `fullId` puts
// the whole id in the title attribute of the element that shows it. Other
// ids (the fixture's A1, an operator's login in an end line) are unchanged.
const SESSION =
  /^(terminal:)?([0-9a-f]{8})-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/i;

// The health row's sentence for a status that carries no error text (v0.10).
const STATUS_NOTE: Partial<Record<AgentStatus, string>> = {
  error: "the session reported an error",
  missing: "the daemon does not know this agent",
  unreachable: "the host could not be reached",
};
// The sheet's words for a pull request's checks and review, with the role
// that colours them (v0.11).
const CHECK_WORDS: Record<
  NonNullable<NonNullable<Checkout["pr"]>["checks"]> | "null",
  [string, string]
> = {
  failure: ["checks failing", "role-err"],
  pending: ["checks pending", "muted"],
  success: ["checks passing", "role-ok"],
  none: ["no checks", "muted"],
  null: ["checks unknown", "muted"],
};
const REVIEW: Record<string, string> = {
  changes_requested: "changes requested",
  approved: "approved",
  pending: "review pending",
};
// Activity kinds as the feed words them; the quiet ones read muted.
const KIND: Record<string, string> = {
  user_message: "user",
  assistant_message: "assistant",
  tool_call: "tool",
};
const QUIET = ["compaction", "notification", "plugin"];
const STATUS_CLS: Record<string, string> = {
  running: "running",
  failed: "role-err",
  canceled: "muted",
};
const shortId = (id: string): string => {
  const m = SESSION.exec(id);
  return m ? `${m[1] ?? ""}${m[2]}` : id;
};
const fullId = (id: string): string =>
  SESSION.test(id) ? ` title="${esc(id)}"` : "";
// short(id) as the design applies it to a send's message id (v0.13): an id
// over twelve characters shows its first eight, the whole id as its title.
const shortSlot = (path: string, id: string): string =>
  id.length > 12
    ? slot(path, esc(id.slice(0, 8)), "", "span", ` title="${esc(id)}"`)
    : slot(path, esc(id));

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
// principal, which waits like one for the viewer, in grey; `busy` is a
// session running a turn the router did not send (v0.12).
type Dot = "ask" | "wait" | "work" | "busy" | "held" | "ready" | "off";
// The rail's order: asking, working or delivered, busy, held, ready, not
// ready; the model's order within a state.
const RANK: Record<Dot, number> = {
  ask: 0,
  wait: 0,
  work: 1,
  busy: 2,
  held: 3,
  ready: 4,
  off: 5,
};

// A question stays a delivery's latest update after its answer; the open
// question tells asking from answered.
const answeredQuestion = (d: {
  question: unknown;
  latest: { kind: UpdateKind } | null;
}): boolean => d.latest?.kind === "question" && !d.question;

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

// Stale work (v0.12): minutes past which a send without a reply, a turn and
// a running tool read as stale, and the share of the context window from
// which it does. The generator's thresholds.
const STALE_MINUTES = { reply: 30, turn: 15, tool: 5 };
const CONTEXT_WARN = 80;

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

// ---- Generic parts ----
//
// Each is named for what it is, so any part of the page can take it: the
// head's chips, the context meter, the rail's usage rows and the usage
// pop-up. Every text passes through esc here or in the caller's slot.

// A chip in the head: a count in bold, then its words, in the `attn` tone
// or none. `words` is markup.
const chip = (
  path: string,
  figure: string | number,
  words: string,
  tone = "",
): string => slot(path, `<b>${figure}</b> ${words}`, tone);

// pace(w, at): how much of a window of `minutes` ending at `resetsAt` has
// passed at `at`, as a percentage, and whether `usedPercent` runs ahead of
// it by more than two points; null for a window whose length or reset is
// unknown, or whose reset has passed.
export const pace = (
  w: { minutes: number | null; resetsAt: string | null; usedPercent: number },
  at: string,
): { elapsed: number; ahead: boolean } | null => {
  const now = Date.parse(at);
  const reset = w.resetsAt ? Date.parse(w.resetsAt) : NaN;
  if (!w.minutes || !(reset > now)) return null;
  const length = w.minutes * 60_000;
  const elapsed = Math.min(
    100,
    Math.max(0, ((now - (reset - length)) / length) * 100),
  );
  return { elapsed, ahead: w.usedPercent > elapsed + 2 };
};

// band(share): warn from 75%, err from 90%, else nothing, by the share as
// shown: 74.5 reads 75%, in warn (v0.13).
export const band = (share: number): "" | "warn" | "err" => {
  const shown = Math.round(share);
  return shown >= 90 ? "err" : shown >= 75 ? "warn" : "";
};

// meter: a bar filled to `share` percent in a role's tone, with a pace
// tick at `pace` percent and the figure after it (classed num unless the
// figure names its own class); a null share draws the track alone. Small by
// default (the board's context meter and the rail's windows); `wide` takes
// its cell (the pop-up's windows).
const meter = (m: {
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
const pairs = (
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
type Column = { label: string; kind: "text" | "mono" | "num" };
type Row = { cells: (string | null)[]; gap?: boolean; bar?: number };
const table = (t: {
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
const disclosure = (d: {
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
  const roleOf = (principal: string): Role | undefined =>
    actor?.principals.find((p) => p.principal === principal)?.role;
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
  // A finished task's verdict: how many deliveries completed, under `first`
  // (the row's slot, or the head's with the deadline), then the reason and
  // who ended it.
  const verdict = (
    path: string,
    f: NonNullable<TaskView["final"]>,
    first = (words: string) => slot(`${path}.final`, words),
  ): string =>
    first(`${f.completed} of ${count(f.of, "delivery", "deliveries")}`) +
    (f.reason
      ? ` · ${slot(`${path}.final.reason`, esc(label(f.reason)))}`
      : "") +
    (f.by ? ` · by ${slot(`${path}.final.by`, esc(f.by))}` : "");

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

  // The account part of the model: a section in the rail with one row per
  // subscription account, and the pop-up with every account, which a row or
  // u opens beside the rail. Neither is drawn while the model carries no
  // usage. Without a script a row is a link to this page with the pop-up
  // drawn open (`?usage`), and while it is open the row and its close
  // button are links back; the script toggles the pop-up in place.
  const usage = model.usage;
  const usageOpen = Boolean(usage && options.usage);
  const usageClose = selected ? href(selected) : "./";
  const usageHref = usageOpen
    ? usageClose
    : esc(`?${selected ? `task=${encodeURIComponent(selected)}&` : ""}usage`);
  const readAt = usage?.at ? `read ${time(usage.at)}` : "not read yet";
  // An account that is not current: its tooltip says why, and it carries a
  // badge.
  const notCurrent = (a: AccountView): boolean =>
    a.status === "stale" || a.status === "unavailable";
  // What an account that is not current says of its age: the reading's
  // while stale, the last check's while unavailable.
  const ageOf = (
    a: AccountView,
    path: string,
  ): { words: string; path: string; at: string } | null =>
    a.status === "stale" && a.reading
      ? {
          words: "last reading",
          path: `age(${path}.reading.observedAt, at)`,
          at: a.reading.observedAt,
        }
      : a.status === "unavailable" && a.checkedAt
        ? {
            words: "checked",
            path: `age(${path}.checkedAt, at)`,
            at: a.checkedAt,
          }
        : null;
  const until = (iso: string): number => Date.parse(iso) - Date.parse(at);
  const subscriptions = (usage?.accounts ?? []).flatMap((a, i) =>
    a.kind === "subscription" ? [{ a, i }] : [],
  );

  // A rail row, built from the agent card's parts. Line 1: the provider's
  // mark, the name, the status word where a card puts its status, and at
  // the right the week's reset in days and hours, a dash once passed.
  // Line 2: the shown windows, each its length and the context meter's
  // look with a pace tick and the share, in the band's role, or warn above
  // pace without one; a passed reset keeps the track alone. A stale row
  // dims, and the tooltip names its age and error and each window.
  const usageRow = (a: AccountView, i: number): string => {
    const path = `usage.accounts[${i}]`;
    const tip = [a.name];
    const old = ageOf(a, path);
    if (notCurrent(a))
      tip.push(
        `${a.status}${old ? `, ${old.words} ${age(old.at, at)} ago` : ""}${a.error ? `: ${a.error}` : ""}`,
      );
    const shown = shownWindows(a.reading);
    const wins = shown.map(({ k, w }) => {
      const wp = `${path}.reading.windows[${k}]`;
      const n = Math.round(Math.max(0, w.usedPercent));
      const figure = { path: `${wp}.usedPercent`, text: `${n}%`, cls: "" };
      const length = `<span class="w" title="${esc(w.label)}">${wshort(w.minutes ?? 0)}</span>`;
      if (passed(w, at)) {
        tip.push(`${windowName(w.label)} ${n}%, reset passed`);
        return `<span class="win dim" data-path="${wp}">${length}${meter({ share: null, figure })}</span>`;
      }
      const p = pace(w, at);
      tip.push(
        `${windowName(w.label)} ${n}%${p ? (p.ahead ? ", above pace" : ", within pace") : ""}${w.resetsAt ? `, resets in ${span(until(w.resetsAt))}` : ""}`,
      );
      return `<span class="win" data-path="${wp}">${length}${meter({
        share: Math.max(0, w.usedPercent),
        tone: band(w.usedPercent) || (p?.ahead ? "warn" : ""),
        pace: p?.elapsed ?? null,
        pacePath: `pace(${wp}, at)`,
        figure,
      })}</span>`;
    });
    const week = shown.find(({ w }) => w.minutes === WEEK_MINUTES);
    const reset = week
      ? slot(
          `left(${path}.reading.windows[${week.k}].resetsAt, at)`,
          week.w.resetsAt && !passed(week.w, at)
            ? dh(until(week.w.resetsAt))
            : DASH,
          "rs",
        )
      : "";
    if (!shown.length) {
      wins.push(
        `<span class="none">${a.status === "loading" ? "…" : DASH}</span>`,
      );
      if (a.status === "loading") tip.push("reading");
      else if (a.reading?.allowance === "unavailable")
        tip.push("current limits are unavailable");
      else if (a.status === "ready") tip.push("no quota windows reported");
    }
    tip.push(readAt);
    const mark = MARKS.get(a.id);
    return `<a class="acct${a.status === "stale" ? " stale" : ""}${shown.length ? "" : " off"}" href="${usageHref}" data-path="${path}" aria-expanded="${usageOpen}" aria-controls="usage" title="${esc(tip.join(" · "))}"><span class="l1">${mark ? `<svg class="mark" viewBox="0 0 24 24" aria-hidden="true"><path fill="currentColor" d="${mark}"/></svg>` : ""}${slot(`${path}.name`, esc(a.name), "nm")}${slot(`${path}.status`, a.status === "loading" ? "reading" : esc(a.status), `st${a.status === "ready" ? "" : " off"}`)}${reset}</span><span class="l2">${wins.join("")}</span></a>`;
  };
  // Pinned under the cards, above the router log; balances stay in the
  // pop-up.
  const usageRail = subscriptions.length
    ? `  <section class="usage-rail" aria-label="Usage" data-path="usage">
    <h2 class="col-h"><span class="kicker">Usage</span>${slot("count(usage.accounts[].kind=subscription)", count(subscriptions.length, "account"), "n")}</h2>
    <div class="accts">${subscriptions.map(({ a, i }) => usageRow(a, i)).join("")}</div>
  </section>
`
    : "";

  // The pop-up's rows share one six-column grid (lead | name | figure |
  // meter | note | when), so every row draws all six cells.
  const entry = (
    cells: [string, string, string, string, string, string],
    path: string,
    cls = "",
  ): string => {
    const [lead, name, figure, gauge, note, when] = cells;
    return `<div class="entry${cls}" data-path="${esc(path)}">${lead || '<span class="lead"></span>'}${name || '<span class="name"></span>'}${figure || '<span class="figure"></span>'}${gauge || '<span class="meter"></span>'}${note || '<span class="note"></span>'}${when || '<span class="when"></span>'}</div>`;
  };
  const badge = (a: AccountView, path: string, cls = ""): string =>
    notCurrent(a)
      ? slot(`${path}.status`, esc(a.status), `badge sm${cls}`)
      : "";
  // An account's lead: its name as the toggle of its details, and from
  // 900px down its badge after it (the badge's own place is the lead of
  // the account's second line).
  const lead = (a: AccountView, path: string, toggle: string): string =>
    `<span class="lead">${toggle}${badge(a, path, " at-narrow")}</span>`;
  // A row with nothing to measure: the account and why, from the name to
  // the when column.
  const bare = (path: string, head: string, words: string): string =>
    `<div class="entry first bare" data-path="${path}">${head}${slot(`${path}.reading`, words, "name quiet")}</div>`;
  const nothing = (a: AccountView): string =>
    a.status === "loading" ? "Reading…" : "No current reading";

  // A subscription: a row per window, the account's name on the first. The
  // share in the band's role, the wide meter with its pace tick, "above
  // pace" in warn, the time to the reset with its date as the tooltip; a
  // passed reset dims its row, with no band and no note.
  const subscriptionRows = (
    a: AccountView,
    path: string,
    leadOf: (row: number) => string,
  ): string[] => {
    const r = a.reading;
    const current = windowsOf(r);
    if (!current.length)
      return [
        bare(
          path,
          leadOf(0),
          r?.allowance === "unavailable"
            ? "Current limits are unavailable"
            : r
              ? "No quota windows reported"
              : nothing(a),
        ),
      ];
    return current.map((w, k) => {
      const wp = `${path}.reading.windows[${k}]`;
      const over = passed(w, at);
      const used = Math.max(0, w.usedPercent);
      const tone = over ? "" : band(used);
      const p = pace(w, at);
      const when = w.resetsAt
        ? slot(
            `left(${wp}.resetsAt, at)`,
            over ? "reset passed" : `resets in ${span(until(w.resetsAt))}`,
            "when",
            "span",
            dated(w.resetsAt, "resets "),
          )
        : slot(`${wp}.resetsAt`, DASH, "when");
      return entry(
        [
          leadOf(k),
          slot(
            `${wp}.label`,
            esc(windowName(w.label)),
            "name",
            "span",
            ` title="${esc(w.label)}"`,
          ),
          slot(`${wp}.usedPercent`, `${Math.round(used)}%`, "figure"),
          meter({
            share: over ? null : used,
            tone,
            wide: true,
            path: `${wp}.usedPercent, pace(${wp}, at)`,
            pace: p?.elapsed ?? null,
            ...(p
              ? { title: `${Math.round(p.elapsed)}% of the window has passed` }
              : {}),
          }),
          p?.ahead ? slot(`pace(${wp}, at)`, "above pace", "note ahead") : "",
          when,
        ],
        wp,
        `${k ? "" : " first"}${over ? " passed" : ""}${tone ? ` ${tone}` : ""}`,
      );
    });
  };

  // A balance: its balance leading, a row per currency the provider
  // reports, neutral; words in place of an amount ("No management key")
  // span the row with the reading's notice as their tooltip. Then the key's
  // row: what is left, a neutral meter of its allowance used, and "of" its
  // limit.
  const balanceRows = (
    a: AccountView,
    path: string,
    leadOf: (row: number) => string,
  ): string[] => {
    const r = a.reading;
    if (!r) return [bare(path, leadOf(0), nothing(a))];
    if (r.allowance === "unavailable")
      return [bare(path, leadOf(0), "Current limits are unavailable")];
    const find = (label: string): { k: number; m: Metric } | null => {
      const k = r.metrics.findIndex((m) => m.label === label);
      const m = r.metrics[k];
      return m ? { k, m } : null;
    };
    const leading = r.metrics.flatMap((m, k) =>
      LEADING.includes(m.label) ? [{ k, m }] : [],
    );
    const rows = leading.length
      ? leading.map(({ k, m }, j) => {
          const mp = `${path}.reading.metrics[${k}]`;
          const name = slot(`${mp}.label`, "balance", "name");
          return typeof m.value === "string"
            ? `<div class="entry${j ? "" : " first"}" data-path="${mp}">${leadOf(j) || '<span class="lead"></span>'}${name}${slot(`${mp}.value`, esc(m.value), "words", "span", ` title="${esc(r.notice ?? m.value)}"`)}</div>`
            : entry(
                [
                  leadOf(j),
                  name,
                  slot(`${mp}.value`, esc(amount(m.value, m.unit)), "figure"),
                  "",
                  "",
                  "",
                ],
                mp,
                j ? "" : " first",
              );
        })
      : [
          entry(
            [
              leadOf(0),
              slot(`${path}.reading.metrics`, "balance", "name"),
              slot(`${path}.reading.metrics`, DASH, "figure"),
              "",
              "",
              "",
            ],
            path,
            " first",
          ),
        ];
    const remaining = find(LABEL.keyRemaining);
    const limit = find(LABEL.keyLimit);
    const k = r.windows.findIndex((w) => w.label === LABEL.keyAllowance);
    const w = r.windows[k];
    if (remaining || w) {
      const rp = remaining
        ? `${path}.reading.metrics[${remaining.k}]`
        : `${path}.reading.metrics`;
      const wp = w ? `${path}.reading.windows[${k}]` : rp;
      rows.push(
        entry(
          [
            leadOf(rows.length),
            slot(`${rp}.label`, "key left", "name"),
            remaining
              ? slot(
                  `${rp}.value`,
                  esc(amount(remaining.m.value, remaining.m.unit)),
                  "figure",
                )
              : slot(`${rp}.value`, DASH, "figure"),
            w
              ? meter({
                  share: Math.max(0, w.usedPercent),
                  wide: true,
                  path: `${wp}.usedPercent`,
                  title: `${Math.round(Math.max(0, w.usedPercent))}% of the key allowance used`,
                })
              : "",
            "",
            limit
              ? slot(
                  `${path}.reading.metrics[${limit.k}].value`,
                  `of ${esc(amount(limit.m.value, limit.m.unit))}`,
                  "when quiet",
                )
              : "",
          ],
          wp,
        ),
      );
    }
    return rows;
  };

  // A provider's table. A day-keyed one lists every calendar day from its
  // newest to its oldest, newest first: the latest fourteen, the rest
  // behind "all n days", a missing day as a gap row (a gap, not a zero);
  // with exactly one numeric column, a bar after it, scaled to that
  // column's largest value among the days shown.
  const dataTable = (path: string, t: DataTable, key: string): string => {
    const columns = t.columns.map((c) => ({
      label: c.label,
      kind: c.format ? COLUMN_KIND[c.format] : ("text" as const),
    }));
    const cellsOf = (r: DataTable["rows"][number]): (string | null)[] =>
      t.columns.map((c) => {
        const value = r[c.key];
        return value === null || value === undefined
          ? null
          : amount(value, c.format === "USD" ? "USD" : null);
      });
    const date = t.columns.find((c) => c.format === "date");
    const numbers = t.columns.filter(
      (c) => c.format === "number" || c.format === "USD",
    );
    const byDay = new Map<string, DataTable["rows"]>();
    for (const r of t.rows) {
      const day = date ? String(r[date.key]) : "";
      byDay.set(day, [...(byDay.get(day) ?? []), r]);
    }
    const dayMs = [...byDay.keys()].map((day) => Date.parse(`${day}T00:00Z`));
    if (!date || !t.rows.length || dayMs.some(Number.isNaN))
      return table({
        path,
        title: t.title,
        columns,
        rows: t.rows.map((r) => ({ cells: cellsOf(r) })),
      });
    const newest = Math.max(...dayMs);
    const days: string[] = [];
    for (let ms = newest; ms >= Math.min(...dayMs); ms -= 86_400_000)
      days.push(new Date(ms).toISOString().slice(0, 10));
    const bars = numbers.length === 1 ? numbers[0] : undefined;
    const valueOf = (r: DataTable["rows"][number]): number => {
      const v = bars ? r[bars.key] : 0;
      return typeof v === "number" ? v : 0;
    };
    const shownDays = days.slice(0, DAYS_SHOWN);
    const top = Math.max(
      0,
      ...shownDays.flatMap((day) => (byDay.get(day) ?? []).map(valueOf)),
    );
    const rowsOf = (list: string[]): Row[] =>
      list.flatMap((day): Row[] => {
        const found = byDay.get(day);
        if (!found)
          return [
            {
              cells: t.columns.map((c) => (c === date ? day : null)),
              gap: true,
            },
          ];
        return found.map((r) => ({
          cells: cellsOf(r),
          ...(bars ? { bar: top ? (100 * valueOf(r)) / top : 0 } : {}),
        }));
      });
    return table({
      path,
      title: t.title,
      columns,
      rows: rowsOf(shownDays),
      bars: bars !== undefined,
      more: {
        key,
        words: `all ${days.length} days`,
        rows: rowsOf(days.slice(DAYS_SHOWN)),
      },
    });
  };

  // An account's details, under its rows at the name column: its other
  // figures as pairs, the reading's notice, the provider's usage page, then
  // each history with its date, pairs, tables and notice.
  const metricPairs = (items: { path: string; m: Metric }[]): string =>
    pairs(
      items.map(({ path, m }) => ({
        path,
        label: m.label,
        value: amount(m.value, m.unit),
      })),
    );
  const details = (a: AccountView, path: string, skip: string[]): string => {
    const r = a.reading;
    const metrics = (r?.metrics ?? []).flatMap((m, k) =>
      skip.includes(m.label)
        ? []
        : [{ path: `${path}.reading.metrics[${k}]`, m }],
    );
    const histories = (r?.details ?? []).map((d, k) => {
      const dp = `${path}.reading.details[${k}]`;
      const meta =
        (d.throughDate
          ? slot(`${dp}.throughDate`, `through ${esc(d.throughDate)}`, "n")
          : "") +
        (d.status === "stale"
          ? slot(
              `age(${dp}.observedAt, at)`,
              `last reading ${age(d.observedAt, at)} ago`,
              "n",
              "span",
              dated(d.observedAt),
            ) + slot(`${dp}.status`, "stale", "badge sm")
          : "");
      return `<section class="dt" data-path="${dp}"><h4>${slot(`${dp}.title`, esc(d.title))}${meta}</h4>${metricPairs(d.metrics.map((m, j) => ({ path: `${dp}.metrics[${j}]`, m })))}${d.tables.map((t, j) => dataTable(`${dp}.tables[${j}]`, t, `usage ${a.id} ${d.title} ${t.title}`)).join("")}${d.notice ? slot(`${dp}.notice`, esc(d.notice), "hint", "p") : ""}</section>`;
    });
    return `${metricPairs(metrics)}${r?.notice ? slot(`${path}.reading.notice`, esc(r.notice), "hint", "p") : ""}<p><a href="${esc(a.url)}" target="_blank" rel="noopener noreferrer" data-path="${path}.url">usage page ↗</a></p>${histories.join("")}`;
  };

  // An account: its rows, then while it is stale or unavailable its badge
  // and status line (the reading's or the check's age, then the error),
  // then its details. The badge takes the lead of the account's second row,
  // so every row keeps its height; an account of one row puts it in the
  // status line's lead.
  const account = (a: AccountView, i: number): string => {
    const path = `usage.accounts[${i}]`;
    const more = disclosure({
      key: `usage ${a.id}`,
      id: `usage-more-${a.id}`,
      path: `${path}.name`,
      label: a.name,
      title: `${a.name} · details`,
      blockPath: path,
      body: details(
        a,
        path,
        a.kind === "subscription" ? [] : [...LEADING, ...BESIDE],
      ),
    });
    // The first row leads with the toggle, the second with the badge.
    const badgeHtml = badge(a, path);
    const leadOf = (row: number): string =>
      row === 0
        ? lead(a, path, more.toggle)
        : row === 1 && badgeHtml
          ? `<span class="lead badge-lead">${badgeHtml}</span>`
          : "";
    const rows =
      a.kind === "subscription"
        ? subscriptionRows(a, path, leadOf)
        : balanceRows(a, path, leadOf);
    const old = ageOf(a, path);
    const bits = [
      ...(old
        ? [
            `${old.words} ${slot(old.path, age(old.at, at), "mono", "span", dated(old.at))} ago`,
          ]
        : []),
      ...(a.error && a.status !== "ready"
        ? [slot(`${path}.error`, esc(a.error))]
        : []),
    ];
    const unplaced = rows.length > 1 ? "" : badgeHtml;
    const status =
      bits.length || unplaced
        ? `<div class="status"><span class="lead badge-lead">${unplaced}</span><p>${bits.join(" · ")}</p></div>`
        : "";
    return `<div class="account ${esc(a.status)}" data-path="${path}" data-account="${esc(a.id)}">${rows.join("")}${status}${more.block}</div>`;
  };

  // The pop-up: a top line with the store's freshness and the close button,
  // then Subscriptions and Balances with their counts. It sits after the
  // board (from 900px down it is the page), and the script places it beside
  // the rail and keeps it open across refreshes.
  const usagePopup = (u: UsageView): string => {
    const groups = (
      [
        ["subscription", "Subscriptions"],
        ["api", "Balances"],
      ] as const
    ).flatMap(([kind, title]) => {
      const mine = u.accounts.flatMap((a, i) =>
        a.kind === kind ? [account(a, i)] : [],
      );
      return mine.length
        ? [
            `<h3 class="group-h"><span class="kicker">${title}</span>${slot(`count(usage.accounts[].kind=${kind})`, String(mine.length), "n")}</h3><div class="ledger">${mine.join("")}</div>`,
          ]
        : [];
    });
    const fresh = u.at
      ? `read ${time(u.at)} · every ${u.every % 60 ? `${u.every}s` : span(u.every * 1000)}`
      : "not read yet";
    const tip = `${u.at ? `usage read ${stamp(u.at)}` : "usage not read yet"} · every ${u.every}s`;
    return `<aside class="usage" id="usage" role="dialog" aria-label="Usage" data-path="usage"${usageOpen ? "" : " hidden"}>
  <div class="top"><span class="kicker">Usage</span>${slot("time(usage.at), usage.every", fresh, "fresh", "span", ` title="${esc(tip)}"`)}<span class="spacer"></span><kbd class="k">u</kbd><a class="close" href="${usageClose}" role="button" aria-label="Close" title="Close (u, esc)">×</a></div>
  <div class="body">
${groups.join("\n")}
  </div>
</aside>`;
  };

  // ---- Agents ----

  // A held placement stays held while its session runs; one that runs a
  // turn with no delivery and no hold is busy (v0.12).
  const dotOf = (p: PlacementView): Dot => {
    const d = p.delivery;
    if (d) return d.question ? (asksViewer(d.id) ? "ask" : "wait") : "work";
    if (p.hold) return "held";
    if (p.agent?.status === "running") return "busy";
    return p.ready ? "ready" : "off";
  };
  const rank = (p: PlacementView): number => RANK[dotOf(p)];

  // A card: its dot, then the body's lines; `idle` is the collapsed card of
  // a session with no delivery. The busy dot also reads the agent's status.
  const cardShell = (
    path: string,
    cls: string,
    dot: Dot,
    body: string,
  ): string =>
    `    <div class="card${cls}" tabindex="0" data-path="${path}">
      <span class="dot ${dot}" data-path="${path}.delivery.latest.kind, ${path}.ready, ${path}.hold${dot === "busy" ? `, ${path}.agent.status` : ""}"></span>
      <div class="body">
${body}
      </div>
    </div>`;
  const lever = (levers: string[]): string =>
    levers.length ? `<span class="lever">${levers.join("")}</span>` : "";
  // The card's last row: the status line, the meter on an idle card, and
  // the lever at its end.
  const tele = (line: string, meter: string, levers: string[]): string =>
    `        <div class="tele"><span class="line">${line}</span>${meter}${lever(levers)}</div>`;
  // v0.10: placements[].agent closes each card as a health row (the status
  // line, the snapshot's age, the lever) and a context meter. The status
  // line is the first that applies: pending permissions in the accent;
  // error, missing and unreachable dotted with the error as tooltip (a
  // sentence when there is none); running with the turn's age; idle with
  // the last turn's end; any other status as words; v0.11 adds "· n
  // subagents" while any run; v0.12 ends it with stale(p, at) in the
  // warning role. A null agent reads "no telemetry". The seen age comes
  // apart: v0.12 shows it on a card with a delivery and on the sheet's
  // head, which repeats the line. The meter turns warn from 80% (v0.12).
  const health = (
    path: string,
    p: PlacementView,
  ): { status: string; seen: string; meter: string } => {
    const ap = `${path}.agent`;
    const a = p.agent;
    const late = stale(p, at, times);
    const warn = late
      ? ` · ${slot(`stale(${path}, at)`, esc(late), "role-warn num")}`
      : "";
    if (!a)
      return {
        status: slot(ap, "no telemetry", "k") + warn,
        seen: "",
        meter: "",
      };
    const errTip = ` title="${esc(a.error ?? STATUS_NOTE[a.status] ?? "")}"`;
    let line: string;
    if (a.permissions.length) {
      line = slot(
        `${ap}.permissions[].name`,
        `asks permission: ${esc(a.permissions.map((q) => q.name).join(", "))}`,
        "ask",
        "span",
        ` title="${esc(a.permissions.map((q) => q.title ?? q.name).join("; "))}"`,
      );
    } else if (a.status in STATUS_NOTE) {
      line = slot(
        `${ap}.status, ${ap}.error`,
        esc(a.status),
        "err",
        "span",
        errTip,
      );
    } else {
      line = slot(`${ap}.status`, esc(label(a.status)));
      if (a.status === "running" && a.turnStartedAt)
        line += ` ${ago(`age(${ap}.turnStartedAt, at)`, a.turnStartedAt, "num")}`;
      else if (
        a.status === "idle" &&
        a.attention === "finished" &&
        a.attentionAt
      )
        line += ` ${ago(`age(${ap}.attentionAt, at)`, a.attentionAt, "num")}`;
    }
    if (a.attention === "error" && !(a.status in STATUS_NOTE))
      line += ` · ${slot(`${ap}.attention, ${ap}.error`, "error", "err", "span", errTip)}`;
    const running = a.subagents?.running.length ?? 0;
    if (running)
      line += ` · ${slot(`count(${ap}.subagents.running)`, count(running, "subagent"))}`;
    line += warn;
    const seen = ago(
      `age(${ap}.seen, at)`,
      a.seen,
      "seen num",
      `seen ${age(a.seen, at)}`,
    );
    let gauge = "";
    const c = a.context;
    if (c) {
      const pct = percent(c.used, c.max);
      let tip = `${thousands(c.used)} of ${thousands(c.max)} tokens in context`;
      const u = a.usage;
      if (u) {
        const cost =
          u.costUsd === null ? "no cost reported" : `$${u.costUsd.toFixed(2)}`;
        tip += ` · since the session started: input ${thousands(u.input)}, cached ${thousands(u.cached)}, output ${thousands(u.output)} · ${cost}`;
      }
      gauge = meter({
        share: pct,
        tone: pct >= CONTEXT_WARN ? "warn" : "",
        path: `${ap}.context, ${ap}.usage`,
        title: tip,
        figure: {
          path: `percent(${ap}.context.used, ${ap}.context.max)`,
          text: `${pct}%`,
        },
      });
    }
    return { status: line, seen, meter: gauge };
  };
  // provider/model, thinking and mode as tags on the sheet's head (v0.12:
  // the card lost its tags row); a null field is left out.
  const harnessTags = (path: string, a: PlacementView["agent"]): string => {
    if (!a) return "";
    const ap = `${path}.agent`;
    const pm = [a.provider, a.model].filter(Boolean).join("/");
    const tag = (field: "thinking" | "mode"): string => {
      const value = a[field];
      return value
        ? slot(
            `${ap}.${field}`,
            esc(value),
            "tag",
            "span",
            ` title="${field} ${esc(value)}"`,
          )
        : "";
    };
    return `${pm ? slot(`${ap}.provider, ${ap}.model`, esc(pm), "tag") : ""}${tag("thinking")}${tag("mode")}`;
  };

  // The card's levers: Answer T while the placement asks the viewer; Hold
  // or Release for an identified viewer, since a hold says a person is
  // typing in the session (v0.9).
  const leversOf = (p: PlacementView, path: string): string[] => {
    const holdLever = actor
      ? form(
          { action: "hold", placement: p.key, hold: p.hold ? "0" : "1" },
          slot(`${path}.hold`, p.hold ? "Release" : "Hold", "btn sm", "button"),
        )
      : "";
    return [
      ...(p.delivery
        ? answers(p.delivery.id)
            .filter((it) => it.act)
            .map((it) =>
              slot(
                it.path,
                `Answer ${esc(it.item.taskId)}`,
                "btn sm accent",
                "a",
                ` href="${href(it.item.taskId, `#answer-${it.item.deliveryId}`)}"`,
              ),
            )
        : []),
      holdLever,
    ].filter(Boolean);
  };
  // The host and session tags, which close the sheet's head.
  const sessionTags = (p: PlacementView, path: string): string =>
    slot(`${path}.host`, esc(p.host), "tag") +
    slot(
      `${path}.session`,
      `session ${esc(shortId(p.session))}`,
      "tag",
      "span",
      fullId(p.session),
    );

  // ---- The sheet (v0.11) ----

  // One placement's health, over the tasks column, opened from its card's
  // name or the s key; every placement's sheet is in the page, hidden, and
  // the script shows one by its key, keeping it open across refreshes. The
  // head repeats the card's dot, name, meter, status line with the seen age
  // and levers, then the tags. Checkout is a key-value grid; Subagents the
  // counts and a tree one level deep of the running ones; Activity the last
  // eight timeline items, a running tool last in the text colour with the
  // pulse dot and the turns left out at 0 (v0.12). A null section reads
  // "<name> not read", adding "session not live" when the router would not
  // read it.
  const section = (kicker: string, body: string, extra = ""): string =>
    `    <section>
      <h3><span class="kicker">${kicker}</span>${extra}</h3>
      ${body}
    </section>`;
  const notRead = (path: string, name: string, a: AgentSnapshot | null) =>
    slot(
      path,
      `${name} not read${live(a) ? "" : " · session not live"}`,
      "none",
      "p",
    );
  const sep = '<span class="muted">·</span>';
  const checkoutSection = (ap: string, c: Checkout | null): string => {
    const cp = `${ap}.checkout`;
    if (!c)
      return section("Checkout", slot(cp, "checkout not read", "none", "p"));
    const rows: [string, string][] = [
      [
        "project",
        slot(
          `${cp}.project`,
          esc(c.project),
          "",
          "span",
          ` title="${esc(c.project)}"`,
        ),
      ],
      [
        "workspace",
        slot(
          `${cp}.workspace`,
          esc(c.workspace),
          "",
          "span",
          ` title="${esc(c.workspace)}"`,
        ) + slot(`${cp}.kind`, esc(label(c.kind)), "muted"),
      ],
      [
        "directory",
        slot(
          `${cp}.directory`,
          esc(c.directory),
          "mono path",
          "span",
          ` title="${esc(c.directory)}"`,
        ),
      ],
    ];
    let branch = c.branch
      ? slot(
          `${cp}.branch`,
          esc(c.branch),
          "mono",
          "span",
          ` title="${esc(c.branch)}"`,
        )
      : slot(`${cp}.branch`, "detached", "muted");
    // v0.12: the remote as owner/repo, the whole value as its title.
    if (c.remote)
      branch += slot(
        `repo(${cp}.remote)`,
        esc(repo(c.remote)),
        "mono muted remote",
        "span",
        ` title="${esc(c.remote)}"`,
      );
    if (c.dirty) branch += slot(`${cp}.dirty`, "dirty", "role-warn");
    const ahead = c.ahead ?? 0;
    const behind = c.behind ?? 0;
    if (ahead || behind)
      branch += slot(
        `${cp}.ahead, ${cp}.behind`,
        `ahead ${ahead} · behind ${behind}`,
        "muted num",
      );
    rows.push(["branch", branch]);
    rows.push([
      "diff",
      c.diff
        ? slot(
            `diff(${cp}.diff.additions, ${cp}.diff.deletions)`,
            diff(c.diff.additions, c.diff.deletions),
            "num",
          )
        : slot(`${cp}.diff`, "no diff", "muted"),
    ]);
    const pr = c.pr;
    if (pr) {
      const pp = `${cp}.pr`;
      const title = `#${pr.number ?? "?"} ${pr.title}`;
      const state = pr.draft
        ? "draft"
        : pr.merged
          ? "merged"
          : label(pr.state.toLowerCase());
      // The title keeps its own row; checks and review take the next one,
      // so a long title is not squeezed. The link needs a web address.
      const web = /^https:\/\//.test(pr.url);
      rows.push([
        "pull request",
        slot(
          `${pp}.number, ${pp}.title, ${pp}.url`,
          esc(title),
          "pr",
          web ? "a" : "span",
          `${web ? ` href="${esc(pr.url)}"` : ""} title="${esc(title)}"`,
        ) +
          slot(`${pp}.state, ${pp}.draft, ${pp}.merged`, esc(state), "muted") +
          (pr.mergeable === "CONFLICTING"
            ? slot(`${pp}.mergeable`, "conflicts", "role-warn")
            : ""),
      ]);
      const [word, role] = CHECK_WORDS[pr.checks ?? "null"];
      let checks = slot(`${pp}.checks`, word, role);
      if (pr.review)
        checks +=
          sep +
          slot(`${pp}.review`, esc(REVIEW[pr.review] ?? label(pr.review)));
      rows.push(["checks", checks]);
    } else
      rows.push(["pull request", slot(`${cp}.pr`, "no pull request", "muted")]);
    let status = slot(`${cp}.status`, esc(label(c.status)));
    if (c.activityAt)
      status += ago(
        `age(${cp}.activityAt, at)`,
        c.activityAt,
        "muted num",
        `active ${age(c.activityAt, at)}`,
      );
    rows.push(["status", status]);
    return section(
      "Checkout",
      `<dl class="kv">${rows.map(([k, v]) => `<dt>${k}</dt><dd>${v}</dd>`).join("")}</dl>`,
    );
  };
  const subagentsSection = (ap: string, a: AgentSnapshot | null): string => {
    const sp = `${ap}.subagents`;
    const sub = a?.subagents ?? null;
    if (!sub) return section("Subagents", notRead(sp, "subagents", a));
    const tally = counts(sub.counts);
    const running = sub.running;
    if (!tally && !running.length)
      return section("Subagents", slot(sp, "none", "none", "p"));
    const body = tally
      ? slot(`counts(${sp}.counts)`, esc(tally), "counts-line", "p")
      : "";
    if (!running.length)
      return section(
        "Subagents",
        body + slot(`${sp}.running`, "none running", "none", "p"),
      );
    const row = (k: number): string => {
      const x = running[k];
      if (!x) return "";
      const rp = `${sp}.running[${k}]`;
      const desc = x.description ?? "";
      return `<div class="subagent" data-path="${rp}"><span class="dot ${x.status === "running" ? "work" : "done"}" data-path="${rp}.status" title="${esc(x.status)}"></span>${slot(`${rp}.title`, esc(x.title ?? "subagent"), "title", "span", ` title="${esc(x.id)}"`)}${slot(`${rp}.description`, esc(desc), "desc", "span", ` title="${esc(desc)}"`)}${ago(`age(${rp}.startedAt, at)`, x.startedAt, "when", `started ${age(x.startedAt, at)}`)}${ago(`age(${rp}.updatedAt, at)`, x.updatedAt, "when", `updated ${age(x.updatedAt, at)}`)}</div>`;
    };
    // A tree one level deep: top-level rows first, each followed by its
    // children; a child whose parent is not in running[] has no row to hang
    // under and sits at the top level.
    const ids = new Set(running.map((x) => x.id));
    const rows: string[] = [];
    running.forEach((x, k) => {
      if (x.parent !== null && ids.has(x.parent)) return;
      rows.push(row(k));
      const kids = running.flatMap((y, j) =>
        y.parent === x.id ? [row(j)] : [],
      );
      if (kids.length)
        rows.push(
          `<div class="kids" data-path="${sp}.running[].parent">${kids.join("")}</div>`,
        );
    });
    return section(
      "Subagents",
      `${body}<div class="subs">${rows.join("")}</div>`,
    );
  };
  const activitySection = (ap: string, a: AgentSnapshot | null): string => {
    const acp = `${ap}.activity`;
    const act = a?.activity ?? null;
    if (!act) return section("Activity · last 8", notRead(acp, "activity", a));
    const turns = act.turns
      ? slot(`${acp}.turns`, count(act.turns, "turn"), "n")
      : "";
    if (!act.items.length)
      return section(
        "Activity · last 8",
        slot(`${acp}.items`, "none", "none", "p"),
        turns,
      );
    const rows = act.items.map((it, k) => {
      const ip = `${acp}.items[${k}]`;
      const call = it.kind === "tool_call";
      const now = k === act.items.length - 1 && call && it.status === "running";
      const cls = `item${now ? " now" : ""}${it.kind === "error" ? " error" : QUIET.includes(it.kind) ? " quiet" : ""}`;
      let what = "";
      if (call) {
        what += slot(
          `${ip}.tool`,
          esc(it.tool ?? "tool"),
          "tool",
          "span",
          ` title="${esc(it.tool ?? "tool")}"`,
        );
        if (it.status)
          what += slot(
            `${ip}.status`,
            esc(it.status),
            `status ${STATUS_CLS[it.status] ?? ""}`.trim(),
          );
      }
      if (it.text)
        what += slot(
          `${ip}.text`,
          esc(it.text),
          "text",
          "span",
          ` title="${esc(it.text)}"`,
        );
      return `<div class="${cls}" data-path="${ip}"${now ? ' aria-current="true"' : ""}><span class="mark${now ? " work" : ""}"></span>${slot(`hms(${ip}.at)`, hms(it.at), "at", "span", dated(it.at))}${slot(`${ip}.kind`, esc(KIND[it.kind] ?? label(it.kind)), "kind")}<span class="what">${what}</span></div>`;
    });
    return section(
      "Activity · last 8",
      `<div class="feed">${rows.join("")}</div>`,
      turns,
    );
  };
  const sheetOf = (p: PlacementView, i: number): string => {
    const path = `placements[${i}]`;
    const a = p.agent;
    const ap = `${path}.agent`;
    const { status, seen, meter } = health(path, p);
    const line = seen ? `${status} · ${seen}` : status;
    return `<aside class="sheet" role="dialog" aria-label="${esc(p.key)}" data-path="${path}" data-key="${esc(p.key)}" hidden>
  <div class="head">
    <div class="name"><span class="dot ${dotOf(p)}" data-path="${path}.delivery.latest.kind, ${path}.ready, ${path}.hold"></span><h2>${slot(`${path}.key`, esc(p.key))}</h2>${meter}<button class="close" type="button" aria-label="Close" title="Close (esc)">×</button></div>
    <div class="tele"><span class="line">${line}</span>${lever(leversOf(p, path))}</div>
    <div class="rig">${harnessTags(path, a)}${sessionTags(p, path)}</div>
  </div>
  <div class="body">
${checkoutSection(ap, a?.checkout ?? null)}
${subagentsSection(ap, a)}
${activitySection(ap, a)}
  </div>
</aside>`;
  };

  const card = (p: PlacementView, i: number): string => {
    const path = `placements[${i}]`;
    const d = p.delivery;
    const latest = d?.latest ?? null;
    const dot = dotOf(p);
    const asks = dot === "ask";
    const levers = leversOf(p, path);
    // The name opens the placement's health sheet, as s does on the
    // focused card (v0.11); its title names it whole, as the name
    // ellipsizes from 1180px down (v0.13).
    const name = slot(
      `${path}.key`,
      esc(p.key),
      "key",
      "span",
      ` role="button" aria-haspopup="dialog" title="${esc(p.key)} · open the sheet (s)"`,
    );
    // v0.12: "seen" belongs to a card with a delivery; a card without one
    // shows the status line alone.
    const { status, seen, meter } = health(path, p);
    const line = d && seen ? `${status} · ${seen}` : status;
    if (dot === "busy")
      // Busy: running a turn the router did not send. Expanded like a work
      // card, "busy" under the name and meter, without the delivery lines.
      return cardShell(
        path,
        "",
        dot,
        `        <div class="name">${name}${meter}</div>
        <div class="what busy">${slot(`${path}.agent.status`, "busy")}</div>
${tele(line, "", levers)}`,
      );
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
${tele(line, meter, levers)}`,
      );
    }
    const task = slot(
      `${path}.delivery.taskId`,
      esc(d.taskId),
      "id",
      "a",
      ` href="${href(d.taskId)}"`,
    );
    // The card's reading, decided once for its first line, its stats line
    // and its corner age: asking while a question is open; the send's
    // outcome while it has not been accepted (a delivery is pinned at the
    // attempt); working once a question was answered; else the latest
    // update, or delivered when there is none yet.
    const outcomePath = `${path}.delivery.outcome`;
    const state = d.question
      ? "asking"
      : d.outcome !== "accepted"
        ? "unaccepted"
        : answeredQuestion(d)
          ? "answered"
          : latest
            ? "updated"
            : "delivered";
    const what =
      state === "asking"
        ? `asks on ${task}`
        : state === "unaccepted"
          ? `${slot(outcomePath, esc(d.outcome))} on ${task}`
          : state === "answered"
            ? `working on ${task}`
            : state === "updated" && latest
              ? `${esc(latest.kind)} on ${task}`
              : `delivered on ${task}`;
    // While a question is open the card shows it in place of the request.
    const excerpt = d.question
      ? ` · ${slot(`${path}.delivery.question.text`, esc(d.question.text))}`
      : ` · ${slot(`${path}.delivery.excerpt`, esc(d.excerpt))}`;
    const latestAt = `${path}.delivery.latest.at`;
    const answeredAt = `times[${path}.delivery.messageId]`;
    const stats =
      state === "unaccepted"
        ? slot(outcomePath, `${esc(d.outcome)}, no reply yet`, "k")
        : state === "answered"
          ? `<span class="k">answered</span>${clock(`time(${answeredAt})`, times[d.messageId])}<span class="k">· no reply yet</span>`
          : latest
            ? `<span class="k">last update</span>${slot(`${path}.delivery.latest.kind`, esc(latest.kind), asks ? "ask" : "")}${clock(`time(${latestAt})`, latest.at)}${latest.at ? ago(`age(${latestAt}, at)`, latest.at, "num", `· ${age(latest.at, at)} ago`) : ""}`
            : slot(`${path}.delivery.latest`, "delivered, no reply yet", "k");
    const corner =
      state === "unaccepted"
        ? ""
        : state === "answered"
          ? ago(`age(${answeredAt}, at)`, times[d.messageId], "age num")
          : latest?.at
            ? ago(`age(${latestAt}, at)`, latest.at, "age num")
            : "";
    return cardShell(
      path,
      asks ? " warm" : "",
      dot,
      `        <div class="name">${name}${meter}${corner}</div>
        <div class="what${asks ? " ask" : ""}">${what}${excerpt}</div>
        <div class="stats">${stats}</div>
${tele(line, "", levers)}`,
    );
  };

  // The rail: the cards in state order, then the Usage section (v0.13),
  // then the router log, collapsed to its kicker line and newest line; r
  // opens the whole block (v0.12, l until v0.13).
  const agents = `<aside class="panel agents" aria-label="Agents" data-part="agents">
  <h2 class="col-h"><span class="kicker">Agents</span>${slot("count(placements)", count(agentCount, "placement"), "n")}</h2>
  <div class="scroll"><div class="cards">
${model.placements
  .map((p, i): [PlacementView, number] => [p, i])
  .sort(([a], [b]) => rank(a) - rank(b))
  .map(([p, i]) => card(p, i))
  .join("\n")}
  </div></div>
${usageRail}  <div class="foot open"><div><span class="kicker">Router log</span> · ${slot("count(log)", `last ${model.log.length}`)} · <kbd class="k">r</kbd></div><div class="lines"><div class="tail">${model.log.map((e, i) => `<div data-path="log[${i}]"><b>${esc(e.actor)}</b> ${esc(e.text)}</div>`).join("")}</div></div></div>
</aside>`;

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
                subscriptions.length
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
${agents}
${tasksPanel}
${detail()}
${model.placements.map((p, i) => sheetOf(p, i)).join("\n")}
</main>
<footer class="keys">
  <span><kbd>↑↓</kbd> move</span><span><kbd>↵</kbd> open</span><span><kbd>space</kbd> peek</span><span><kbd>s</kbd> sheet</span><span><kbd>a</kbd> answer</span><span><kbd>c</kbd> cancel</span><span><kbd>p</kbd> hold</span><span data-key="r" role="button"><kbd>r</kbd> log</span>${usage ? "<span><kbd>u</kbd> usage</span>" : ""}<span><kbd>/</kbd> filter</span><span data-key="?" role="button"><kbd>?</kbd> keys</span>
  <span class="spacer"></span>
  <span>refreshes every ${refreshSeconds}s</span>
</footer>
</div>
${usage ? `${usagePopup(usage)}\n` : ""}<div class="help" role="dialog" aria-label="Keys" hidden>
  <div class="top"><span class="kicker">Keys</span><span class="spacer"></span><kbd class="k">?</kbd></div>
  <div class="grid">${keyRows(helpKeys)}${usage ? `<span class="sub kicker">In usage</span>${keyRows(HELP_USAGE_KEYS)}` : ""}</div>
  <div class="theme"><span>theme</span><span class="themes" role="group" aria-label="Theme">${THEMES.map((name) => `<button type="button" data-theme="${name}"${name === theme ? ' class="on" aria-pressed="true"' : ' aria-pressed="false"'}>${THEME_NAMES[name]}</button>`).join("")}</span></div>
</div>
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
  --fs: 13px; --fs-mono: 11.5px; --fs-small: 12px; --pad: 12px; --row-pad: 7px 10px; --card-gap: 6px;
}
/* Flexoki dark: bg black, bg-2 base-950, ui base-900/850/800, tx base-200/500/700, accent blue-400; roles green/orange/red-400. */
:root, html[data-theme="flexoki"] {
  --canvas: #100F0F; --surface: #1C1B1A; --surface-2: #282726; --text: #CECDC3; --text-2: #878580; --text-3: #575653;
  --hair: #282726; --hair-soft: #1F1E1D; --hair-strong: #403E3C;
  --wash: rgba(206,205,195,.05); --press: rgba(206,205,195,.10);
  --accent: #4385BE; --accent-soft: rgba(67,133,190,.16); --accent-line: rgba(67,133,190,.4); --on-accent: #FFFCF0;
  --ok: #879A39; --warn: #DA702C; --err: #D14D41;
  --shadow: rgba(0,0,0,.45);
}
/* Flexoki light: bg paper, bg-2 base-50, ui base-100/150/200, tx black/base-600/base-300, accent blue-600; roles green/orange/red-600. */
@media (prefers-color-scheme: light) {
  html[data-theme="flexoki"] {
    --canvas: #FFFCF0; --surface: #F2F0E5; --surface-2: #E6E4D9; --text: #100F0F; --text-2: #6F6E69; --text-3: #B7B5AC;
    --hair: #E6E4D9; --hair-soft: #ECEAE0; --hair-strong: #CECDC3;
    --wash: rgba(16,15,15,.04); --press: rgba(16,15,15,.08);
    --accent: #205EA6; --accent-soft: rgba(32,94,166,.10); --accent-line: rgba(32,94,166,.35); --on-accent: #FFFCF0;
    --ok: #66800B; --warn: #BC5215; --err: #AF3029;
    --shadow: rgba(16,15,15,.18);
  }
}
/* One Dark, from Zed's assets/themes/one/one.json: editor.background, surface, border.variant, border, text, text.muted, text.placeholder, element.active, text.accent; roles success, warning, error. */
html[data-theme="one-dark"] {
  --canvas: #282C33; --surface: #2F343E; --surface-2: #363C46; --text: #DCE0E5; --text-2: #A9AFBC; --text-3: #878A98;
  --hair: #363C46; --hair-soft: #30353F; --hair-strong: #464B57;
  --wash: rgba(220,224,229,.05); --press: #454A56;
  --accent: #74ADE8; --accent-soft: rgba(116,173,232,.14); --accent-line: rgba(116,173,232,.4); --on-accent: #282C33;
  --ok: #A1C181; --warn: #DEC184; --err: #D07277;
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
#app { position: relative; height: 100vh; display: grid; grid-template-rows: 52px 1fr 40px; grid-template-columns: minmax(0, 1fr); }
/* min-width: 0, so the page's grid lets the nav be narrower than its
   children's full text and .who truncates instead of widening the page. */
.nav { display: flex; align-items: center; gap: 14px; padding: 0 20px; min-width: 0; background: var(--canvas); border-bottom: 1px solid var(--hair); }
.nav .brand { font-weight: 500; font-size: 17px; letter-spacing: -.2px; }
.nav .who { flex: 0 1 auto; min-width: 0; max-width: 260px; overflow: hidden; text-overflow: ellipsis; white-space: nowrap; font-size: var(--fs-small); color: var(--text-3); }
.nav .counts { display: flex; gap: 6px; margin-left: 4px; }
.nav .br { display: none; }
.nav .counts > span { font-family: var(--mono); font-size: var(--fs-mono); font-weight: 500; letter-spacing: .3px; padding: 4px 10px; border-radius: 100px; border: 1px solid var(--hair); color: var(--text-2); white-space: nowrap; }
.nav .counts > span b { font-weight: 500; color: var(--text); margin-right: 4px; }
.nav .counts .attn { background: var(--accent-soft); border-color: transparent; color: var(--accent); }
.nav .counts .attn b { color: var(--accent); }
/* The rail's Usage section (v0.13): pinned under the cards, above the router log; one two-line row per subscription
   account, from the card's parts. Colour per figure only; a stale row dims; a passed window keeps its track only. */
.agents .usage-rail { flex: none; border-top: 1px solid var(--hair); padding-top: 4px; }
.accts { display: grid; gap: 2px; padding: 0 10px 8px; }
.acct { display: grid; gap: 5px; width: 100%; min-width: 0; padding: 7px 10px; border: 1px solid transparent; border-radius: 8px; background: none; color: var(--text); font: inherit; text-align: left; cursor: pointer; transition: background var(--t-fast) var(--std); }
.acct:hover { background: var(--wash); }
.acct .l1 { display: flex; align-items: center; gap: 8px; min-width: 0; font-size: var(--fs); }
.acct .mark { width: 12px; height: 12px; flex: 0 0 12px; color: var(--text); }
.acct .nm { font-weight: 500; letter-spacing: -.1px; white-space: nowrap; }
.acct .st { font-size: var(--fs-small); color: var(--text-3); white-space: nowrap; }
.acct .st.off { color: var(--text-2); }
.acct .rs { margin-left: auto; font-family: var(--mono); font-size: var(--fs-mono); font-weight: 500; color: var(--text-2); white-space: nowrap; font-variant-numeric: tabular-nums; }
.acct .l2 { display: flex; gap: 14px; min-width: 0; padding-left: 20px; }
.acct .win { flex: 1 1 0; min-width: 0; display: flex; align-items: center; gap: 6px; }
.acct .win .w { flex: none; font-family: var(--mono); font-size: var(--fs-mono); color: var(--text-3); }
.acct .win .meter { flex: 1 1 auto; min-width: 0; font-variant-numeric: tabular-nums; }
.acct .win .meter .bar { flex: 1 1 auto; width: auto; min-width: 20px; }
.acct .win.dim .meter { color: var(--text-3); }
.acct .none { font-family: var(--mono); font-size: var(--fs-mono); color: var(--text-3); }
.acct.stale > * { opacity: .55; }
.nav .spacer, .row .spacer, .col-h .spacer, .keys .spacer { flex: 1; }
.nav .tick { font-family: var(--mono); font-size: var(--fs-mono); color: var(--text-3); white-space: nowrap; cursor: help; }
.nav nav { display: flex; gap: 4px; align-items: center; }
.nav nav a { font-family: var(--mono); font-size: var(--fs-mono); font-weight: 500; color: var(--text-2); padding: 6px 11px; border-radius: 8px; text-decoration: none; transition: background var(--t-fast) var(--std), color var(--t-fast) var(--std); }
.nav nav a:hover { background: var(--wash); color: var(--text); }
.nav nav a.active { background: var(--press); color: var(--text); }
.themes { display: flex; border: 1px solid var(--hair); border-radius: 100px; padding: 2px; }
.themes button { font-family: var(--mono); font-size: var(--fs-mono); font-weight: 500; color: var(--text-2); background: transparent; border: 0; border-radius: 100px; padding: 3px 10px; cursor: pointer; transition: background var(--t-fast) var(--std), color var(--t-fast) var(--std); }
.themes button:hover { color: var(--text); }
.themes button.on { background: var(--press); color: var(--text); }

.bento { min-height: 0; width: 100%; max-width: 1600px; margin: 0 auto; padding: 10px 12px; display: grid; grid-template-columns: 3fr 4fr 5fr; gap: 10px; }
.bento > .agents { grid-area: 1 / 1; } .bento > .tasks { grid-area: 1 / 2; } .bento > .detail { grid-area: 1 / 3; }
.panel { position: relative; min-height: 0; overflow: hidden; background: var(--surface); border: 1px solid var(--hair); border-radius: 12px; display: flex; flex-direction: column; }
.scroll { min-height: 0; overflow-y: auto; flex: 1; scrollbar-width: thin; scrollbar-color: var(--hair-strong) transparent; }
.kicker { font-family: var(--mono); font-size: var(--fs-mono); font-weight: 500; letter-spacing: .6px; text-transform: uppercase; color: var(--text-3); }
.kicker.attn { color: var(--accent); }
.col-h { display: flex; align-items: baseline; gap: 10px; padding: 14px 16px 8px; }
.col-h .n { font-family: var(--mono); font-size: var(--fs-mono); font-weight: 500; color: var(--text-3); }

/* Dots: one accent for what needs you; everything else is a shape in the text colour. */
.dot { display: inline-block; width: 8px; height: 8px; border-radius: 50%; background: var(--text-3); flex: 0 0 8px; margin-top: 6px; }
.dot.ask, .dot.fail { background: var(--accent); box-shadow: 0 0 0 3px var(--accent-soft); }
.dot.work, .dot.busy { background: var(--text); animation: pulse 2s var(--std) infinite; }
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
.card.focused { outline: 2px solid var(--text); outline-offset: 2px; }
.card .body { flex: 1; min-width: 0; display: grid; gap: 2px; }
.card .name { font-weight: 500; font-size: var(--fs); letter-spacing: -.1px; display: flex; align-items: baseline; gap: 8px; }
.card .name .key { cursor: pointer; text-decoration: underline; text-decoration-color: transparent; text-underline-offset: 3px; transition: text-decoration-color var(--t-fast) var(--std); }
.card .name .key:hover { text-decoration-color: var(--hair-strong); }
.card .name .age { margin-left: auto; font-family: var(--mono); font-weight: 500; font-size: var(--fs-mono); color: var(--text-3); }
.card .what { font-size: var(--fs-small); color: var(--text-2); overflow: hidden; text-overflow: ellipsis; white-space: nowrap; }
.card .what.ask { color: var(--accent); }
.card .what .id { color: inherit; font-size: inherit; }
.card .what.busy { color: var(--text); }
.card .stats { display: flex; gap: 6px; align-items: baseline; font-family: var(--mono); font-size: var(--fs-mono); color: var(--text-2); white-space: nowrap; }
.card .stats .k { color: var(--text-3); }
.card .stats .ask { color: var(--accent); }
.card .lever { flex: 0 0 auto; display: flex; gap: 6px; }
/* Health: placements[].agent closes the card as one row with the lever at its end; the meter sits in the
   name row, or in this row on an idle card. Only a pending permission takes the accent; a status with an
   error is dotted and carries the error as its tooltip; stale work and a window at 80% take the warning role. */
.card .name .meter { margin-left: auto; align-self: center; }
.card .name .meter + .age { margin-left: 0; }
.card .tele { display: flex; flex-wrap: wrap; gap: 4px 10px; align-items: center; font-size: var(--fs-small); color: var(--text-2); min-width: 0; }
.card.idle .tele { grid-column: 1 / -1; }
/* A status line too long to share the row with the levers keeps the row; the levers wrap under it, right-aligned. */
.card .tele .line { flex: 1 1 auto; min-width: 0; overflow: hidden; text-overflow: ellipsis; white-space: nowrap; }
.card .tele .lever { margin-left: auto; }
.card .tele .ask { color: var(--accent); font-weight: 500; }
.card .tele .err { text-decoration: underline dotted var(--text-3); text-underline-offset: 3px; cursor: help; }
.card .tele .seen, .card .tele .k { color: var(--text-3); }
.meter { flex: 0 0 auto; display: inline-flex; align-items: center; gap: 6px; font-family: var(--mono); font-size: var(--fs-mono); color: var(--text-2); }
.meter .bar { width: 44px; height: 4px; border-radius: 2px; background: var(--hair-strong); overflow: hidden; }
.meter .bar i { display: block; height: 100%; background: var(--text-2); }
.meter.warn { color: var(--warn); }
.meter.warn .bar i { background: var(--warn); }
/* The router log, collapsed: its kicker line and the newest line under the cards, which take the rest. */
.agents .scroll { flex: 1 1 auto; }
.agents .foot { flex: none; padding: 10px 16px 12px; border-top: 1px solid var(--hair); font-family: var(--mono); font-size: var(--fs-mono); line-height: 1.6; color: var(--text-3); display: flex; flex-direction: column; gap: 1px; overflow: hidden; }
.agents .foot .k { margin-left: 2px; }
.agents .foot:not(.open) .tail > div:not(:last-child) { display: none; }
/* Open (r): the cards take what they need; the log fills the rest, newest line at the bottom, at least four lines. */
.agents:has(.foot.open) .scroll { flex: 0 1 auto; }
.agents .foot.open { flex: 1 1 0; min-height: calc(4 * 1.6 * var(--fs-mono) + 46px); /* four lines plus the heading line and padding */ }
/* A line clipped at the top fades out instead of showing half its height. */
.agents .foot.open .lines { flex: 1; min-height: 0; position: relative; overflow: hidden; -webkit-mask-image: linear-gradient(to bottom, transparent, #000 1.6em); mask-image: linear-gradient(to bottom, transparent, #000 1.6em); }
.agents .foot.open .lines .tail { position: absolute; left: 0; right: 0; bottom: 0; }
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
.task .line2 { grid-column: 2 / -1; display: flex; flex-wrap: wrap; gap: 0 8px; align-items: baseline; font-size: var(--fs-small); color: var(--text-2); min-width: 0; margin-top: 1px; }
.task .line2 .state { font-family: var(--mono); font-size: var(--fs-mono); font-weight: 500; letter-spacing: .3px; white-space: nowrap; color: var(--text-2); }
/* The line wraps rather than squeeze the sub below 8em: the route (the sender, the recipient, a late warning) moves
   under it whole, still at the right, and a name too long for the line ends in an ellipsis, whole in its title. */
.task .line2 .sub { flex: 1 1 8em; min-width: 0; overflow: hidden; text-overflow: ellipsis; white-space: nowrap; }
.task .line2 .route { display: flex; gap: 0 8px; align-items: baseline; max-width: 100%; margin-left: auto; }
.task .line2 .to { font-family: var(--mono); font-size: var(--fs-mono); color: var(--text-3); white-space: nowrap; min-width: 0; overflow: hidden; text-overflow: ellipsis; }
.task .line2 .to + .to::before, .task .line2 .to + .stale::before { content: "· "; }
.task .line2 .to + .stale::before { color: var(--text-3); }
.task .line2 .stale { white-space: nowrap; flex: none; }
/* A notice never waits on the viewer: outcomes stay in the text colours, withdrawn muted. */
td .outcome.withdrawn { color: var(--text-3); }
.task.ask .state, .task.fail .state { color: var(--accent); }
.task.done .excerpt { color: var(--text-2); }
.task.done.canceled .state { color: var(--text-3); }

/* Detail: head, transcript, the one form the viewer can act with, then the facts. */
.detail .head { padding: 14px 18px 12px; border-bottom: 1px solid var(--hair); }
.detail .head .title { display: flex; align-items: center; gap: 10px; flex-wrap: wrap; }
.detail .head h2 { flex: 1 1 0; min-width: 0; font-size: calc(var(--fs) + 4px); font-weight: 500; letter-spacing: -.3px; line-height: 1.25; display: -webkit-box; -webkit-box-orient: vertical; -webkit-line-clamp: 2; line-clamp: 2; overflow: hidden; overflow-wrap: anywhere; }
.detail .head h2 .id { color: var(--text-3); margin-right: 6px; }
.detail .head .meta { margin-top: 4px; font-size: var(--fs-small); color: var(--text-2); }
.detail .head .meta [title] { cursor: help; }
.detail .head .meta .end { white-space: nowrap; }
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
.form { margin: 12px 18px 6px; padding: 10px 12px; border: 1px solid var(--accent-line); border-radius: 12px; display: grid; gap: 6px; }
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
.keys > span { white-space: nowrap; }
.keys kbd { font-family: var(--mono); font-weight: 500; color: var(--text-2); }

/* The peek, the sheet and the help are the three overlays, and the only places a shadow is allowed. */
.peek { position: fixed; z-index: 60; width: 420px; padding: 14px; border-radius: 12px; background: var(--surface-2); border: 1px solid var(--hair-strong); box-shadow: 0 24px 48px var(--shadow); display: grid; gap: 8px; cursor: default; animation: rise var(--t-fast) var(--std) both; }
.peek::before { content: ""; position: absolute; left: -6px; top: 22px; width: 10px; height: 10px; background: var(--surface-2); border-left: 1px solid var(--hair-strong); border-bottom: 1px solid var(--hair-strong); transform: rotate(45deg); }
.peek .top { display: flex; align-items: center; gap: 8px; }
.peek .top .spacer { flex: 1; }
.peek .q { white-space: pre-wrap; font-size: var(--fs); color: var(--text); line-height: 1.5; padding: 8px 10px; border-radius: 8px; background: var(--accent-soft); border: 1px solid var(--accent-line); }
/* The help: the keys in two columns, bottom right over the detail; the theme switch is its last row. */
.help { position: fixed; z-index: 70; right: 24px; bottom: 52px; width: 320px; padding: 12px 14px; border-radius: 12px; background: var(--surface-2); border: 1px solid var(--hair-strong); box-shadow: 0 24px 48px var(--shadow); display: grid; gap: 8px; animation: rise var(--t-fast) var(--std) both; }
.help[hidden] { display: none; }
.help .top { display: flex; align-items: center; }
.help .top .spacer { flex: 1; }
.help .grid { display: grid; grid-template-columns: 56px 1fr; column-gap: 12px; row-gap: 3px; align-items: baseline; font-size: var(--fs-small); color: var(--text-2); }
.help .grid kbd { font-family: var(--mono); font-size: var(--fs-mono); font-weight: 500; color: var(--text); }
.help .grid .sub { grid-column: 1 / -1; margin-top: 6px; }
.help .theme { display: flex; align-items: center; justify-content: space-between; padding-top: 8px; border-top: 1px solid var(--hair); font-size: var(--fs-small); color: var(--text-2); }
@keyframes rise { from { opacity: 0; transform: translateY(6px); } to { opacity: 1; transform: none; } }

/* The sheet: one placement's health, laid over the tasks column from the rail's right edge; nothing dims.
   Positioned in the tasks panel's grid area, it spans the board's full height and takes the column's width, at
   most 560px, so the detail stays whole; only from 901px to 1180px may it spill over the detail (see that query).
   Every placement's sheet is in the page, hidden, until the script shows one. */
.bento { position: relative; }
.bento > .sheet { grid-area: 1 / 2 / 2 / 3; position: absolute; inset: 0 auto 0 0; z-index: 50; width: 100%; max-width: 560px; background: var(--surface); border: 1px solid var(--hair-strong); border-radius: 12px; box-shadow: 0 24px 48px var(--shadow); display: flex; flex-direction: column; overflow: hidden; animation: slide var(--t-mid) var(--emph) both; }
@keyframes slide { from { opacity: 0; transform: translateX(-8px); } to { opacity: 1; transform: none; } }
.sheet .head { padding: 14px 18px 12px; border-bottom: 1px solid var(--hair); display: grid; gap: 6px; }
.sheet .head .name { display: flex; align-items: center; gap: 10px; }
.sheet .head .name .dot { margin-top: 0; }
.sheet .head h2 { font-size: calc(var(--fs) + 4px); font-weight: 500; letter-spacing: -.3px; line-height: 1.25; }
.sheet .head h2 { flex: 1; min-width: 0; }
.sheet .close, .usage .close { width: 28px; height: 28px; border-radius: 8px; border: 0; background: transparent; color: var(--text-3); font-size: 18px; line-height: 1; cursor: pointer; transition: background var(--t-fast) var(--std), color var(--t-fast) var(--std); }
.sheet .close:hover, .usage .close:hover { background: var(--wash); color: var(--text); }
.sheet .head .tele { display: flex; gap: 10px; align-items: center; font-size: var(--fs-small); color: var(--text-2); min-width: 0; }
.sheet .head .tele .line { flex: 1; min-width: 0; overflow: hidden; text-overflow: ellipsis; white-space: nowrap; }
.sheet .head .tele .ask { color: var(--accent); font-weight: 500; }
.sheet .head .tele .err { text-decoration: underline dotted var(--text-3); text-underline-offset: 3px; cursor: help; }
.sheet .head .tele .k, .sheet .head .tele .seen { color: var(--text-3); }
.sheet .head .rig { display: flex; gap: 4px; flex-wrap: wrap; align-items: center; }
.sheet .body { min-height: 0; overflow-y: auto; padding: 4px 18px 18px; display: grid; align-content: start; gap: 4px; scrollbar-width: thin; scrollbar-color: var(--hair-strong) transparent; }
.sheet section { padding: 12px 0 8px; border-bottom: 1px solid var(--hair-soft); display: grid; gap: 6px; }
.sheet section:last-child { border-bottom: 0; }
.sheet section > h3 { display: flex; align-items: baseline; gap: 10px; }
.sheet section > h3 .n { font-family: var(--mono); font-size: var(--fs-mono); font-weight: 500; color: var(--text-3); }
.sheet .none { font-size: var(--fs-small); color: var(--text-3); }
.sheet .muted { color: var(--text-3); }
/* Roles colour words, never fills. */
.role-ok { color: var(--ok); }
.role-warn { color: var(--warn); }
.role-err { color: var(--err); }
/* Checkout: label, value. */
.kv { display: grid; grid-template-columns: 84px 1fr; font-size: var(--fs-small); }
.kv > dt, .kv > dd { margin: 0; padding: 5px 0; border-bottom: 1px solid var(--hair-soft); min-width: 0; }
.kv > dt { color: var(--text-3); }
/* A value row keeps each part whole and wraps the next one under it; a part wider than the row ends in an ellipsis,
   whole in its title. An activity row does the same, its text taking the rest of a line or the next one. */
.kv > dd { display: flex; flex-wrap: wrap; gap: 0 8px; align-items: baseline; color: var(--text); }
.kv > dt:nth-last-of-type(1), .kv > dd:last-of-type { border-bottom: 0; }
.kv > dd > * { flex: none; max-width: 100%; overflow: hidden; text-overflow: ellipsis; white-space: nowrap; }
/* Subagents: a tree one level deep; a child hangs under its parent from a hairline guide. */
.counts-line { font-size: var(--fs-small); color: var(--text-2); }
.subs { display: grid; gap: 2px; }
.subs .kids { margin-left: 3px; padding-left: 16px; border-left: 1px solid var(--hair-strong); display: grid; gap: 2px; }
.subagent { display: grid; grid-template-columns: 8px auto 1fr 84px 84px; column-gap: 10px; align-items: center; padding: 5px 0; font-size: var(--fs-small); }
.subagent .dot { margin-top: 0; }
.subagent .title { font-weight: 500; color: var(--text); white-space: nowrap; }
.subagent .desc { min-width: 0; overflow: hidden; text-overflow: ellipsis; white-space: nowrap; color: var(--text-2); }
.subagent .when { font-family: var(--mono); font-size: var(--fs-mono); color: var(--text-3); white-space: nowrap; text-align: right; }
/* Activity: the last eight, oldest first; a running tool is the current row, in the text colour with the pulse dot. */
.feed { display: grid; }
.feed .item { display: grid; grid-template-columns: 8px 70px 76px 1fr; column-gap: 10px; align-items: baseline; padding: 4px 0; font-size: var(--fs-small); color: var(--text); }
.feed .item .mark { align-self: center; width: 6px; height: 6px; border-radius: 50%; }
.feed .item .mark.work { width: 8px; height: 8px; background: var(--text); animation: pulse 2s var(--std) infinite; }
.feed .item .at { font-family: var(--mono); font-size: var(--fs-mono); color: var(--text-3); }
.feed .item .kind { color: var(--text-2); }
.feed .item .what { display: flex; flex-wrap: wrap; gap: 0 8px; align-items: baseline; min-width: 0; }
.feed .item .tool { font-weight: 500; }
.feed .item .tool, .feed .item .status { max-width: 100%; overflow: hidden; text-overflow: ellipsis; white-space: nowrap; }
.feed .item .status { color: var(--text-2); }
.feed .item .status.running { color: var(--text); }
.feed .item .text { flex: 1 1 8em; min-width: 0; overflow: hidden; text-overflow: ellipsis; white-space: nowrap; color: var(--text-2); }
.feed .item.error, .feed .item.error .kind, .feed .item.error .text { color: var(--err); }
.feed .item.quiet, .feed .item.quiet .kind, .feed .item.quiet .text { color: var(--text-3); }

/* Usage (v0.13): a pop-up beside the rail, over the tasks column as the health sheet, the board in view behind it (no
   scrim); the surface, border, radius and shadow of the sheet. Its body scrolls between the head and the key line. */
.usage { position: fixed; z-index: 65; top: 62px; left: 12px; width: min(640px, calc(100vw - 24px)); max-height: calc(100vh - 62px - 46px); display: flex; flex-direction: column; background: var(--surface); border: 1px solid var(--hair-strong); border-radius: 12px; box-shadow: 0 24px 48px var(--shadow); overflow: hidden; animation: rise var(--t-fast) var(--std) both; }
.usage[hidden] { display: none; }
.usage .top { flex: none; display: flex; align-items: center; gap: 10px; padding: 8px 8px 8px 16px; border-bottom: 1px solid var(--hair); }
.usage .top .spacer { flex: 1; }
.usage .fresh { font-family: var(--mono); font-size: var(--fs-mono); color: var(--text-3); white-space: nowrap; cursor: help; }
.usage .body { min-height: 0; overflow-y: auto; padding-bottom: 8px; scrollbar-width: thin; scrollbar-color: var(--hair-strong) transparent; }
.usage .group-h { display: flex; align-items: baseline; gap: 10px; padding: 12px 10px 4px; }
.usage .group-h .n { font-family: var(--mono); font-size: var(--fs-mono); font-weight: 500; color: var(--text-3); }
/* Ledger: one six-column grid for both groups, so subscriptions and balances align: lead 84 | name | figure 64 |
   meter 140 | note 72 | when 128, at the board's row density, a hairline between accounts. */
.ledger { display: grid; }
.account + .account { border-top: 1px solid var(--hair-soft); }
.entry { display: grid; grid-template-columns: 84px minmax(96px, 1fr) 64px 140px 72px 128px; column-gap: 6px; align-items: start; padding: var(--row-pad); font-size: var(--fs-small); color: var(--text-2); }
.entry > * { min-width: 0; line-height: 18px; }
.entry > .lead { display: grid; justify-items: start; }
.entry .toggle { display: flex; gap: 5px; align-items: baseline; max-width: 100%; padding: 0; border: 0; background: none; font-weight: 500; color: var(--text); cursor: pointer; white-space: nowrap; overflow: hidden; text-overflow: ellipsis; }
.entry .toggle::before { content: "▸"; flex: none; font-family: var(--mono); font-size: var(--fs-mono); color: var(--text-3); transition: transform var(--t-fast) var(--std); }
.entry .toggle[aria-expanded="true"]::before { transform: rotate(90deg); }
.entry > .name { color: var(--text); overflow-wrap: anywhere; }
.entry > .name.muted { color: var(--text-2); cursor: help; }
.entry > .name.quiet { color: var(--text-3); }
.entry.bare > .name { grid-column: 2 / -1; }
.entry > .words { grid-column: 3 / -1; color: var(--text-2); cursor: help; overflow-wrap: anywhere; }
.entry > .figure { text-align: right; font-family: var(--mono); font-size: var(--fs-mono); font-weight: 500; color: var(--text); white-space: nowrap; font-variant-numeric: tabular-nums; }
.entry > .meter { display: flex; height: 18px; }
.entry > .note { white-space: nowrap; color: var(--text-3); }
.entry > .note.ahead { color: var(--warn); }
.entry > .when { text-align: right; font-family: var(--mono); font-size: var(--fs-mono); white-space: nowrap; font-variant-numeric: tabular-nums; color: var(--text-2); }
.entry > .when[title] { cursor: help; }
.entry > .when.quiet { color: var(--text-3); }
.entry.warn > .figure { color: var(--warn); }
.entry.err > .figure { color: var(--err); }
/* A passed reset says nothing of now: the figure and time in text-3, the meter's track alone. */
.entry.passed > .figure, .entry.passed > .when { color: var(--text-3); }
/* A stale account dims every cell but its lead, band hues with them; its status line stays at text-2. */
.account.stale .entry > :not(.lead) { opacity: .55; }
/* The note's warn hue reads strong even at .55; a stale account's note drops to text-2 with the rest. */
.account.stale .entry > .note.ahead { color: var(--text-2); }
.badge.sm { font-size: calc(var(--fs-mono) - 1.5px); padding: 1px 6px; line-height: 14px; }
.badge.at-narrow { display: none; }
.account .status { display: grid; grid-template-columns: 84px minmax(0, 1fr); column-gap: 6px; align-items: start; padding: 0 10px 8px; font-size: var(--fs-small); line-height: 18px; color: var(--text-2); overflow-wrap: anywhere; }
.account .status .mono { color: var(--text); }
/* The wide meter takes its cell; the 2px pace tick marks the elapsed share of the window. */
.meter.wide .bar { flex: 1; width: auto; }
.meter.err { color: var(--err); }
.meter.err .bar i { background: var(--err); }
.meter .bar.paced { position: relative; overflow: visible; }
.meter .bar.paced i { border-radius: 2px; }
.meter .bar .pace { position: absolute; top: -3px; bottom: -3px; width: 2px; margin-left: -1px; border-radius: 1px; background: var(--text); }
/* Details: under the account's rows, indented to the name column. */
.more { display: grid; gap: 6px; padding: 0 10px 12px calc(10px + 84px + 6px); font-size: var(--fs-small); color: var(--text-2); min-width: 0; }
.more[hidden] { display: none; }
.more .dt { display: grid; gap: 6px; min-width: 0; padding-top: 4px; }
.more h4 { display: flex; flex-wrap: wrap; align-items: baseline; gap: 2px 8px; margin: 0; font-size: var(--fs-small); font-weight: 500; color: var(--text); }
.more h4 .n { font-family: var(--mono); font-size: var(--fs-mono); font-weight: 400; color: var(--text-3); }
.more h4.kicker { margin-top: 2px; }
.pairs { display: flex; flex-wrap: wrap; gap: 2px 16px; margin: 0; }
.pairs > div { display: flex; gap: 6px; align-items: baseline; min-width: 0; }
.pairs dt { color: var(--text-3); }
.pairs dd { margin: 0; font-family: var(--mono); font-size: var(--fs-mono); color: var(--text); font-variant-numeric: tabular-nums; }
/* A table is as wide as its content and scrolls sideways in its own box, never the page. */
.scroll-x { max-width: 100%; width: fit-content; overflow-x: auto; scrollbar-width: thin; scrollbar-color: var(--hair-strong) transparent; }
table.data { width: fit-content; }
table.data td, table.data th { padding: 1px 14px 1px 0; line-height: 18px; }
.scroll-x td, .scroll-x th { white-space: nowrap; }
td.num, th.num { text-align: right; font-family: var(--mono); font-size: var(--fs-mono); font-variant-numeric: tabular-nums; }
table.data td:last-child, table.data th:last-child { text-align: left; }
table.data td.num:last-child, table.data th.num:last-child { text-align: right; }
table.data td.bar { width: 88px; padding-right: 0; }
table.data td.bar i { display: block; height: 4px; border-radius: 2px; background: var(--text-3); }
table.data tr.gap td { color: var(--text-3); }
table.data tr.all td { border-bottom: 0; }
.days { padding: 0; border: 0; background: none; color: var(--text-2); font-size: var(--fs-small); text-decoration: underline; text-decoration-color: var(--hair-strong); text-underline-offset: 3px; cursor: pointer; }

/* 901-1180px: the rail is a fixed 272px column, the tasks and detail share the rest. */
@media (min-width: 901px) and (max-width: 1180px) {
  .bento { grid-template-columns: 272px minmax(0, 4fr) minmax(0, 5fr); }
  .nav .who { max-width: 160px; }
  /* The sheet is an overlay, so it spills over the detail rather than hide its close button (design/README.md). */
  .bento > .sheet { min-width: 320px; }
}
/* 1279px and less: a card's first line holds the dot, the name (one line, ellipsized) and the meter; its status
   takes its own line under the name, then the health row with the lever, and the facts table's heads may wrap.
   The design draws the card this way from 1180px down; design/README.md says why the page starts higher. */
@media (max-width: 1279px) {
  .cards { grid-template-columns: minmax(0, 1fr); }
  .card .stats { min-width: 0; overflow: hidden; }
  .card .body { grid-template-columns: minmax(0, 1fr); }
  .card .name .key { min-width: 0; overflow: hidden; text-overflow: ellipsis; white-space: nowrap; }
  .card.idle .body { grid-template-columns: minmax(0, 1fr) auto; column-gap: 8px; }
  .card.idle .tele { display: contents; }
  .card.idle .name { grid-area: 1 / 1; }
  .card.idle .tele > .meter { grid-area: 1 / 2; align-self: center; }
  .card.idle .what { grid-area: 2 / 1 / 3 / 3; }
  .card.idle .tele > .line { grid-area: 3 / 1; font-size: var(--fs-small); color: var(--text-2); }
  .card.idle .tele > .lever { grid-area: 3 / 2; align-self: center; }
  table.rec th { white-space: normal; }
}
/* 1180px and less: facts tables become records (the detail column is too narrow for six columns from here down):
   the key cells on the first line, the rest labelled on the second. */
@media (max-width: 1180px) {
  table.rec, table.rec tbody { display: block; }
  table.rec tr:has(> th) { display: none; }
  table.rec tr { display: flex; flex-wrap: wrap; align-items: baseline; gap: 2px 12px; padding: 6px 0; border-bottom: 1px solid var(--hair-soft); }
  table.rec tr::before { content: ""; order: 1; flex: 0 0 100%; }
  table.rec td { order: 2; display: block; min-width: 0; padding: 0; border: 0; text-align: left; overflow-wrap: anywhere; }
  table.rec td.key { order: 0; }
  table.rec td[data-label]::before { content: attr(data-label) " "; color: var(--text-3); }
}
/* 900px and less: one column that scrolls as a page, in DOM order (rail, tasks, detail). */
@media (max-width: 900px) {
  html, body { height: auto; }
  body { overflow: visible; }
  #app { height: auto; min-height: 100vh; grid-template-rows: auto auto auto; }
  /* The head wraps: brand, who and the links on the first line; the chips and the tick below. */
  .nav { flex-wrap: wrap; gap: 6px 10px; padding: 10px 14px; }
  .nav .who { flex: 1 1 0; max-width: none; }
  .nav .spacer { display: none; }
  .nav nav { order: 1; }
  .nav .br { display: block; order: 2; flex: 0 0 100%; height: 0; }
  .nav .counts { order: 3; flex-wrap: wrap; margin-left: 0; }
  .nav .tick { order: 4; }
  .bento { grid-template-columns: minmax(0, 1fr); padding: 8px; }
  .bento > .agents, .bento > .tasks, .bento > .detail { grid-area: auto; }
  .panel, .scroll { overflow: visible; }
  /* The sheet, the usage and the peek take the screen's width. */
  .bento > .sheet { grid-area: auto; position: fixed; inset: 0; max-width: none; border-radius: 0; }
  .peek { left: 12px; right: 12px; width: auto; top: 120px; }
  .peek::before { display: none; }
  /* The open usage is the page: the board under it hides, and the sheet scrolls as a page. */
  .usage { position: absolute; inset: 0 0 auto 0; min-height: 100vh; width: auto; max-height: none; overflow: visible; border: 0; border-radius: 0; box-shadow: none; }
  .usage .body { overflow: visible; }
  body:has(> .usage:not([hidden])) > #app { display: none; }
  .usage .top kbd { display: none; }
  /* The key line keeps only what a tap can do. */
  .keys { padding: 8px 14px; gap: 18px; }
  .keys > span:not([data-key]) { display: none; }
  .keys > span[data-key] { cursor: pointer; padding: 4px 0; }
  /* A ledger row wraps: the lead on its own line, then the name with its figure, the meter across, the note left
     and the time right; the status line and the details drop their indent. */
  .entry { display: flex; flex-wrap: wrap; gap: 4px 10px; }
  .entry > :empty { display: none; }
  .entry > .lead { flex: 1 1 100%; display: flex; align-items: baseline; gap: 8px; }
  .entry > .name { order: 1; flex: 1 1 0; }
  .entry > .figure, .entry > .words { order: 2; }
  .entry > .meter { order: 4; flex: 1 1 100%; height: 10px; }
  .entry > .note { order: 5; }
  .entry > .when { order: 6; margin-left: auto; }
  .account .status, .more { padding-left: 10px; }
  /* The badge follows the name; the second line's lead holds nothing then. */
  .badge.at-narrow { display: inline-block; }
  .entry > .lead.badge-lead { display: none; }
  .account .status { display: block; }
  .account .status > .lead { display: none; }
}

/* The live page. A row opens its task through the link on its id, stretched
   over the row, so rows work without a script; the row shows its focus. */
.task[hidden], .peek[hidden], .bento > .sheet[hidden] { display: none; }
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
.keys > span[data-key] { cursor: pointer; }
/* A usage row and the pop-up's close button are links, so a page without a script opens and closes the pop-up
   (?usage); the script toggles it in place. */
a.acct, .usage a.close { text-decoration: none; }
.usage a.close { display: inline-grid; place-items: center; }
/* A day table's older rows show without a script; "all n days" shows while the script keeps them shut. */
table.data:has(> tbody.older:not([hidden])) tr.all { display: none; }
`;

// ---- Script: reads the rendered page and its data attributes only ----

// The page works without it. It keeps what a person is doing across
// refreshes and adds the filter, the keys, the peek, the sheet, the usage
// pop-up in place, opening a task in place, the full router log and the
// help with its theme switch.
const SCRIPT = `
const root = document.documentElement;
const $ = (selector, from = document) => from.querySelector(selector);
const $$ = (selector, from = document) => [...from.querySelectorAll(selector)];
const stored = (store, key, fallback) => {
  try { return JSON.parse(store.getItem(key)) ?? fallback; } catch { return fallback; }
};
const selected = () => $(".detail")?.dataset.task;
const narrow = matchMedia("(max-width: 900px)");

// Theme: the server paints the cookie's palette. A palette chosen on this
// device, in the help, wins and goes into both stores, so the next page
// paints it first. The cookie takes the page's directory, which is the
// board's: the page is served only there.
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

// The router log: collapsed to its newest line until r opens the whole
// block, which stays open across refreshes, on this device. The server
// renders it open, so a page without a script, which r needs, shows every
// line in the open layout; the script sets it from the stored choice at
// start and after each refresh, before the page is painted.
const logOpen = () => localStorage.getItem("router-log") === "open";
const showLog = () => $(".agents .foot")?.classList.toggle("open", logOpen());
const toggleLog = () => {
  if (!$(".agents .foot")) return false;
  if (logOpen()) localStorage.removeItem("router-log");
  else localStorage.setItem("router-log", "open");
  showLog();
  return true;
};

// Blocks a toggle opens, by data-key, on this device: an account's details
// and a day table's older rows, in the usage pop-up. The server draws them
// open, so a page without a script shows them; the script shuts each one
// not kept open, at start and after each refresh, before the page is
// painted.
const opened = () => [].concat(stored(localStorage, "router-open", []));
const showBlock = (block, open) => {
  block.hidden = !open;
  if (block.id) $$('[aria-controls="' + CSS.escape(block.id) + '"]').forEach((t) => t.setAttribute("aria-expanded", String(open)));
};
const unfold = () => {
  const open = opened();
  $$(".usage [data-key]").forEach((block) => showBlock(block, open.includes(block.dataset.key)));
};
const keepBlock = (block, open) => {
  showBlock(block, open);
  const keys = opened().filter((key) => key !== block.dataset.key);
  if (open) keys.push(block.dataset.key);
  localStorage.setItem("router-open", JSON.stringify(keys));
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

// The peek opens beside its row, above the panels; from 900px down the CSS
// places it across the screen.
const peek = () => $(".peek:not([hidden])");
const openPeek = (p) => {
  peek()?.setAttribute("hidden", "");
  p.hidden = false;
  if (narrow.matches) {
    p.style.left = p.style.top = "";
    return;
  }
  const r = p.parentElement.getBoundingClientRect();
  p.style.left = Math.max(8, Math.min(r.right + 16, innerWidth - p.offsetWidth - 8)) + "px";
  p.style.top = Math.max(8, Math.min(r.top - 8, innerHeight - p.offsetHeight - 8)) + "px";
};
const closePeek = () => {
  const p = peek();
  p.hidden = true;
  $("a.id", p.parentElement)?.focus();
};

// The sheet: one placement's health over the tasks column. Every
// placement's sheet is in the page, hidden; a card's name or the s key
// shows one by its key, esc or its close button hides it, and a refresh
// keeps it open by key while the placement is still there.
const sheet = () => $(".bento > .sheet:not([hidden])");
const sheetFor = (key, root = document) => $('.bento > .sheet[data-key="' + CSS.escape(key) + '"]', root);
// The card of a placement, by its key: indexes shift between refreshes.
const cardFor = (key) => $$(".card").find((c) => $(".name .key", c)?.textContent === key);
const closeSheet = () => {
  const s = sheet();
  if (!s) return;
  s.hidden = true;
  cardFor(s.dataset.key)?.focus();
};
const openSheet = (key) => {
  const s = sheetFor(key);
  if (!s) return false;
  if (sheet() !== s) sheet()?.setAttribute("hidden", "");
  s.hidden = false;
  return true;
};

// The usage pop-up (v0.13): a rail row or u opens it beside the rail, over
// the tasks column, moved left to stay 12px inside the viewport; from 900px
// down the CSS makes it the page. A row, u, esc, its close button or a click
// outside closes it. Opening puts the focus on an account's toggle (the
// row's, from a row), and closing gives it back.
const usage = () => $(".usage");
const usageOpen = () => Boolean(usage() && !usage().hidden);
const place = () => {
  const u = usage();
  if (!u) return;
  if (u.hidden || narrow.matches) {
    u.style.left = "";
    return;
  }
  const rail = $(".agents")?.getBoundingClientRect().right ?? 0;
  u.style.left = Math.max(12, Math.min(rail + 8, innerWidth - 12 - u.offsetWidth)) + "px";
};
const syncUsage = () => {
  $$(".acct").forEach((a) => a.setAttribute("aria-expanded", String(usageOpen())));
  place();
};
// The element that opened the pop-up, and how to find it again when a
// refresh has replaced it: a row by its task, else by its tag and path.
let usageFrom = null;
const finder = (el) => {
  const task = el?.matches(".task a.id") && el.closest(".task").dataset.task;
  if (task) return '.task[data-task="' + CSS.escape(task) + '"] a.id';
  return el?.dataset?.path ? el.localName + '[data-path="' + CSS.escape(el.dataset.path) + '"]' : null;
};
const setUsage = (open, from = null) => {
  const u = usage();
  if (!u) return false;
  const was = usageOpen();
  u.hidden = !open;
  syncUsage();
  if (open && !was) {
    const el = from ?? document.activeElement;
    usageFrom = { el, find: finder(el) };
    const toggle = (from && $('.toggle[data-path="' + CSS.escape(from.dataset.path + ".name") + '"]', u)) || $(".toggle", u);
    toggle?.focus({ preventScroll: true });
  } else if (!open && was) {
    const to = usageFrom?.el.isConnected ? usageFrom.el : usageFrom?.find && $(usageFrom.find);
    const lost = u.contains(document.activeElement) || document.activeElement === document.body;
    if (lost && to) to.focus();
    else if (u.contains(document.activeElement)) document.activeElement.blur();
    usageFrom = null;
  }
  return true;
};
addEventListener("resize", place);

// Every few seconds the page fetches itself for the selected task and swaps
// the nav counts and tick, every panel the page marks with data-part, the
// sheets and the usage pop-up. A panel or an open overlay stays as it is
// while it holds the focus (unless the focus is on a row, a card, a usage
// row or an account's toggle that the new page has too) or a text
// selection, so what is being typed, read or copied is not pulled away.
// Opening a task in place is the same fetch, which swaps the detail
// whatever it holds; a later open supersedes an earlier one still on its
// way, and no periodic fetch starts while an open is on its way, so the
// open lands and its address and focus follow it. The notice is outside
// the swapped parts.
const parts = () => [".nav .counts", ".nav .tick", ...$$("[data-part]").map((el) => '[data-part="' + CSS.escape(el.dataset.part) + '"]')];
let fetches = 0;
// The open on its way, until its fetch settles: its task, the hash its link
// names, and whether it adds its link to the history (an open the viewer
// started) or finds the address set (Back, Forward, the task an action
// returns to).
let opening = null;
// How long an open waits for its page before it follows its link.
const OPEN_WAIT_MS = 12000;
// An open that cannot fetch follows its link instead. A link that differs
// from the address only by its hash (or not at all, as after Back) would
// not load the page, so the address takes the link and the page loads
// again.
const follow = (open, query) => {
  const link = new URL((query || location.pathname) + open.hash, location.href);
  if (link.pathname + link.search !== location.pathname + location.search) return location.assign(link);
  if (open.push && link.hash !== location.hash) history.pushState(null, "", link);
  else history.replaceState(null, "", link);
  location.reload();
};
const refresh = async (open = null) => {
  if (!open && (opening || document.hidden)) return;
  const id = open ? open.id : selected();
  const mine = ++fetches;
  const query = id ? "?task=" + encodeURIComponent(id) : "";
  let doc = null;
  try {
    const r = await fetch(location.pathname + query, { cache: "no-store", headers: { accept: "text/html" }, signal: open ? AbortSignal.timeout(OPEN_WAIT_MS) : null });
    if (!r.ok) throw new Error(r.statusText);
    doc = new DOMParser().parseFromString(await r.text(), "text/html");
  } catch {
    doc = null;
  }
  if (mine !== fetches) return;
  // The open has settled, so the timed refreshes go on whatever it found.
  if (open) opening = null;
  if (!doc) {
    if (open) follow(open, query);
    return;
  }
  const focus = document.activeElement;
  const sel = document.getSelection();
  const range = sel && !sel.isCollapsed && sel.rangeCount ? sel.getRangeAt(0) : null;
  // Whether a part holds a selection (either end, or the span between).
  const selectedIn = (el) => range !== null && range.intersectsNode(el);
  const row = focus?.matches(".task a.id") ? focus.closest(".task").dataset.task : null;
  const card = focus?.matches(".card") ? focus.dataset.path : null;
  const acct = focus?.matches(".acct") ? focus.dataset.path : null;
  const toggle = focus?.matches(".usage .toggle") ? focus.getAttribute("aria-controls") : null;
  const kept = row || card || acct || toggle;
  const peeked = peek() && '.task[data-task="' + CSS.escape(peek().parentElement.dataset.task) + '"] .peek[data-path="' + CSS.escape(peek().dataset.path) + '"]';
  const shown = sheet()?.dataset.key ?? "";
  const words = $(".filter input")?.value ?? "";
  for (const part of parts()) {
    const old = $(part);
    const next = $(part, doc);
    const swap = open && part === '[data-part="detail"]' && old?.dataset.task !== next?.dataset.task;
    if (!old || !next || (!swap && ((old.contains(focus) && !kept) || selectedIn(old)))) continue;
    const top = $(".scroll", old)?.scrollTop ?? 0;
    old.replaceWith(next);
    const scroll = $(".scroll", next);
    if (scroll) scroll.scrollTop = swap ? 0 : top;
  }
  // The hidden sheets are swapped whole; the open one keeps its element,
  // its scroll and its slide, and takes the new head and body, unless it
  // holds the focus or a selection. It goes when its placement is gone.
  const showing = sheet();
  $$(".bento > .sheet").forEach((s) => s !== showing && s.remove());
  $$(".bento > .sheet", doc).forEach((s) => s.dataset.key !== shown && $(".bento").append(s));
  const fresh = shown && sheetFor(shown, doc);
  if (showing && !fresh) showing.remove();
  else if (showing && fresh && !showing.contains(focus) && !selectedIn(showing)) {
    const top = $(".body", showing).scrollTop;
    showing.dataset.path = fresh.dataset.path;
    showing.replaceChildren(...fresh.children);
    $(".body", showing).scrollTop = top;
  }
  // The pop-up likewise: shut, it is swapped whole; open, it keeps its
  // element, its scroll and its place, and takes the new content. It comes
  // and goes with the usage section.
  const u = usage();
  const next = $(".usage", doc);
  if (!u && next) $(".help").before(next);
  else if (u && !next) u.remove();
  else if (u?.hidden) u.replaceWith(next);
  else if (u && ((!u.contains(focus) || toggle) && !selectedIn(u))) {
    const top = $(".body", u).scrollTop;
    u.replaceChildren(...next.children);
    $(".body", u).scrollTop = top;
  }
  if (row) $('.task[data-task="' + CSS.escape(row) + '"] a.id')?.focus();
  if (card) $('.card[data-path="' + CSS.escape(card) + '"]')?.focus();
  if (acct) $('.acct[data-path="' + CSS.escape(acct) + '"]')?.focus();
  if (toggle) $('.usage .toggle[aria-controls="' + CSS.escape(toggle) + '"]')?.focus();
  if (peeked && !peek() && $(peeked)) openPeek($(peeked));
  const input = $(".filter input");
  if (input && input !== focus) input.value = words;
  // The address follows: an open the viewer started adds its link to the
  // history, as following it would (a link to the address itself adds
  // nothing). When the page shows another task than the address names (the
  // bare page, a task that has gone), the address takes it, keeping its
  // notice and hash.
  if (open?.push && query + open.hash !== location.search + location.hash) history.pushState(null, "", (query || location.pathname) + open.hash);
  const here = new URLSearchParams(location.search);
  if (selected() && selected() !== here.get("task")) {
    here.set("task", selected());
    history.replaceState(null, "", "?" + here + location.hash);
  }
  // An Answer lever's open goes to its form.
  const target = open?.hash && document.getElementById(decodeURIComponent(open.hash.slice(1)));
  if (target) {
    target.scrollIntoView({ block: "nearest" });
    $("textarea", target)?.focus();
  }
  fold();
  showLog();
  unfold();
  syncUsage();
  filter();
  drafts();
};
setInterval(() => refresh(), Number($("#app").dataset.refresh) * 1000);

// Opening a task in place (v0.13): a link to a task (a row's id, a card's
// task, the peek's Open task, an Answer lever) marks its row at once, then
// swaps in the page fetched for the task; an Answer lever then goes to its
// form. Back and Forward open the task their entry names. The link still
// works without the script, and a modified click keeps the browser's own.
const openTask = (id, hash = "", push = true) => {
  const row = id && $('.task[data-task="' + CSS.escape(id) + '"]');
  if (row) {
    $$(".task[aria-current]").forEach((r) => {
      r.classList.remove("selected");
      r.removeAttribute("aria-current");
    });
    row.classList.add("selected");
    row.setAttribute("aria-current", "true");
  }
  opening = { id, hash, push };
  return refresh(opening);
};
addEventListener("popstate", () => {
  const id = new URLSearchParams(location.search).get("task");
  if (id !== selected()) openTask(id, location.hash, false);
});
const plain = (e) => e.button === 0 && !e.metaKey && !e.ctrlKey && !e.shiftKey && !e.altKey;

document.addEventListener("click", (e) => {
  if (e.defaultPrevented || !plain(e)) return;
  const key = e.target.closest(".card .name .key");
  if (key) return openSheet(key.textContent);
  if (e.target.closest(".sheet .close")) return closeSheet();
  // A lever in the sheet leaves the page; the sheet comes back with it.
  if (e.target.closest(".sheet a:not([href^='?task='])")) sessionStorage.setItem("router-sheet", sheet()?.dataset.key ?? "");
  const acct = e.target.closest(".acct");
  if (acct) {
    e.preventDefault();
    return setUsage(!usageOpen(), acct);
  }
  if (e.target.closest(".usage .close")) {
    e.preventDefault();
    return setUsage(false);
  }
  const toggle = e.target.closest(".usage .toggle");
  const block = toggle && document.getElementById(toggle.getAttribute("aria-controls"));
  if (block) return keepBlock(block, block.hidden);
  const days = e.target.closest(".usage .days");
  const older = days && $(".older", days.closest("table"));
  if (older) return keepBlock(older, true);
  if (usageOpen() && !e.target.closest(".usage")) setUsage(false);
  const link = e.target.closest('a[href^="?task="]');
  if (link) {
    e.preventDefault();
    const url = new URL(link.href);
    peek()?.setAttribute("hidden", "");
    openTask(url.searchParams.get("task"), url.hash);
  }
});

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
  sessionStorage.setItem("router-sheet", sheet()?.dataset.key ?? "");
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

// The keys the footer and the help name (v0.13). Each returns whether it
// did something.
const typing = (el) => el?.matches("input, textarea, select");
// ↑ ↓ move between the rows from a row, a card or nothing in particular;
// on a button, a link or a scrolling table they are the browser's.
const move = (step, el) => {
  if (el && el !== document.body && !el.matches(".task a.id, .card")) return false;
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
// The focused agent's card, the open sheet's, or the card of the agent
// working on the selected task.
const agentCard = (el) =>
  el?.closest(".card") ??
  (sheet() && cardFor(sheet().dataset.key)) ??
  $$(".card").find((c) => $("a.id", c)?.textContent === selected());
// ↵ or →: the focused row's task, or the focused card's sheet.
const openKey = (row, el) => {
  if (row) {
    peek()?.setAttribute("hidden", "");
    openTask(row.dataset.task);
    return true;
  }
  const key = el?.matches(".card") && $(".name .key", el)?.textContent;
  return key ? openSheet(key) : false;
};
// ← or esc: close the help, then the usage, then the peek, then the sheet.
const back = () => {
  if (!$(".help").hidden) $(".help").hidden = true;
  else if (usageOpen()) setUsage(false);
  else if (peek()) closePeek();
  else if (sheet()) closeSheet();
  else return false;
  return true;
};
// In the usage pop-up: ↑ ↓ move between the accounts, → or ↵ open the
// focused account's details, ← closes them, or the pop-up when they are
// shut.
const USAGE_KEYS = ["ArrowUp", "ArrowDown", "ArrowLeft", "ArrowRight", "Enter"];
const usageKey = (key, el) => {
  const toggles = $$(".usage .toggle");
  const at = toggles.indexOf(el);
  const block = at >= 0 && document.getElementById(el.getAttribute("aria-controls"));
  if (key === "ArrowUp" || key === "ArrowDown") {
    const next = at < 0 ? toggles[0] : toggles[Math.min(toggles.length - 1, Math.max(0, at + (key === "ArrowDown" ? 1 : -1)))];
    next?.focus();
    return Boolean(next);
  }
  if (key === "ArrowLeft") {
    if (block && !block.hidden) keepBlock(block, false);
    else setUsage(false);
    return true;
  }
  if (!block) return false;
  keepBlock(block, true);
  return true;
};
const KEYS = {
  ArrowDown: (row, el) => move(1, el),
  ArrowUp: (row, el) => move(-1, el),
  Enter: openKey,
  ArrowRight: openKey,
  ArrowLeft: back,
  " ": (row) => {
    const p = row && $(".peek", row);
    if (!p) return false;
    if (p === peek()) closePeek(); else openPeek(p);
    return true;
  },
  a: () => {
    const field = peek() ? $("textarea", peek()) : $(".detail form[id^='answer-'] textarea");
    field?.focus();
    return Boolean(field);
  },
  c: () => press($(".detail .actions button")),
  // The focused agent, or the one working on the selected task.
  p: (row, el) => press(agentCard(el) && $("button[data-path$='.hold']", agentCard(el))),
  s: (row, el) => {
    const key = agentCard(el) && $(".name .key", agentCard(el))?.textContent;
    if (!key) return false;
    if (sheet()?.dataset.key === key) closeSheet(); else openSheet(key);
    return true;
  },
  r: toggleLog,
  u: () => setUsage(!usageOpen()),
  "/": () => {
    const input = $(".filter input");
    input?.focus();
    return Boolean(input);
  },
  "?": () => { $(".help").hidden = !$(".help").hidden; return true; },
};
// A screen without a keyboard still opens the log and the help, where the
// theme switch is: the footer's r and ? take a tap.
document.addEventListener("click", (e) => {
  const key = e.target.closest(".keys > span[data-key]")?.dataset.key;
  if (key) KEYS[key]();
});
document.addEventListener("keydown", (e) => {
  // A key that ends an IME composition (a Hangul syllable, a kana
  // conversion) belongs to the text; Safari marks it only by keyCode 229.
  if (e.isComposing || e.keyCode === 229) return;
  const el = document.activeElement;
  if (e.key === "Escape") {
    if (!back() && typing(el)) el.blur();
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
  // ⇧ with an arrow or ↵ is the browser's (selecting, a new window).
  if (e.shiftKey && (e.key.startsWith("Arrow") || e.key === "Enter")) return;
  // While the pop-up is open, and the help is not over it, its arrows and
  // ↵ move between its accounts from a toggle, the pop-up or nothing in
  // particular.
  const inUsage = !el || el === document.body || el === usage() || el.matches(".usage .toggle");
  if (usageOpen() && $(".help").hidden && USAGE_KEYS.includes(e.key) && inUsage) {
    if (usageKey(e.key, el)) e.preventDefault();
    return;
  }
  const row = el?.matches(".task a.id") ? el.closest(".task") : null;
  if (KEYS[e.key]?.(row, el)) e.preventDefault();
});

// An action returns to the bare page with its notice; reopen the task it
// was taken on. A page drawn with the pop-up open (?usage, the link a page
// without a script follows) keeps it open and drops the parameter.
const returned = sessionStorage.getItem("router-task");
sessionStorage.removeItem("router-task");
const sheetBack = sessionStorage.getItem("router-sheet");
sessionStorage.removeItem("router-sheet");
if (sheetBack) openSheet(sheetBack);
const params = new URLSearchParams(location.search);
if (params.has("usage")) {
  params.delete("usage");
  history.replaceState(null, "", location.pathname + (params.toString() ? "?" + params : ""));
}
if (returned && params.has("notice") && !params.has("task") && returned !== selected() && $('.task[data-task="' + CSS.escape(returned) + '"]')) {
  history.replaceState(null, "", "?task=" + encodeURIComponent(returned) + "&notice=" + encodeURIComponent(params.get("notice")));
  openTask(returned, "", false);
}
paint();
fold();
showLog();
unfold();
syncUsage();
filter();
drafts();
`;
