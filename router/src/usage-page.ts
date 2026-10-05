// The Usage view of the router page: this host's accounts as the board
// model's `usage` carries them (usage.ts), on its own route beside the
// board. It is drawn in the board page's frame, with the same head, tokens,
// themes, help and script; what it adds is made of the generic parts in the
// page's CSS (the ledger's rows, the wide meter with its pace tick, pairs,
// the disclosure, the sideways-scrolling table, the head's chips). A first
// cut, which the design refines in v0.13. Pure: the model and the options
// decide every byte. Every slot names the model path it reads, as on the
// board.
//
// Subscriptions: one row per quota window, with the share used, a meter
// with a pace tick, the time to its reset and what is left; colour only in
// the 75 and 90 bands and above pace. Balances: one row per API account,
// the balance leading, neutral. An account says how fresh it is only when
// it is not current, and names what failed. Absent stays a dash, never 0.
import type { BoardModel } from "./board.ts";
import {
  age,
  chip,
  count,
  dated,
  DASH,
  esc,
  frame,
  head,
  slot,
  span,
  stamp,
  thousands,
  themeOf,
  time,
} from "./board-page.ts";
import type {
  AccountView,
  DataTable,
  DetailView,
  Metric,
  WindowView,
} from "./usage.ts";

export type UsageOptions = {
  refreshSeconds?: number;
  // The palette, from the router-theme cookie.
  theme?: string | null;
};

// pace(w, at): how much of the window has passed, as a percentage, and
// whether use runs ahead of it by more than two points; null for a window
// whose length or reset is unknown, or whose reset has passed.
export const pace = (
  w: Pick<WindowView, "minutes" | "resetsAt" | "usedPercent">,
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

// band(used): warn from 75%, err from 90%, else nothing.
export const band = (used: number): "" | "warn" | "err" =>
  used >= 90 ? "err" : used >= 75 ? "warn" : "";

const money = (value: number, currency: string): string =>
  new Intl.NumberFormat("en-US", {
    style: "currency",
    currency,
    currencyDisplay: currency === "USD" ? "narrowSymbol" : "symbol",
    minimumFractionDigits: 2,
    // A sub-cent amount keeps its precision; anything else reads as cents.
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
  if (unit === "USD" || unit === "CNY") return money(value, unit);
  if (!unit || unit === "number") return thousands(value);
  return `${thousands(value)} ${value === 1 && unit.endsWith("s") ? unit.slice(0, -1) : unit}`;
};

// A window's label without the word "window".
const windowName = (label: string): string => label.replace(/ window$/, "");

const pct = (n: number): string => `${Math.round(n)}%`;

// The figures a balance row leads with or shows beside it; the rest go to
// the row's pairs.
const BALANCE = ["Account balance", "Balance"];
const KEY = ["Key remaining", "Key limit"];

// Day-keyed tables show their latest sixty days; gaps stay gaps.
const DAYS_SHOWN = 60;

export function renderUsage(
  model: BoardModel,
  options: UsageOptions = {},
): string {
  const { at } = model;
  const usage = model.usage;
  const refreshSeconds = options.refreshSeconds ?? 10;
  const accounts = (usage?.accounts ?? []).map((a, i) => ({
    a,
    path: `usage.accounts[${i}]`,
  }));
  const subscriptions = accounts.filter(({ a }) => a.kind === "subscription");
  const balances = accounts.filter(({ a }) => a.kind === "api");

  // ---- Head ----

  // The worst subscription window, then how many accounts are stale,
  // unavailable or still being read; the board's chips stay on the board.
  const windows = subscriptions.flatMap(({ a, path }) =>
    (a.reading?.windows ?? []).map((w, k) => ({
      a,
      w,
      path: `${path}.reading.windows[${k}]`,
    })),
  );
  const worst = windows.reduce<(typeof windows)[number] | null>(
    (top, x) => (!top || x.w.usedPercent > top.w.usedPercent ? x : top),
    null,
  );
  const tally = (status: AccountView["status"]): number =>
    accounts.filter(({ a }) => a.status === status).length;
  const chips = [
    worst
      ? chip(
          "max(usage.accounts[].reading.windows[].usedPercent)",
          `<b>${pct(worst.w.usedPercent)}</b> ${esc(worst.a.name)} ${esc(windowName(worst.w.label))}`,
          band(worst.w.usedPercent),
        )
      : "",
    ...(
      [
        ["stale", "stale"],
        ["unavailable", "unavailable"],
        ["loading", "reading"],
      ] as const
    ).map(([status, words]) => {
      const n = tally(status);
      return n
        ? chip(
            `count(usage.accounts[].status=${status})`,
            `<b>${n}</b> ${words}`,
          )
        : "";
    }),
  ].join("");
  // The head's freshness line: when the store last read, and how often.
  const tick = usage
    ? slot(
        "time(usage.at), usage.every",
        usage.at
          ? `read ${time(usage.at)} · every ${span(usage.every * 1000)}`
          : "not read yet",
        "tick",
        "span",
        ` title="${esc(`${usage.at ? `usage read ${stamp(usage.at)}` : "usage not read yet"} · every ${usage.every}s · built ${stamp(at)} · ${model.version}`)}"`,
      )
    : slot("usage", "usage off", "tick");

  // ---- Parts of an account ----

  // The account's freshness, only when it is not current: a badge with the
  // reading's age, then the failure and the notice in the router's words.
  const state = (a: AccountView, path: string): string => {
    const parts: string[] = [];
    let badge = "";
    const r = a.reading;
    // While the first read runs, the row already says so.
    if (a.status !== "ready" && a.status !== "loading") {
      const words = !r
        ? "not read"
        : a.status === "stale"
          ? "stale"
          : "unavailable";
      const when =
        a.status === "stale" && r
          ? slot(
              `age(${path}.reading.observedAt, at)`,
              `last reading ${age(r.observedAt, at)} ago`,
              "",
              "span",
              dated(r.observedAt),
            )
          : a.checkedAt
            ? slot(
                `age(${path}.checkedAt, at)`,
                `checked ${age(a.checkedAt, at)} ago`,
                "",
                "span",
                dated(a.checkedAt),
              )
            : "";
      badge = slot(`${path}.status`, words, "badge");
      if (when) parts.push(when);
    }
    if (a.error) parts.push(slot(`${path}.error`, esc(a.error)));
    if (r?.notice) parts.push(slot(`${path}.reading.notice`, esc(r.notice)));
    return badge || parts.length ? `<p>${badge}${parts.join(" · ")}</p>` : "";
  };
  const pairs = (items: { path: string; m: Metric }[]): string =>
    items.length
      ? `<dl class="pairs">${items.map(({ path, m }) => `<div data-path="${esc(path)}"><dt>${esc(m.label)}</dt><dd>${esc(amount(m.value, m.unit))}</dd></div>`).join("")}</dl>`
      : "";
  const table = (path: string, t: DataTable): string => {
    let rows = t.rows;
    let cut = "";
    if (t.columns.some((c) => c.key === "date")) {
      const days = [...new Set(rows.map((r) => String(r.date)))]
        .sort()
        .reverse();
      if (days.length > DAYS_SHOWN) {
        const kept = new Set(days.slice(0, DAYS_SHOWN));
        rows = rows.filter((r) => kept.has(String(r.date)));
        cut = `latest ${DAYS_SHOWN} of ${days.length} days`;
      }
    }
    const cls = (format: string | null): string =>
      format ? ' class="num"' : "";
    const body = rows.length
      ? `<div class="scroll-x"><table><tr>${t.columns.map((c) => `<th${cls(c.format)}>${esc(c.label)}</th>`).join("")}</tr>${rows.map((r) => `<tr>${t.columns.map((c) => `<td${cls(c.format)}>${esc(amount(r[c.key], c.format === "USD" ? "USD" : null))}</td>`).join("")}</tr>`).join("")}</table></div>`
      : `<p class="hint">No rows reported.</p>`;
    return `<h4 class="kicker" data-path="${esc(path)}">${esc(t.title)}${cut ? `<span class="n">${cut}</span>` : ""}</h4>${body}`;
  };
  // A detail behind its disclosure, keyed by account and title so the
  // script keeps it open across refreshes.
  const detail = (a: AccountView, d: DetailView, path: string): string => {
    const read = `${d.status === "stale" ? "last reading" : "read"} ${age(d.observedAt, at)} ago`;
    const meta = [
      d.throughDate ? `through ${esc(d.throughDate)}` : "",
      slot(
        `age(${path}.observedAt, at)`,
        read,
        "",
        "span",
        dated(d.observedAt),
      ),
    ].filter(Boolean);
    return `<details class="disclosure" data-key="${esc(`${a.id}/${d.title}`)}" data-path="${path}">
      <summary>${slot(`${path}.title`, esc(d.title))}<span class="n">${meta.join(" · ")}</span>${d.status === "stale" ? slot(`${path}.status`, "stale", "badge") : ""}</summary>
      <div class="body">${pairs(d.metrics.map((m, k) => ({ path: `${path}.metrics[${k}]`, m })))}${d.tables.map((t, k) => table(`${path}.tables[${k}]`, t)).join("")}${d.notice ? slot(`${path}.notice`, esc(d.notice), "hint", "p") : ""}</div>
    </details>`;
  };
  const more = (
    a: AccountView,
    path: string,
    metrics: { path: string; m: Metric }[],
  ): string => {
    const r = a.reading;
    const inner =
      state(a, path) +
      pairs(metrics) +
      (r?.details ?? [])
        .map((d, k) => detail(a, d, `${path}.reading.details[${k}]`))
        .join("");
    return inner ? `<div class="more" data-path="${path}">${inner}</div>` : "";
  };
  // The lead: the account's name, linked to the provider's own usage page.
  const lead = (a: AccountView, path: string): string =>
    slot(
      `${path}.name, ${path}.url`,
      esc(a.name),
      "lead",
      "a",
      ` href="${esc(a.url)}" target="_blank" rel="noopener noreferrer" title="${esc(`${a.name}'s usage page`)}"`,
    );
  // A row with nothing to measure: the account and why.
  const bare = (a: AccountView, path: string, words: string): string =>
    `<div class="entry first" data-path="${path}">${lead(a, path)}${slot(`${path}.reading`, words, "name")}</div>`;
  const nothing = (a: AccountView): string =>
    a.status === "loading" ? "Reading…" : "No current reading";
  const metricsOf = (a: AccountView, path: string, skip: string[] = []) =>
    (a.reading?.metrics ?? []).flatMap((m, k) =>
      skip.includes(m.label)
        ? []
        : [{ path: `${path}.reading.metrics[${k}]`, m }],
    );
  const meter = (used: number, cls: string, p: ReturnType<typeof pace>) =>
    `<span class="meter wide${cls ? ` ${cls}` : ""}"${p ? ` title="${Math.round(p.elapsed)}% of the window has passed"` : ""}><span class="bar${p ? " paced" : ""}"><i style="width: ${Math.min(100, Math.max(0, used))}%"></i>${p ? `<b class="pace" style="left: ${p.elapsed.toFixed(1)}%"></b>` : ""}</span></span>`;

  // ---- Subscriptions ----

  // One row per window: the account (on its first row), the window, the
  // share used, the meter with its pace tick, ahead of pace or not, the
  // reset and what is left.
  const subscription = (a: AccountView, path: string): string => {
    const r = a.reading;
    const shown = r && r.allowance !== "unavailable" ? r.windows : [];
    const rows = shown.length
      ? shown.map((w, k) => {
          const wp = `${path}.reading.windows[${k}]`;
          const used = Math.max(0, w.usedPercent);
          const tone = band(used);
          const p = pace(w, at);
          const reset = w.resetsAt
            ? slot(
                `left(${wp}.resetsAt, at)`,
                Date.parse(w.resetsAt) > Date.parse(at)
                  ? `resets in ${span(Date.parse(w.resetsAt) - Date.parse(at))}`
                  : "reset passed",
                "when",
                "span",
                dated(w.resetsAt, "resets "),
              )
            : slot(`${wp}.resetsAt`, DASH, "when");
          return `<div class="entry${k ? "" : " first"}${tone ? ` ${tone}` : ""}" data-path="${wp}">${k ? '<span class="lead"></span>' : lead(a, path)}${slot(`${wp}.label`, esc(windowName(w.label)), "name")}${slot(`${wp}.usedPercent`, pct(used), "figure")}${meter(used, tone, p)}${p ? slot(`pace(${wp}, at)`, p.ahead ? "above pace" : "within pace", `note${p.ahead ? " ahead" : ""}`) : '<span class="note"></span>'}${reset}${slot(`${wp}.usedPercent`, `${Math.max(0, 100 - Math.round(used))}% left`, "rest")}</div>`;
        })
      : [
          bare(
            a,
            path,
            r?.allowance === "unavailable"
              ? "Current limits are unavailable"
              : r
                ? "No quota windows reported"
                : nothing(a),
          ),
        ];
    return rows.join("\n") + more(a, path, metricsOf(a, path));
  };

  // ---- Balances ----

  // One row per account: the balance leading (every currency), then the
  // key's allowance beside it when the provider reports one; the key's
  // spend and the balance's parts go to the pairs. Neutral: no band.
  const balance = (a: AccountView, path: string): string => {
    const r = a.reading;
    if (!r) return bare(a, path, nothing(a)) + more(a, path, []);
    const find = (label: string) => {
      const k = r.metrics.findIndex((m) => m.label === label);
      return k < 0 ? null : { k, m: r.metrics[k] as Metric };
    };
    const leading = r.metrics.flatMap((m, k) =>
      BALANCE.includes(m.label)
        ? [
            slot(
              `${path}.reading.metrics[${k}].value`,
              esc(amount(m.value, m.unit)),
            ),
          ]
        : [],
    );
    const remaining = find("Key remaining");
    const limit = find("Key limit");
    const key = remaining
      ? `key ${slot(`${path}.reading.metrics[${remaining.k}].value`, esc(amount(remaining.m.value, remaining.m.unit)))} left${limit ? ` of ${slot(`${path}.reading.metrics[${limit.k}].value`, esc(amount(limit.m.value, limit.m.unit)))}` : ""}`
      : "";
    // The key's allowance in the board's own small meter, its share used.
    const k = r.windows.findIndex((w) => w.label === "Key allowance");
    const w = r.windows[k];
    const used = w ? Math.max(0, w.usedPercent) : 0;
    const allowance = w
      ? `<span class="meter" title="key allowance used"><span class="bar"><i style="width: ${Math.min(100, used)}%"></i></span>${slot(`${path}.reading.windows[${k}].usedPercent`, pct(used), "num")}</span>`
      : "";
    return `<div class="entry first" data-path="${path}">${lead(a, path)}<span class="figure leading">${leading.join(" · ") || DASH}</span><span class="name">${key}</span>${allowance}</div>${more(a, path, metricsOf(a, path, [...BALANCE, ...KEY]))}`;
  };

  // ---- Panels ----

  const panel = (
    cls: string,
    title: string,
    list: { a: AccountView; path: string }[],
    draw: (a: AccountView, path: string) => string,
  ): string =>
    list.length
      ? `<section class="panel ${cls}" aria-label="${title}">
  <h2 class="col-h"><span class="kicker">${title}</span><span class="n" data-path="count(usage.accounts[].kind=${list[0]?.a.kind})">${count(list.length, "account")}</span></h2>
  <div class="scroll"><div class="ledger">
${list.map(({ a, path }) => draw(a, path)).join("\n")}
  </div></div>
</section>`
      : "";
  const panels = [
    panel("subscriptions", "Subscriptions", subscriptions, subscription),
    panel("balances", "Balances", balances, balance),
  ].filter(Boolean);
  const main = usage
    ? `<main class="bento ${panels.length > 1 ? "pair" : "single"}">
${panels.join("\n")}
</main>`
    : `<main class="bento single"><section class="panel" aria-label="Usage"><h2 class="col-h"><span class="kicker">Usage</span><span class="n">off: the configuration has no usage section</span></h2></section></main>`;

  return frame({
    model,
    theme: themeOf(options.theme),
    refreshSeconds,
    title: "Usage · Router",
    comment: `<!-- Rendered from the ${esc(model.version)} view model's usage. Every slot's
     data-path names what it reads: a plain path indexes the model, and
     time(), age(), left(), count(), max() and pace() are formats over it. -->`,
    notice: "",
    head: head(model, "usage", chips, tick),
    main,
    keys: `<span><kbd>?</kbd> keys</span>`,
    help: [
      ["?", "keys and theme"],
      ["esc", "close"],
    ],
  });
}
