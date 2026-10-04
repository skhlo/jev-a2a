// Telemetry: Paseo's snapshot reduced to the board's fields, written whole
// beside the record and read back without a lock; what is not there or not
// readable is "no telemetry".
import test from "node:test";
import assert from "node:assert/strict";
import { mkdtempSync, readdirSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import type { PaseoAgent } from "@getpaseo/client";
import { isReady, snapshotOf } from "./paseo.ts";
import {
  agentLine,
  emptySnapshot,
  parseTelemetry,
  readTelemetry,
  TELEMETRY_VERSION,
  telemetryPath,
  writeTelemetry,
  type AgentSnapshot,
  type Telemetry,
} from "./telemetry.ts";

const SEEN = "2026-09-30T09:44:50.000Z";

// A snapshot as the daemon sends one, with every field the router reads.
const full: PaseoAgent = {
  id: "A1",
  provider: "claude",
  cwd: "/work",
  model: "claude-opus-5-5",
  thinkingOptionId: "medium",
  effectiveThinkingOptionId: "high",
  createdAt: "2026-09-30T09:00:00.000Z",
  updatedAt: SEEN,
  lastUserMessageAt: "2026-09-30T09:44:31.000Z",
  status: "running",
  activeTurn: { turnId: "t1", startedAt: "2026-09-30T09:44:31.000Z" },
  capabilities: {
    supportsStreaming: true,
    supportsSessionPersistence: true,
    supportsDynamicModes: true,
    supportsMcpServers: true,
    supportsReasoningStream: true,
    supportsToolInvocations: true,
  },
  currentModeId: "auto",
  availableModes: [],
  pendingPermissions: [
    {
      id: "p1",
      provider: "claude",
      name: "Bash",
      kind: "tool",
      title: "Run the tests",
    },
  ],
  persistence: null,
  lastUsage: {
    inputTokens: 10,
    cachedInputTokens: 20,
    outputTokens: 30,
    totalCostUsd: 1.5,
    contextWindowUsedTokens: 61_400,
    contextWindowMaxTokens: 200_000,
  },
  lastError: "boom",
  title: "router orchestrator",
  labels: {},
  attentionReason: "permission",
  attentionTimestamp: "2026-09-30T09:44:40.000Z",
};

test("snapshotOf reads every field, and nulls what the daemon left out", () => {
  assert.deepEqual(snapshotOf(full, SEEN), {
    seen: SEEN,
    status: "running",
    attention: "permission",
    attentionAt: "2026-09-30T09:44:40.000Z",
    turnStartedAt: "2026-09-30T09:44:31.000Z",
    lastUserMessageAt: "2026-09-30T09:44:31.000Z",
    permissions: [
      { id: "p1", name: "Bash", title: "Run the tests", kind: "tool" },
    ],
    provider: "claude",
    model: "claude-opus-5-5",
    // The effective level wins over the requested one.
    thinking: "high",
    mode: "auto",
    context: { used: 61_400, max: 200_000 },
    usage: { input: 10, cached: 20, output: 30, costUsd: 1.5 },
    error: "boom",
    title: "router orchestrator",
    cwd: "/work",
    // The sheet is the adapter's to fill, after the rail.
    checkout: null,
    subagents: null,
    activity: null,
  });
  const bare: PaseoAgent = {
    id: "A1",
    provider: "claude",
    cwd: "/work",
    model: null,
    createdAt: SEEN,
    updatedAt: SEEN,
    lastUserMessageAt: null,
    status: "idle",
    capabilities: full.capabilities,
    currentModeId: null,
    availableModes: [],
    pendingPermissions: [],
    persistence: null,
    title: null,
    labels: {},
  };
  assert.deepEqual(snapshotOf(bare, SEEN), {
    ...emptySnapshot(SEEN, "missing"),
    status: "idle",
    provider: "claude",
    cwd: "/work",
  });
  // A window needs both bounds; usage without one has no context, and a
  // cost the daemon did not report is null, not zero.
  assert.equal(
    snapshotOf({ ...bare, lastUsage: { inputTokens: 5 } }, SEEN).context,
    null,
  );
  assert.deepEqual(
    snapshotOf({ ...bare, lastUsage: { inputTokens: 5 } }, SEEN).usage,
    { input: 5, cached: 0, output: 0, costUsd: null },
  );
});

test("the file round-trips, is replaced whole, and anything else reads as no telemetry", () => {
  const home = mkdtempSync(join(tmpdir(), "telemetry-"));
  const errors: string[] = [];
  const onError = (message: string): void => {
    errors.push(message);
  };
  assert.equal(readTelemetry(home, onError), null);
  assert.equal(errors.length, 0);
  const telemetry: Telemetry = {
    version: TELEMETRY_VERSION,
    at: SEEN,
    placements: {
      "orchestrator@mbp": snapshotOf(full, SEEN),
      "knowledge@mini": emptySnapshot(SEEN, "unreachable", "ssh flake"),
    },
  };
  writeTelemetry(home, telemetry);
  assert.deepEqual(readTelemetry(home, onError), telemetry);
  // No temporary file is left behind.
  assert.deepEqual(readdirSync(home), ["telemetry.json"]);
  // A second write replaces the first.
  writeTelemetry(home, { ...telemetry, placements: {} });
  assert.deepEqual(readTelemetry(home, onError)?.placements, {});
  assert.equal(errors.length, 0);
  // Not JSON, then JSON that is not a telemetry file: null, with a word.
  writeFileSync(telemetryPath(home), "{");
  assert.equal(readTelemetry(home, onError), null);
  writeFileSync(telemetryPath(home), JSON.stringify({ version: "other" }));
  assert.equal(readTelemetry(home, onError), null);
  assert.deepEqual(
    errors.map((message) => message.split(":")[0]),
    ["telemetry.json is not JSON", "telemetry.json is not a telemetry file"],
  );
  // Partial damage drops the placement, named, not the file; a window
  // without a usable max or a cost that is not a number read as null, so
  // nothing divides by zero.
  const dropped: string[] = [];
  assert.deepEqual(
    parseTelemetry(
      {
        version: TELEMETRY_VERSION,
        at: SEEN,
        placements: {
          good: {
            ...emptySnapshot(SEEN, "missing"),
            context: { used: 5, max: 0 },
            usage: { input: 1, cached: 2, output: 3, costUsd: "free" },
          },
          bad: { seen: SEEN, status: "asleep" },
          worse: 7,
        },
      },
      (message) => dropped.push(message),
    ),
    {
      version: TELEMETRY_VERSION,
      at: SEEN,
      placements: {
        good: {
          ...emptySnapshot(SEEN, "missing"),
          usage: { input: 1, cached: 2, output: 3, costUsd: null },
        },
      },
    },
  );
  assert.deepEqual(dropped, [
    "telemetry.json: the entry for bad is not a snapshot",
    "telemetry.json: the entry for worse is not a snapshot",
  ]);
});

test("the sheet round-trips, and a damaged sheet field reads as not read while the rail stays", () => {
  const home = mkdtempSync(join(tmpdir(), "telemetry-"));
  const sheet: AgentSnapshot = {
    ...emptySnapshot(SEEN, "missing"),
    status: "running",
    checkout: {
      project: "A2A",
      workspace: "feat-x",
      directory: "/work/.paseo/worktrees/feat-x",
      kind: "worktree",
      branch: "feat/x",
      remote: "git@github.com:me/a2a.git",
      dirty: true,
      ahead: 2,
      behind: 0,
      diff: { additions: 10, deletions: 3 },
      pr: {
        number: 7,
        url: "https://github.com/me/a2a/pull/7",
        title: "feat: x",
        state: "OPEN",
        draft: false,
        merged: false,
        mergeable: "MERGEABLE",
        checks: "failure",
        review: null,
      },
      status: "running",
      activityAt: SEEN,
    },
    subagents: {
      counts: { running: 1, completed: 2, failed: 0, canceled: 0 },
      running: [
        {
          id: "s1",
          title: "worker",
          description: "Review the diff.",
          status: "running",
          startedAt: SEEN,
          updatedAt: SEEN,
          parent: null,
        },
      ],
    },
    activity: {
      turns: 1,
      items: [
        {
          at: SEEN,
          kind: "user_message",
          text: "go",
          tool: null,
          status: null,
        },
        {
          at: SEEN,
          kind: "tool_call",
          text: "pnpm test",
          tool: "Bash",
          status: "running",
        },
      ],
    },
  };
  const telemetry: Telemetry = {
    version: TELEMETRY_VERSION,
    at: SEEN,
    placements: { "orchestrator@mbp": sheet },
  };
  writeTelemetry(home, telemetry);
  assert.deepEqual(readTelemetry(home), telemetry);
  // A sheet field that does not parse is null; the snapshot is kept, and
  // a checkout with no git facts keeps its nulls.
  const parsed = parseTelemetry({
    version: TELEMETRY_VERSION,
    at: SEEN,
    placements: {
      a: {
        ...sheet,
        checkout: { ...sheet.checkout, kind: "tarball" },
        subagents: { counts: {}, running: [{ id: "s1" }] },
        activity: { turns: "many", items: [{ kind: "song" }] },
      },
      b: {
        ...sheet,
        checkout: { ...sheet.checkout, pr: { number: 1 }, diff: {} },
        subagents: { counts: {}, running: [] },
        activity: { items: [] },
      },
    },
  });
  assert.deepEqual(parsed?.placements.a, {
    ...sheet,
    checkout: null,
    subagents: null,
    activity: null,
  });
  assert.deepEqual(parsed?.placements.b, {
    ...sheet,
    checkout: { ...sheet.checkout, pr: null, diff: null },
    subagents: {
      counts: { running: 0, completed: 0, failed: 0, canceled: 0 },
      running: [],
    },
    activity: { turns: 0, items: [] },
  });
  // The status line carries the branch, the diff, the pull request and the
  // open subagents.
  assert.equal(
    agentLine(sheet),
    `running · feat/x* +10 −3 · PR #7 failure · 1 subagent(s) running · seen ${SEEN}`,
  );
});

test("agentLine says what matters in one line", () => {
  assert.equal(
    agentLine(snapshotOf(full, SEEN)),
    `running · attention: permission · turn since 2026-09-30T09:44:31.000Z · waiting on Bash · context 61400/200000 (31%) · claude/claude-opus-5-5 · high · auto · $1.50 · error: boom · seen ${SEEN}`,
  );
  assert.equal(
    agentLine(emptySnapshot(SEEN, "unreachable", "ssh flake")),
    `unreachable · error: ssh flake · seen ${SEEN}`,
  );
  // No cost reported: no dollar figure.
  assert.equal(
    agentLine({
      ...emptySnapshot(SEEN, "missing"),
      status: "idle",
      usage: { input: 1, cached: 0, output: 0, costUsd: null },
    }),
    `idle · seen ${SEEN}`,
  );
});

test("a session is ready when idle or closed with nothing pending: a prompt resumes a closed one, but must not unarchive one", () => {
  const statuses = [
    "idle",
    "closed",
    "running",
    "initializing",
    "error",
  ] as const;
  assert.deepEqual(
    statuses.map((status) => [
      status,
      isReady(status, 0),
      isReady(status, 1),
      isReady(status, 0, true),
    ]),
    [
      ["idle", true, false, true],
      ["closed", true, false, false],
      ["running", false, false, false],
      ["initializing", false, false, false],
      ["error", false, false, false],
    ],
  );
});
