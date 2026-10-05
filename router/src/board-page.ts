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
//
// renderBoard reads the model for the viewer once (board-context.ts) and
// assembles the page from its columns: the agents (board-agents.ts), the
// tasks and the selected task (board-tasks.ts) and usage (board-usage.ts),
// written with the shared parts (board-parts.ts). The CSS and the script
// are in board-style.ts and board-script.ts.
import type { BoardModel } from "./board.ts";
import { agentsPanel, placementSheets } from "./board-agents.ts";
import { pageContext } from "./board-context.ts";
import { chip, esc, href, noun, slot, stamp, time } from "./board-parts.ts";
import { SCRIPT } from "./board-script.ts";
import { STYLE } from "./board-style.ts";
import { taskDetail, tasksPanel } from "./board-tasks.ts";
import { usageParts } from "./board-usage.ts";

// The nav tick's title: when the model was built and the telemetry taken,
// to the second, and the contract (v0.12). The design gives the clocks
// alone; a telemetry file can be a day old.
const built = (model: BoardModel): string =>
  `built ${stamp(model.at)} · ${model.telemetryAt ? `telemetry ${stamp(model.telemetryAt)}` : "no telemetry"} · ${model.version}`;

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

// The page for `model` as its actor sees it. Pure: the model, the viewer in
// it and the options decide every byte.
export function renderBoard(
  model: BoardModel,
  options: RenderOptions = {},
): string {
  const refreshSeconds = options.refreshSeconds ?? 10;
  const page = pageContext(model, options.task);
  const { actor, at, needs, flight, selected } = page;

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
${agentsPanel(page, drawnUsage?.rail ?? "")}
${tasksPanel(page)}
${taskDetail(page)}
${placementSheets(page)}
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
