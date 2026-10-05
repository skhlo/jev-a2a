// The usage parts of the board page (v0.13), the account part of the
// model: a section in the rail with one row per subscription account, and
// the pop-up with every account, which a row or u opens beside the rail.
// Neither is drawn while the model carries no usage. Without a script a row
// is a link to this page with the pop-up drawn open (`?usage`), and while
// it is open the row and its close button are links back; the script
// toggles the pop-up in place.
import {
  age,
  count,
  DASH,
  dated,
  disclosure,
  esc,
  href,
  meter,
  pairs,
  slot,
  span,
  stamp,
  table,
  thousands,
  time,
  type Column,
  type Row,
} from "./board-parts.ts";
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
const until = (iso: string, at: string): number =>
  Date.parse(iso) - Date.parse(at);

// A rail row, built from the agent card's parts. Line 1: the provider's
// mark, the name, the status word where a card puts its status, and at
// the right the week's reset in days and hours, a dash once passed.
// Line 2: the shown windows, each its length and the context meter's
// look with a pace tick and the share, in the band's role, or warn above
// pace without one; a passed reset keeps the track alone. A stale row
// dims, and the tooltip names its age and error and each window.
const usageRow = (
  { at, usageOpen, usageHref, readAt }: UsageLinks,
  a: AccountView,
  i: number,
): string => {
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
      `${windowName(w.label)} ${n}%${p ? (p.ahead ? ", above pace" : ", within pace") : ""}${w.resetsAt ? `, resets in ${span(until(w.resetsAt, at))}` : ""}`,
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
          ? dh(until(week.w.resetsAt, at))
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
  notCurrent(a) ? slot(`${path}.status`, esc(a.status), `badge sm${cls}`) : "";
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
  at: string,
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
          over ? "reset passed" : `resets in ${span(until(w.resetsAt, at))}`,
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
const details = (
  at: string,
  a: AccountView,
  path: string,
  skip: string[],
): string => {
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
const account = (at: string, a: AccountView, i: number): string => {
  const path = `usage.accounts[${i}]`;
  const more = disclosure({
    key: `usage ${a.id}`,
    id: `usage-more-${a.id}`,
    path: `${path}.name`,
    label: a.name,
    title: `${a.name} · details`,
    blockPath: path,
    body: details(
      at,
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
      ? subscriptionRows(at, a, path, leadOf)
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
const usagePopup = (
  { at, usageOpen, usageClose }: UsageLinks,
  u: UsageView,
): string => {
  const groups = (
    [
      ["subscription", "Subscriptions"],
      ["api", "Balances"],
    ] as const
  ).flatMap(([kind, title]) => {
    const mine = u.accounts.flatMap((a, i) =>
      a.kind === kind ? [account(at, a, i)] : [],
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

// The page the parts are drawn on: its time, whether the pop-up is drawn
// open, where a row and the pop-up's close button lead, and when usage was
// read.
type UsageLinks = {
  at: string;
  usageOpen: boolean;
  usageClose: string;
  usageHref: string;
  readAt: string;
};

// The rail's section, empty without a subscription account, and the
// pop-up, for usage `u` on a page at `at`. `selected` is the page's
// selected task, which a link keeps; `usageOpen` draws the pop-up open.
export function usageParts(
  u: UsageView,
  at: string,
  selected: string | null,
  usageOpen: boolean,
): { rail: string; popup: string } {
  const usageClose = selected ? href(selected) : "./";
  const usageHref = usageOpen
    ? usageClose
    : esc(`?${selected ? `task=${encodeURIComponent(selected)}&` : ""}usage`);
  const readAt = u.at ? `read ${time(u.at)}` : "not read yet";
  const links = { at, usageOpen, usageClose, usageHref, readAt };
  const subscriptions = u.accounts.flatMap((a, i) =>
    a.kind === "subscription" ? [{ a, i }] : [],
  );
  // Pinned under the cards, above the router log; balances stay in the
  // pop-up.
  const rail = subscriptions.length
    ? `  <section class="usage-rail" aria-label="Usage" data-path="usage">
    <h2 class="col-h"><span class="kicker">Usage</span>${slot("count(usage.accounts[].kind=subscription)", count(subscriptions.length, "account"), "n")}</h2>
    <div class="accts">${subscriptions.map(({ a, i }) => usageRow(links, a, i)).join("")}</div>
  </section>
`
    : "";
  return { rail, popup: usagePopup(links, u) };
}
