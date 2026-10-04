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

// The session's directory as Paseo's workspace list describes it: the
// sidebar's row (project, branch, +a −d, #n) plus the git and pull request
// state behind it. From one list per host per run, joined to the agent by
// project key and workspace name.
const WORKSPACE_KINDS = [
  "local_checkout",
  "worktree",
  "checkout",
  "directory",
] as const;
const WORKSPACE_STATUSES = [
  "running",
  "attention",
  "needs_input",
  "failed",
  "done",
] as const;
const MERGEABLES = ["UNKNOWN", "MERGEABLE", "CONFLICTING"] as const;
const CHECKS = ["success", "pending", "none", "failure"] as const;
const REVIEWS = ["pending", "approved", "changes_requested"] as const;
export type Checkout = {
  project: string;
  workspace: string;
  directory: string;
  kind: (typeof WORKSPACE_KINDS)[number];
  branch: string | null;
  remote: string | null;
  dirty: boolean | null;
  ahead: number | null;
  behind: number | null;
  // Paseo reports none for a plain checkout with nothing to diff.
  diff: { additions: number; deletions: number } | null;
  pr: {
    number: number | null;
    url: string;
    title: string;
    state: string;
    draft: boolean;
    merged: boolean;
    mergeable: (typeof MERGEABLES)[number] | null;
    checks: (typeof CHECKS)[number] | null;
    review: (typeof REVIEWS)[number] | null;
  } | null;
  status: (typeof WORKSPACE_STATUSES)[number];
  activityAt: string | null;
};

// The harness's subagents as Paseo lists them, the whole session's history:
// counts by status, and the ones still open.
export const SUBAGENT_STATUSES = [
  "running",
  "completed",
  "failed",
  "canceled",
] as const;
export type SubagentStatus = (typeof SUBAGENT_STATUSES)[number];
export type Subagent = {
  id: string;
  // The subagent's type as the harness names it (worker, Explore).
  title: string | null;
  // The first line of its brief.
  description: string | null;
  status: SubagentStatus;
  startedAt: string;
  updatedAt: string;
  // Another subagent's id when this one was spawned by a subagent.
  parent: string | null;
};
export type Subagents = {
  counts: Record<SubagentStatus, number>;
  running: Subagent[];
};
export const zeroCounts = (): Record<SubagentStatus, number> =>
  Object.fromEntries(SUBAGENT_STATUSES.map((s) => [s, 0])) as Record<
    SubagentStatus,
    number
  >;

// The tail of the session's timeline: the last few entries, oldest first,
// each cut to a line.
export const ACTIVITY_KINDS = [
  "user_message",
  "assistant_message",
  "reasoning",
  "tool_call",
  "todo",
  "error",
  "notification",
  "compaction",
  "plugin",
] as const;
export type ActivityKind = (typeof ACTIVITY_KINDS)[number];
// A tool call's states, the same words as a subagent's.
export type ToolStatus = SubagentStatus;
export type ActivityItem = {
  at: string | null;
  kind: ActivityKind;
  text: string | null;
  // A tool call's name and state; null for the other kinds.
  tool: string | null;
  status: ToolStatus | null;
};
export type Activity = {
  // User messages among the items, not the session's total.
  turns: number;
  items: ActivityItem[];
};

export type AgentSnapshot = {
  seen: string;
  status: AgentStatus;
  attention: Attention | null;
  // When the attention was raised: for `finished`, when the last turn ended.
  attentionAt: string | null;
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
  // The health sheet. Each is null when the router did not read it: the
  // sheet is off, the session was not live (a timeline fetch would resume a
  // closed one), or that read failed. An empty list is read and empty.
  checkout: Checkout | null;
  subagents: Subagents | null;
  activity: Activity | null;
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
    attentionAt: null,
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
    checkout: null,
    subagents: null,
    activity: null,
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

// One of a list of words, or null.
export const oneOf = <T extends string>(
  words: readonly T[],
  value: unknown,
): T | null => words.find((w) => w === value) ?? null;

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
  const status = oneOf(STATUSES, value.status);
  if (!status) return null;
  const attention = oneOf(ATTENTIONS, value.attention);
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
    attentionAt: str(value.attentionAt),
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
    checkout: parseCheckout(value.checkout),
    subagents: parseSubagents(value.subagents),
    activity: parseActivity(value.activity),
  };
}

const bool = (value: unknown): boolean | null =>
  typeof value === "boolean" ? value : null;

// A sheet field that does not parse reads as not read: the snapshot keeps
// its rail.
function parseCheckout(value: unknown): Checkout | null {
  if (!isRecord(value)) return null;
  const project = str(value.project);
  const workspace = str(value.workspace);
  const directory = str(value.directory);
  const kind = oneOf(WORKSPACE_KINDS, value.kind);
  const status = oneOf(WORKSPACE_STATUSES, value.status);
  if (
    project === null ||
    workspace === null ||
    directory === null ||
    !kind ||
    !status
  )
    return null;
  const additions = isRecord(value.diff) ? num(value.diff.additions) : null;
  const deletions = isRecord(value.diff) ? num(value.diff.deletions) : null;
  const pr = isRecord(value.pr) ? value.pr : null;
  const url = pr ? str(pr.url) : null;
  return {
    project,
    workspace,
    directory,
    kind,
    branch: str(value.branch),
    remote: str(value.remote),
    dirty: bool(value.dirty),
    ahead: num(value.ahead),
    behind: num(value.behind),
    diff:
      additions !== null && deletions !== null
        ? { additions, deletions }
        : null,
    pr:
      pr && url !== null
        ? {
            number: num(pr.number),
            url,
            title: str(pr.title) ?? "",
            state: str(pr.state) ?? "",
            draft: bool(pr.draft) ?? false,
            merged: bool(pr.merged) ?? false,
            mergeable: oneOf(MERGEABLES, pr.mergeable),
            checks: oneOf(CHECKS, pr.checks),
            review: oneOf(REVIEWS, pr.review),
          }
        : null,
    status,
    activityAt: str(value.activityAt),
  };
}

function parseSubagents(value: unknown): Subagents | null {
  if (
    !isRecord(value) ||
    !isRecord(value.counts) ||
    !Array.isArray(value.running)
  )
    return null;
  const counts = zeroCounts();
  for (const status of SUBAGENT_STATUSES)
    counts[status] = num(value.counts[status]) ?? 0;
  const running: Subagent[] = [];
  for (const raw of value.running) {
    if (!isRecord(raw)) return null;
    const id = str(raw.id);
    const status = oneOf(SUBAGENT_STATUSES, raw.status);
    const startedAt = str(raw.startedAt);
    const updatedAt = str(raw.updatedAt);
    if (id === null || !status || startedAt === null || updatedAt === null)
      return null;
    running.push({
      id,
      title: str(raw.title),
      description: str(raw.description),
      status,
      startedAt,
      updatedAt,
      parent: str(raw.parent),
    });
  }
  return { counts, running };
}

function parseActivity(value: unknown): Activity | null {
  if (!isRecord(value) || !Array.isArray(value.items)) return null;
  const items: ActivityItem[] = [];
  for (const raw of value.items) {
    if (!isRecord(raw)) return null;
    const kind = oneOf(ACTIVITY_KINDS, raw.kind);
    if (!kind) return null;
    items.push({
      at: str(raw.at),
      kind,
      text: str(raw.text),
      tool: str(raw.tool),
      status: oneOf(SUBAGENT_STATUSES, raw.status),
    });
  }
  return { turns: num(value.turns) ?? 0, items };
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
  if (agent.checkout) parts.push(checkoutLine(agent.checkout));
  if (agent.subagents?.counts.running)
    parts.push(`${agent.subagents.counts.running} subagent(s) running`);
  if (agent.error) parts.push(`error: ${agent.error}`);
  return `${parts.join(" · ")} · seen ${agent.seen}`;
}

// The sidebar's row in words: branch (starred when dirty), diff, PR and
// its checks.
export function checkoutLine(c: Checkout): string {
  const parts = [`${c.branch ?? c.kind}${c.dirty ? "*" : ""}`];
  if (c.diff) parts.push(`+${c.diff.additions} −${c.diff.deletions}`);
  if (c.pr)
    parts.push(
      `PR #${c.pr.number ?? "?"}${c.pr.checks ? ` ${c.pr.checks}` : ""}`,
    );
  return parts.join(" · ");
}
