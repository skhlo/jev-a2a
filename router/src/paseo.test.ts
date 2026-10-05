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
  firstLine,
  pasteable,
  promptEmpty,
  screenFrom,
  subagentsOf,
  terminalCondition,
  terminalSnapshotOf,
  type Daemon,
  type PaseoTerminal,
  type ProviderSubagent,
  type Screen,
  type TimelineEntry,
} from "./paseo.ts";

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
      return { lines: [], cursorRow: null };
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
const atPrompt = (box: string): Screen => ({
  lines: [
    "source main ❯ claude",
    " ▐▛███▛█   Claude Code v2.1.289",
    "",
    rule,
    box,
    rule,
    ...status,
    ...Array<string>(15).fill(""),
  ],
  cursorRow: 4,
});
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
const DIALOG: Screen = { lines: DIALOG_LINES, cursorRow: 9 };

// A daemon holding one terminal, whose activity the scripted hook changes
// when Enter arrives.
function terminalDaemon(
  start: PaseoTerminal | null,
  onEnter: ((t: PaseoTerminal) => PaseoTerminal) | null,
  screen: Screen = EMPTY,
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
      return screen;
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
      terminalCondition(t),
      condition,
      JSON.stringify([t.activity, t.title]),
    );
});

test("only an empty prompt box at the foot of the screen, with the cursor in it, is a prompt to paste into", () => {
  assert.equal(promptEmpty(EMPTY), true);
  assert.equal(
    promptEmpty({ ...EMPTY, lines: EMPTY.lines.map((l) => `${l}  `) }),
    true,
  );
  assert.equal(promptEmpty(TYPED), false);
  assert.equal(promptEmpty(DIALOG), false);
  assert.equal(promptEmpty({ lines: [], cursorRow: null }), false);
  assert.equal(promptEmpty({ ...EMPTY, cursorRow: null }), false);
  // A box a killed CLI left behind, with the shell's prompt and cursor
  // under it.
  assert.equal(
    promptEmpty({
      lines: [...EMPTY.lines.slice(0, 9), "source main ❯ "],
      cursorRow: 9,
    }),
    false,
  );
  // A box left above a screenful of other output is not the one in use.
  assert.equal(
    promptEmpty({
      lines: [...EMPTY.lines.slice(0, 9), ...Array<string>(5).fill("output")],
      cursorRow: 4,
    }),
    false,
  );
});

test("a grid snapshot reads as its lines with dim cells blank, and its cursor row", () => {
  const cell = (char: string, dim = false) => ({ char, dim });
  const row = (text: string, dim = false) =>
    [...text].map((char) => cell(char, dim));
  const screen = screenFrom({
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
  assert.deepEqual(screen, {
    lines: ["─".repeat(12), "❯        ", "─".repeat(12)],
    cursorRow: 1,
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

test("pasteable keeps text, tabs and newlines and drops what could drive the terminal", () => {
  assert.equal(
    pasteable("a\tb\r\nc\rd\u001b[201~\u0007e\u007f"),
    "a\tb\nc\nd[201~e",
  );
});
