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
  subagentsOf,
  type Daemon,
  type Subagent,
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

test("checkoutFor joins by project key and workspace name, then by directory, else null", () => {
  assert.equal(checkoutFor(project, [plain, worktree])?.workspace, "feat-x");
  // The same directory under another name: the directory decides.
  const renamed = { ...project, projectKey: "prj_9", workspaceName: "other" };
  assert.equal(checkoutFor(renamed, [plain, worktree])?.workspace, "feat-x");
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
  status: Subagent["status"],
  createdAt: string,
  parent: string | null = null,
): Subagent => ({
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
        { at: "t6", kind: "todo", text: "0 item(s)", tool: null, status: null },
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
  assert.deepEqual(calls, [
    "refresh A1",
    "workspaces",
    "subagents A1",
    "tail A1 3",
    "refresh A2",
    "subagents A2",
    "tail A2 3",
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

test("a failed sheet read nulls its field and leaves a note; the rail and the rest stand", async () => {
  const { daemon } = scripted("idle", ["workspaces", "tail"]);
  const seen = await adapterOver(daemon).observe("A1", SEEN);
  assert.equal(seen?.ready, true);
  assert.equal(seen?.snapshot.status, "idle");
  assert.equal(seen?.snapshot.checkout, null);
  assert.equal(seen?.snapshot.subagents?.counts.running, 1);
  assert.equal(seen?.snapshot.activity, null);
  assert.deepEqual(seen?.notes, [
    "checkout of A1 not read: list timed out",
    "activity of A1 not read: timeline gone",
  ]);
});

test("with the sheet off, only the rail is read", async () => {
  const { daemon, calls } = scripted("running");
  const seen = await adapterOver(daemon, { sheet: false }).observe("A1", SEEN);
  assert.equal(seen?.snapshot.checkout, null);
  assert.equal(seen?.snapshot.subagents, null);
  assert.equal(seen?.snapshot.activity, null);
  assert.deepEqual(calls, ["refresh A1"]);
});
