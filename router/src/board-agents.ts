// The agents column of the board page: a card per placement in the rail,
// with the usage rail and the router log under them, and each placement's
// health sheet.
import type { PlacementView } from "./board.ts";
import type { PageContext } from "./board-context.ts";
import {
  age,
  answeredQuestion,
  clock,
  CONTEXT_WARN,
  count,
  dated,
  esc,
  form,
  fullId,
  hms,
  href,
  label,
  meter,
  percent,
  shortId,
  slot,
  stale,
  thousands,
} from "./board-parts.ts";
import type { AgentSnapshot, AgentStatus, Checkout } from "./telemetry.ts";

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

// A held placement stays held while its session runs; one that runs a
// turn with no delivery and no hold is busy (v0.12).
const dotOf = ({ asksViewer }: PageContext, p: PlacementView): Dot => {
  const d = p.delivery;
  if (d) return d.question ? (asksViewer(d.id) ? "ask" : "wait") : "work";
  if (p.hold) return "held";
  if (p.agent?.status === "running") return "busy";
  return p.ready ? "ready" : "off";
};
const rank = (page: PageContext, p: PlacementView): number =>
  RANK[dotOf(page, p)];

// A card: its dot, then the body's lines; `idle` is the collapsed card of
// a session with no delivery. The busy dot also reads the agent's status.
const cardShell = (path: string, cls: string, dot: Dot, body: string): string =>
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
  { at, times, ago }: PageContext,
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
    else if (a.status === "idle" && a.attention === "finished" && a.attentionAt)
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
const leversOf = (
  { actor, answers }: PageContext,
  p: PlacementView,
  path: string,
): string[] => {
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
const checkoutSection = (
  { at, ago }: PageContext,
  ap: string,
  c: Checkout | null,
): string => {
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
        sep + slot(`${pp}.review`, esc(REVIEW[pr.review] ?? label(pr.review)));
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
const subagentsSection = (
  { at, ago }: PageContext,
  ap: string,
  a: AgentSnapshot | null,
): string => {
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
    const kids = running.flatMap((y, j) => (y.parent === x.id ? [row(j)] : []));
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
const sheetOf = (page: PageContext, p: PlacementView, i: number): string => {
  const path = `placements[${i}]`;
  const a = p.agent;
  const ap = `${path}.agent`;
  const { status, seen, meter } = health(page, path, p);
  const line = seen ? `${status} · ${seen}` : status;
  return `<aside class="sheet" role="dialog" aria-label="${esc(p.key)}" data-path="${path}" data-key="${esc(p.key)}" hidden>
  <div class="head">
    <div class="name"><span class="dot ${dotOf(page, p)}" data-path="${path}.delivery.latest.kind, ${path}.ready, ${path}.hold"></span><h2>${slot(`${path}.key`, esc(p.key))}</h2>${meter}<button class="close" type="button" aria-label="Close" title="Close (esc)">×</button></div>
    <div class="tele"><span class="line">${line}</span>${lever(leversOf(page, p, path))}</div>
    <div class="rig">${harnessTags(path, a)}${sessionTags(p, path)}</div>
  </div>
  <div class="body">
${checkoutSection(page, ap, a?.checkout ?? null)}
${subagentsSection(page, ap, a)}
${activitySection(ap, a)}
  </div>
</aside>`;
};

const card = (page: PageContext, p: PlacementView, i: number): string => {
  const { at, times, ago } = page;
  const path = `placements[${i}]`;
  const d = p.delivery;
  const latest = d?.latest ?? null;
  const dot = dotOf(page, p);
  const asks = dot === "ask";
  const levers = leversOf(page, p, path);
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
  const { status, seen, meter } = health(page, path, p);
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
export function agentsPanel(page: PageContext, usageRail: string): string {
  const { model } = page;
  const agentCount = model.placements.length;
  return `<aside class="panel agents" aria-label="Agents" data-part="agents">
  <h2 class="col-h"><span class="kicker">Agents</span>${slot("count(placements)", count(agentCount, "placement"), "n")}</h2>
  <div class="scroll"><div class="cards">
${model.placements
  .map((p, i): [PlacementView, number] => [p, i])
  .sort(([a], [b]) => rank(page, a) - rank(page, b))
  .map(([p, i]) => card(page, p, i))
  .join("\n")}
  </div></div>
${usageRail}  <div class="foot open"><div><span class="kicker">Router log</span> · ${slot("count(log)", `last ${model.log.length}`)} · <kbd class="k">r</kbd></div><div class="lines"><div class="tail">${model.log.map((e, i) => `<div data-path="log[${i}]"><b>${esc(e.actor)}</b> ${esc(e.text)}</div>`).join("")}</div></div></div>
</aside>`;
}

// Every placement's sheet, hidden until the script opens one.
export function placementSheets(page: PageContext): string {
  return page.model.placements.map((p, i) => sheetOf(page, p, i)).join("\n");
}
