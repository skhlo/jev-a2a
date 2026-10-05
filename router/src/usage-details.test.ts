// The history behind an account: Codex's token activity and OpenRouter's
// spending, ported from API Dash's tests. Calendar dates and safe counts are
// validated; what is missing stays unknown; private fields never pass.
import test from "node:test";
import assert from "node:assert/strict";
import { codexDetails, openrouterDetails } from "./usage-details.ts";
import type { UsageDetail } from "./usage.ts";

const now = Date.parse("2026-09-13T12:00:00Z");
const metric = (detail: UsageDetail, label: string) =>
  detail.metrics.find((m) => m.label === label)?.value;
const rows = (detail: UsageDetail, title: string) =>
  detail.tables.find((t) => t.title === title)?.rows;

test("Codex history validates calendar dates and safe counts without exposing thread estimates", () => {
  const detail = codexDetails(
    {
      summary: {
        lifetimeTokens: Number.MAX_SAFE_INTEGER + 1,
        peakDailyTokens: -1,
        currentStreakDays: 0,
      },
      dailyUsageBuckets: [
        { startDate: "2026-02-30", tokens: 50 },
        { startDate: "2026-09-11garbage", tokens: 50 },
        { startDate: "2026-09-11", tokens: 1.5 },
        { startDate: "2026-09-12", tokens: "0" },
        { startDate: "2026-09-10", tokens: 7 },
      ],
      threadUsage: { estimatedUsageUsdMicros: 123456, threadId: "private-id" },
    },
    now,
  );
  // Newest first; a day with no bucket stays a gap; zero is kept.
  assert.deepEqual(rows(detail, "Daily token history"), [
    { date: "2026-09-12", tokens: 0 },
    { date: "2026-09-10", tokens: 7 },
  ]);
  assert.deepEqual(detail.metrics, [
    { label: "Current streak", value: 0, unit: "days" },
  ]);
  assert.equal(detail.throughDate, "2026-09-12");
  assert.equal(detail.observedAt, now);
  assert.equal(JSON.stringify(detail).includes("123456"), false);
  assert.equal(JSON.stringify(detail).includes("private"), false);
  assert.throws(() =>
    codexDetails(
      { dailyUsageBuckets: [{ startDate: "2026-02-30", tokens: 1 }] },
      now,
    ),
  );
  assert.throws(() => codexDetails({}, now));
  const empty = codexDetails({ dailyUsageBuckets: [] }, now);
  assert.deepEqual(empty.metrics, []);
  assert.equal(empty.throughDate, null);
  assert.match(empty.notice ?? "", /did not return daily history/);
});

test("OpenRouter completed-day activity keeps external cost apart and missing counts unknown", () => {
  const detail = openrouterDetails(
    {
      data: [
        {
          date: "2026-09-11 00:00:00",
          model: "model-a",
          provider_name: "Provider A",
          requests: 2,
          prompt_tokens: 10,
          completion_tokens: 5,
          reasoning_tokens: 4,
          usage: 1.25,
          byok_usage_inference: 0.5,
          endpoint_id: "private-endpoint",
          user_id: "private-user",
        },
        {
          date: "2026-09-11",
          model: "model-a",
          provider_name: "Provider A",
          requests: 1,
          prompt_tokens: 2,
          completion_tokens: 3,
          reasoning_tokens: 2,
          usage: 0.75,
          byok_usage_inference: 0.25,
        },
        { date: "2026-09-13", model: "today-must-not-appear", usage: 100 },
        { date: "2026-02-30", usage: 100 },
        { date: "2026-09-10junk", usage: 100 },
        {
          date: "2026-09-09",
          model: "<img src=x>",
          provider_name: 3,
          requests: 1,
          prompt_tokens: 1,
          completion_tokens: 1,
          reasoning_tokens: 0,
          usage: 0,
          byok_usage_inference: 0,
        },
      ],
    },
    now,
  );
  assert.equal(metric(detail, "OpenRouter spend"), 2);
  assert.equal(metric(detail, "External BYOK cost"), 0.75);
  assert.equal(detail.throughDate, "2026-09-11");
  const byModel = rows(detail, "By model and provider");
  assert.equal(byModel?.length, 2);
  assert.equal(byModel?.[0]?.reasoning, 6);
  // A name that does not read as one is Unknown.
  assert.deepEqual(
    byModel?.map((r) => [r.model, r.provider]),
    [
      ["model-a", "Provider A"],
      ["Unknown", "Unknown"],
    ],
  );
  assert.deepEqual(
    rows(detail, "Daily activity")?.map((r) => r.date),
    ["2026-09-11", "2026-09-11", "2026-09-09"],
  );
  assert.match(detail.notice ?? "", /were omitted/);
  assert.equal(JSON.stringify(detail).includes("private-"), false);
  assert.equal(JSON.stringify(detail).includes("today-must-not-appear"), false);

  const missing = openrouterDetails(
    {
      data: [
        {
          date: "2026-09-11",
          model: "model-a",
          usage: 0,
          prompt_tokens: -1,
          requests: 0,
        },
      ],
    },
    now,
  );
  assert.equal(metric(missing, "OpenRouter spend"), 0);
  assert.equal(metric(missing, "External BYOK cost"), undefined);
  assert.equal(metric(missing, "Prompt + completion"), undefined);
  assert.equal(metric(missing, "Requests"), 0);
  assert.equal(rows(missing, "By model and provider")?.[0]?.output, null);
  const overflow = openrouterDetails(
    {
      data: [1, 1].map(() => ({
        date: "2026-09-11",
        requests: Number.MAX_SAFE_INTEGER,
        prompt_tokens: Number.MAX_SAFE_INTEGER,
        completion_tokens: 1,
        usage: 1e308,
      })),
    },
    now,
  );
  assert.equal(metric(overflow, "Requests"), undefined);
  assert.equal(metric(overflow, "Prompt + completion"), undefined);
  assert.equal(metric(overflow, "OpenRouter spend"), undefined);
  assert.throws(() =>
    openrouterDetails({ data: [{ date: "2026-02-30", usage: 1 }] }, now),
  );
  assert.throws(() => openrouterDetails({}, now));
  assert.deepEqual(openrouterDetails({ data: [] }, now).metrics, []);
});
