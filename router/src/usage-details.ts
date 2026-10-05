// The history behind an account, from the provider's own records: Codex's
// token activity and OpenRouter's spending by model and provider. A port of
// API Dash's native-details.ts. Pure: the readers fetch the payloads. A
// count that is missing, negative, fractional or unsafe stays unknown, and
// an unknown operand makes its total unknown rather than undercounting.
// Claude's local statistics are not ported: current Claude Code writes no
// stats cache.
import { calendarDate, number, record } from "./usage.ts";
import type { DataTable, Metric, UsageDetail } from "./usage.ts";

// A count a provider sent: a safe whole number, not negative; else null.
const safeCount = (value: unknown): number | null => {
  const n = number(value);
  return n !== null && Number.isSafeInteger(n) && n >= 0 ? n : null;
};
const counts = (
  source: Record<string, unknown>,
  fields: [string, string, string | null][],
): Metric[] =>
  fields.flatMap(([key, label, unit]) => {
    const n = safeCount(source[key]);
    return n === null ? [] : [{ label, value: n, unit }];
  });
const column = (
  key: string,
  label: string,
  format: DataTable["columns"][number]["format"] = null,
): DataTable["columns"][number] => ({ key, label, format });

// `account/usage/read` from the Codex app-server: the summary and the daily
// token buckets; thread usage and its estimates are not read.
export function codexDetails(value: unknown, now: number): UsageDetail {
  const data = record(value);
  const summary = record(data.summary);
  const buckets = Array.isArray(data.dailyUsageBuckets)
    ? data.dailyUsageBuckets
    : null;
  const daily = (buckets ?? [])
    .flatMap((raw) => {
      const row = record(raw);
      const date = calendarDate(row.startDate);
      const tokens = safeCount(row.tokens);
      return date && tokens !== null ? [{ date, tokens }] : [];
    })
    .sort((a, b) => a.date.localeCompare(b.date));
  const metrics = counts(summary, [
    ["lifetimeTokens", "Lifetime tokens", "tokens"],
    ["peakDailyTokens", "Peak daily tokens", "tokens"],
    ["longestRunningTurnSec", "Longest turn", "seconds"],
    ["currentStreakDays", "Current streak", "days"],
    ["longestStreakDays", "Longest streak", "days"],
  ]);
  if (!metrics.length && !daily.length && buckets?.length !== 0)
    throw new Error("No Codex account history.");
  const through = daily.at(-1)?.date ?? null;
  return {
    title: "Token activity",
    observedAt: now,
    status: "ready",
    throughDate: through,
    metrics,
    tables: [
      {
        title: "Daily token history",
        columns: [
          column("date", "Date", "date"),
          column("tokens", "Tokens", "number"),
        ],
        rows: [...daily].reverse(),
      },
    ],
    notice: through
      ? `Account-wide history through ${through}. The latest reported day can lag behind the live quota.`
      : "The account did not return daily history.",
  };
}

// Unknown operands and unsafe arithmetic stay unknown, rather than undercounting.
function sum(
  a: number | null,
  b: number | null,
  integer = true,
): number | null {
  if (a === null || b === null) return null;
  const result = a + b;
  return Number.isFinite(result) && (!integer || Number.isSafeInteger(result))
    ? result
    : null;
}
function nonnegative(value: unknown): number | null {
  const n = number(value);
  return n !== null && n >= 0 ? n : null;
}
// A provider's model or provider name, when it reads as one.
function label(value: unknown): string {
  return typeof value === "string" &&
    /^[a-zA-Z0-9][a-zA-Z0-9 ._:/()-]{0,159}$/.test(value)
    ? value
    : "Unknown";
}
function optional(label: string, value: number | null, unit: string | null) {
  return value === null ? [] : [{ label, value, unit }];
}

// OpenRouter's `/activity` (a management key's view of the account): the
// last 30 completed UTC days by model and provider; today is left out, as it
// is still being counted.
export function openrouterDetails(value: unknown, now: number): UsageDetail {
  const data = record(value);
  if (!Array.isArray(data.data)) throw new Error("No OpenRouter activity.");
  const FIELDS = [
    "input",
    "output",
    "reasoning",
    "requests",
    "cost",
    "byok",
    "tokens",
  ] as const;
  type Totals = Record<(typeof FIELDS)[number], number | null>;
  const empty = (): Totals => ({
    input: 0,
    output: 0,
    reasoning: 0,
    requests: 0,
    cost: 0,
    byok: 0,
    tokens: 0,
  });
  const add = (a: Totals, b: Totals) => {
    for (const key of FIELDS)
      a[key] = sum(a[key], b[key], key !== "cost" && key !== "byok");
  };
  const models = new Map<
    string,
    { model: string; provider: string; totals: Totals }
  >();
  const rows: Record<string, string | number | null>[] = [];
  const totals = empty();
  let through: string | null = null;
  const today = new Date(now).toISOString().slice(0, 10);
  for (const raw of data.data) {
    const row = record(raw);
    const date = calendarDate(
      typeof row.date === "string"
        ? row.date.replace(/ 00:00:00$/, "")
        : row.date,
    );
    if (!date || date >= today) continue;
    const model = label(row.model_permaslug ?? row.model);
    const provider = label(row.provider_name);
    const input = safeCount(row.prompt_tokens);
    const output = safeCount(row.completion_tokens);
    const values: Totals = {
      input,
      output,
      reasoning: safeCount(row.reasoning_tokens),
      requests: safeCount(row.requests),
      cost: nonnegative(row.usage),
      byok: nonnegative(row.byok_usage_inference),
      tokens: sum(input, output),
    };
    add(totals, values);
    const key = `${model}\0${provider}`;
    const aggregate = models.get(key) ?? { model, provider, totals: empty() };
    add(aggregate.totals, values);
    models.set(key, aggregate);
    rows.push({ date, model, provider, ...values });
    if (through === null || date > through) through = date;
  }
  if (data.data.length && !rows.length)
    throw new Error("No valid completed-day OpenRouter activity.");
  return {
    title: "Model & provider spending",
    observedAt: now,
    status: "ready",
    throughDate: through,
    metrics: rows.length
      ? [
          ...optional("OpenRouter spend", totals.cost, "USD"),
          ...optional("External BYOK cost", totals.byok, "USD"),
          ...optional("Requests", totals.requests, null),
          ...optional("Prompt + completion", totals.tokens, "tokens"),
          {
            label: "Models",
            value: new Set([...models.values()].map((m) => m.model)).size,
            unit: null,
          },
        ]
      : [],
    tables: [
      {
        title: "By model and provider",
        columns: [
          column("model", "Model", "name"),
          column("provider", "Provider", "name"),
          column("requests", "Requests", "number"),
          column("input", "Input", "number"),
          column("output", "Output", "number"),
          column("reasoning", "Reasoning¹", "number"),
          column("cost", "Spend", "USD"),
          column("byok", "External BYOK", "USD"),
        ],
        rows: [...models.values()]
          .map(({ model, provider, totals }) => ({
            model,
            provider,
            ...totals,
          }))
          .sort((a, b) => (b.cost ?? -1) - (a.cost ?? -1)),
      },
      {
        title: "Daily activity",
        columns: [
          column("date", "UTC day", "date"),
          column("model", "Model", "name"),
          column("provider", "Provider", "name"),
          column("requests", "Requests", "number"),
          column("input", "Input", "number"),
          column("output", "Output", "number"),
          column("cost", "Spend", "USD"),
          column("byok", "External BYOK", "USD"),
        ],
        rows: rows.sort((a, b) => String(b.date).localeCompare(String(a.date))),
      },
    ],
    notice:
      "Last 30 completed UTC days, excluding today; today's key spend is separate. External BYOK cost is not OpenRouter credit spend. Missing or unsafe values are unavailable. ¹ Reasoning is shown separately, not added to completion tokens." +
      (rows.length < data.data.length
        ? " Invalid or incomplete-day rows were omitted."
        : ""),
  };
}
