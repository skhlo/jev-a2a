// Paseo adapter over @getpaseo/client. Never the CLI (random message id per
// call) and never Paseo MCP. Facts this relies on, verified in the 0.9.2
// source: the daemon keeps a receipt per (agentId, messageId); a repeat with
// the same key and text is a no-op after a completed send, and answers
// agent_request_outcome_unknown while a receipt is still pending; a send to a
// running agent interrupts its turn, so the router sends only to agents it
// has seen idle or closed. Verified in the 0.10.2 daemon: a `closed` agent is
// a persisted session whose process is not running (every agent after a
// daemon restart), and a prompt to it resumes the session first
// (sendPromptToAgent calls ensureAgentLoaded), while the refresh the router
// observes with does not; an archived agent reads closed too, and a prompt
// would unarchive it, so readiness excludes it. A timeline fetch resumes a
// closed agent as a prompt does, so the health sheet's per-session reads
// happen only for sessions seen idle or running.
//
// The subagent list and the terminals are not on the public client; they
// are on the DaemonClient the client is built over, exported under the
// package's internal subpath. This builds the same pair createPaseoClient
// builds, so one connection serves both; the lockfile pins the client, and
// with it the subpath.
//
// A placement's session may instead be a Paseo terminal running an agent
// CLI, named `terminal:<id>` in `agents`. Verified on the 0.10.2 daemon with
// Claude Code 2.1.289: the terminal record carries an `activity` that
// Paseo's Claude hooks set (`working` on a submitted prompt, `idle` with
// `finished` when the turn ends, `needs_input` at a permission prompt), and
// null until the session's first prompt since the daemon started; the
// title starts with Claude Code's idle mark (✳) at the prompt and a spinner
// during a turn; a bracketed paste and then Enter arrive as one prompt, and
// the activity turns within a second. A terminal takes raw input only: no
// message key, no receipt, so the router confirms a send by the activity
// change that follows it.
import { spawn, type ChildProcess } from "node:child_process";
import { randomUUID } from "node:crypto";
import { createServer, type Server, type Socket } from "node:net";
import { createPaseoApi } from "@getpaseo/client";
import type {
  PaseoAgent,
  PaseoAgentRefetchResult,
  PaseoWorkspace,
} from "@getpaseo/client";
import {
  DaemonClient,
  type FetchAgentTimelinePayload,
  type ProviderSubagentListPayload,
} from "@getpaseo/client/internal/daemon-client";
import {
  ACTIVITY_KINDS,
  SUBAGENT_STATUSES,
  oneOf,
  zeroCounts,
  type Activity,
  type ActivityItem,
  type AgentSnapshot,
  type Checkout,
  type Subagents,
} from "./telemetry.ts";
import { terminalOf } from "./config.ts";
import type { AdapterOutcome } from "./types.ts";

export type Observation = {
  // The agent exists; ready as `isReady` says.
  ready: boolean;
  status: string;
  pendingPermissions: number;
  // The rest of what the daemon said, for the board's telemetry, stamped
  // with the caller's clock.
  snapshot: AgentSnapshot;
  // Sheet reads that failed, one line each; the field they fed is null.
  notes?: string[];
};

// A fault in the router itself, as opposed to a host that cannot be reached:
// the run must stop and say so rather than record an outcome.
export class RouterBug extends Error {
  override name = "RouterBug";
}

export type Adapter = {
  // null: the daemon does not know this agent. `seen` is the time the
  // snapshot is recorded as taken.
  observe(agentId: string, seen: string): Promise<Observation | null>;
  send(agentId: string, key: string, text: string): Promise<AdapterOutcome>;
  close(): Promise<void>;
};

export type AdapterOptions = {
  // Whether to read the health sheet (checkout, subagents, activity) along
  // with the rail. Default on.
  sheet?: boolean;
  // Activity items kept per session (the timeline is fetched with room for
  // the harness's own calls, HARNESS_ROOM more).
  tail?: number;
  // How long a terminal send waits for the activity change that confirms
  // it, and the pause between looks. Tests shorten them.
  receiptMs?: number;
  pause?: (ms: number) => Promise<void>;
};

export type ProviderSubagent = ProviderSubagentListPayload["subagents"][number];
export type TimelineEntry = FetchAgentTimelinePayload["entries"][number];
export type PaseoTerminal = Awaited<
  ReturnType<DaemonClient["listTerminals"]>
>["terminals"][number];
type TerminalActivity = NonNullable<PaseoTerminal["activity"]>;

// What the adapter asks of a daemon, so the rules above it are testable
// without one.
export type Daemon = {
  refresh(agentId: string): Promise<PaseoAgentRefetchResult | null>;
  send(agentId: string, text: string, messageId: string): Promise<void>;
  workspaces(): Promise<PaseoWorkspace[]>;
  subagents(agentId: string): Promise<ProviderSubagent[]>;
  tail(agentId: string, limit: number): Promise<TimelineEntry[]>;
  terminals(): Promise<PaseoTerminal[]>;
  input(terminalId: string, data: string): Promise<void>;
  close(): Promise<void>;
};

// What a failed send means. Only a refusal before any send is a definite
// not_sent; a key conflict is the router contradicting its own record;
// anything else may have reached the agent.
export function sendFailure(
  error: unknown,
  agentId: string,
  key: string,
): AdapterOutcome {
  const message = error instanceof Error ? error.message : String(error);
  if (message.includes("agent_request_key_conflict"))
    throw new RouterBug(
      `${key} was already sent to ${agentId} with different text.`,
    );
  if (/^Agent not found: |^Agent identifier /.test(message)) return "not_sent";
  return "unknown";
}

// A session the router may send to now: idle, or closed (the send resumes
// it) unless archived (the send would unarchive what a person put away),
// with no permission waiting. Running would be interrupted; error and
// initializing are not a session yet.
export const isReady = (
  status: PaseoAgent["status"],
  pendingPermissions: number,
  archived = false,
): boolean =>
  (status === "idle" || (status === "closed" && !archived)) &&
  pendingPermissions === 0;

// Claude Code's mark at the head of the terminal title while it waits at
// its prompt; a spinner takes its place during a turn.
const IDLE_MARK = "✳ ";

// A terminal the router may send to now: its activity is idle or its turn
// finished, with no prompt waiting on a person; with no activity yet, its
// title shows the idle mark. A working session would take the paste as a
// queued prompt, and one at a permission prompt would take it as the answer.
export function terminalReady(t: PaseoTerminal): boolean {
  const a = t.activity;
  if (!a) return (t.title ?? "").startsWith(IDLE_MARK);
  if (a.attentionReason === "needs_input") return false;
  return a.state === "idle" || a.attentionReason === "finished";
}

// The activity in a word, for the run's report.
function terminalStatus(t: PaseoTerminal): string {
  const a = t.activity;
  if (!a) return `no activity yet, title "${t.title ?? ""}"`;
  if (a.attentionReason === "needs_input" || a.state === "attention")
    return "needs input";
  return a.state === "working" ? "working" : "idle";
}

// A terminal's record reduced to the board's fields: what its activity and
// title say, its directory and checkout, and nothing a terminal does not
// report (provider, model, context, usage).
export function terminalSnapshotOf(
  t: PaseoTerminal,
  seen: string,
): AgentSnapshot {
  const a = t.activity ?? null;
  const at = a ? new Date(a.changedAt).toISOString() : null;
  const asking =
    a?.attentionReason === "needs_input" ||
    (a?.state === "attention" && a.attentionReason !== "finished");
  const status: AgentSnapshot["status"] = a
    ? a.state === "working" && !asking
      ? "running"
      : "idle"
    : (t.title ?? "").startsWith(IDLE_MARK)
      ? "idle"
      : "initializing";
  return {
    seen,
    status,
    attention: asking
      ? "permission"
      : a?.attentionReason === "finished"
        ? "finished"
        : null,
    attentionAt: asking || a?.attentionReason === "finished" ? at : null,
    turnStartedAt: status === "running" ? at : null,
    lastUserMessageAt: null,
    permissions: [],
    provider: null,
    model: null,
    thinking: null,
    mode: null,
    context: null,
    usage: null,
    error: null,
    // The title without its leading mark (idle or spinner).
    title: t.title?.replace(/^[^\p{L}\p{N}\s]\s+/u, "") || null,
    cwd: t.cwd ?? null,
    checkout: null,
    subagents: null,
    activity: null,
  };
}

// Text as a bracketed paste may carry it: no escape that could end the
// paste early or drive the terminal, line breaks as newlines.
export const pasteable = (text: string): string =>
  text
    .replace(/\r\n?/g, "\n")
    .replace(/[\u0000-\u0008\u000b-\u001f\u007f]/g, "");

// A prompt reached the session: its activity changed after the send to a
// turn that started or already finished.
const started = (
  before: TerminalActivity | null | undefined,
  after: TerminalActivity | null | undefined,
): boolean =>
  Boolean(after) &&
  after?.changedAt !== before?.changedAt &&
  (after?.state === "working" || after?.attentionReason === "finished");

// The daemon's agent snapshot (protocol 0.10.1: status, activeTurn,
// lastUserMessageAt, pendingPermissions, attentionReason and its
// timestamp, lastUsage with
// the context window, lastError, model and mode ids) reduced to the
// board's fields. What the daemon left out reads as null; a context window
// needs both bounds.
export function snapshotOf(agent: PaseoAgent, seen: string): AgentSnapshot {
  const usage = agent.lastUsage;
  const used = usage?.contextWindowUsedTokens;
  const max = usage?.contextWindowMaxTokens;
  return {
    seen,
    status: agent.status,
    attention: agent.attentionReason ?? null,
    attentionAt: agent.attentionTimestamp ?? null,
    turnStartedAt: agent.activeTurn?.startedAt ?? null,
    lastUserMessageAt: agent.lastUserMessageAt ?? null,
    permissions: agent.pendingPermissions.map((p) => ({
      id: p.id,
      name: p.name,
      title: p.title ?? null,
      kind: p.kind,
    })),
    provider: agent.provider,
    model: agent.model ?? null,
    thinking: agent.effectiveThinkingOptionId ?? agent.thinkingOptionId ?? null,
    mode: agent.currentModeId ?? null,
    context:
      typeof used === "number" && typeof max === "number" && max > 0
        ? { used, max }
        : null,
    usage: usage
      ? {
          input: usage.inputTokens ?? 0,
          cached: usage.cachedInputTokens ?? 0,
          output: usage.outputTokens ?? 0,
          costUsd: usage.totalCostUsd ?? null,
        }
      : null,
    error: agent.lastError ?? null,
    title: agent.title ?? null,
    cwd: agent.cwd,
    checkout: null,
    subagents: null,
    activity: null,
  };
}

// The first line of a text, cut to a width; null when there is none.
export function firstLine(
  text: string | null | undefined,
  width = 160,
): string | null {
  const line = text?.split("\n").find((l) => l.trim()) ?? null;
  if (line === null) return null;
  const trimmed = line.trim();
  return trimmed.length > width ? `${trimmed.slice(0, width - 1)}…` : trimmed;
}

// A workspace entry (protocol 0.9.2 and 0.10.1 alike: project placement,
// gitRuntime, diffStat, githubRuntime.pullRequest) reduced to the sheet's
// checkout.
export function checkoutOf(w: PaseoWorkspace): Checkout {
  const git = w.gitRuntime ?? null;
  const pr = w.githubRuntime?.pullRequest ?? null;
  return {
    project: w.projectDisplayName,
    workspace: w.name,
    directory: w.workspaceDirectory,
    kind: w.workspaceKind,
    branch: git?.currentBranch ?? w.project?.checkout.currentBranch ?? null,
    remote: git?.remoteUrl ?? w.project?.checkout.remoteUrl ?? null,
    dirty: git?.isDirty ?? null,
    ahead: git?.aheadBehind?.ahead ?? git?.aheadOfOrigin ?? null,
    behind: git?.aheadBehind?.behind ?? git?.behindOfOrigin ?? null,
    diff: w.diffStat
      ? { additions: w.diffStat.additions, deletions: w.diffStat.deletions }
      : null,
    pr: pr
      ? {
          number: pr.number ?? null,
          url: pr.url,
          title: pr.title,
          state: pr.state,
          draft: pr.isDraft ?? false,
          merged: pr.isMerged,
          mergeable: pr.mergeable ?? null,
          checks: pr.checksStatus ?? null,
          review: pr.reviewDecision ?? null,
        }
      : null,
    status: w.status,
    activityAt: w.activityAt,
  };
}

// The agent's place in the workspace list: by project key and workspace
// name, else by directory. Null when the daemon placed the agent nowhere
// it lists.
export function checkoutFor(
  project: PaseoAgentRefetchResult["project"],
  workspaces: PaseoWorkspace[],
): Checkout | null {
  if (!project) return null;
  const named = workspaces.find(
    (w) =>
      w.project?.projectKey === project.projectKey &&
      (w.project.workspaceName ?? w.name) === project.workspaceName,
  );
  const match =
    named ??
    workspaces.find((w) => w.workspaceDirectory === project.checkout.cwd);
  return match ? checkoutOf(match) : null;
}

// The session's whole subagent history, counted, with the open ones
// listed oldest first; a history is long and the sheet is short.
export function subagentsOf(list: ProviderSubagent[], limit = 20): Subagents {
  const counts = zeroCounts();
  for (const s of list)
    if (SUBAGENT_STATUSES.includes(s.status)) counts[s.status] += 1;
  const running = list
    .filter((s) => s.status === "running")
    .sort((a, b) => (a.createdAt < b.createdAt ? -1 : 1))
    .slice(0, limit)
    .map((s) => ({
      id: s.id,
      title: s.title,
      description: firstLine(s.description),
      status: s.status,
      startedAt: s.createdAt,
      updatedAt: s.updatedAt,
      parent: s.parentSubagentId ?? null,
    }));
  return { counts, running };
}

// Tool calls the harness makes to itself (a background command's
// completion notice), not the session's work: the tail leaves them out,
// and is fetched with this many extra entries so it usually stays full.
const HARNESS_TOOLS = new Set(["task_notification"]);
const HARNESS_ROOM = 4;

// A timeline tail, each entry cut to a line: what it was, its first line
// of text, and for a tool call its name and state. `limit` keeps the last
// so many after the harness's own calls are dropped.
export function activityOf(entries: TimelineEntry[], limit?: number): Activity {
  const items = entries.flatMap((e): ActivityItem[] => {
    const item = e.item;
    const kind = oneOf(ACTIVITY_KINDS, item.type);
    if (!kind) return [];
    if (item.type === "tool_call" && HARNESS_TOOLS.has(item.name)) return [];
    const base = { at: e.timestamp, kind, tool: null, status: null };
    switch (item.type) {
      case "user_message":
      case "assistant_message":
      case "reasoning":
        return [{ ...base, text: firstLine(item.text) }];
      case "tool_call":
        return [
          {
            ...base,
            text: firstLine(toolText(item.detail)),
            tool: item.name,
            status: item.status,
          },
        ];
      case "error":
      case "notification":
        return [{ ...base, text: firstLine(item.message) }];
      case "todo":
        return [
          {
            ...base,
            text: `${item.items.length} item${item.items.length === 1 ? "" : "s"}`,
          },
        ];
      case "compaction":
        return [{ ...base, text: item.status }];
      default:
        return [{ ...base, text: null }];
    }
  });
  const kept = limit === undefined ? items : items.slice(-limit);
  return {
    turns: kept.filter((i) => i.kind === "user_message").length,
    items: kept,
  };
}

type ToolCall = Extract<TimelineEntry["item"], { type: "tool_call" }>;

// The one line that says what a tool call did.
function toolText(detail: ToolCall["detail"]): string | null {
  switch (detail.type) {
    case "shell":
      return detail.command;
    case "read":
    case "edit":
    case "write":
      return detail.filePath;
    case "search":
      return detail.query;
    case "fetch":
      return detail.url;
    case "worktree_setup":
      return detail.worktreePath;
    case "sub_agent":
      return detail.description ?? detail.subAgentType ?? null;
    case "plain_text":
      return detail.text ?? detail.label ?? null;
    case "plan":
      return detail.text;
    default:
      return null;
  }
}

// The adapter's rules over a daemon: the rail from one refresh; the sheet,
// when on, from one workspace list per adapter (one run) and, for a session
// seen idle or running, its subagents and timeline tail. Each sheet read
// fails on its own: the field is null and the observation carries a note.
export function adapterOver(
  daemon: Daemon,
  options: AdapterOptions = {},
): Adapter {
  const sheet = options.sheet ?? true;
  const tail = options.tail ?? 8;
  const receiptMs = options.receiptMs ?? 10_000;
  const pause =
    options.pause ??
    ((ms: number) => new Promise<void>((done) => setTimeout(done, ms)));
  const terminal = async (id: string): Promise<PaseoTerminal | null> =>
    (await daemon.terminals()).find((t) => t.id === id) ?? null;
  // One list per adapter, and one note when it failed: the first observe
  // hears why, the rest only get their null.
  let workspaces: Promise<PaseoWorkspace[] | null> | null = null;
  const listed = (notes: string[]): Promise<PaseoWorkspace[] | null> =>
    (workspaces ??= daemon.workspaces().catch((error: unknown) => {
      notes.push(
        `workspaces not listed: ${error instanceof Error ? error.message : String(error)}`,
      );
      return null;
    }));
  const attempt = async <T>(
    what: string,
    agentId: string,
    read: () => Promise<T>,
    notes: string[],
  ): Promise<T | null> => {
    try {
      return await read();
    } catch (error: unknown) {
      notes.push(
        `${what} of ${agentId} not read: ${error instanceof Error ? error.message : String(error)}`,
      );
      return null;
    }
  };
  // A terminal is observed from the daemon's terminal list: its activity
  // and title for readiness, its workspace for the checkout. A terminal has
  // no subagent list or timeline to read.
  const observeTerminal = async (
    id: string,
    seen: string,
  ): Promise<Observation | null> => {
    const t = await terminal(id);
    if (!t) return null;
    const snapshot = terminalSnapshotOf(t, seen);
    const notes: string[] = [];
    if (sheet) {
      const list = await listed(notes);
      const w =
        list?.find((w) => w.id === t.workspaceId) ??
        list?.find((w) => w.workspaceDirectory === t.cwd);
      snapshot.checkout = w ? checkoutOf(w) : null;
    }
    return {
      ready: terminalReady(t),
      status: terminalStatus(t),
      pendingPermissions: 0,
      snapshot,
      ...(notes.length ? { notes } : {}),
    };
  };
  // A terminal send: refused before any input unless the terminal is there
  // and ready; then the text as one bracketed paste and Enter after it.
  // Accepted only once the activity shows the prompt started a turn; with
  // no such change within receiptMs the prompt may sit unsent in the input
  // or have run, so the outcome is unknown.
  const sendTerminal = async (
    id: string,
    text: string,
  ): Promise<AdapterOutcome> => {
    let before: PaseoTerminal | null;
    try {
      before = await terminal(id);
    } catch {
      return "not_sent";
    }
    if (!before || !terminalReady(before)) return "not_sent";
    try {
      await daemon.input(id, `\x1b[200~${pasteable(text)}\x1b[201~`);
    } catch {
      return "not_sent";
    }
    try {
      await pause(300);
      await daemon.input(id, "\r");
    } catch {
      return "unknown";
    }
    for (let waited = 0; waited < receiptMs; waited += 250) {
      await pause(250);
      const now = await terminal(id).catch(() => null);
      if (started(before.activity, now?.activity)) return "accepted";
    }
    return "unknown";
  };
  return {
    async observe(agentId, seen) {
      const id = terminalOf(agentId);
      if (id) return observeTerminal(id, seen);
      const result = await daemon.refresh(agentId);
      if (!result) return null;
      const { status, pendingPermissions } = result.agent;
      const snapshot = snapshotOf(result.agent, seen);
      const notes: string[] = [];
      if (sheet) {
        const list = await listed(notes);
        snapshot.checkout = list ? checkoutFor(result.project, list) : null;
        if (status === "idle" || status === "running") {
          snapshot.subagents = await attempt(
            "subagents",
            agentId,
            async () => subagentsOf(await daemon.subagents(agentId)),
            notes,
          );
          snapshot.activity = await attempt(
            "activity",
            agentId,
            async () =>
              activityOf(await daemon.tail(agentId, tail + HARNESS_ROOM), tail),
            notes,
          );
        }
      }
      return {
        ready: isReady(
          status,
          pendingPermissions.length,
          Boolean(result.agent.archivedAt),
        ),
        status,
        pendingPermissions: pendingPermissions.length,
        snapshot,
        ...(notes.length ? { notes } : {}),
      };
    },
    async send(agentId, key, text) {
      const id = terminalOf(agentId);
      if (id) return sendTerminal(id, text);
      try {
        await daemon.send(agentId, text, key);
        return "accepted";
      } catch (error: unknown) {
        return sendFailure(error, agentId, key);
      }
    },
    close: () => daemon.close(),
  };
}

// endpoint: a websocket URL, or ssh://[user@]host[:port] for a daemon bound to
// loopback on another machine.
export async function createPaseoAdapter(
  endpoint: string,
  options: AdapterOptions = {},
): Promise<Adapter> {
  const tunnel = endpoint.startsWith("ssh://")
    ? await openSshTunnel(endpoint)
    : null;
  const daemonClient = new DaemonClient({
    url: tunnel ? `ws://127.0.0.1:${tunnel.port}/ws` : endpoint,
    clientId: `jev-router-${randomUUID()}`,
    clientType: "cli",
  });
  try {
    await daemonClient.connect();
  } catch (error) {
    tunnel?.close();
    throw tunnel?.failure()
      ? new Error(`SSH to ${endpoint} failed: ${tunnel.failure()}`)
      : error;
  }
  const api = createPaseoApi(daemonClient);
  return adapterOver(
    {
      refresh: (agentId) => api.agents.ref(agentId).refresh(),
      async send(agentId, text, messageId) {
        await api.agents.ref(agentId).send(text, { messageId });
      },
      workspaces: async () => (await api.workspaces.list()).entries,
      subagents: async (agentId) =>
        (await daemonClient.listProviderSubagents(agentId)).subagents,
      tail: async (agentId, limit) =>
        (
          await api.agents.ref(agentId).timeline.refetch({
            direction: "tail",
            limit,
            projection: "projected",
          })
        ).entries,
      terminals: async () => (await daemonClient.listTerminals()).terminals,
      async input(terminalId, data) {
        daemonClient.sendTerminalInput(terminalId, { type: "input", data });
      },
      async close() {
        try {
          await api.dispose();
        } finally {
          try {
            await daemonClient.close();
          } finally {
            tunnel?.close();
          }
        }
      },
    },
    options,
  );
}

type Tunnel = { port: number; close(): void; failure(): string | null };

// The Paseo CLI's tunnel, in miniature: a local listener that, on its first
// connection, spawns `ssh -W 127.0.0.1:<daemonPort> <host>` and pipes the
// socket through it. One connection per tunnel, which is all one run needs.
function openSshTunnel(endpoint: string): Promise<Tunnel> {
  const url = new URL(endpoint);
  if (
    url.password ||
    url.search ||
    url.hash ||
    (url.pathname && url.pathname !== "/")
  )
    throw new Error(
      `Unsupported ssh endpoint ${endpoint}: use ssh://[user@]host[:port]`,
    );
  const host = url.username
    ? `${decodeURIComponent(url.username)}@${url.hostname}`
    : url.hostname;
  const args = [
    "-T",
    "-o",
    "BatchMode=yes",
    "-o",
    "ConnectTimeout=10",
    "-o",
    "ClearAllForwardings=yes",
    "-o",
    "ExitOnForwardFailure=yes",
    ...(url.port ? ["-p", url.port] : []),
    "-W",
    "127.0.0.1:6767",
    host,
  ];
  let server: Server | null = null;
  let socket: Socket | null = null;
  let child: ChildProcess | null = null;
  let stderr = "";
  let failure: string | null = null;
  const close = (): void => {
    server?.close();
    server = null;
    socket?.destroy();
    socket = null;
    if (child && !child.killed) child.kill();
    child = null;
  };
  return new Promise((resolve, reject) => {
    server = createServer((accepted) => {
      socket = accepted;
      server?.close();
      server = null;
      const ssh = spawn("ssh", args, { stdio: ["pipe", "pipe", "pipe"] });
      child = ssh;
      ssh.stderr.on("data", (chunk: Buffer) => {
        stderr = `${stderr}${chunk.toString()}`.slice(-2000);
      });
      ssh.on("error", (error) => {
        failure = error.message;
        accepted.destroy(error);
      });
      ssh.on("exit", (code, signal) => {
        if (code !== 0 || signal)
          failure = stderr.trim() || `ssh exited with ${signal ?? code}`;
        accepted.destroy(failure ? new Error(failure) : undefined);
      });
      accepted.on("error", () => undefined);
      accepted.on("close", () => {
        if (child && !child.killed) child.kill();
      });
      accepted.pipe(ssh.stdin);
      ssh.stdout.pipe(accepted);
    });
    server.once("error", (error) => {
      close();
      reject(error);
    });
    server.listen(0, "127.0.0.1", () => {
      const address = server?.address();
      if (!address || typeof address === "string") {
        close();
        reject(new Error("Could not allocate a tunnel port"));
        return;
      }
      resolve({ port: address.port, close, failure: () => failure });
    });
  });
}
