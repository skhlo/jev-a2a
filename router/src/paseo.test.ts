// The adapter's rules over a scripted daemon: the sheet's mappers, the
// workspace join, one workspace list per adapter, per-session reads only
// for live sessions, and a failed read costing one field.
import test from "node:test";
import assert from "node:assert/strict";
import type { PaseoAgent, PaseoWorkspace } from "@getpaseo/client";
import {
  activityOf,
  adapterOver,
  checkoutFor,
  checkoutOf,
  claudeCondition,
  claudePromptEmpty,
  codexPrompt,
  firstLine,
  pasteable,
  screenFrom,
  subagentsOf,
  terminalSnapshotOf,
  type Daemon,
  type PaseoTerminal,
  type ProviderSubagent,
  type Screen,
  type TimelineEntry,
} from "./paseo.ts";

// A screen as the adapter reads it: lines with dim cells blank, the same
// lines as drawn (the same unless given), and the cursor.
const screen = (
  lines: string[],
  cursorRow: number | null,
  cursorCol: number | null = null,
  drawn: string[] = lines,
): Screen => ({ lines, drawn, cursorRow, cursorCol });

const SEEN = "2026-09-30T09:44:50.000Z";

const agent = (status: PaseoAgent["status"]): PaseoAgent => ({
  id: "A1",
  provider: "claude",
  cwd: "/work/.paseo/worktrees/feat-x",
  model: null,
  createdAt: SEEN,
  updatedAt: SEEN,
  lastUserMessageAt: null,
  status,
  capabilities: {
    supportsStreaming: true,
    supportsSessionPersistence: true,
    supportsDynamicModes: true,
    supportsMcpServers: true,
    supportsReasoningStream: true,
    supportsToolInvocations: true,
  },
  currentModeId: null,
  availableModes: [],
  pendingPermissions: [],
  persistence: null,
  title: null,
  labels: {},
});

const project = {
  projectKey: "prj_1",
  projectName: "A2A",
  workspaceName: "feat-x",
  checkout: {
    cwd: "/work/.paseo/worktrees/feat-x",
    isGit: true as const,
    currentBranch: "feat/x",
    remoteUrl: null,
    worktreeRoot: "/work/.paseo/worktrees/feat-x",
    isPaseoOwnedWorktree: true,
    mainRepoRoot: "/work",
  },
};

// A workspace entry with every field the sheet reads.
const worktree: PaseoWorkspace = {
  id: "wks_1",
  projectId: "prj_1",
  projectDisplayName: "A2A",
  projectRootPath: "/work",
  workspaceDirectory: "/work/.paseo/worktrees/feat-x",
  projectKind: "git",
  workspaceKind: "worktree",
  name: "feat-x",
  archivingAt: null,
  status: "running",
  statusEnteredAt: SEEN,
  activityAt: SEEN,
  scripts: [],
  diffStat: { additions: 10, deletions: 3 },
  gitRuntime: {
    currentBranch: "feat/x",
    remoteUrl: "git@github.com:me/a2a.git",
    isPaseoOwnedWorktree: true,
    isDirty: true,
    aheadBehind: { ahead: 2, behind: 0 },
  },
  githubRuntime: {
    pullRequest: {
      number: 7,
      url: "https://github.com/me/a2a/pull/7",
      title: "feat: x",
      state: "OPEN",
      baseRefName: "main",
      headRefName: "feat/x",
      isMerged: false,
      isDraft: false,
      mergeable: "MERGEABLE",
      checksStatus: "failure",
      reviewDecision: null,
    },
  },
  project,
};

// A plain checkout the daemon knows little about.
const plain: PaseoWorkspace = {
  id: "wks_2",
  projectId: "prj_2",
  projectDisplayName: "home",
  projectRootPath: "/home/me",
  workspaceDirectory: "/home/me",
  projectKind: "directory",
  workspaceKind: "directory",
  name: "main",
  archivingAt: null,
  status: "done",
  statusEnteredAt: null,
  activityAt: null,
  scripts: [],
};

test("checkoutOf reads the sidebar's row, and nulls what the daemon left out", () => {
  assert.deepEqual(checkoutOf(worktree), {
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
  });
  assert.deepEqual(checkoutOf(plain), {
    project: "home",
    workspace: "main",
    directory: "/home/me",
    kind: "directory",
    branch: null,
    remote: null,
    dirty: null,
    ahead: null,
    behind: null,
    diff: null,
    pr: null,
    status: "done",
    activityAt: null,
  });
});

test("checkoutFor joins by project key and workspace name, by directory when the names do not match or are missing, else null", () => {
  // Two workspaces of one project, same directory shape, different names:
  // the name decides, not the directory.
  const other: PaseoWorkspace = {
    ...worktree,
    id: "wks_3",
    name: "feat-y",
    workspaceDirectory: "/work/.paseo/worktrees/feat-x",
    project: { ...project, workspaceName: "feat-y" },
  };
  assert.equal(
    checkoutFor(project, [plain, other, worktree])?.workspace,
    "feat-x",
  );
  // No name on the daemon's side: the directory decides.
  const unnamed = { ...project, workspaceName: null };
  const bare = { ...worktree, project: { ...project, workspaceName: null } };
  assert.equal(checkoutFor(unnamed, [plain, bare])?.workspace, "feat-x");
  // A different name and a different directory: nothing.
  const renamed = { ...project, projectKey: "prj_9", workspaceName: "other" };
  assert.equal(
    checkoutFor({ ...renamed, checkout: { ...project.checkout, cwd: "/x" } }, [
      plain,
      worktree,
    ]),
    null,
  );
  assert.equal(checkoutFor(null, [worktree]), null);
});

const sub = (
  id: string,
  status: ProviderSubagent["status"],
  createdAt: string,
  parent: string | null = null,
): ProviderSubagent => ({
  id,
  parentAgentId: "A1",
  parentSubagentId: parent,
  provider: "claude",
  title: "worker",
  description: `Brief for ${id}.\nMore detail below.`,
  status,
  createdAt,
  updatedAt: createdAt,
  toolCallId: id,
});

test("subagentsOf counts the history and lists the open ones oldest first, capped", () => {
  const list = [
    sub("s3", "running", "2026-09-30T09:03:00.000Z", "s2"),
    sub("s1", "completed", "2026-09-30T09:01:00.000Z"),
    sub("s2", "running", "2026-09-30T09:02:00.000Z"),
    sub("s4", "failed", "2026-09-30T09:04:00.000Z"),
    sub("s5", "canceled", "2026-09-30T09:05:00.000Z"),
  ];
  assert.deepEqual(subagentsOf(list), {
    counts: { running: 2, completed: 1, failed: 1, canceled: 1 },
    running: [
      {
        id: "s2",
        title: "worker",
        description: "Brief for s2.",
        status: "running",
        startedAt: "2026-09-30T09:02:00.000Z",
        updatedAt: "2026-09-30T09:02:00.000Z",
        parent: null,
      },
      {
        id: "s3",
        title: "worker",
        description: "Brief for s3.",
        status: "running",
        startedAt: "2026-09-30T09:03:00.000Z",
        updatedAt: "2026-09-30T09:03:00.000Z",
        parent: "s2",
      },
    ],
  });
  assert.equal(subagentsOf(list, 1).running.length, 1);
  assert.deepEqual(subagentsOf([]), {
    counts: { running: 0, completed: 0, failed: 0, canceled: 0 },
    running: [],
  });
  // A long history: all counted, none listed; a wide fan-out: twenty
  // listed by default.
  const history = Array.from({ length: 73 }, (_, i) =>
    sub(
      `h${i}`,
      "completed",
      `2026-09-30T09:${String(i % 60).padStart(2, "0")}:00.000Z`,
    ),
  );
  assert.deepEqual(subagentsOf(history), {
    counts: { running: 0, completed: 73, failed: 0, canceled: 0 },
    running: [],
  });
  const wide = Array.from({ length: 25 }, (_, i) =>
    sub(
      `w${i}`,
      "running",
      `2026-09-30T10:${String(i).padStart(2, "0")}:00.000Z`,
    ),
  );
  const listed = subagentsOf(wide);
  assert.equal(listed.counts.running, 25);
  assert.equal(listed.running.length, 20);
  assert.equal(listed.running[0]?.id, "w0");
});

const entry = (
  timestamp: string,
  item: TimelineEntry["item"],
): TimelineEntry => ({
  provider: "claude",
  item,
  timestamp,
  seqStart: 1,
  seqEnd: 1,
  sourceSeqRanges: [],
  collapsed: [],
});

test("activityOf drops the harness's own tool calls and keeps the last `limit` of what is left", () => {
  const tool = (at: string, name: string) =>
    entry(at, {
      type: "tool_call",
      callId: `c-${at}`,
      name,
      detail: { type: "plain_text", text: at },
      status: "completed",
      error: null,
    });
  const activity = activityOf(
    [
      entry("t0", { type: "user_message", text: "go" }),
      tool("t1", "Bash"),
      tool("t2", "task_notification"),
      tool("t3", "Bash"),
      tool("t4", "task_notification"),
      tool("t5", "Read"),
    ],
    3,
  );
  assert.deepEqual(
    activity.items.map((i) => i.at),
    ["t1", "t3", "t5"],
  );
  assert.equal(activity.turns, 0, "turns count the kept window");
});

test("activityOf cuts each entry to a line and counts the user messages", () => {
  const long = "x".repeat(200);
  assert.deepEqual(
    activityOf([
      entry("t1", { type: "user_message", text: "\n  go\nand more" }),
      entry("t2", { type: "reasoning", text: long }),
      entry("t3", {
        type: "tool_call",
        callId: "c1",
        name: "Bash",
        detail: { type: "shell", command: "pnpm test" },
        status: "running",
        error: null,
      }),
      entry("t4", {
        type: "tool_call",
        callId: "c2",
        name: "Read",
        detail: { type: "read", filePath: "README.md" },
        status: "completed",
        error: null,
      }),
      entry("t5", { type: "error", message: "rate limited" }),
      entry("t6", { type: "todo", items: [] }),
      entry("t7", { type: "compaction", status: "completed" }),
      entry("t8", {
        type: "plugin",
        id: "p",
        pluginId: "p",
        kind: "k",
        version: 1,
        data: null,
      }),
      entry("t9", { type: "user_message", text: "   " }),
    ]),
    {
      turns: 2,
      items: [
        {
          at: "t1",
          kind: "user_message",
          text: "go",
          tool: null,
          status: null,
        },
        {
          at: "t2",
          kind: "reasoning",
          text: `${"x".repeat(159)}…`,
          tool: null,
          status: null,
        },
        {
          at: "t3",
          kind: "tool_call",
          text: "pnpm test",
          tool: "Bash",
          status: "running",
        },
        {
          at: "t4",
          kind: "tool_call",
          text: "README.md",
          tool: "Read",
          status: "completed",
        },
        {
          at: "t5",
          kind: "error",
          text: "rate limited",
          tool: null,
          status: null,
        },
        { at: "t6", kind: "todo", text: "0 items", tool: null, status: null },
        {
          at: "t7",
          kind: "compaction",
          text: "completed",
          tool: null,
          status: null,
        },
        { at: "t8", kind: "plugin", text: null, tool: null, status: null },
        {
          at: "t9",
          kind: "user_message",
          text: null,
          tool: null,
          status: null,
        },
      ],
    },
  );
  assert.equal(firstLine(null), null);
  assert.equal(firstLine("one\ntwo", 2), "o…");
});

// A daemon that records what was asked of it.
function scripted(status: PaseoAgent["status"], fail: string[] = []) {
  const calls: string[] = [];
  const daemon: Daemon = {
    async refresh(agentId) {
      calls.push(`refresh ${agentId}`);
      return { agent: { ...agent(status), id: agentId }, project };
    },
    async send() {
      calls.push("send");
    },
    async workspaces() {
      calls.push("workspaces");
      if (fail.includes("workspaces")) throw new Error("list timed out");
      return [worktree];
    },
    async subagents(agentId) {
      calls.push(`subagents ${agentId}`);
      if (fail.includes("subagents")) throw new Error("no such provider");
      return [sub("s1", "running", SEEN)];
    },
    async tail(agentId, limit) {
      calls.push(`tail ${agentId} ${limit}`);
      if (fail.includes("tail")) throw new Error("timeline gone");
      return [entry("t1", { type: "user_message", text: "go" })];
    },
    async terminals() {
      calls.push("terminals");
      return [];
    },
    async screen() {
      calls.push("screen");
      return screen([], null);
    },
    async input() {
      calls.push("input");
    },
    async close() {
      calls.push("close");
    },
  };
  return { daemon, calls };
}

test("a live session gets the whole sheet; the workspace list is read once per adapter", async () => {
  const { daemon, calls } = scripted("running");
  const adapter = adapterOver(daemon, { tail: 3 });
  const first = await adapter.observe("A1", SEEN);
  const second = await adapter.observe("A2", SEEN);
  assert.equal(first?.snapshot.checkout?.branch, "feat/x");
  assert.equal(first?.snapshot.subagents?.counts.running, 1);
  assert.deepEqual(first?.snapshot.activity, {
    turns: 1,
    items: [
      { at: "t1", kind: "user_message", text: "go", tool: null, status: null },
    ],
  });
  assert.equal(first?.notes, undefined);
  assert.equal(second?.snapshot.checkout?.branch, "feat/x");
  // The tail is fetched with HARNESS_ROOM extra entries.
  assert.deepEqual(calls, [
    "refresh A1",
    "workspaces",
    "subagents A1",
    "tail A1 7",
    "refresh A2",
    "subagents A2",
    "tail A2 7",
  ]);
});

test("a session that is not live gets its checkout and nothing that would resume it", async () => {
  for (const status of ["closed", "initializing", "error"] as const) {
    const { daemon, calls } = scripted(status);
    const seen = await adapterOver(daemon).observe("A1", SEEN);
    assert.equal(seen?.snapshot.checkout?.workspace, "feat-x", status);
    assert.equal(seen?.snapshot.subagents, null, status);
    assert.equal(seen?.snapshot.activity, null, status);
    assert.deepEqual(calls, ["refresh A1", "workspaces"], status);
  }
});

test("a failed sheet read nulls its field and leaves a note; the rail and the rest stand; a failed list is one note per adapter", async () => {
  const { daemon, calls } = scripted("idle", ["workspaces", "tail"]);
  const adapter = adapterOver(daemon);
  const seen = await adapter.observe("A1", SEEN);
  assert.equal(seen?.ready, true);
  assert.equal(seen?.snapshot.status, "idle");
  assert.equal(seen?.snapshot.checkout, null);
  assert.equal(seen?.snapshot.subagents?.counts.running, 1);
  assert.equal(seen?.snapshot.activity, null);
  assert.deepEqual(seen?.notes, [
    "workspaces not listed: list timed out",
    "activity of A1 not read: timeline gone",
  ]);
  // The next session on the host gets its null without the list being
  // asked for again or the failure repeated.
  const next = await adapter.observe("A2", SEEN);
  assert.equal(next?.snapshot.checkout, null);
  assert.deepEqual(next?.notes, ["activity of A2 not read: timeline gone"]);
  assert.equal(calls.filter((c) => c === "workspaces").length, 1);
});

test("with the sheet off, only the rail is read", async () => {
  const { daemon, calls } = scripted("running");
  const seen = await adapterOver(daemon, { sheet: false }).observe("A1", SEEN);
  assert.equal(seen?.snapshot.checkout, null);
  assert.equal(seen?.snapshot.subagents, null);
  assert.equal(seen?.snapshot.activity, null);
  assert.deepEqual(calls, ["refresh A1"]);
});

// A terminal as the daemon lists it, and screens as Claude Code draws
// them (from captures on 0.10.2 with Claude Code 2.1.289).
const term = (
  activity: PaseoTerminal["activity"],
  title = "✳ Claude Code",
): PaseoTerminal => ({
  id: "T1",
  name: "Terminal 1",
  cwd: "/work/.paseo/worktrees/feat-x",
  workspaceId: "wks_1",
  title,
  activity,
});
const finishedAt = (changedAt: number): PaseoTerminal["activity"] => ({
  state: "idle",
  attentionReason: "finished",
  changedAt,
});
const rule = "─".repeat(40);
const status = [
  "  ✻ | Opus 5.5 | xhigh | ctx 0%/1.0m",
  "   source |  main | ⇣4",
  "  ⏵⏵ auto mode on (shift+tab to cycle) · ← for agents",
];
const atPrompt = (box: string): Screen =>
  screen(
    [
      "source main ❯ claude",
      " ▐▛███▛█   Claude Code v2.1.289",
      "",
      rule,
      box,
      rule,
      ...status,
      ...Array<string>(15).fill(""),
    ],
    4,
  );
const EMPTY = atPrompt("❯");
const TYPED = atPrompt("❯ half a line");
const DIALOG_LINES = [
  "● Bash(touch /tmp/marker)",
  "  ⎿  Waiting…",
  rule,
  " Bash command",
  " Create a marker file",
  "╌".repeat(40),
  " touch /tmp/marker",
  "╌".repeat(40),
  " Do you want to proceed?",
  " ❯ 1. Yes",
  "   2. Yes, and always allow access to /tmp from this project",
  "   3. No",
  " Esc to cancel · Tab to amend",
];
const DIALOG = screen(DIALOG_LINES, 9);

// A daemon holding one terminal, whose activity the scripted hook changes
// when Enter arrives.
function terminalDaemon(
  start: PaseoTerminal | null,
  onEnter: ((t: PaseoTerminal) => PaseoTerminal) | null,
  shown: Screen = EMPTY,
) {
  let current = start;
  const inputs: string[] = [];
  const reads: string[] = [];
  const { daemon } = scripted("idle");
  const terminals: Daemon = {
    ...daemon,
    async terminals() {
      return current ? [current] : [];
    },
    async screen(terminalId) {
      reads.push(terminalId);
      return shown;
    },
    async input(terminalId, data) {
      assert.equal(terminalId, "T1");
      inputs.push(data);
      if (data === "\r" && current && onEnter) current = onEnter(current);
    },
  };
  return { daemon: terminals, inputs, reads };
}
const quick = { receiptMs: 1_000, sleep: () => Promise.resolve() };

test("a terminal's condition: working by its activity or spinner, waiting at the idle mark, away when the title is not Claude Code's", () => {
  const cases: [PaseoTerminal, string][] = [
    [term(finishedAt(5)), "waiting"],
    [term(null), "waiting"],
    [
      term({ state: "idle", attentionReason: "needs_input", changedAt: 5 }),
      "waiting",
    ],
    // A permission dialog: the title shows the idle mark, the activity
    // stays working.
    [term({ state: "working", changedAt: 5 }), "working"],
    [term(null, "◐ Fix the bug"), "working"],
    // The CLI exited: Paseo keeps the idle of its SessionEnd hook.
    [term({ state: "idle", changedAt: 5 }, "skhl@mbp:~/dotfiles"), "away"],
    [term(null, "~/dotfiles"), "away"],
    [term(null, "$ vim notes.md"), "away"],
    [term(null, ""), "away"],
    // Killed mid-turn under a shell that sets its title.
    [term({ state: "working", changedAt: 5 }, "skhl@mbp:~/dotfiles"), "away"],
  ];
  for (const [t, condition] of cases)
    assert.equal(
      claudeCondition(t),
      condition,
      JSON.stringify([t.activity, t.title]),
    );
});

test("only an empty prompt box at the foot of the screen, with the cursor in it, is a prompt to paste into", () => {
  assert.equal(claudePromptEmpty(EMPTY), true);
  assert.equal(
    claudePromptEmpty({ ...EMPTY, lines: EMPTY.lines.map((l) => `${l}  `) }),
    true,
  );
  assert.equal(claudePromptEmpty(TYPED), false);
  assert.equal(claudePromptEmpty(DIALOG), false);
  assert.equal(claudePromptEmpty(screen([], null)), false);
  assert.equal(claudePromptEmpty({ ...EMPTY, cursorRow: null }), false);
  // A box a killed CLI left behind, with the shell's prompt and cursor
  // under it.
  assert.equal(
    claudePromptEmpty(
      screen([...EMPTY.lines.slice(0, 9), "source main ❯ "], 9),
    ),
    false,
  );
  // A box left above a screenful of other output is not the one in use.
  assert.equal(
    claudePromptEmpty(
      screen(
        [...EMPTY.lines.slice(0, 9), ...Array<string>(5).fill("output")],
        4,
      ),
    ),
    false,
  );
});

test("a grid snapshot reads as its lines with dim cells blank, the same lines as drawn, and its cursor", () => {
  const cell = (char: string, dim = false) => ({ char, dim });
  const row = (text: string, dim = false) =>
    [...text].map((char) => cell(char, dim));
  const read = screenFrom({
    rows: 3,
    cols: 12,
    grid: [
      row("─".repeat(12)),
      [...row("❯ "), ...row('Try "x"', true)],
      row("─".repeat(12)),
    ],
    scrollback: [],
    cursor: { row: 1, col: 2 },
  });
  assert.deepEqual(read, {
    lines: ["─".repeat(12), "❯        ", "─".repeat(12)],
    drawn: ["─".repeat(12), '❯ Try "x"', "─".repeat(12)],
    cursorRow: 1,
    cursorCol: 2,
  });
});

test("a terminal's snapshot says what its condition and activity say, and nulls what a terminal does not report", () => {
  const seen = terminalSnapshotOf(term(finishedAt(Date.parse(SEEN))), SEEN);
  assert.equal(seen.status, "idle");
  assert.equal(seen.attention, "finished");
  assert.equal(seen.attentionAt, SEEN);
  assert.equal(seen.title, "Claude Code");
  assert.equal(seen.cwd, "/work/.paseo/worktrees/feat-x");
  assert.equal(seen.provider, null);
  assert.equal(seen.context, null);
  const working = terminalSnapshotOf(
    term({ state: "working", changedAt: Date.parse(SEEN) }, "◑ Fix the bug"),
    SEEN,
  );
  assert.equal(working.status, "running");
  assert.equal(working.turnStartedAt, SEEN);
  assert.equal(working.attention, null);
  assert.equal(working.title, "Fix the bug");
  const away = terminalSnapshotOf(
    term(finishedAt(5), "skhl@mbp:~/dotfiles"),
    SEEN,
  );
  assert.equal(away.status, "closed");
  assert.equal(away.attention, null);
  assert.equal(away.title, "skhl@mbp:~/dotfiles");
});

test("observing a terminal: ready only at an empty prompt box, the screen read only when it waits, the workspace joined; an unknown terminal is not found", async () => {
  const idle = terminalDaemon(term(finishedAt(5)), null);
  const seen = await adapterOver(idle.daemon).observe("terminal:T1", SEEN);
  assert.equal(seen?.ready, true);
  assert.equal(seen?.status, "idle");
  assert.equal(seen?.snapshot.checkout?.workspace, "feat-x");
  assert.equal(seen?.snapshot.subagents, null);
  assert.deepEqual(idle.reads, ["T1"]);

  const typed = terminalDaemon(term(finishedAt(5)), null, TYPED);
  const busy = await adapterOver(typed.daemon).observe("terminal:T1", SEEN);
  assert.equal(busy?.ready, false);
  assert.equal(busy?.status, "at its prompt with text in it or a dialog open");

  const working = terminalDaemon(
    term({ state: "working", changedAt: 5 }),
    null,
  );
  const run = await adapterOver(working.daemon).observe("terminal:T1", SEEN);
  assert.equal(run?.ready, false);
  assert.equal(run?.status, "working");
  assert.deepEqual(working.reads, []);

  const exited = terminalDaemon(term(finishedAt(5), "skhl@mbp:~"), null);
  const gone = await adapterOver(exited.daemon).observe("terminal:T1", SEEN);
  assert.equal(gone?.ready, false);
  assert.equal(
    gone?.status,
    'Claude Code is not running in the terminal (title "skhl@mbp:~")',
  );

  const blind = terminalDaemon(term(null), null);
  blind.daemon.screen = () => Promise.reject(new Error("capture failed"));
  const unread = await adapterOver(blind.daemon).observe("terminal:T1", SEEN);
  assert.equal(unread?.ready, false);
  assert.deepEqual(unread?.notes, [
    "screen of terminal:T1 not read: capture failed",
  ]);

  assert.equal(
    await adapterOver(terminalDaemon(null, null).daemon).observe(
      "terminal:T1",
      SEEN,
    ),
    null,
  );
});

test("a terminal send is one bracketed paste and then Enter, accepted when the activity shows the prompt started a turn", async () => {
  const { daemon, inputs } = terminalDaemon(term(finishedAt(5)), (t) => ({
    ...t,
    activity: { state: "working", changedAt: 9 },
  }));
  const outcome = await adapterOver(daemon, quick).send(
    "terminal:T1",
    "D1/M1",
    "[router T1 M1] Task\r\n\nFix it\u001b[201~ now",
  );
  assert.equal(outcome, "accepted");
  assert.deepEqual(inputs, [
    "\u001b[200~[router T1 M1] Task\n\nFix it[201~ now\u001b[201~",
    "\r",
  ]);
});

test("a turn that finished before the next look still confirms the send, from no activity too", async () => {
  for (const start of [term(finishedAt(5)), term(null)]) {
    const { daemon } = terminalDaemon(start, (t) => ({
      ...t,
      activity: finishedAt(9),
    }));
    assert.equal(
      await adapterOver(daemon, quick).send("terminal:T1", "D1/M1", "go"),
      "accepted",
    );
  }
});

test("a terminal send is refused before any input unless the terminal waits at an empty prompt", async () => {
  const refused: [PaseoTerminal | null, Screen][] = [
    [null, EMPTY],
    [term({ state: "working", changedAt: 5 }), DIALOG],
    [term(null), DIALOG],
    [term(finishedAt(5)), TYPED],
    [term(finishedAt(5), "skhl@mbp:~/dotfiles"), EMPTY],
  ];
  for (const [start, screen] of refused) {
    const { daemon, inputs } = terminalDaemon(start, null, screen);
    assert.equal(
      await adapterOver(daemon, quick).send("terminal:T1", "D1/M1", "go"),
      "not_sent",
      JSON.stringify([start?.activity, start?.title, screen.lines[4]]),
    );
    assert.deepEqual(inputs, []);
  }
});

test("a terminal send that fails before the paste is not sent; one that fails after it is unknown", async () => {
  const listless = terminalDaemon(term(finishedAt(5)), null);
  listless.daemon.terminals = () => Promise.reject(new Error("gone"));
  assert.equal(
    await adapterOver(listless.daemon, quick).send(
      "terminal:T1",
      "D1/M1",
      "go",
    ),
    "not_sent",
  );
  for (const [failing, outcome] of [
    [1, "not_sent"],
    [2, "unknown"],
  ] as const) {
    const { daemon, inputs } = terminalDaemon(term(finishedAt(5)), null);
    const input = daemon.input;
    daemon.input = async (id, data) => {
      if (inputs.length + 1 === failing) throw new Error("socket closed");
      return input(id, data);
    };
    assert.equal(
      await adapterOver(daemon, quick).send("terminal:T1", "D1/M1", "go"),
      outcome,
    );
  }
});

test("a send is unknown when no turn follows, whatever else the activity does", async () => {
  for (const after of [
    null,
    term(finishedAt(5)).activity,
    { state: "idle" as const, attentionReason: null, changedAt: 9 },
  ]) {
    const { daemon, inputs } = terminalDaemon(term(finishedAt(5)), (t) => ({
      ...t,
      activity: after,
    }));
    assert.equal(
      await adapterOver(daemon, quick).send("terminal:T1", "D1/M1", "go"),
      "unknown",
      JSON.stringify(after),
    );
    assert.equal(inputs.length, 2);
  }
});

// Codex's screens as the daemon's grid snapshot gives them, read through
// screenFrom: each row a list of runs, a string drawn plain or [text, "dim"]
// (shapes and dim runs as probed with Codex 0.159.2 and 0.160.0, ticket 018).
type Run = string | [string, "dim"];
const gridScreen = (rows: Run[][], row: number, col: number): Screen =>
  screenFrom({
    rows: rows.length,
    cols: 80,
    grid: rows.map((runs) =>
      runs.flatMap((run) =>
        [...(typeof run === "string" ? run : run[0])].map((char) => ({
          char,
          dim: typeof run !== "string",
        })),
      ),
    ),
    scrollback: [],
    cursor: { row, col },
  });
const CODEX_HEAD: Run[][] = [
  [">_ OpenAI Codex", [" (v0.159.2)", "dim"]],
  [["~/Projects/2026/09/jev-a2a", "dim"]],
  [],
  ["Shall we make the thing that makes the other thing easier?"],
  [],
];
const CODEX_FOOT: Run[][] = [
  [],
  ["GPT-6-Astra low · ~/Projects/2026/09/jev-a2a · main · Ask for approval"],
  ["? for shortcuts"],
];
const COMPOSER: Run[] = ["› ", ["Ask Codex to do anything", "dim"]];
// Codex with `above` between its header and the composer rows; the cursor
// on the composer's first row, at `col`, unless `at` says otherwise.
const codexAt = (
  above: Run[][],
  composer: Run[][],
  col = 2,
  at?: [number, number],
): Screen => {
  const row = CODEX_HEAD.length + above.length;
  return gridScreen(
    [...CODEX_HEAD, ...above, ...composer, ...CODEX_FOOT],
    at?.[0] ?? row,
    at?.[1] ?? col,
  );
};
const PAST_PROMPT: Run[] = [["›", "dim"], " Reply with the single word done."];
const CODEX_EMPTY = codexAt([PAST_PROMPT, [], ["• done"], []], [COMPOSER]);
const statusRow = (what: string, time: string): Run[] => [
  "• ",
  [what, "dim"],
  [` (${time} • `, "dim"],
  "esc",
  [" to interrupt)", "dim"],
];
const CODEX_THINKING = codexAt(
  [PAST_PROMPT, [], statusRow("Working", "1s"), []],
  [COMPOSER],
);
// A status line a narrow terminal cuts short.
const CODEX_CUT = codexAt(
  [
    PAST_PROMPT,
    [],
    [
      "• ",
      ["Working", "dim"],
      [" (1s • ", "dim"],
      "esc",
      [" to interrupt", "dim"],
    ],
    [],
  ],
  [COMPOSER],
);
// The automatic reviewer at work: the activity says needs_input, the
// composer looks empty.
const CODEX_REVIEW = codexAt(
  [
    ["• Running touch /tmp/marker"],
    [],
    statusRow("Reviewing approval request", "8s"),
    [["  └ /bin/zsh -lc 'touch /tmp/marker'", "dim"]],
  ],
  [COMPOSER],
);
// A turn streaming its answer shows no status row.
const CODEX_STREAMING = codexAt(
  [["• 1"], ["  2"], ["  3"], ["  4"]],
  [COMPOSER],
);
const CODEX_DECLINED = codexAt(
  [
    ["✗ You canceled the request to run touch /tmp/marker"],
    [],
    ["■ Conversation interrupted - use /feedback if something went wrong"],
    [],
  ],
  [COMPOSER],
);
const CODEX_DRAFT = codexAt([], [["› draft"]], 7);
const CODEX_DRAFT_HOME = codexAt([], [["› draft"]], 2);
const CODEX_TWO_LINES = codexAt([], [["› one"], ["  two"]], 5, [
  CODEX_HEAD.length + 1,
  5,
]);
const CODEX_PASTE = codexAt([], [["› [Pasted Content 2737 chars]"]], 29);
// A draft whose first line is empty, the cursor moved up to it, over a
// one-line footer.
const CODEX_DRAFT_BELOW = gridScreen(
  [...CODEX_HEAD, COMPOSER, ["  two"], [], ["? for shortcuts"]],
  CODEX_HEAD.length,
  2,
);
// A draft of spaces: the placeholder is gone and the line trims to the ›.
const CODEX_SPACES = codexAt([], [["›  "]], 3);
// A composer left on screen with a one-line footer and the shell's prompt,
// and its cursor, under it: bash's, and zsh's two-character `> `, whose
// cursor sits in the composer's column.
const codexLeft = (prompt: string, col: number): Screen =>
  gridScreen(
    [...CODEX_HEAD, COMPOSER, [], ["? for shortcuts"], [prompt]],
    CODEX_HEAD.length + 3,
    col,
  );
const CODEX_LEFT = codexLeft("jev-a2a main ❯ ", 15);
const CODEX_LEFT_ZSH = codexLeft("> ", 2);
// The approval overlay in place of the composer: its selected option also
// starts with ›, and the cursor is parked at the foot.
const CODEX_APPROVAL = gridScreen(
  [
    ...CODEX_HEAD,
    ["Would you like to run the following command?"],
    [],
    ["  $ touch /tmp/marker"],
    [],
    ["› 1. Yes, proceed (y)"],
    ["  2. Yes, and don't ask again for commands that start with `touch`"],
    ["  3. No, and tell Codex what to do differently (esc)"],
    [],
    [
      ["Press ", "dim"],
      "enter",
      [" to confirm or ", "dim"],
      "esc",
      [" to cancel", "dim"],
    ],
  ],
  CODEX_HEAD.length + 8,
  80,
);
// The model-migration notice at start: no composer, the cursor parked.
const CODEX_NOTICE = gridScreen(
  [
    [],
    [
      "  Codex now uses GPT-6 Luna in place of GPT-5.4 Mini. Switch to GPT-6 Luna to",
    ],
    ["  continue."],
    ["enter/esc", [" continue ·", "dim"], "ctrl+c", [" quit", "dim"]],
  ],
  21,
  1,
);
// Codex exited: the shell's prompt, no composer.
const CODEX_EXITED = gridScreen(
  [
    ["jev-a2a main ❯ codex --no-daemon"],
    ["Token usage: total=20,868 input=20,800 (+ 40,576 cached) output=68"],
    ["To continue this session, run:"],
    ["codex resume 01a10c10-68c5-71c1-b03e-8f810f6c6fac"],
    [],
    ["jev-a2a main ❯ "],
  ],
  5,
  15,
);
// Codex killed: its frame stays, the shell writes over the composer row and
// prompts below it.
const CODEX_KILLED = gridScreen(
  [
    ...CODEX_HEAD,
    [
      "› Killed                     codex --no-daemon -c model_reasoning_effort=low",
    ],
    [],
    ["GPT-6-Astra low · ~/Projects/2026/09/jev-a2a · main · Ask for approval"],
    ["jev-a2a main ✗ "],
  ],
  CODEX_HEAD.length + 3,
  15,
);

test("Codex's empty composer is the last undimmed › alone on its line, the footer under it and the cursor after it; a status line offering Esc is a turn", () => {
  const cases: [string, Screen, string][] = [
    ["empty", CODEX_EMPTY, "empty"],
    ["declined approval", CODEX_DECLINED, "empty"],
    ["streaming (the activity covers it)", CODEX_STREAMING, "empty"],
    ["thinking", CODEX_THINKING, "busy"],
    ["automatic review", CODEX_REVIEW, "busy"],
    ["status line cut short", CODEX_CUT, "busy"],
    ["draft", CODEX_DRAFT, "other"],
    ["draft, cursor at its start", CODEX_DRAFT_HOME, "other"],
    ["two-line draft", CODEX_TWO_LINES, "other"],
    ["paste", CODEX_PASTE, "other"],
    ["draft below an empty first line", CODEX_DRAFT_BELOW, "other"],
    ["composer left above the shell", CODEX_LEFT, "other"],
    ["composer left above zsh's prompt", CODEX_LEFT_ZSH, "other"],
    ["draft of spaces", CODEX_SPACES, "other"],
    ["approval overlay", CODEX_APPROVAL, "other"],
    ["startup notice", CODEX_NOTICE, "other"],
    ["exited", CODEX_EXITED, "other"],
    ["killed", CODEX_KILLED, "other"],
    [
      "no cursor",
      { ...CODEX_EMPTY, cursorRow: null, cursorCol: null },
      "other",
    ],
    ["nothing", screen([], null), "other"],
  ];
  for (const [what, shown, expected] of cases)
    assert.equal(codexPrompt(shown), expected, what);
  // A composer with more than the footer under it is not the one in use.
  const below = codexAt([], [COMPOSER, ...CODEX_FOOT, ["output"]]);
  assert.equal(codexPrompt(below), "other");
  // Trailing blank rows are not below it.
  assert.equal(
    codexPrompt({
      ...CODEX_EMPTY,
      lines: [...CODEX_EMPTY.lines, "", ""],
      drawn: [...CODEX_EMPTY.drawn, "", ""],
    }),
    "empty",
  );
});

const codexTerm = (
  activity: PaseoTerminal["activity"],
  title = "jev-a2a",
): PaseoTerminal => term(activity, title);
const needsInput = (changedAt: number): PaseoTerminal["activity"] => ({
  state: "idle",
  attentionReason: "needs_input",
  changedAt,
});
const asCodex = { clis: { "terminal:T1": "codex" as const } };

test("observing Codex: ready at its empty composer whatever its title, not while its activity or status line shows a turn, and a stale needs_input does not hold it", async () => {
  const observe = async (t: PaseoTerminal, shown: Screen) => {
    const d = terminalDaemon(t, null, shown);
    const seen = await adapterOver(d.daemon, asCodex).observe(
      "terminal:T1",
      SEEN,
    );
    return { seen, reads: d.reads };
  };
  const fresh = await observe(codexTerm(null), CODEX_EMPTY);
  assert.equal(fresh.seen?.ready, true);
  assert.equal(fresh.seen?.status, "idle");
  // The same terminal as Claude Code would be away: the title is not its.
  const asClaude = terminalDaemon(codexTerm(null), null, CODEX_EMPTY);
  assert.equal(
    (await adapterOver(asClaude.daemon).observe("terminal:T1", SEEN))?.ready,
    false,
  );

  const declined = await observe(codexTerm(needsInput(5)), CODEX_DECLINED);
  assert.equal(declined.seen?.ready, true);

  const review = await observe(codexTerm(needsInput(5)), CODEX_REVIEW);
  assert.equal(review.seen?.ready, false);
  assert.equal(review.seen?.status, "working");
  assert.equal(review.seen?.snapshot.status, "running");

  const streaming = await observe(
    codexTerm({ state: "working", changedAt: 5 }),
    CODEX_STREAMING,
  );
  assert.equal(streaming.seen?.ready, false);
  assert.equal(streaming.seen?.status, "working");
  assert.deepEqual(streaming.reads, []);

  for (const shown of [CODEX_DRAFT, CODEX_APPROVAL, CODEX_EXITED]) {
    const other = await observe(codexTerm(finishedAt(5)), shown);
    assert.equal(other.seen?.ready, false);
    assert.equal(
      other.seen?.status,
      "not at an empty Codex composer: a draft, a dialog, or Codex not running",
    );
  }
});

test("a Codex terminal's snapshot carries its title without spinner frames or the approval banner", () => {
  const titles: [string, string | null][] = [
    ["jev-a2a", "jev-a2a"],
    ["⠹ Run terminal probe | jev-a2a", "Run terminal probe | jev-a2a"],
    ["⠼ ⠼ | dotfiles", "dotfiles"],
    ["[ ! ] Action Required | ⠏ | jev-a2a", "jev-a2a"],
    [
      "[ . ] Action Required | Run terminal probe | jev-a2a",
      "Run terminal probe | jev-a2a",
    ],
    ["", null],
  ];
  for (const [title, shown] of titles)
    assert.equal(
      terminalSnapshotOf(codexTerm(finishedAt(5), title), SEEN, "codex").title,
      shown,
      title,
    );
  const working = terminalSnapshotOf(
    codexTerm({ state: "working", changedAt: Date.parse(SEEN) }),
    SEEN,
    "codex",
  );
  assert.equal(working.status, "running");
  const waiting = terminalSnapshotOf(codexTerm(needsInput(5)), SEEN, "codex");
  assert.equal(waiting.status, "idle");
  assert.equal(waiting.attention, null);
});

test("a Codex send goes only to its empty composer, and is confirmed by the turn it starts", async () => {
  const { daemon, inputs } = terminalDaemon(
    codexTerm(needsInput(5)),
    (t) => ({ ...t, activity: { state: "working", changedAt: 9 } }),
    CODEX_DECLINED,
  );
  assert.equal(
    await adapterOver(daemon, { ...quick, ...asCodex }).send(
      "terminal:T1",
      "D1/M1",
      "go",
    ),
    "accepted",
  );
  assert.deepEqual(inputs, ["\u001b[200~go\u001b[201~", "\r"]);
  const refused: [PaseoTerminal, Screen][] = [
    [codexTerm(needsInput(5)), CODEX_REVIEW],
    [codexTerm({ state: "working", changedAt: 5 }), CODEX_STREAMING],
    [codexTerm(finishedAt(5)), CODEX_DRAFT_HOME],
    [codexTerm(needsInput(5)), CODEX_APPROVAL],
    [codexTerm(finishedAt(5)), CODEX_KILLED],
  ];
  for (const [start, shown] of refused) {
    const held = terminalDaemon(start, null, shown);
    assert.equal(
      await adapterOver(held.daemon, { ...quick, ...asCodex }).send(
        "terminal:T1",
        "D1/M1",
        "go",
      ),
      "not_sent",
    );
    assert.deepEqual(held.inputs, []);
  }
});

test("pasteable keeps text, tabs and newlines and drops what could drive the terminal", () => {
  assert.equal(
    pasteable("a\tb\r\nc\rd\u001b[201~\u0007e\u007f"),
    "a\tb\nc\nd[201~e",
  );
});
