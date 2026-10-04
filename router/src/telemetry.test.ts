// Telemetry: Paseo's snapshot reduced to the board's fields, written whole
// beside the record and read back without a lock; what is not there or not
// readable is "no telemetry".
import test from "node:test";
import assert from "node:assert/strict";
import { mkdtempSync, readdirSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import type { PaseoAgent } from "@getpaseo/client";
import {
  agentLine,
  emptySnapshot,
  parseTelemetry,
  readTelemetry,
  snapshotOf,
  TELEMETRY_VERSION,
  telemetryPath,
  writeTelemetry,
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
};

test("snapshotOf reads every field, and nulls what the daemon left out", () => {
  assert.deepEqual(snapshotOf(full, SEEN), {
    seen: SEEN,
    status: "running",
    attention: "permission",
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
  // A window needs both bounds; usage without one has no context.
  assert.equal(
    snapshotOf({ ...bare, lastUsage: { inputTokens: 5 } }, SEEN).context,
    null,
  );
  assert.deepEqual(
    snapshotOf({ ...bare, lastUsage: { inputTokens: 5 } }, SEEN).usage,
    { input: 5, cached: 0, output: 0, costUsd: 0 },
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
  // Partial damage drops the placement, not the file.
  assert.deepEqual(
    parseTelemetry({
      version: TELEMETRY_VERSION,
      at: SEEN,
      placements: {
        good: emptySnapshot(SEEN, "missing"),
        bad: { seen: SEEN, status: "asleep" },
        worse: 7,
      },
    }),
    {
      version: TELEMETRY_VERSION,
      at: SEEN,
      placements: { good: emptySnapshot(SEEN, "missing") },
    },
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
});
