// Usage, the model: the normalizers from provider payloads (ported from API
// Dash's tests), when a reading is stale, the store, and the view the board
// model carries.
import test from "node:test";
import assert from "node:assert/strict";
import {
  ACCOUNT_IDS,
  calendarDate,
  claudeReading,
  codexReading,
  createUsageStore,
  deepseekReading,
  isStale,
  openrouterReading,
  ReadError,
  snapshot,
  usageView,
  type AccountId,
  type AccountState,
  type Loader,
  type Reading,
} from "./usage.ts";

const now = Date.parse("2026-09-12T12:00:00Z");
const good: Reading = {
  allowance: "ready",
  source: "fixture",
  observedAt: now,
  windows: [],
  metrics: [{ label: "Balance", value: 0, unit: "USD" }],
  notice: null,
  details: [],
};
const every = (load: Loader): Record<AccountId, Loader> =>
  Object.fromEntries(ACCOUNT_IDS.map((id) => [id, load])) as Record<
    AccountId,
    Loader
  >;

test("Codex uses distinct live buckets and keeps zero, hours, lengths and reset units", () => {
  const bucket = {
    primary: {
      usedPercent: 0,
      windowDurationMins: 300,
      resetsAt: now / 1000 + 3600,
    },
    secondary: {
      usedPercent: 23,
      windowDurationMins: 10080,
      resetsAt: now / 1000 + 86400,
    },
    planType: "pro",
    credits: { balance: "0" },
  };
  const result = codexReading(
    {
      rateLimits: bucket,
      rateLimitsByLimitId: {
        codex: bucket,
        special: {
          limitName: "Spark",
          primary: { usedPercent: 75, windowDurationMins: 60 },
        },
      },
    },
    now,
  );
  assert.deepEqual(
    result.windows.map((w) => [w.label, w.usedPercent, w.minutes]),
    [
      ["5-hour window", 0, 300],
      ["7-day window", 23, 10080],
      ["Spark · 1-hour window", 75, 60],
    ],
  );
  assert.equal(result.windows[0]?.resetsAt, now + 3600_000);
  assert.equal(result.windows[2]?.resetsAt, null);
  assert.deepEqual(result.metrics, [
    { label: "Plan", value: "pro", unit: null },
    { label: "Credits", value: 0, unit: null },
  ]);
  assert.equal(result.allowance, "ready");
  // A window without a length has no pace and says so in its label.
  assert.deepEqual(
    codexReading({ rateLimits: { primary: { usedPercent: 5 } } }, now)
      .windows[0],
    { label: "Current window", usedPercent: 5, minutes: null, resetsAt: null },
  );
  assert.throws(() => codexReading({ rateLimits: {} }, now), ReadError);
});

test("Claude tells a missing window from zero quota used, and gives each window its length", () => {
  const result = claudeReading(
    {
      five_hour: { utilization: 0, resets_at: "2026-09-12T17:00:00Z" },
      seven_day: { utilization: 65 },
      seven_day_opus: null,
      seven_day_overage_included: { utilization: 10 },
    },
    now,
  );
  assert.deepEqual(
    result.windows.map((w) => [w.label, w.usedPercent, w.minutes, w.resetsAt]),
    [
      ["5-hour window", 0, 300, Date.parse("2026-09-12T17:00:00Z")],
      ["7-day window", 65, 10080, null],
      ["Included extra usage", 10, null, null],
    ],
  );
  assert.deepEqual(
    claudeReading({ extra_usage: { is_enabled: true, used_credits: 0 } }, now)
      .metrics,
    [{ label: "Extra usage spent", value: 0, unit: "USD" }],
  );
  assert.throws(() =>
    claudeReading({ error: { type: "authentication_error" } }, now),
  );
});

test("OpenRouter keeps the account balance apart from the key and works without management data", () => {
  const key = {
    data: {
      limit: 20,
      limit_remaining: 16,
      usage_daily: 0,
      usage_weekly: 2,
      usage_monthly: 4,
    },
  };
  const result = openrouterReading(
    key,
    { data: { total_credits: 30, total_usage: 15 } },
    now,
  );
  assert.deepEqual(result.metrics[0], {
    label: "Account balance",
    value: 15,
    unit: "USD",
  });
  assert.equal(result.metrics[1]?.value, 16);
  assert.deepEqual(result.windows, [
    { label: "Key allowance", usedPercent: 20, minutes: null, resetsAt: null },
  ]);
  const partial = openrouterReading(key, null, now);
  assert.equal(
    partial.metrics.some((m) => m.label === "Account balance"),
    false,
  );
  assert.equal(
    partial.metrics.find((m) => m.label === "Key spend today")?.value,
    0,
  );
  assert.throws(() => openrouterReading(null, null, now));
});

test("DeepSeek keeps every currency and never turns a missing balance into zero", () => {
  const result = deepseekReading(
    {
      is_available: false,
      balance_infos: [
        { currency: "USD", total_balance: "0.00" },
        { currency: "CNY", total_balance: "12.34" },
        { currency: "EUR", total_balance: "9" },
      ],
    },
    now,
  );
  assert.deepEqual(
    result.metrics.map((m) => [m.value, m.unit]),
    [
      [0, "USD"],
      [12.34, "CNY"],
    ],
  );
  assert.match(result.notice ?? "", /insufficient/);
  assert.throws(() =>
    deepseekReading({ balance_infos: [{ currency: "USD" }] }, now),
  );
});

test("a calendar date is a day that exists, written YYYY-MM-DD, and the times and the histories both use that check", () => {
  assert.equal(calendarDate("2026-09-30"), "2026-09-30");
  assert.equal(calendarDate("2028-02-29"), "2028-02-29");
  for (const bad of [
    "2026-02-30",
    "2026-13-01",
    "2026-9-30",
    "2026-09-30Z",
    20260930,
  ])
    assert.equal(calendarDate(bad), null, String(bad));
  // A reset on a day that does not exist is no reset.
  assert.equal(
    claudeReading(
      { five_hour: { utilization: 1, resets_at: "2026-02-30T10:00:00Z" } },
      now,
    ).windows[0]?.resetsAt,
    null,
  );
});

test("a reading is stale after ten minutes, a minute in the future, or past a reset", () => {
  assert.equal(isStale(good, now + 10 * 60_000), false);
  assert.equal(isStale(good, now + 10 * 60_000 + 1), true);
  assert.equal(isStale({ ...good, observedAt: now + 61_000 }, now), true);
  assert.equal(isStale({ ...good, allowance: "stale" }, now), true);
  const window = { label: "5h", usedPercent: 10, minutes: 300 };
  assert.equal(
    isStale({ ...good, windows: [{ ...window, resetsAt: now }] }, now),
    true,
  );
  assert.equal(
    isStale({ ...good, windows: [{ ...window, resetsAt: now + 1 }] }, now),
    false,
  );
});

test("a failed refresh keeps the last reading and its time, and hides the provider's error", async () => {
  let time = now;
  let fail: Error | null = null;
  const store = createUsageStore(
    every(async () => {
      if (fail) throw fail;
      return { ...good, observedAt: time };
    }),
    () => time,
  );
  assert.deepEqual(
    store.state().accounts.map((a) => a.status),
    ["loading", "loading", "loading", "loading"],
  );
  assert.equal(store.state().at, null);
  await store.refresh();
  assert.equal(store.state().at, now);
  fail = new Error("Bearer fixture-secret from the provider");
  time += 60_000;
  await store.refresh();
  const [codex, claude, deepseek] = snapshot(store.state().accounts, time);
  assert.equal(codex?.status, "stale");
  assert.equal(codex?.reading?.observedAt, now);
  assert.equal(codex?.checkedAt, time);
  assert.match(codex?.error ?? "", /sign-in/);
  assert.match(claude?.error ?? "", /\/login/);
  assert.match(deepseek?.error ?? "", /API key/);
  assert.equal(JSON.stringify(store.state()).includes("fixture-secret"), false);
  // A reader's own sentence is shown as it is.
  fail = new ReadError("No DeepSeek API key on this host.");
  await store.refresh();
  assert.equal(
    store.state().accounts[2]?.error,
    "No DeepSeek API key on this host.",
  );
  // A source never read is unavailable with no reading; one read again is
  // current and its error is gone.
  const fresh = createUsageStore({
    deepseek: async () => Promise.reject(fail),
  });
  await fresh.refresh();
  assert.deepEqual(
    fresh.state().accounts.map((a) => [a.id, a.status, a.reading]),
    [["deepseek", "unavailable", null]],
  );
  fail = null;
  await store.refresh();
  assert.equal(store.state().accounts[2]?.error, null);
  assert.equal(snapshot(store.state().accounts, time)[2]?.status, "ready");
});

test("refreshes asked for while one runs are that one; the store holds only the accounts it has loaders for", async () => {
  let reads = 0;
  const store = createUsageStore(
    {
      codex: async () => {
        reads++;
        await new Promise((resolve) => setTimeout(resolve, 10));
        return good;
      },
      openrouter: async () => good,
    },
    () => now,
  );
  await Promise.all([store.refresh(), store.refresh(), store.refresh()]);
  assert.equal(reads, 1);
  await store.refresh();
  assert.equal(reads, 2);
  assert.deepEqual(
    store.state().accounts.map((a) => a.id),
    ["codex", "openrouter"],
  );
});

test("history alone reads unavailable; details age apart from the allowance and go stale with a failed refresh", () => {
  const detail = {
    title: "Token activity",
    observedAt: now,
    status: "ready" as const,
    throughDate: "2026-09-11",
    metrics: [],
    tables: [],
    notice: null,
  };
  const reading: Reading = { ...good, details: [detail] };
  const account: AccountState = {
    id: "codex",
    name: "Codex",
    kind: "subscription",
    url: "https://x",
    status: "ready",
    checkedAt: now,
    error: null,
    reading,
  };
  const at = (t: number, a = account) => snapshot([a], t)[0];
  assert.equal(at(now)?.status, "ready");
  assert.equal(at(now)?.reading?.details[0]?.status, "ready");
  assert.equal(at(now + 11 * 60_000)?.reading?.details[0]?.status, "stale");
  const historyOnly = {
    ...account,
    reading: { ...reading, allowance: "unavailable" as const },
  };
  assert.equal(at(now, historyOnly)?.status, "unavailable");
  assert.equal(at(now, historyOnly)?.reading?.details[0]?.status, "ready");
  const failed = { ...account, error: "Could not refresh." };
  assert.equal(at(now, failed)?.status, "stale");
  assert.equal(at(now, failed)?.reading?.details[0]?.status, "stale");
});

test("the view: every time an ISO string, null for what was not read", () => {
  const view = usageView(
    {
      at: null,
      every: 120,
      accounts: [
        {
          id: "claude",
          name: "Claude",
          kind: "subscription",
          url: "https://claude.ai/settings/usage",
          status: "ready",
          checkedAt: now,
          error: null,
          reading: {
            ...good,
            windows: [
              {
                label: "5-hour window",
                usedPercent: 1,
                minutes: 300,
                resetsAt: now + 1000,
              },
              { label: "x", usedPercent: 2, minutes: null, resetsAt: null },
            ],
          },
        },
        {
          id: "deepseek",
          name: "DeepSeek",
          kind: "api",
          url: "https://platform.deepseek.com/usage",
          status: "loading",
          checkedAt: null,
          error: null,
          reading: null,
        },
      ],
    },
    now,
  );
  assert.equal(view.at, null);
  assert.equal(view.every, 120);
  assert.equal(view.accounts[0]?.checkedAt, "2026-09-12T12:00:00.000Z");
  assert.equal(
    view.accounts[0]?.reading?.observedAt,
    "2026-09-12T12:00:00.000Z",
  );
  assert.deepEqual(
    view.accounts[0]?.reading?.windows.map((w) => w.resetsAt),
    ["2026-09-12T12:00:01.000Z", null],
  );
  assert.deepEqual(view.accounts[1], {
    id: "deepseek",
    name: "DeepSeek",
    kind: "api",
    url: "https://platform.deepseek.com/usage",
    status: "loading",
    checkedAt: null,
    error: null,
    reading: null,
  });
});
