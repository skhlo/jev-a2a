// Usage: what this host's accounts allow and have used, read with this
// host's own logins. A port of the account part of API Dash (skhlo/dotfiles,
// scripts/api-dash/model.ts): the four accounts, the normalizers that turn a
// provider's payload into a reading, when a reading is stale, and the store
// `router serve` keeps in memory and refreshes on its own cadence. Nothing
// here does I/O: usage-readers.ts reads the providers, usage-details.ts
// shapes the history behind an account, and the board model carries
// `usageView` of the store for the Usage tab and the JSON.
//
// The rules API Dash settled: absent is never zero (a value the provider did
// not send is left out, not counted as 0); a failed source keeps its last
// reading with its original time; a reading is stale after ten minutes, with
// a time in the future, or once a window's reset has passed; history alone
// never stands for a current allowance. Provider error text and credentials
// never enter a reading.

export const ACCOUNTS = [
  {
    id: "codex",
    name: "Codex",
    kind: "subscription",
    url: "https://chatgpt.com/codex/settings/usage",
  },
  {
    id: "claude",
    name: "Claude",
    kind: "subscription",
    url: "https://claude.ai/settings/usage",
  },
  {
    id: "deepseek",
    name: "DeepSeek",
    kind: "api",
    url: "https://platform.deepseek.com/usage",
  },
  {
    id: "openrouter",
    name: "OpenRouter",
    kind: "api",
    url: "https://openrouter.ai/activity",
  },
] as const;
export type AccountId = (typeof ACCOUNTS)[number]["id"];
export type AccountKind = (typeof ACCOUNTS)[number]["kind"];
export const ACCOUNT_IDS: AccountId[] = ACCOUNTS.map((a) => a.id);

// The labels the Usage view places by name, written here by the
// normalizers and read there: the balance a row leads with, an API key's
// figures and allowance, and the word a window's label ends with.
export const LABEL = {
  accountBalance: "Account balance",
  balance: "Balance",
  keyRemaining: "Key remaining",
  keyLimit: "Key limit",
  keyAllowance: "Key allowance",
} as const;
export const WINDOW_SUFFIX = " window";

// A quota window: the share used, its length when the provider names it
// (which the pace marker needs) and when it resets.
export type QuotaWindow = {
  label: string;
  usedPercent: number;
  minutes: number | null;
  resetsAt: number | null;
};
// A value is a number, or words for one that is not (Codex's "Unlimited").
export type Metric = {
  label: string;
  value: number | string;
  unit: string | null;
};
// A column's format says what its cells are: a count, an amount in USD, a
// calendar date, a name a machine wrote (a model or a provider), or words.
export type DataTable = {
  title: string;
  columns: {
    key: string;
    label: string;
    format: "number" | "USD" | "date" | "name" | null;
  }[];
  rows: Record<string, string | number | null>[];
};
// History behind an account, account-wide, with its own time and
// freshness: a reading of the current allowance can be fresh while its
// history is not.
export type UsageDetail = {
  title: string;
  observedAt: number;
  status: "ready" | "stale";
  // The latest day the history reports, not the day it was read.
  throughDate: string | null;
  metrics: Metric[];
  tables: DataTable[];
  notice: string | null;
};
// Whether the reading holds a current allowance: `unavailable` is a reading
// of history alone.
export type Allowance = "ready" | "stale" | "unavailable";
export type Reading = {
  allowance: Allowance;
  source: string;
  observedAt: number;
  windows: QuotaWindow[];
  metrics: Metric[];
  notice: string | null;
  details: UsageDetail[];
};
export type AccountStatus = "loading" | "ready" | "stale" | "unavailable";
export type AccountState = {
  id: AccountId;
  name: string;
  kind: AccountKind;
  url: string;
  status: AccountStatus;
  // When the last refresh of this account ended, whatever its outcome.
  checkedAt: number | null;
  reading: Reading | null;
  // The router's own sentence for the last refresh's failure, never the
  // provider's text; null after a refresh that succeeded.
  error: string | null;
};

// A reader's failure in the router's own words, safe to show. Any other
// error shows as a fixed sentence for the account.
export class ReadError extends Error {
  override name = "ReadError";
}

export function record(value: unknown): Record<string, unknown> {
  return value !== null && typeof value === "object" && !Array.isArray(value)
    ? (value as Record<string, unknown>)
    : {};
}
export function number(value: unknown): number | null {
  if (typeof value !== "number" && typeof value !== "string") return null;
  if (typeof value === "string" && !value.trim()) return null;
  const n = Number(value);
  return Number.isFinite(n) ? n : null;
}
// A calendar date as YYYY-MM-DD, or null for anything else, including a
// date that does not exist (2026-02-30).
export function calendarDate(value: unknown): string | null {
  if (typeof value !== "string" || !/^\d{4}-\d{2}-\d{2}$/.test(value))
    return null;
  const midnight = Date.parse(`${value}T00:00:00Z`);
  return Number.isFinite(midnight) &&
    new Date(midnight).toISOString().slice(0, 10) === value
    ? value
    : null;
}
// Seconds since the epoch, or an ISO date or date-time with its offset, as
// milliseconds; anything else, or a calendar date that does not exist, null.
export function timestamp(value: unknown): number | null {
  if (typeof value === "number") {
    const ms = value * 1000;
    return Number.isFinite(ms) && Math.abs(ms) <= 8.64e15 ? ms : null;
  }
  if (
    typeof value !== "string" ||
    !/^\d{4}-\d{2}-\d{2}(?:T(?:[01]\d|2[0-3]):[0-5]\d:[0-5]\d(?:\.\d{1,9})?(?:Z|[+-](?:[01]\d|2[0-3]):[0-5]\d))?$/.test(
      value,
    )
  )
    return null;
  if (!calendarDate(value.slice(0, 10))) return null;
  const n = Date.parse(value);
  return Number.isFinite(n) ? n : null;
}
function quota(
  label: string,
  percent: unknown,
  reset: unknown,
  minutes: number | null,
): QuotaWindow[] {
  const n = number(percent);
  return n === null || n < 0
    ? []
    : [{ label, usedPercent: n, minutes, resetsAt: timestamp(reset) }];
}
function positive(value: unknown): number | null {
  const n = number(value);
  return n !== null && n > 0 ? n : null;
}
function duration(minutes: number | null): string {
  if (minutes === null) return `Current${WINDOW_SUFFIX}`;
  return minutes % 1440 === 0
    ? `${minutes / 1440}-day${WINDOW_SUFFIX}`
    : minutes % 60 === 0
      ? `${minutes / 60}-hour${WINDOW_SUFFIX}`
      : `${minutes}-minute${WINDOW_SUFFIX}`;
}
// A money metric, left out when the provider sent no amount.
function moneyMetric(label: string, value: unknown, unit = "USD"): Metric[] {
  const n = number(value);
  return n === null ? [] : [{ label, value: n, unit }];
}
const reading = (
  source: string,
  observedAt: number,
  windows: QuotaWindow[],
  metrics: Metric[],
  notice: string | null = null,
): Reading => ({
  allowance: "ready",
  source,
  observedAt,
  windows,
  metrics,
  notice,
  details: [],
});

// `account/rateLimits/read` from the Codex app-server: the codex bucket
// first, then any other limit by its name.
export function codexReading(value: unknown, now: number): Reading {
  const data = record(value);
  const buckets = record(data.rateLimitsByLimitId);
  const entries = Object.keys(buckets).length
    ? Object.entries(buckets).sort(([a], [b]) =>
        a === "codex" ? -1 : b === "codex" ? 1 : a.localeCompare(b),
      )
    : [["codex", data.rateLimits]];
  const windows: QuotaWindow[] = [];
  const metrics: Metric[] = [];
  for (const [id, raw] of entries) {
    const bucket = record(raw);
    const prefix =
      id === "codex"
        ? ""
        : `${typeof bucket.limitName === "string" && bucket.limitName ? bucket.limitName : String(id)} · `;
    for (const name of ["primary", "secondary"]) {
      const w = record(bucket[name]);
      const minutes = positive(w.windowDurationMins);
      windows.push(
        ...quota(
          prefix + duration(minutes),
          w.usedPercent,
          w.resetsAt,
          minutes,
        ),
      );
    }
    if (id === "codex") {
      if (typeof bucket.planType === "string")
        metrics.push({ label: "Plan", value: bucket.planType, unit: null });
      const credits = record(bucket.credits);
      const balance = number(credits.balance);
      if (credits.unlimited === true)
        metrics.push({ label: "Credits", value: "Unlimited", unit: null });
      else if (balance !== null)
        metrics.push({ label: "Credits", value: balance, unit: null });
    }
  }
  if (!windows.length && !metrics.length)
    throw new ReadError("Codex did not return subscription usage.");
  return reading("Codex account usage", now, windows, metrics);
}

// Claude's OAuth usage endpoint.
const CLAUDE_WINDOWS: [string, string, number | null][] = [
  ["five_hour", `5-hour${WINDOW_SUFFIX}`, 300],
  ["seven_day", `7-day${WINDOW_SUFFIX}`, 10080],
  ["seven_day_opus", "7-day · Opus", 10080],
  ["seven_day_sonnet", "7-day · Sonnet", 10080],
  ["seven_day_overage_included", "Included extra usage", null],
];
export function claudeReading(value: unknown, now: number): Reading {
  const data = record(value);
  const windows: QuotaWindow[] = [];
  for (const [key, label, minutes] of CLAUDE_WINDOWS) {
    const w = record(data[key]);
    windows.push(...quota(label, w.utilization, w.resets_at, minutes));
  }
  const extra = record(data.extra_usage);
  const cents = (value: unknown): number | null => {
    const n = number(value);
    return n === null ? null : n / 100;
  };
  const metrics =
    extra.is_enabled === true
      ? [
          ...moneyMetric("Extra usage spent", cents(extra.used_credits)),
          ...moneyMetric("Extra usage limit", cents(extra.monthly_limit)),
        ]
      : [];
  if (!windows.length && !metrics.length)
    throw new ReadError("Claude did not return subscription usage.");
  return reading("Claude usage", now, windows, metrics);
}

// OpenRouter's key endpoint (the key's limit and spend) and its credits
// endpoint (the account's balance, which needs a management key). Either
// may be absent.
export function openrouterReading(
  keyValue: unknown,
  creditsValue: unknown,
  now: number,
): Reading {
  const key = record(record(keyValue).data);
  const credits = record(record(creditsValue).data);
  const purchased = number(credits.total_credits);
  const spent = number(credits.total_usage);
  const metrics: Metric[] = [];
  if (purchased !== null && spent !== null)
    metrics.push(...moneyMetric(LABEL.accountBalance, purchased - spent));
  metrics.push(
    ...moneyMetric(LABEL.keyRemaining, key.limit_remaining),
    ...moneyMetric(LABEL.keyLimit, key.limit),
    ...moneyMetric("Key spend today", key.usage_daily),
    ...moneyMetric("Key spend this week", key.usage_weekly),
    ...moneyMetric("Key spend this month", key.usage_monthly),
  );
  const limit = number(key.limit);
  const remaining = number(key.limit_remaining);
  const windows =
    limit !== null && limit > 0 && remaining !== null
      ? quota(
          LABEL.keyAllowance,
          Math.max(0, ((limit - remaining) / limit) * 100),
          null,
          null,
        )
      : [];
  if (!metrics.length && !windows.length)
    throw new ReadError("OpenRouter did not return account or key usage.");
  return reading("OpenRouter API", now, windows, metrics);
}

// DeepSeek's balance endpoint: each currency's balance and its parts.
export function deepseekReading(value: unknown, now: number): Reading {
  const data = record(value);
  const metrics: Metric[] = [];
  for (const raw of Array.isArray(data.balance_infos)
    ? data.balance_infos
    : []) {
    const balance = record(raw);
    if (balance.currency !== "USD" && balance.currency !== "CNY") continue;
    metrics.push(
      ...moneyMetric(LABEL.balance, balance.total_balance, balance.currency),
      ...moneyMetric("Topped up", balance.topped_up_balance, balance.currency),
      ...moneyMetric("Granted", balance.granted_balance, balance.currency),
    );
  }
  if (!metrics.length)
    throw new ReadError("DeepSeek did not return a balance.");
  return reading(
    "DeepSeek balance API",
    now,
    [],
    metrics,
    data.is_available === false
      ? "Balance is insufficient for API calls."
      : null,
  );
}

// Ten minutes old, more than a minute in the future, or past a window's
// reset: the reading no longer says what is allowed now.
const STALE_MS = 10 * 60_000;
const SKEW_MS = 60_000;
export const aged = (observedAt: number, now: number): boolean =>
  now - observedAt > STALE_MS || observedAt > now + SKEW_MS;
export function isStale(reading: Reading, now: number): boolean {
  return (
    reading.allowance === "stale" ||
    aged(reading.observedAt, now) ||
    reading.windows.some((w) => w.resetsAt !== null && w.resetsAt <= now)
  );
}

// The accounts as of `now`: a reading of history alone is unavailable, and
// one kept from before a failed refresh, or aged, is stale, as is any
// detail of an account whose last refresh failed.
export function snapshot(
  accounts: AccountState[],
  now: number,
): AccountState[] {
  return accounts.map((s) => ({
    ...s,
    status:
      s.reading?.allowance === "unavailable"
        ? "unavailable"
        : s.reading && (s.error || isStale(s.reading, now))
          ? "stale"
          : s.status,
    reading: s.reading && {
      ...s.reading,
      details: s.reading.details.map((d) => ({
        ...d,
        status:
          s.error || d.status === "stale" || aged(d.observedAt, now)
            ? "stale"
            : "ready",
      })),
    },
  }));
}

// The fixed sentence for a failed refresh when the reader gave none of its
// own.
const failed = (account: AccountState): string =>
  account.id === "claude"
    ? "Could not refresh. Open Claude Code and run /login, then /usage."
    : account.kind === "api"
      ? "Could not refresh. Check the provider's API key on this host."
      : "Could not refresh. Check the sign-in on the provider's usage page.";

export type Loader = () => Promise<Reading>;
export type UsageStore = {
  // The accounts as last refreshed, and when that refresh ended (null
  // before the first).
  state(): { at: number | null; accounts: AccountState[] };
  // Reads every account; a refresh asked for while one runs is that one.
  refresh(): Promise<void>;
};

// The store of the accounts that have a loader, in the accounts' order.
// Each refresh reads every account at once; one failure never hides another.
export function createUsageStore(
  loaders: Partial<Record<AccountId, Loader>>,
  clock: () => number = Date.now,
): UsageStore {
  const states: AccountState[] = ACCOUNTS.filter((a) => loaders[a.id]).map(
    (a) => ({
      ...a,
      status: "loading",
      checkedAt: null,
      reading: null,
      error: null,
    }),
  );
  let at: number | null = null;
  let pending: Promise<void> | undefined;
  return {
    state: () => ({ at, accounts: states.map((s) => ({ ...s })) }),
    refresh() {
      if (pending) return pending;
      pending = Promise.all(
        states.map(async (s) => {
          const load = loaders[s.id];
          try {
            if (!load) throw new Error("No loader.");
            s.reading = await load();
            s.status =
              s.reading.allowance === "unavailable"
                ? "unavailable"
                : isStale(s.reading, clock())
                  ? "stale"
                  : "ready";
            s.error = null;
          } catch (error: unknown) {
            s.status = s.reading ? "stale" : "unavailable";
            s.error = error instanceof ReadError ? error.message : failed(s);
          }
          s.checkedAt = clock();
        }),
      )
        .then(() => {
          at = clock();
        })
        .finally(() => {
          pending = undefined;
        });
      return pending;
    },
  };
}

// What the board model carries: the store at `now`, with every time an ISO
// string and null for what was not read.
export type UsageState = {
  at: number | null;
  every: number;
  accounts: AccountState[];
};
export type WindowView = {
  label: string;
  usedPercent: number;
  minutes: number | null;
  resetsAt: string | null;
};
export type DetailView = Omit<UsageDetail, "observedAt"> & {
  observedAt: string;
};
export type ReadingView = Omit<
  Reading,
  "observedAt" | "windows" | "details"
> & {
  observedAt: string;
  windows: WindowView[];
  details: DetailView[];
};
export type AccountView = Omit<AccountState, "checkedAt" | "reading"> & {
  checkedAt: string | null;
  reading: ReadingView | null;
};
export type UsageView = {
  // When the last refresh ended; null before the first.
  at: string | null;
  // Seconds between refreshes.
  every: number;
  accounts: AccountView[];
};

const iso = (ms: number): string => new Date(ms).toISOString();
const isoOrNull = (ms: number | null): string | null =>
  ms === null ? null : iso(ms);

// The state as the page and the JSON carry it, with ISO times. A deep
// copy: changing the view changes nothing the store holds.
export function usageView(state: UsageState, now: number): UsageView {
  return structuredClone({
    at: isoOrNull(state.at),
    every: state.every,
    accounts: snapshot(state.accounts, now).map((a) => ({
      ...a,
      checkedAt: isoOrNull(a.checkedAt),
      reading: a.reading && {
        ...a.reading,
        observedAt: iso(a.reading.observedAt),
        windows: a.reading.windows.map((w) => ({
          ...w,
          resetsAt: isoOrNull(w.resetsAt),
        })),
        details: a.reading.details.map((d) => ({
          ...d,
          observedAt: iso(d.observedAt),
        })),
      },
    })),
  });
}
