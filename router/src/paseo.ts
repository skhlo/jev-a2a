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
// builds, so one connection serves both; package.json pins the client's
// exact version, and with it the subpath.
//
// A placement's session may instead be an agent CLI in a Paseo terminal,
// named `terminal:<id>` in `agents`: Claude Code, or Codex where the
// configuration's `terminals` says so. A terminal takes raw input only: no
// message key, no receipt. So the router sends only to the CLI's empty
// prompt, read from the terminal's activity and screen (and Claude Code's
// title), and confirms a send by the activity change that follows it. The
// facts this relies on, verified on the 0.10.2 daemon with Claude Code
// 2.1.289 and Codex 0.159.2 and 0.160.0, and what it does not cover, are in
// the contract's Adapters section (Paseo terminal).
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
  type TerminalStreamEvent,
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
import { terminalOf, type TerminalCli } from "./config.ts";
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
  // The session as the daemon names it: an agent by its full id, which the
  // daemon also finds by a unique prefix or a title; a terminal by its
  // exact id. null when the daemon does not know it.
  resolve(session: string): Promise<string | null>;
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
  // it, and the wait itself. Tests shorten them.
  receiptMs?: number;
  sleep?: (ms: number) => Promise<void>;
  // The CLI in each terminal session (`terminal:<id>`) that does not run
  // Claude Code.
  clis?: Record<string, TerminalCli>;
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
  screen(terminalId: string): Promise<Screen>;
  input(terminalId: string, data: string): Promise<void>;
  close(): Promise<void>;
};

// The daemon's refusal of an agent id it does not know.
const unknownAgent = (error: unknown): boolean =>
  /^Agent not found: |^Agent identifier /.test(
    error instanceof Error ? error.message : String(error),
  );

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
  if (unknownAgent(error)) return "not_sent";
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

// Claude Code's marks at the head of the terminal title: ✳ while the
// session waits at its prompt, and also while a permission dialog is open;
// a spinner frame during a turn. A title without one is not Claude Code's.
const MARK = /^([✳◐◓◑◒])\s+/u;
const IDLE = "✳";
// A rule line of Claude Code's prompt box, and its top rule, which may end
// in the session's name and tags, right-aligned after as many dashes as the
// terminal's width leaves ("──── my session ─").
const RULE = /^─{20,}$/;
const TOP_RULE = /^(?:─{20,}|─+ .+ ─+)$/;

// What a terminal's record says of Claude Code in it, in one place for
// readiness, the run's report and the board:
// - away: the title is not Claude Code's, so it is not running there (it
//   exited, and the activity Paseo kept from its last hook is stale);
// - working: a turn runs, by the title's spinner or the activity, which
//   stays working through a permission dialog;
// - waiting: the title shows the idle mark and no turn runs.
export type TerminalCondition = "working" | "waiting" | "away";
export function claudeCondition(t: PaseoTerminal): TerminalCondition {
  const mark = MARK.exec(t.title ?? "")?.[1];
  if (!mark) return "away";
  return mark !== IDLE || t.activity?.state === "working"
    ? "working"
    : "waiting";
}

// A terminal's visible lines (a dim cell read as a space), the same lines
// as drawn (`drawn`), and where its cursor is.
export type Screen = {
  lines: string[];
  drawn: string[];
  cursorRow: number | null;
  cursorCol: number | null;
};

// Claude Code's prompt box on the screen, empty and in use: the last two
// rule lines hold a lone ❯ (its dim placeholder read as spaces), with only
// the status lines under them and the cursor on the ❯. A dialog takes the
// box's place and a half-typed line fills it, so a paste would be answered
// or merged; a box a killed CLI left on the screen has the shell's cursor
// below it. None of them is ready. The activity cannot tell: it is empty
// before the first prompt and after an Esc, dialog or not.
export function claudePromptEmpty(screen: Screen): boolean {
  const shown = screen.lines.map((line) => line.trimEnd());
  while (shown.length && !shown.at(-1)) shown.pop();
  const rule = shown.findLastIndex((line) => RULE.test(line));
  return (
    rule >= 2 &&
    shown[rule - 1] === "❯" &&
    TOP_RULE.test(shown[rule - 2] ?? "") &&
    shown.length - 1 - rule <= 6 &&
    screen.cursorRow === rule - 1
  );
}

// Codex's status line while a turn runs ("Working (3s • esc to
// interrupt)"), shown too while its automatic reviewer weighs an approval,
// when the activity says needs_input and the composer looks empty. It is
// not shown while an answer streams; the activity covers that. Matched
// anywhere in a row, so a row cut short by a narrow terminal still holds.
const CODEX_RUNNING = /esc to interrupt/;

// Where a terminal stands on its screen: at an empty prompt, in a turn its
// record does not show, or anywhere else.
export type PromptState = "empty" | "busy" | "other";

// Codex's composer, empty and in use: the last line that starts with a `›`
// not drawn dim (the transcript's earlier prompts are dim, and so is the
// placeholder), with nothing after it, a blank line under it, at most the
// footer below that, and the cursor just after the `›`. A draft (even with
// the cursor moved to its start), an approval overlay, a startup notice,
// the shell after Codex exits and the frame a killed Codex leaves all fail
// it.
export function codexPrompt(screen: Screen): PromptState {
  if (screen.drawn.some((line) => CODEX_RUNNING.test(line))) return "busy";
  const shown = screen.lines.map((line) => line.trimEnd());
  while (shown.length && !shown.at(-1)) shown.pop();
  const row = shown.findLastIndex((line) => line.startsWith("›"));
  return row >= 0 &&
    shown[row] === "›" &&
    !shown[row + 1] &&
    shown.length - 1 - row <= 3 &&
    screen.cursorRow === row &&
    screen.cursorCol === 2
    ? "empty"
    : "other";
}

// What a Codex terminal's record says: a turn by the activity Paseo's Codex
// hooks set (they reach Paseo only from `codex --no-daemon`), else waiting.
// The title cannot tell: it shows a turn seconds late, or keeps stale
// spinner frames, so an exited Codex is told by the screen alone. Nor can a
// needs_input activity, which outlives a declined approval.
const codexCondition = (t: PaseoTerminal): TerminalCondition =>
  t.activity?.state === "working" ? "working" : "waiting";

// Codex's title without what it adds while it works or waits on an
// approval: "[ ! ] Action Required | " and spinner frames.
const SPINNER = /^[⠀-⣿](?: [⠀-⣿])*\s*/u;
const codexTitle = (t: PaseoTerminal): string | null =>
  (t.title ?? "")
    .replace(/^\[ [!.] \] Action Required \| /u, "")
    .split(" | ")
    .map((part) => part.replace(SPINNER, ""))
    .filter(Boolean)
    .join(" | ") || null;

// What the router reads of each CLI in a terminal: its condition from the
// record, where it stands on the screen when the record says waiting, its
// title for the board, and its name and not-ready line for the run's report.
type TerminalProfile = {
  name: string;
  notAtPrompt: string;
  condition(t: PaseoTerminal): TerminalCondition;
  prompt(screen: Screen): PromptState;
  title(t: PaseoTerminal): string | null;
};
const PROFILES: Record<TerminalCli, TerminalProfile> = {
  claude: {
    name: "Claude Code",
    notAtPrompt: "at its prompt with text in it or a dialog open",
    condition: claudeCondition,
    prompt: (screen) => (claudePromptEmpty(screen) ? "empty" : "other"),
    title: (t) => (t.title ?? "").replace(MARK, "") || null,
  },
  codex: {
    name: "Codex",
    notAtPrompt:
      "not at an empty Codex composer: a draft, a dialog, or Codex not running",
    condition: codexCondition,
    prompt: codexPrompt,
    title: codexTitle,
  },
};

// The terminal in words, for the run's report.
function terminalStatus(
  t: PaseoTerminal,
  profile: TerminalProfile,
  condition: TerminalCondition,
  prompt: PromptState | null,
): string {
  if (condition === "working" || prompt === "busy") return "working";
  if (condition === "away")
    return `${profile.name} is not running in the terminal (title "${t.title ?? ""}")`;
  return prompt === "empty" ? "idle" : profile.notAtPrompt;
}

// A terminal's record reduced to the board's fields: what its condition
// and activity say (and the screen, when it shows a turn the record does
// not), its title without its CLI's marks, its directory and checkout, and
// nothing a terminal does not report (provider, model, context, usage).
export function terminalSnapshotOf(
  t: PaseoTerminal,
  seen: string,
  cli: TerminalCli = "claude",
  prompt: PromptState | null = null,
): AgentSnapshot {
  const profile = PROFILES[cli];
  const condition = profile.condition(t);
  const a = t.activity ?? null;
  const at = a ? new Date(a.changedAt).toISOString() : null;
  const finished = condition === "waiting" && a?.attentionReason === "finished";
  return {
    seen,
    status:
      condition === "working" || prompt === "busy"
        ? "running"
        : condition === "waiting"
          ? "idle"
          : "closed",
    attention: finished ? "finished" : null,
    attentionAt: finished ? at : null,
    turnStartedAt: condition === "working" && a ? at : null,
    lastUserMessageAt: null,
    permissions: [],
    provider: null,
    model: null,
    thinking: null,
    mode: null,
    context: null,
    usage: null,
    error: null,
    title: profile.title(t),
    cwd: t.cwd ?? null,
    checkout: null,
    subagents: null,
    activity: null,
  };
}

// A bracketed paste is followed by Enter only after this long, so the CLI
// takes the paste as text first (300 ms verified with Claude Code and
// Codex);
// the activity is looked at this often for the send's receipt.
const PASTE_SETTLE_MS = 300;
const RECEIPT_LOOK_MS = 250;

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
  const sleep =
    options.sleep ??
    ((ms: number) => new Promise<void>((done) => setTimeout(done, ms)));
  const terminal = async (id: string): Promise<PaseoTerminal | null> =>
    (await daemon.terminals()).find((t) => t.id === id) ?? null;
  // The daemon refuses an agent id it does not know rather than answering
  // null: the session is missing, not the host unreachable.
  const refreshed = (agentId: string) =>
    daemon.refresh(agentId).catch((error: unknown) => {
      if (unknownAgent(error)) return null;
      throw error;
    });
  const cliOf = (session: string): TerminalCli =>
    options.clis?.[session] ?? "claude";
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
  // Where a terminal whose record says waiting stands on its screen; a
  // screen that cannot be read is no empty prompt, with a note.
  const promptOf = async (
    id: string,
    profile: TerminalProfile,
    notes: string[],
  ): Promise<PromptState> =>
    (await attempt(
      "screen",
      `terminal:${id}`,
      async () => profile.prompt(await daemon.screen(id)),
      notes,
    )) ?? "other";
  // A terminal is observed from the daemon's terminal list, and, when its
  // record says it waits, its screen: ready only at the CLI's empty prompt.
  // Its workspace gives the checkout; a terminal has no subagent list or
  // timeline to read.
  const observeTerminal = async (
    id: string,
    cli: TerminalCli,
    seen: string,
  ): Promise<Observation | null> => {
    const t = await terminal(id);
    if (!t) return null;
    const profile = PROFILES[cli];
    const condition = profile.condition(t);
    const notes: string[] = [];
    const prompt =
      condition === "waiting" ? await promptOf(id, profile, notes) : null;
    const snapshot = terminalSnapshotOf(t, seen, cli, prompt);
    if (sheet) {
      const list = await listed(notes);
      const w =
        list?.find((w) => w.id === t.workspaceId) ??
        list?.find((w) => w.workspaceDirectory === t.cwd);
      snapshot.checkout = w ? checkoutOf(w) : null;
    }
    return {
      ready: prompt === "empty",
      status: terminalStatus(t, profile, condition, prompt),
      pendingPermissions: 0,
      snapshot,
      ...(notes.length ? { notes } : {}),
    };
  };
  // A terminal send: refused before any input unless the terminal is there
  // and ready, looked at again now; then the text as one bracketed paste
  // and Enter after it. Accepted only once the activity shows the prompt
  // started a turn; with no such change within about receiptMs (plus the
  // looks' own time) the prompt may sit unsent in the box or have run, so
  // the outcome is unknown.
  const sendTerminal = async (
    id: string,
    cli: TerminalCli,
    text: string,
  ): Promise<AdapterOutcome> => {
    const profile = PROFILES[cli];
    let before: PaseoTerminal | null;
    try {
      before = await terminal(id);
    } catch {
      return "not_sent";
    }
    if (
      !before ||
      profile.condition(before) !== "waiting" ||
      (await promptOf(id, profile, [])) !== "empty"
    )
      return "not_sent";
    try {
      await daemon.input(id, `\x1b[200~${pasteable(text)}\x1b[201~`);
    } catch {
      return "not_sent";
    }
    try {
      await sleep(PASTE_SETTLE_MS);
      await daemon.input(id, "\r");
    } catch {
      return "unknown";
    }
    for (let waited = 0; waited < receiptMs; waited += RECEIPT_LOOK_MS) {
      await sleep(RECEIPT_LOOK_MS);
      const now = await terminal(id).catch(() => null);
      if (started(before.activity, now?.activity)) return "accepted";
    }
    return "unknown";
  };
  return {
    async resolve(session) {
      const id = terminalOf(session);
      if (id) return (await terminal(id)) ? session : null;
      return (await refreshed(session))?.agent.id ?? null;
    },
    async observe(agentId, seen) {
      const id = terminalOf(agentId);
      if (id) return observeTerminal(id, cliOf(agentId), seen);
      const result = await refreshed(agentId);
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
      if (id) return sendTerminal(id, cliOf(agentId), text);
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
    // One connection for one run, and the next run is the retry. A client
    // that reconnects never settles connect() while the host is gone, and
    // the ssh tunnel takes one connection, so a retry finds no listener.
    reconnect: { enabled: false },
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
      screen: (terminalId) => screenOf(daemonClient, terminalId),
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

type TerminalState = Extract<
  TerminalStreamEvent,
  { type: "snapshot" }
>["state"];

// A grid snapshot as a Screen. The capture call returns plain text even
// when asked for colour, and Claude Code and Codex draw the placeholder in
// an empty prompt dim (verified with Claude Code 2.1.289 and Codex 0.159.2
// and 0.160.0), so in `lines` a dim cell reads as a space; `raw` keeps it,
// for Codex's status line, which is mostly dim.
export function screenFrom(state: TerminalState): Screen {
  return {
    lines: state.grid.map((row) =>
      row.map((cell) => (cell.dim ? " " : cell.char)).join(""),
    ),
    drawn: state.grid.map((row) => row.map((cell) => cell.char).join("")),
    cursorRow: state.cursor.row,
    cursorCol: state.cursor.col,
  };
}

// One snapshot of a terminal's grid, through a subscription released at
// once; a refused subscription fails with the daemon's reason.
async function screenOf(
  daemonClient: DaemonClient,
  terminalId: string,
): Promise<Screen> {
  let timer: ReturnType<typeof setTimeout> | undefined;
  let release = (): Promise<void> => Promise.resolve();
  try {
    const state = await new Promise<TerminalState>((resolve, reject) => {
      timer = setTimeout(
        () => reject(new Error("no snapshot of the terminal within 5 s")),
        5_000,
      );
      const subscription = daemonClient.observeTerminal(terminalId, (event) => {
        if (event.type === "snapshot") resolve(event.state);
      });
      release = () => subscription.release();
      subscription.ready.catch(reject);
    });
    return screenFrom(state);
  } finally {
    clearTimeout(timer);
    await release().catch(() => undefined);
  }
}

type Tunnel = { port: number; close(): void; failure(): string | null };

// ssh's options for an ssh://[user@]host[:port] endpoint, and where it
// goes: no prompts, a bounded connect, the port if one is named.
export type SshArgs = { options: string[]; destination: string };
export function sshArgs(endpoint: string): SshArgs {
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
  return {
    options: [
      "-T",
      "-o",
      "BatchMode=yes",
      "-o",
      "ConnectTimeout=10",
      ...(url.port ? ["-p", url.port] : []),
    ],
    destination: host,
  };
}

// The Paseo CLI's tunnel, in miniature: a local listener that, on its first
// connection, spawns `ssh -W 127.0.0.1:<daemonPort> <host>` and pipes the
// socket through it. One connection per tunnel, which is all one run needs.
function openSshTunnel(endpoint: string): Promise<Tunnel> {
  const { options, destination } = sshArgs(endpoint);
  const args = [
    ...options,
    "-o",
    "ClearAllForwardings=yes",
    "-o",
    "ExitOnForwardFailure=yes",
    "-W",
    "127.0.0.1:6767",
    destination,
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
      // After ssh has exited and its output is read, so the client's
      // connection ends only once the failure says why.
      ssh.on("close", (code, signal) => {
        if (code !== 0 || signal)
          failure ??= stderr.trim() || `ssh exited with ${signal ?? code}`;
        accepted.destroy(failure ? new Error(failure) : undefined);
      });
      accepted.on("error", () => undefined);
      // ssh may exit before the client's first bytes reach it; its exit
      // says why, and an unheard EPIPE here would end the process.
      ssh.stdin.on("error", () => undefined);
      accepted.on("close", () => {
        if (child && !child.killed) child.kill();
      });
      accepted.pipe(ssh.stdin);
      ssh.stdout.pipe(accepted, { end: false });
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
