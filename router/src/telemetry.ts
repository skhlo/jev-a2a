// What the router last saw of each served session beyond its readiness:
// the adapter's snapshot, reduced to the fields the board shows. It is not
// part of the record: an observation is journaled only when readiness or
// the session changes, and a snapshot changes every run (`updatedAt`,
// tokens). The shell writes it whole after each run's observations as
// `telemetry.json` beside the journal, replacing the file by rename; the
// board and `router status` read it without a lock and show what they
// find, with the time it was taken. A missing or unreadable file is "no
// telemetry", never a fault.
import { readFileSync, renameSync, writeFileSync } from "node:fs";
import { join } from "node:path";

export const TELEMETRY_VERSION = "jev-router-telemetry/1";

// Paseo's statuses, plus the two the router adds when it got no snapshot.
const STATUSES = [
  "idle",
  "running",
  "initializing",
  "error",
  "closed",
  "missing",
  "unreachable",
] as const;
export type AgentStatus = (typeof STATUSES)[number];

const ATTENTIONS = ["finished", "error", "permission"] as const;
export type Attention = (typeof ATTENTIONS)[number];

export type AgentSnapshot = {
  seen: string;
  status: AgentStatus;
  attention: Attention | null;
  turnStartedAt: string | null;
  lastUserMessageAt: string | null;
  permissions: {
    id: string;
    name: string;
    title: string | null;
    kind: string;
  }[];
  provider: string | null;
  model: string | null;
  thinking: string | null;
  mode: string | null;
  // Both bounds, max above zero; null when the provider reports no window.
  context: { used: number; max: number } | null;
  // Token counts since the session started; costUsd null when the provider
  // reports none.
  usage: {
    input: number;
    cached: number;
    output: number;
    costUsd: number | null;
  } | null;
  error: string | null;
  title: string | null;
  cwd: string | null;
};

export type Telemetry = {
  version: typeof TELEMETRY_VERSION;
  at: string;
  placements: Record<string, AgentSnapshot>;
};

// A snapshot for a session the router got nothing from: the daemon does not
// know the agent (`missing`), or the host could not be reached
// (`unreachable`, with the failure as `error`).
export function emptySnapshot(
  seen: string,
  status: "missing" | "unreachable",
  error: string | null = null,
): AgentSnapshot {
  return {
    seen,
    status,
    attention: null,
    turnStartedAt: null,
    lastUserMessageAt: null,
    permissions: [],
    provider: null,
    model: null,
    thinking: null,
    mode: null,
    context: null,
    usage: null,
    error,
    title: null,
    cwd: null,
  };
}

export const telemetryPath = (home: string): string =>
  join(home, "telemetry.json");

// Replaces the file whole, so a reader never sees a partial one.
export function writeTelemetry(home: string, telemetry: Telemetry): void {
  const path = telemetryPath(home);
  const tmp = `${path}.${process.pid}.tmp`;
  writeFileSync(tmp, `${JSON.stringify(telemetry, null, 2)}\n`);
  renameSync(tmp, path);
}

// Null when there is no file or it is not a telemetry file of this version;
// `onError` hears why when it was there and unreadable, and which entries
// a damaged file lost.
export function readTelemetry(
  home: string,
  onError: (message: string) => void = () => undefined,
): Telemetry | null {
  let text: string;
  try {
    text = readFileSync(telemetryPath(home), "utf8");
  } catch (error: unknown) {
    if (isMissing(error)) return null;
    onError(`telemetry.json unreadable: ${describe(error)}`);
    return null;
  }
  let value: unknown;
  try {
    value = JSON.parse(text);
  } catch (error: unknown) {
    onError(`telemetry.json is not JSON: ${describe(error)}`);
    return null;
  }
  const telemetry = parseTelemetry(value, onError);
  if (!telemetry) onError("telemetry.json is not a telemetry file");
  return telemetry;
}

const isMissing = (error: unknown): boolean =>
  typeof error === "object" &&
  error !== null &&
  "code" in error &&
  error.code === "ENOENT";

const describe = (error: unknown): string =>
  error instanceof Error ? error.message : String(error);

const isRecord = (value: unknown): value is Record<string, unknown> =>
  typeof value === "object" && value !== null && !Array.isArray(value);

const str = (value: unknown): string | null =>
  typeof value === "string" ? value : null;

// A finite count, or null: a missing or odd number must not become a zero
// that divides.
const num = (value: unknown): number | null =>
  typeof value === "number" && Number.isFinite(value) ? value : null;

// Reads a file this module wrote; anything else is null. Snapshots that do
// not parse are dropped one by one, with a word each, so one bad entry
// hides one placement.
export function parseTelemetry(
  value: unknown,
  onError: (message: string) => void = () => undefined,
): Telemetry | null {
  if (
    !isRecord(value) ||
    value.version !== TELEMETRY_VERSION ||
    typeof value.at !== "string" ||
    !isRecord(value.placements)
  )
    return null;
  const placements: Record<string, AgentSnapshot> = {};
  for (const [key, raw] of Object.entries(value.placements)) {
    const snapshot = parseSnapshot(raw);
    if (snapshot) placements[key] = snapshot;
    else onError(`telemetry.json: the entry for ${key} is not a snapshot`);
  }
  return { version: TELEMETRY_VERSION, at: value.at, placements };
}

function parseSnapshot(value: unknown): AgentSnapshot | null {
  if (!isRecord(value) || typeof value.seen !== "string") return null;
  const status = STATUSES.find((s) => s === value.status);
  if (!status) return null;
  const attention = ATTENTIONS.find((a) => a === value.attention) ?? null;
  const used = isRecord(value.context) ? num(value.context.used) : null;
  const max = isRecord(value.context) ? num(value.context.max) : null;
  const context =
    used !== null && max !== null && max > 0 ? { used, max } : null;
  const usage = isRecord(value.usage)
    ? {
        input: num(value.usage.input) ?? 0,
        cached: num(value.usage.cached) ?? 0,
        output: num(value.usage.output) ?? 0,
        costUsd: num(value.usage.costUsd),
      }
    : null;
  const permissions = Array.isArray(value.permissions)
    ? value.permissions.flatMap((p: unknown) =>
        isRecord(p) && typeof p.id === "string" && typeof p.name === "string"
          ? [
              {
                id: p.id,
                name: p.name,
                title: str(p.title),
                kind: str(p.kind) ?? "",
              },
            ]
          : [],
      )
    : [];
  return {
    seen: value.seen,
    status,
    attention,
    turnStartedAt: str(value.turnStartedAt),
    lastUserMessageAt: str(value.lastUserMessageAt),
    permissions,
    provider: str(value.provider),
    model: str(value.model),
    thinking: str(value.thinking),
    mode: str(value.mode),
    context,
    usage,
    error: str(value.error),
    title: str(value.title),
    cwd: str(value.cwd),
  };
}

// One line of a snapshot, as `router status` prints it under the placement.
export function agentLine(agent: AgentSnapshot): string {
  const parts: string[] = [agent.status];
  if (agent.attention) parts.push(`attention: ${agent.attention}`);
  if (agent.turnStartedAt) parts.push(`turn since ${agent.turnStartedAt}`);
  if (agent.permissions.length)
    parts.push(`waiting on ${agent.permissions.map((p) => p.name).join(", ")}`);
  if (agent.context)
    parts.push(
      `context ${agent.context.used}/${agent.context.max} (${Math.round((100 * agent.context.used) / agent.context.max)}%)`,
    );
  const harness = [agent.provider, agent.model].filter(Boolean).join("/");
  if (harness)
    parts.push(
      [harness, agent.thinking, agent.mode].filter(Boolean).join(" · "),
    );
  if (agent.usage?.costUsd !== null && agent.usage?.costUsd !== undefined)
    parts.push(`$${agent.usage.costUsd.toFixed(2)}`);
  if (agent.error) parts.push(`error: ${agent.error}`);
  return `${parts.join(" · ")} · seen ${agent.seen}`;
}
