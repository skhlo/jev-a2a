// The Usage view: the fixture's usage drawn as a person reads it (text,
// classes, data-paths), the head shared with the board, the states, the
// escaping, and the narrow-screen rules in the page's CSS.
import test from "node:test";
import assert from "node:assert/strict";
import {
  boardModel,
  boardState,
  identify,
  messageTimes,
  type BoardModel,
} from "./board.ts";
import { band, pace, renderBoard } from "./board-page.ts";
import { amount, renderUsage, type UsageModel } from "./usage-page.ts";
import {
  agedUsage,
  config,
  firstUsage,
  NOW,
  otherUsage,
  sampleJournal,
  telemetry,
  usage,
} from "./board-fixture.ts";
import { sampleModel } from "./board-sample.ts";
import { dataPaths } from "./design-paths.ts";
import {
  deepseekReading,
  LABEL,
  openrouterReading,
  WINDOW_SUFFIX,
  type UsageState,
} from "./usage.ts";

const ME = "me@example.com";
const NOW_ISO = new Date(NOW).toISOString();
const model = (state: UsageState | null, now = NOW): BoardModel =>
  boardModel(
    boardState(config, sampleJournal, now),
    config,
    now,
    messageTimes(sampleJournal),
    identify({ "tailscale-user-login": ME }, config.serve.identities),
    telemetry,
    state,
  );
// The model with its usage, which the server draws the Usage view for.
const withUsage = (m: BoardModel): UsageModel => {
  const { usage } = m;
  assert.ok(usage, "the model carries usage");
  return { ...m, usage };
};
const strip = (html: string): string =>
  html.replace(/<[^>]+>/g, "").replace(/\s+/g, " ");
const escape = (text: string): string =>
  text.replace(/[.*+?^${}()|[\]\\]/g, "\\$&");
// The text of each element that reads `path`.
const textsOf = (html: string, path: string, tag = "span"): string[] =>
  [
    ...html.matchAll(
      new RegExp(
        `<${tag}\\b[^>]*data-path="${escape(path)}"[^>]*>([^]*?)</${tag}>`,
        "g",
      ),
    ),
  ].map((m) => strip(m[1] ?? ""));
const headOf = (html: string): string =>
  html.slice(html.indexOf('<header class="nav">'), html.indexOf("</header>"));
const STYLE = (html: string): string =>
  html.match(/<style>([^]*?)<\/style>/)?.[1] ?? "";
// The narrow-screen block of the page's CSS.
const NARROW = (html: string): string => {
  const css = STYLE(html);
  return css.slice(css.indexOf("@media (max-width: 900px)"));
};
// The rows of one account, and the block under them, from the tag of its
// first row.
const account = (html: string, i: number): string => {
  const row = (k: number, from = 0): number => {
    const at = html.indexOf(`data-path="usage.accounts[${k}]`, from);
    return at < 0 ? -1 : html.lastIndexOf("<div", at);
  };
  const start = row(i);
  const next = row(i + 1, start);
  return html.slice(start, next < 0 ? html.indexOf("</main>") : next);
};

test("the formats: pace, the bands and amounts, absent as a dash", () => {
  const at = "2026-09-30T09:45:00.000Z";
  // 90 of 300 minutes gone: 30%, and 41% used is ahead by more than two.
  assert.deepEqual(
    pace(
      { minutes: 300, resetsAt: "2026-09-30T13:15:00.000Z", usedPercent: 41 },
      at,
    ),
    { elapsed: 30, ahead: true },
  );
  assert.equal(
    pace(
      { minutes: 300, resetsAt: "2026-09-30T13:15:00.000Z", usedPercent: 32 },
      at,
    )?.ahead,
    false,
  );
  // No length, no reset, or a reset passed: no pace.
  for (const w of [
    { minutes: null, resetsAt: "2026-09-30T13:15:00.000Z" },
    { minutes: 300, resetsAt: null },
    { minutes: 300, resetsAt: at },
  ])
    assert.equal(pace({ ...w, usedPercent: 1 }, at), null);
  assert.deepEqual([0, 74.9, 75, 89.9, 90, 104].map(band), [
    "",
    "",
    "warn",
    "warn",
    "err",
    "err",
  ]);
  assert.equal(amount(null, "USD"), "—");
  assert.equal(amount(undefined, null), "—");
  assert.equal(amount(0, "USD"), "$0.00");
  assert.equal(amount(0.004, "USD"), "$0.004");
  assert.equal(amount(12.34, "CNY"), "CN¥12.34");
  assert.equal(amount(0, null), "0");
  assert.equal(amount(1, "days"), "1 day");
  assert.equal(amount(48_213_900, "tokens"), "48,213,900 tokens");
  assert.equal(amount("Unlimited", null), "Unlimited");
});

test("nav on both tabs: Board | Usage | JSON, the open one marked, every link relative; no Usage tab while usage is off", () => {
  const board = renderBoard(sampleModel(), { task: "T2" });
  const page = renderUsage(withUsage(sampleModel()));
  assert.ok(
    headOf(board).includes(
      '<nav><a class="active" href="./">Board</a><a href="usage/">Usage</a><a href="board.json">JSON</a></nav>',
    ),
  );
  assert.ok(
    headOf(page).includes(
      '<nav><a href="../">Board</a><a class="active" href="./">Usage</a><a href="../board.json">JSON</a></nav>',
    ),
  );
  assert.equal(page.match(/board\.json/g)?.length, 1);
  const off = renderBoard(model(null), { task: "T2" });
  assert.ok(
    headOf(off).includes(
      '<nav><a class="active" href="./">Board</a><a href="board.json">JSON</a></nav>',
    ),
  );
  // The head is the same element: only its chips, its tick and the marked
  // tab differ.
  const bare = (html: string): string =>
    headOf(html)
      .replace(/<span class="counts">[^]*?<\/span>\n/, "")
      .replace(/<span class="tick"[^]*?<\/span>\n/, "")
      .replace(/<nav>[^]*<\/nav>/, "");
  assert.equal(bare(page), bare(board));
});

test("the head: Usage's own chips (the worst window in its band, the stale count) and its freshness line; the board keeps its chips", () => {
  const page = renderUsage(withUsage(sampleModel()));
  const head = headOf(page);
  assert.ok(
    head.includes(
      '<span class="err" data-path="max(usage.accounts[].reading.windows[].usedPercent)"><b>92%</b> Claude 5-hour · stale</span>',
    ),
  );
  assert.deepEqual(textsOf(head, "count(usage.accounts[].status=stale)"), [
    "1 stale",
  ]);
  assert.ok(!head.includes("needs you") && !head.includes("in flight"));
  assert.ok(
    head.includes(
      '<span class="tick" data-path="time(usage.at), usage.every" title="usage read 2026-09-30 09:44:30Z · every 120s · built 2026-09-30 09:45:00Z · jev-router-board/1">read 09:44Z · every 2m</span>',
    ),
  );
  // A cadence that is not a whole minute reads in seconds.
  for (const [every, words] of [
    [90, "every 90s"],
    [60, "every 1m"],
    [3600, "every 1h"],
  ] as const)
    assert.ok(
      headOf(renderUsage(withUsage(model({ ...usage, every })))).includes(
        `>read 09:44Z · ${words}</span>`,
      ),
      words,
    );
  const board = headOf(renderBoard(sampleModel(), { task: "T2" }));
  assert.ok(board.includes("in flight") && !board.includes("stale"));
  // Before the first read, and once every reading aged.
  const first = headOf(renderUsage(withUsage(model(firstUsage))));
  assert.match(first, />not read yet</);
  assert.deepEqual(textsOf(first, "count(usage.accounts[].status=loading)"), [
    "4 reading",
  ]);
  const later = headOf(renderUsage(withUsage(model(usage, NOW + 11 * 60_000))));
  assert.deepEqual(textsOf(later, "count(usage.accounts[].status=stale)"), [
    "4 stale",
  ]);
  // An hour on, Claude's 5-hour reset has passed: its 92% is no longer the
  // worst window, and the next one, from a reading as stale, says so.
  const hour = headOf(renderUsage(withUsage(model(usage, NOW + 60 * 60_000))));
  assert.deepEqual(
    textsOf(hour, "max(usage.accounts[].reading.windows[].usedPercent)"),
    ["78% Codex 7-day · stale"],
  );
  assert.ok(!hour.includes("92%"));
  // The chip's band follows the share as shown: 89.6 reads 90%, red.
  const rounded = structuredClone(usage);
  const week = rounded.accounts[0]?.reading?.windows[1];
  const claudeReading = rounded.accounts[1]?.reading;
  assert.ok(week && claudeReading);
  week.usedPercent = 89.6;
  claudeReading.windows = [];
  assert.ok(
    headOf(renderUsage(withUsage(model(rounded)))).includes(
      '<span class="err" data-path="max(usage.accounts[].reading.windows[].usedPercent)"><b>90%</b> Codex 7-day</span>',
    ),
  );
  // A current reading's worst window has no word after it.
  const fresh = structuredClone(usage);
  const claude = fresh.accounts[1];
  assert.ok(claude?.reading);
  claude.reading.observedAt = NOW - 30_000;
  claude.reading.windows = claude.reading.windows.filter(
    (w) => w.resetsAt === null || w.resetsAt > NOW,
  );
  claude.error = null;
  claude.status = "ready";
  assert.deepEqual(
    textsOf(
      headOf(renderUsage(withUsage(model(fresh)))),
      "max(usage.accounts[].reading.windows[].usedPercent)",
    ),
    ["92% Claude 5-hour"],
  );
});

test("subscriptions: a row per window with the share used, the meter and its pace tick, the reset and what is left; colour only in a band or ahead of pace", () => {
  const page = renderUsage(withUsage(sampleModel()));
  const codex = account(page, 0);
  const w0 = "usage.accounts[0].reading.windows[0]";
  // The account leads its first row only, linked to the provider's page.
  assert.ok(
    codex.includes(
      '<a class="lead" data-path="usage.accounts[0].name, usage.accounts[0].url" href="https://chatgpt.com/codex/settings/usage" target="_blank" rel="noopener noreferrer"',
    ),
  );
  assert.equal(codex.match(/class="lead"/g)?.length, 2);
  assert.deepEqual(textsOf(codex, `${w0}.label`), ["5-hour"]);
  // The name may wrap; its title is the whole label.
  assert.ok(
    codex.includes(
      `<span class="name" data-path="${w0}.label" title="5-hour window">5-hour</span>`,
    ),
  );
  assert.deepEqual(textsOf(codex, `${w0}.usedPercent`), ["41%", "59% left"]);
  assert.ok(
    codex.includes(
      `<span class="meter wide" data-path="${w0}.usedPercent, pace(${w0}, at)" title="30% of the window has passed"><span class="bar paced"><i style="width: 41%"></i><b class="pace" style="left: 30.0%"></b></span></span>`,
    ),
  );
  assert.ok(
    codex.includes(
      `<span class="note ahead" data-path="pace(${w0}, at)">above pace</span>`,
    ),
  );
  assert.ok(
    codex.includes(
      `<span class="when" data-path="left(${w0}.resetsAt, at)" title="resets 2026-09-30 13:15Z">resets in 3h 30m</span>`,
    ),
  );
  // 5-hour: no band, ahead of pace; 7-day: in the 75% band, within pace;
  // Claude's 5-hour in the 90% band.
  assert.match(
    codex,
    /<div class="entry first" data-path="usage\.accounts\[0\]\.reading\.windows\[0\]">/,
  );
  assert.match(
    codex,
    /<div class="entry warn" data-path="usage\.accounts\[0\]\.reading\.windows\[1\]">/,
  );
  assert.match(
    codex,
    /class="note" data-path="pace\(usage\.accounts\[0\]\.reading\.windows\[1\], at\)">within pace</,
  );
  assert.match(
    account(page, 1),
    /<div class="entry first err" data-path="usage\.accounts\[1\]\.reading\.windows\[0\]">/,
  );
  // Zero is shown as zero: the Opus window and the credits.
  assert.deepEqual(
    textsOf(
      account(page, 1),
      "usage.accounts[1].reading.windows[2].usedPercent",
    ),
    ["0%", "100% left"],
  );
  assert.ok(
    codex.includes(
      '<div data-path="usage.accounts[0].reading.metrics[1]"><dt>Credits</dt><dd>0</dd></div>',
    ),
  );
  // A current account says nothing of its freshness.
  assert.ok(!codex.includes('class="badge"'));
  // A window whose reset has passed says so, with no pace and no colour.
  const sonnet = "usage.accounts[1].reading.windows[3]";
  const claude = account(page, 1);
  assert.deepEqual(textsOf(claude, `left(${sonnet}.resetsAt, at)`), [
    "reset passed",
  ]);
  assert.match(
    claude,
    new RegExp(
      `<div class="entry" data-path="${escape(sonnet)}">[^]*?<span class="note"></span>`,
    ),
  );
  assert.ok(!claude.includes(`data-path="pace(${sonnet}, at)"`));
  // Its share is history: the figure stays, "left" is a dash. A banded
  // window past its reset loses its band too: Claude's 92% an hour on.
  assert.deepEqual(textsOf(claude, `${sonnet}.usedPercent`), ["12%", "—"]);
  const hour = account(
    renderUsage(withUsage(model(usage, NOW + 60 * 60_000))),
    1,
  );
  const five = "usage.accounts[1].reading.windows[0]";
  assert.deepEqual(textsOf(hour, `${five}.usedPercent`), ["92%", "—"]);
  assert.match(
    hour,
    new RegExp(`<div class="entry first" data-path="${escape(five)}">`),
  );
  assert.ok(hour.includes('<span class="meter wide" data-path'));
  assert.doesNotMatch(hour, /class="[^"]*\b(warn|err)\b/);
  // The band follows the share as shown, not the share as read.
  const edges = structuredClone(usage);
  const codexWindows = edges.accounts[0]?.reading?.windows;
  assert.ok(codexWindows?.[0] && codexWindows[1]);
  codexWindows[0].usedPercent = 74.6;
  codexWindows[1].usedPercent = 89.6;
  const edged = account(renderUsage(withUsage(model(edges))), 0);
  for (const [k, figure, tone] of [
    [0, "75%", "warn"],
    [1, "90%", "err"],
  ] as const) {
    const wp = `usage.accounts[0].reading.windows[${k}]`;
    assert.deepEqual(textsOf(edged, `${wp}.usedPercent`)[0], figure);
    assert.match(
      edged,
      new RegExp(`<div class="entry[^"]* ${tone}" data-path="${escape(wp)}">`),
    );
  }
  // A subscription that reported no window says so on its row.
  const aged = renderUsage(withUsage(model(agedUsage)));
  assert.ok(strip(account(aged, 0)).includes("CodexNo quota windows reported"));
});

test("freshness per account only when it is not current, naming what failed", () => {
  const page = renderUsage(withUsage(sampleModel()));
  // Claude kept its last reading after a refresh that failed.
  assert.ok(
    strip(account(page, 1)).includes(
      "stalelast reading 13m ago · Claude login expired; open Claude Code.",
    ),
  );
  // The age is mono, as the board's ages are.
  assert.deepEqual(
    textsOf(account(page, 1), "age(usage.accounts[1].reading.observedAt, at)"),
    ["last reading 13m ago"],
  );
  assert.ok(
    account(page, 1).includes(
      '<span class="mono" data-path="age(usage.accounts[1].reading.observedAt, at)"',
    ),
  );
  const other = renderUsage(withUsage(model(otherUsage)));
  // History alone: the limits are unavailable, the history is there.
  const codex = strip(account(other, 0));
  assert.ok(codex.includes("Current limits are unavailable"));
  assert.ok(
    codex.includes("unavailablechecked 31s ago · Codex usage unavailable."),
  );
  assert.ok(codex.includes("Token activity"));
  // Never read: no reading, the reason.
  assert.ok(
    strip(account(other, 1)).includes(
      "No current readingnot readchecked 31s ago · No Claude login on this host. Open Claude Code and run /login.",
    ),
  );
  const first = renderUsage(withUsage(model(firstUsage)));
  assert.equal(strip(first).match(/Reading…/g)?.length, 4);
  assert.ok(!first.includes('class="badge"'));
  // Aged past ten minutes, a current account goes stale.
  const later = renderUsage(withUsage(model(usage, NOW + 11 * 60_000)));
  assert.ok(strip(account(later, 0)).includes("stalelast reading 11m ago"));
  // A store that stalled: no refresh failed, every reading stale by its age
  // alone, with no failure named.
  const aged = renderUsage(withUsage(model(agedUsage)));
  for (const i of [0, 1, 2, 3]) {
    const text = strip(account(aged, i));
    assert.ok(text.includes("stalelast reading 12m ago"), text);
    assert.ok(!text.includes("Could not refresh"), text);
  }
});

test("balances: the balance leading, the key beside it, neutral; a missing management key reads as such", () => {
  const page = renderUsage(withUsage(sampleModel()));
  const deepseek = account(page, 2);
  const openrouter = account(page, 3);
  assert.deepEqual(
    textsOf(deepseek, "usage.accounts[2].reading.metrics[0].value"),
    ["$4.12"],
  );
  assert.ok(strip(deepseek).includes("Granted$0.00"));
  assert.deepEqual(
    textsOf(openrouter, "usage.accounts[3].reading.metrics[0].value"),
    ["No management key"],
  );
  assert.ok(strip(openrouter).includes("key $12.00 left of $20.00"));
  // Money in mono, as in the pairs.
  assert.ok(
    openrouter.includes(
      'key <span class="mono" data-path="usage.accounts[3].reading.metrics[1].value">$12.00</span> left of <span class="mono" data-path="usage.accounts[3].reading.metrics[2].value">$20.00</span>',
    ),
  );
  assert.ok(
    strip(openrouter).includes(
      "A management key is required for the account balance and spending (OPENROUTER_MANAGEMENT_KEY).",
    ),
  );
  assert.ok(
    openrouter.includes(
      '<span class="meter" title="key allowance used"><span class="bar"><i style="width: 40%"></i></span><span class="num" data-path="usage.accounts[3].reading.windows[0].usedPercent">40%</span></span>',
    ),
  );
  // No band and no accent in the balances, even with the key's allowance
  // at 75% and 90%.
  for (const share of [40, 75, 90]) {
    const m = sampleModel();
    const w = m.usage?.accounts[3]?.reading?.windows[0];
    assert.ok(w);
    w.usedPercent = share;
    const html = renderUsage(withUsage(m));
    const balances = html.slice(html.indexOf('class="panel balances"'));
    assert.ok(
      !/class="[^"]*\b(warn|err|attn|ask)\b/.test(balances),
      String(share),
    );
    assert.ok(
      balances.includes(`<span class="meter" title="key allowance used">`),
    );
  }
  // With a management key: the balance and the spending.
  const managed = account(renderUsage(withUsage(model(otherUsage))), 3);
  assert.deepEqual(
    textsOf(managed, "usage.accounts[3].reading.metrics[0].value"),
    ["$15.20"],
  );
  assert.ok(managed.includes("By model and provider"));
  // History alone: no balance to lead with, said as a subscription says it,
  // and the history under it.
  const historyOnly = structuredClone(otherUsage);
  const alone = historyOnly.accounts[3];
  assert.ok(alone?.reading);
  alone.status = "unavailable";
  Object.assign(alone.reading, {
    allowance: "unavailable",
    windows: [],
    metrics: [],
  });
  const row = account(renderUsage(withUsage(model(historyOnly))), 3);
  assert.ok(strip(row).includes("OpenRouterCurrent limits are unavailable"));
  assert.ok(!row.includes('class="figure leading"'));
  assert.ok(
    row.includes('data-key="openrouter/Model &amp; provider spending"'),
  );
});

test("details behind a disclosure per account, keyed for the script, with tables of mono numerals; day tables show sixty days and no invented ones", () => {
  const page = renderUsage(withUsage(sampleModel()));
  const dp = "usage.accounts[0].reading.details[0]";
  assert.ok(
    page.includes(
      `<details class="disclosure" data-key="codex/Token activity" data-path="${dp}">`,
    ),
  );
  assert.doesNotMatch(page, /<details [^>]*\bopen\b/);
  assert.ok(
    page.includes(
      '<th class="mono">Date</th><th class="num">Tokens</th></tr><tr><td class="mono">2026-09-29</td><td class="num">3,388,100</td></tr>',
    ),
  );
  // Sep 21 had no bucket: a gap, not a zero; Sep 27 reported zero.
  assert.ok(!page.includes("2026-09-21"));
  assert.ok(
    page.includes('<td class="mono">2026-09-27</td><td class="num">0</td>'),
  );
  // Seventy days: the latest sixty, said so; a table without days is whole.
  const m = sampleModel();
  const detail = m.usage?.accounts[0]?.reading?.details[0];
  assert.ok(detail);
  const days = Array.from({ length: 70 }, (_, i) =>
    new Date(Date.parse("2026-07-01T00:00:00Z") + i * 86_400_000)
      .toISOString()
      .slice(0, 10),
  );
  detail.tables = [
    {
      title: "Daily token history",
      columns: [
        { key: "date", label: "Date", format: "date" },
        { key: "tokens", label: "Tokens", format: "number" },
      ],
      rows: days.map((date) => ({ date, tokens: null })).reverse(),
    },
    {
      title: "By model",
      columns: [{ key: "model", label: "Model", format: "name" }],
      rows: days.map((_, i) => ({ model: `model-${i}` })),
    },
  ];
  const long = renderUsage(withUsage(m));
  assert.ok(
    long.includes(
      '>Daily token history<span class="n">latest 60 of 70 days</span></h4>',
    ),
  );
  assert.equal(long.match(/<td class="num">—<\/td>/g)?.length, 60);
  assert.ok(!long.includes(`<td class="mono">${days[9]}</td>`));
  assert.ok(long.includes(`<td class="mono">${days[10]}</td>`));
  assert.equal(long.match(/<td class="mono">model-\d+<\/td>/g)?.length, 70);
});

test("data labels render as text: a hostile label, value, notice or title is escaped everywhere", () => {
  const hostile = '<script>alert(1)</script>"&';
  const m = sampleModel();
  const codex = m.usage?.accounts[0];
  const reading = codex?.reading;
  const w = reading?.windows[0];
  const detail = reading?.details[0];
  const table = detail?.tables[0];
  assert.ok(codex && reading && w && detail && table);
  codex.name = hostile;
  codex.error = hostile;
  codex.url = hostile;
  w.label = hostile;
  detail.throughDate = hostile;
  // The worst window, which the head's chip names.
  const worst = m.usage?.accounts[1]?.reading?.windows[0];
  assert.ok(worst);
  worst.label = hostile;
  reading.metrics.push({ label: hostile, value: hostile, unit: null });
  reading.notice = hostile;
  detail.title = hostile;
  detail.notice = hostile;
  table.title = hostile;
  table.columns.push({ key: "x", label: hostile, format: null });
  table.rows[0] = { ...table.rows[0], x: hostile };
  const page = renderUsage(withUsage(m));
  assert.ok(!page.includes("<script>alert"));
  assert.ok(!page.includes('"&<'));
  const safe = "&lt;script&gt;alert(1)&lt;/script&gt;&quot;&amp;";
  assert.ok(page.includes(`data-key="codex/${safe}"`));
  assert.ok(page.includes(`title="${safe}'s usage page"`));
  assert.ok(page.includes(`<td>${safe}</td>`));
  assert.ok(page.includes(`<th>${safe}</th>`));
  assert.ok(page.includes(`<dt>${safe}</dt><dd>${safe}</dd>`));
  assert.ok(page.includes(`href="${safe}"`));
  assert.ok(page.includes(`through ${safe}`));
  assert.ok(headOf(page).includes(`<b>92%</b> Claude ${safe} · stale</span>`));
  // Absent values stay dashes, and the page takes only a known palette.
  const forged = renderUsage(withUsage(m), {
    theme: '"><script>alert(2)</script>',
  });
  assert.ok(forged.includes('<html lang="en" data-theme="flexoki">'));
  assert.ok(!forged.includes("alert(2)"));
  assert.ok(
    renderUsage(withUsage(m), { theme: "one-dark" }).includes(
      '<html lang="en" data-theme="one-dark">',
    ),
  );
});

test("the labels the page places by name are the ones the normalizers write", () => {
  const at = Date.parse(NOW_ISO);
  const openrouter = openrouterReading(
    { data: { limit: 10, limit_remaining: 4 } },
    { data: { total_credits: 9, total_usage: 2 } },
    at,
  );
  assert.deepEqual(
    openrouter.metrics.slice(0, 3).map((m) => m.label),
    [LABEL.accountBalance, LABEL.keyRemaining, LABEL.keyLimit],
  );
  assert.equal(openrouter.windows[0]?.label, LABEL.keyAllowance);
  const deepseek = deepseekReading(
    { balance_infos: [{ currency: "USD", total_balance: "3" }] },
    at,
  );
  assert.equal(deepseek.metrics[0]?.label, LABEL.balance);
  // Placed: the balances lead, the key's figures stand beside them with its
  // allowance in the small meter, and a window's name drops the suffix.
  const page = renderUsage(withUsage(sampleModel()));
  assert.deepEqual(
    textsOf(account(page, 2), "usage.accounts[2].reading.metrics[0].value"),
    ["$4.12"],
  );
  assert.ok(account(page, 2).includes('<span class="figure leading">'));
  assert.ok(strip(account(page, 3)).includes("key $12.00 left of $20.00"));
  assert.ok(account(page, 3).includes('title="key allowance used"'));
  const label = sampleModel().usage?.accounts[0]?.reading?.windows[0]?.label;
  assert.ok(label);
  assert.ok(label.endsWith(WINDOW_SUFFIX));
  assert.deepEqual(
    textsOf(account(page, 0), "usage.accounts[0].reading.windows[0].label"),
    [label.slice(0, -WINDOW_SUFFIX.length)],
  );
});

test("the script the views share: it swaps the panels the page marks, keeps open disclosures across a refresh, and a board key without its part does nothing", () => {
  const page = renderUsage(withUsage(sampleModel()));
  const board = renderBoard(sampleModel(), { task: "T2" });
  // The parts each view marks, in its markup before the script.
  const marked = (html: string) =>
    [
      ...html
        .slice(0, html.indexOf("<script>"))
        .matchAll(/data-part="([^"]+)"/g),
    ].map((m) => m[1]);
  assert.deepEqual(marked(page), ["subscriptions", "balances"]);
  assert.deepEqual(marked(board), ["agents", "tasks", "detail"]);
  const script = page.slice(
    page.indexOf("<script>") + 8,
    page.lastIndexOf("</script>"),
  );
  assert.ok(
    script.includes(
      `const parts = () => [".nav .counts", ".nav .tick", ...$$("[data-part]").map((el) => '[data-part="' + CSS.escape(el.dataset.part) + '"]')];`,
    ),
  );
  assert.ok(script.includes("  for (const part of parts()) {"));
  assert.ok(!/\.subscriptions|\.balances/.test(script));
  // Open disclosures come back at start and after each refresh.
  assert.match(script, /\n {2}showLog\(\);\n {2}unfold\(\);\n/);
  assert.match(script, /\nunfold\(\);\n/);
  assert.ok(script.includes('localStorage.setItem("router-open"'));
  // l and / do nothing without the log and the filter, so the key falls
  // through on the Usage view.
  assert.ok(
    script.includes(
      'const toggleLog = () => {\n  if (!$(".agents .foot")) return false;',
    ),
  );
  assert.ok(
    script.includes(
      '  "/": () => {\n    const input = $(".filter input");\n    input?.focus();\n    return Boolean(input);\n  },',
    ),
  );
  assert.doesNotThrow(() => new Function(script));
});

test("the page reads without a script and takes no input: no form, the help's keys and the theme switch, the refresh", () => {
  const page = renderUsage(withUsage(sampleModel()));
  assert.ok(!page.includes("<form"));
  assert.ok(!page.includes("<input"));
  assert.ok(!page.includes("<textarea"));
  assert.ok(page.includes('<div id="app" data-refresh="10">'));
  assert.ok(page.includes("<title>Usage · Router</title>"));
  assert.ok(
    page.includes('<footer class="keys">\n  <span><kbd>?</kbd> keys</span>'),
  );
  assert.ok(
    page.includes(
      '<div class="grid"><kbd>?</kbd><span>keys and theme</span><kbd>esc</kbd><span>close</span></div>',
    ),
  );
  assert.ok(page.includes('class="themes" role="group" aria-label="Theme"'));
  // Every slot reads the model's usage, the actor, or a format over them.
  const paths = dataPaths(page);
  assert.ok(paths.length > 40);
  assert.deepEqual(
    paths.filter(
      (p) => !/^(usage|actor|(time|age|left|count|max|pace)\(usage)/.test(p),
    ),
    [],
  );
});

test("between the breakpoints: a pair of panels stacks below 1360px, where a row of quota windows no longer fits the wider column, and the main area scrolls", () => {
  const css = STYLE(renderUsage(withUsage(sampleModel())));
  const block = css.slice(
    css.indexOf("@media (max-width: 1359px) {"),
    css.indexOf("@media (max-width: 900px)"),
  );
  assert.ok(block.startsWith("@media (max-width: 1359px) {"));
  for (const rule of [
    ".bento.pair { grid-template-columns: minmax(0, 1fr); grid-auto-rows: max-content; overflow-y: auto; }",
    ".bento.pair > .panel, .bento.pair .scroll { overflow: visible; }",
  ])
    assert.ok(block.includes(rule), rule);
  // The row's fixed cells, which the 1360px follows from: measured in
  // Chromium, a window label keeps a width from 390px to 1440px.
  for (const rule of [
    ".entry > .lead { flex: 0 0 88px;",
    ".entry > .meter.wide { flex: 0 0 168px; }",
    ".entry > .note { flex: 0 0 76px;",
    ".entry > .when { flex: 0 0 128px; }",
    ".entry > .rest { flex: 0 0 68px;",
  ])
    assert.ok(css.includes(rule), rule);
});

test("the narrow screen: one column, rows that wrap with a leading figure on its own line, chips that wrap, tables that scroll inside their box", () => {
  const page = renderUsage(withUsage(sampleModel()));
  const narrow = NARROW(page);
  for (const rule of [
    ".bento.pair, .bento.single { grid-template-columns: minmax(0, 1fr); }",
    ".nav .counts { flex-wrap: wrap; }",
    ".entry { flex-wrap: wrap; row-gap: 4px; }",
    ".entry > .lead:empty { display: none; }",
    ".entry > .meter.wide { order: 4; flex: 1 1 100%; }",
    ".more { padding-left: 10px; }",
  ])
    assert.ok(narrow.includes(rule), rule);
  const css = STYLE(page);
  assert.ok(css.includes(".scroll-x { overflow-x: auto;"));
  assert.ok(
    css.includes(
      ".bento.pair { grid-template-columns: minmax(0, 7fr) minmax(0, 5fr); }",
    ),
  );
  // The fixed widths of a desktop row add up to less than 390px once the
  // narrow rules let the meter and the lead take lines of their own: the
  // widest fixed cell left on a line is the reset (128px), which the narrow
  // rules release.
  assert.ok(
    narrow.includes(
      ".entry > .when { order: 6; flex: 0 0 auto; margin-left: auto; }",
    ),
  );
  assert.ok(
    narrow.includes(
      ".entry > .figure.leading { order: 0; flex: 1 1 100%; min-width: 0; }",
    ),
  );
  assert.ok(narrow.includes(".entry > .meter:not(.wide) { order: 2; }"));
});
