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
import type { Judgment, StuckReason } from "./types.ts";
import { pageContext, type NeedsItem } from "./board-context.ts";
import {
  age,
  answeredQuestion,
  clock,
  chip,
  CONTEXT_WARN,
  count,
  DASH,
  dated,
  esc,
  form,
  fullId,
  hms,
  href,
  label,
  left,
  meter,
  noun,
  percent,
  shortId,
  slot,
  stale,
  staleTask,
  stamp,
  thousands,
  time,
  when,
} from "./board-parts.ts";
import { SCRIPT } from "./board-script.ts";
import { usageParts } from "./board-usage.ts";
import { STYLE } from "./board-style.ts";

// ---- Formats: the generator's helpers over the same fields ----

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

// A task's first line, for the detail title: the design sized the title for
// the sample's short texts, and a real request runs to pages. The full text
// is in the transcript, and in the title attribute.
const headline = (text: string): string =>
  text
    .split(/\r?\n/)
    .map((line) => line.trim())
    .find((line) => line) ?? text;

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
    answers,
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
${drawnUsage?.rail ?? ""}  <div class="foot open"><div><span class="kicker">Router log</span> · ${slot("count(log)", `last ${model.log.length}`)} · <kbd class="k">r</kbd></div><div class="lines"><div class="tail">${model.log.map((e, i) => `<div data-path="log[${i}]"><b>${esc(e.actor)}</b> ${esc(e.text)}</div>`).join("")}</div></div></div>
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
${drawnUsage ? `${drawnUsage.popup}\n` : ""}<div class="help" role="dialog" aria-label="Keys" hidden>
  <div class="top"><span class="kicker">Keys</span><span class="spacer"></span><kbd class="k">?</kbd></div>
  <div class="grid">${keyRows(helpKeys)}${usage ? `<span class="sub kicker">In usage</span>${keyRows(HELP_USAGE_KEYS)}` : ""}</div>
  <div class="theme"><span>theme</span><span class="themes" role="group" aria-label="Theme">${THEMES.map((name) => `<button type="button" data-theme="${name}"${name === theme ? ' class="on" aria-pressed="true"' : ' aria-pressed="false"'}>${THEME_NAMES[name]}</button>`).join("")}</span></div>
</div>
<script>${SCRIPT}</script>
</body></html>
`;
}
