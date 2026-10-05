// The Usage view of the router page: this host's accounts as the board
// model's `usage` carries them (usage.ts), on its own route beside the
// board. It is drawn in the board page's frame, with the same head, tokens,
// themes, help and script, and from the page's generic parts (board-page.ts:
// the chip, the meter with its pace tick, pairs, the table, the
// disclosure); what is here is what the accounts mean. A first cut, which
// the design refines in v0.13. Pure: the model and the options decide every
// byte. Every slot names the model path it reads, as on the board.
//
// Subscriptions: one row per quota window, with the share used, a meter
// with a pace tick, the time to its reset and what is left; colour only in
// the 75 and 90 bands and above pace. Balances: one row per API account,
// the balance leading, neutral. An account says how fresh it is only when
// it is not current, and names what failed. Absent stays a dash, never 0.
import type { BoardModel } from "./board.ts";
import {
  age,
  band,
  chip,
  count,
  dated,
  DASH,
  disclosure,
  esc,
  frame,
  head,
  meter,
  pace,
  pairs,
  slot,
  span,
  stamp,
  table,
  thousands,
  themeOf,
  time,
  type Column,
} from "./board-page.ts";
import {
  LABEL,
  WINDOW_SUFFIX,
  type AccountView,
  type DataTable,
  type DetailView,
  type Metric,
  type UsageView,
  type WindowView,
} from "./usage.ts";

// The board model with its usage, which the server draws this view for.
export type UsageModel = BoardModel & { usage: UsageView };

export type UsageOptions = {
  refreshSeconds?: number;
  // The palette, from the router-theme cookie.
  theme?: string | null;
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

const pct = (n: number): string => `${Math.round(n)}%`;

// The figures a balance row leads with or shows beside it; the rest go to
// the row's pairs.
const LEADING: string[] = [LABEL.accountBalance, LABEL.balance];
const BESIDE: string[] = [LABEL.keyRemaining, LABEL.keyLimit];

// Day-keyed tables show their latest sixty days; gaps stay gaps.
const DAYS_SHOWN = 60;

// How a table column draws: counts and amounts as numerals, dates and names
// a machine wrote in mono, words as text.
const KIND: Record<string, Column["kind"]> = {
  number: "num",
  USD: "num",
  date: "mono",
  name: "mono",
};

export function renderUsage(
  model: UsageModel,
  options: UsageOptions = {},
): string {
  const { at, usage } = model;
  const refreshSeconds = options.refreshSeconds ?? 10;
  const accounts = usage.accounts.map((a, i) => ({
    a,
    path: `usage.accounts[${i}]`,
  }));
  const subscriptions = accounts.filter(({ a }) => a.kind === "subscription");
  const balances = accounts.filter(({ a }) => a.kind === "api");
  // A window whose reset is at or before `at` says nothing of now: its
  // share is history, so it takes no band, no "left" and no place in the
  // head.
  const passed = (w: WindowView): boolean =>
    w.resetsAt !== null && Date.parse(w.resetsAt) <= Date.parse(at);

  // ---- Head ----

  // The worst subscription window, then how many accounts are stale,
  // unavailable or still being read; the board's chips stay on the board.
  // A window whose reset has passed says nothing of now and is left out; one
  // from a stale reading says so.
  const windows = subscriptions.flatMap(({ a, path }) =>
    (a.reading?.allowance === "unavailable" ? [] : (a.reading?.windows ?? []))
      .map((w, k) => ({ a, w, path: `${path}.reading.windows[${k}]` }))
      .filter(({ w }) => !passed(w)),
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
          pct(worst.w.usedPercent),
          `${esc(worst.a.name)} ${esc(windowName(worst.w.label))}${worst.a.status === "stale" ? " · stale" : ""}`,
          band(Math.round(worst.w.usedPercent)),
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
        ? chip(`count(usage.accounts[].status=${status})`, n, words)
        : "";
    }),
  ].join("");
  // The head's freshness line: when the store last read, and how often.
  const tick = slot(
    "time(usage.at), usage.every",
    usage.at
      ? `read ${time(usage.at)} · every ${usage.every % 60 ? `${usage.every}s` : span(usage.every * 1000)}`
      : "not read yet",
    "tick",
    "span",
    ` title="${esc(`${usage.at ? `usage read ${stamp(usage.at)}` : "usage not read yet"} · every ${usage.every}s · built ${stamp(at)} · ${model.version}`)}"`,
  );

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
              "mono",
              "span",
              dated(r.observedAt),
            )
          : a.checkedAt
            ? slot(
                `age(${path}.checkedAt, at)`,
                `checked ${age(a.checkedAt, at)} ago`,
                "mono",
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
  const metricPairs = (items: { path: string; m: Metric }[]): string =>
    pairs(
      items.map(({ path, m }) => ({
        path,
        label: m.label,
        value: amount(m.value, m.unit),
      })),
    );
  // A provider's table: day-keyed ones keep their latest sixty days.
  const dataTable = (path: string, t: DataTable): string => {
    let rows = t.rows;
    let note = "";
    const date = t.columns.find((c) => c.format === "date");
    if (date) {
      const days = [...new Set(rows.map((r) => String(r[date.key])))]
        .sort()
        .reverse();
      if (days.length > DAYS_SHOWN) {
        const kept = new Set(days.slice(0, DAYS_SHOWN));
        rows = rows.filter((r) => kept.has(String(r[date.key])));
        note = `latest ${DAYS_SHOWN} of ${days.length} days`;
      }
    }
    return table({
      path,
      title: t.title,
      note,
      columns: t.columns.map((c) => ({
        label: c.label,
        kind: (c.format && KIND[c.format]) || "text",
      })),
      rows: rows.map((r) =>
        t.columns.map((c) =>
          amount(r[c.key], c.format === "USD" ? "USD" : null),
        ),
      ),
    });
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
    return disclosure({
      key: `${a.id}/${d.title}`,
      path,
      summary: `${slot(`${path}.title`, esc(d.title))}<span class="n">${meta.join(" · ")}</span>${d.status === "stale" ? slot(`${path}.status`, "stale", "badge") : ""}`,
      body: `${metricPairs(d.metrics.map((m, k) => ({ path: `${path}.metrics[${k}]`, m })))}${d.tables.map((t, k) => dataTable(`${path}.tables[${k}]`, t)).join("")}${d.notice ? slot(`${path}.notice`, esc(d.notice), "hint", "p") : ""}`,
    });
  };
  const more = (
    a: AccountView,
    path: string,
    metrics: { path: string; m: Metric }[],
  ): string => {
    const r = a.reading;
    const inner =
      state(a, path) +
      metricPairs(metrics) +
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
          // The band follows the share as shown: 74.6 reads 75%, amber.
          const shown = Math.round(used);
          const over = passed(w);
          const tone = over ? "" : band(shown);
          const p = pace(w, at);
          const reset = w.resetsAt
            ? slot(
                `left(${wp}.resetsAt, at)`,
                over
                  ? "reset passed"
                  : `resets in ${span(Date.parse(w.resetsAt) - Date.parse(at))}`,
                "when",
                "span",
                dated(w.resetsAt, "resets "),
              )
            : slot(`${wp}.resetsAt`, DASH, "when");
          const bar = meter({
            share: used,
            tone,
            wide: true,
            path: `${wp}.usedPercent, pace(${wp}, at)`,
            pace: p?.elapsed ?? null,
            ...(p
              ? { title: `${Math.round(p.elapsed)}% of the window has passed` }
              : {}),
          });
          const note = p
            ? slot(
                `pace(${wp}, at)`,
                p.ahead ? "above pace" : "within pace",
                `note${p.ahead ? " ahead" : ""}`,
              )
            : '<span class="note"></span>';
          return `<div class="entry${k ? "" : " first"}${tone ? ` ${tone}` : ""}" data-path="${wp}">${k ? '<span class="lead"></span>' : lead(a, path)}${slot(`${wp}.label`, esc(windowName(w.label)), "name", "span", ` title="${esc(w.label)}"`)}${slot(`${wp}.usedPercent`, pct(used), "figure")}${bar}${note}${reset}${slot(`${wp}.usedPercent`, over ? DASH : `${Math.max(0, 100 - shown)}% left`, "rest")}</div>`;
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
    if (r.allowance === "unavailable")
      return (
        bare(a, path, "Current limits are unavailable") +
        more(a, path, metricsOf(a, path))
      );
    const find = (label: string) => {
      for (const [k, m] of r.metrics.entries())
        if (m.label === label) return { k, m };
      return null;
    };
    const leading = r.metrics.flatMap((m, k) =>
      LEADING.includes(m.label)
        ? [
            slot(
              `${path}.reading.metrics[${k}].value`,
              esc(amount(m.value, m.unit)),
            ),
          ]
        : [],
    );
    const remaining = find(LABEL.keyRemaining);
    const limit = find(LABEL.keyLimit);
    const key = remaining
      ? `key ${slot(`${path}.reading.metrics[${remaining.k}].value`, esc(amount(remaining.m.value, remaining.m.unit)), "mono")} left${limit ? ` of ${slot(`${path}.reading.metrics[${limit.k}].value`, esc(amount(limit.m.value, limit.m.unit)), "mono")}` : ""}`
      : "";
    // The key's allowance in the board's own small meter, its share used.
    const k = r.windows.findIndex((w) => w.label === LABEL.keyAllowance);
    const w = r.windows[k];
    const allowance = w
      ? meter({
          share: Math.max(0, w.usedPercent),
          title: "key allowance used",
          figure: {
            path: `${path}.reading.windows[${k}].usedPercent`,
            text: pct(Math.max(0, w.usedPercent)),
          },
        })
      : "";
    return `<div class="entry first" data-path="${path}">${lead(a, path)}<span class="figure leading">${leading.join(" · ") || DASH}</span><span class="name">${key}</span>${allowance}</div>${more(a, path, metricsOf(a, path, [...LEADING, ...BESIDE]))}`;
  };

  // ---- Panels ----

  const panel = (
    part: string,
    title: string,
    list: { a: AccountView; path: string }[],
    draw: (a: AccountView, path: string) => string,
  ): string =>
    list.length
      ? `<section class="panel ${part}" aria-label="${title}" data-part="${part}">
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
    main: `<main class="bento ${panels.length > 1 ? "pair" : "single"}">
${panels.join("\n")}
</main>`,
    keys: `<span><kbd>?</kbd> keys</span>`,
    help: [
      ["?", "keys and theme"],
      ["esc", "close"],
    ],
  });
}
