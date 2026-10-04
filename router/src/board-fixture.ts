// The board's fixture: a small deployment and a journal with one task of
// each kind a requester needs to see. No delivery is stuck, so the operator
// has nothing to resolve; `replacedJournal` adds one. The board tests, the
// server tests and the sample generator all read it (the generator reads
// `sampleJournal`, the fixture plus one participant-sent task), so the
// committed sample shows what the tests check. Its times are fixed and
// realistic, and nothing in it comes from a live record, which holds
// private request text.
import type { RouterConfig } from "./config.ts";
import type { Entry } from "./journal.ts";
import type { Event } from "./types.ts";
import type { Telemetry } from "./telemetry.ts";
import base from "./example-config.ts";

export const config: RouterConfig = {
  ...base,
  // A deadline in milliseconds, as a deployment that ticks with the wall
  // clock records it; the example's is in model ticks.
  policy: { ...base.policy, deadline: 60 * 60_000 },
  home: "/nowhere",
  hosts: {
    mbp: { paseo: "ws://mbp", replyCommand: "router" },
    mini: { paseo: "ws://mini", replyCommand: "router" },
  },
  agents: {
    "orchestrator@mbp": "A1",
    "knowledge@mini": "K1",
    "environment@mbp": "E1",
  },
  serve: {
    listen: "127.0.0.1:0",
    board: "127.0.0.1:0",
    identities: {
      "me@example.com": ["you", "operator"],
      "guest@example.com": ["you"],
    },
    wake: 0,
  },
  jev: { model: "jev-latest" },
  telemetry: { sheet: true },
};

// When the board is read: after the last event and before any deadline.
export const NOW = Date.parse("2026-09-30T09:45:00Z");

// `HH:MM`, or `HH:MM:SS` for runs seconds apart.
const stamp = (clock: string): string =>
  new Date(
    `2026-09-30T${clock.length === 5 ? `${clock}:00` : clock}Z`,
  ).toISOString();

// One shell run as the shell records it: the clock moves to the run's time,
// then its events follow, each stamped with that time.
const run = (clock: string, ...events: Event[]): Entry[] => {
  const at = stamp(clock);
  return [
    { at, event: { type: "tick", now: Date.parse(at) } },
    ...events.map((event) => ({ at, event })),
  ];
};

// T1 waits for a recipient Jev was not sure of, T2 asks a question, T3 is
// finished, and T4 went where Jev picked and is being worked on. The three
// served placements are ready with a question pending, busy, and held.
export const journal: Entry[] = [
  ...run(
    "09:02",
    {
      type: "observe",
      placement: "orchestrator@mbp",
      ready: true,
      session: "A1",
    },
    {
      type: "observe",
      placement: "knowledge@mini",
      ready: true,
      session: "K1",
    },
    {
      type: "observe",
      placement: "environment@mbp",
      ready: true,
      session: "E1",
    },
    {
      type: "submit",
      by: "you",
      messageId: "M1",
      text: "Fix <b>the</b> build",
    },
    {
      type: "judged",
      taskId: "T1",
      choice: "orchestrator",
      probabilities: {
        orchestrator: 0.6,
        knowledge: 0.2,
        environment: 0.1,
        incus: 0.1,
        none: 0,
      },
      model: "jev-1.13.0",
    },
  ),
  ...run(
    "09:10",
    {
      type: "submit",
      by: "you",
      messageId: "M2",
      text: "Ask me something",
      to: "orchestrator",
    },
    { type: "attempt", deliveryId: "D1" },
    {
      type: "adapterResult",
      deliveryId: "D1",
      messageId: "M2",
      outcome: "accepted",
    },
  ),
  ...run("09:14", {
    type: "update",
    by: "A1",
    taskId: "T2",
    messageId: "Q1",
    inReplyTo: "M2",
    kind: "question",
    text: "Which branch?",
  }),
  ...run("09:15", {
    type: "submit",
    by: "you",
    messageId: "M3",
    text: "Done quickly",
    to: "orchestrator",
  }),
  ...run(
    "09:16",
    {
      type: "answer",
      by: "you",
      taskId: "T2",
      messageId: "A1m",
      questionId: "Q1",
      text: "main",
    },
    { type: "observe", placement: "orchestrator@mbp", ready: true },
    { type: "attempt", deliveryId: "D1" },
    {
      type: "adapterResult",
      deliveryId: "D1",
      messageId: "A1m",
      outcome: "accepted",
    },
  ),
  ...run("09:20", {
    type: "update",
    by: "A1",
    taskId: "T2",
    messageId: "W1",
    inReplyTo: "A1m",
    kind: "working",
    text: "on it",
  }),
  ...run("09:25", {
    type: "observe",
    placement: "environment@mbp",
    hold: true,
  }),
  ...run(
    "09:31",
    {
      type: "update",
      by: "A1",
      taskId: "T2",
      messageId: "Q2",
      inReplyTo: "A1m",
      kind: "question",
      text: "Force push?",
    },
    { type: "observe", placement: "orchestrator@mbp", ready: true },
    { type: "attempt", deliveryId: "D2" },
    {
      type: "adapterResult",
      deliveryId: "D2",
      messageId: "M3",
      outcome: "accepted",
    },
  ),
  ...run(
    "09:38",
    {
      type: "update",
      by: "A1",
      taskId: "T3",
      messageId: "C1",
      inReplyTo: "M3",
      kind: "completed",
      text: "all green",
    },
    { type: "observe", placement: "orchestrator@mbp", ready: true },
  ),
  ...run(
    "09:40",
    {
      type: "submit",
      by: "you",
      messageId: "M4",
      text: "Summarize the review pipeline notes",
    },
    {
      type: "judged",
      taskId: "T4",
      choice: "knowledge",
      probabilities: {
        orchestrator: 0.03,
        knowledge: 0.94,
        environment: 0.01,
        incus: 0.01,
        none: 0.01,
      },
      model: "jev-1.13.0",
    },
    { type: "attempt", deliveryId: "D3" },
    {
      type: "adapterResult",
      deliveryId: "D3",
      messageId: "M4",
      outcome: "accepted",
    },
  ),
  ...run("09:44", {
    type: "update",
    by: "K1",
    taskId: "T4",
    messageId: "W2",
    inReplyTo: "M4",
    kind: "working",
    text: "Reading the notes",
  }),
];

// The journal up to a run's clock (HH:MM), exclusive: the record as it stood
// before that run.
const before = (clock: string): Entry[] => {
  const at = stamp(clock);
  const start = journal.findIndex(
    (entry) => entry.event.type === "tick" && entry.at === at,
  );
  if (start < 0) throw new Error(`no run at ${clock} in the fixture`);
  return journal.slice(0, start);
};

// The journal after T2's first question was answered and before the
// session replied: the question is still its latest update.
export const answeredJournal = before("09:20");

// The journal before its last run: T4's delivery is accepted and the
// session has not replied yet.
export const deliveredJournal = before("09:44");

// The journal with one more shell run at the time of its last one, so the
// board still reads it at NOW.
export const extend = (...events: Event[]): Entry[] => [
  ...journal,
  ...run("09:44", ...events),
];

// The record with a fifth task sent to the released environment@mbp and
// still attempting: the delivery is pinned, its send not yet accepted. The
// environment participant has several placements; D5 is the one on mbp.
export const attemptingJournal = extend(
  { type: "observe", placement: "environment@mbp", hold: false, ready: true },
  {
    type: "submit",
    by: "you",
    messageId: "M5",
    text: "Rebuild",
    to: "environment",
  },
  { type: "attempt", deliveryId: "D5" },
);

// The record after knowledge@mini's session was replaced while T4's
// delivery was pinned to it: the operator has that delivery to resolve, and
// the requester's items are unchanged.
export const replacedJournal = extend({
  type: "observe",
  placement: "knowledge@mini",
  session: "K2",
});

// The record with a fifth task the orchestrator's session sent to incus
// (its delivery is D4: T1 had none yet): incus asked a question and the
// sender was told it at orchestrator@mbp, where it hears back.
export const viaJournal = extend(
  {
    type: "submit",
    by: "A1",
    messageId: "M5",
    text: "Start a scratch VM for the router's tests.",
    to: "incus",
  },
  { type: "observe", placement: "incus@lab01", session: "L1", ready: true },
  { type: "attempt", deliveryId: "D4" },
  {
    type: "adapterResult",
    deliveryId: "D4",
    messageId: "M5",
    outcome: "accepted",
  },
  {
    type: "update",
    by: "L1",
    taskId: "T5",
    messageId: "Q5",
    inReplyTo: "M5",
    kind: "question",
    text: "Which image?",
  },
  {
    type: "noticeAttempt",
    taskId: "T5",
    key: "question/D4/Q5",
    text: "[router T5 question/D4/Q5] incus asks about your request.",
  },
  {
    type: "noticeResult",
    taskId: "T5",
    key: "question/D4/Q5",
    outcome: "accepted",
  },
);

// The record the published sample is built from: the fixture plus a fifth
// task the orchestrator's session sent in the minute after the fixture's
// last run, carrying each kind of notice in a different state. Jev was
// unsure, so the sender was owed a choice, but its session was mid-turn
// when the router looked; it chose incus itself before it was told
// (withdrawn). incus asked and the sender, idle by then, was told
// (accepted); it answered from the turn the question started, and incus
// finished while that turn still ran, so the end is owed and waits for the
// sender to be idle (pending).
export const sampleJournal: Entry[] = [
  ...journal,
  ...run(
    "09:44:10",
    {
      type: "submit",
      by: "A1",
      messageId: "M5",
      text: "Start a scratch VM for the router's tests.",
    },
    {
      type: "judged",
      taskId: "T5",
      choice: "incus",
      // The orchestrator may address environment and incus, so Jev chose
      // among those and none.
      probabilities: { environment: 0.4, incus: 0.55, none: 0.05 },
      model: "jev-1.13.0",
    },
    { type: "observe", placement: "orchestrator@mbp", ready: false },
  ),
  ...run(
    "09:44:20",
    { type: "choose", by: "A1", taskId: "T5", to: "incus" },
    { type: "observe", placement: "incus@lab01", session: "L1", ready: true },
    { type: "attempt", deliveryId: "D4" },
    {
      type: "adapterResult",
      deliveryId: "D4",
      messageId: "M5",
      outcome: "accepted",
    },
  ),
  ...run(
    "09:44:30",
    {
      type: "update",
      by: "L1",
      taskId: "T5",
      messageId: "Q5",
      inReplyTo: "M5",
      kind: "question",
      text: "Which image?",
    },
    { type: "observe", placement: "orchestrator@mbp", ready: true },
    {
      type: "noticeAttempt",
      taskId: "T5",
      key: "question/D4/Q5",
      text: "[router T5 question/D4/Q5] incus asks about your request.",
    },
    {
      type: "noticeResult",
      taskId: "T5",
      key: "question/D4/Q5",
      outcome: "accepted",
    },
  ),
  ...run(
    "09:44:40",
    {
      type: "answer",
      by: "A1",
      taskId: "T5",
      messageId: "A5",
      questionId: "Q5",
      text: "ubuntu-24.04",
    },
    { type: "observe", placement: "orchestrator@mbp", ready: false },
    { type: "observe", placement: "incus@lab01", ready: true },
    { type: "attempt", deliveryId: "D4" },
    {
      type: "adapterResult",
      deliveryId: "D4",
      messageId: "A5",
      outcome: "accepted",
    },
  ),
  ...run(
    "09:44:50",
    {
      type: "update",
      by: "L1",
      taskId: "T5",
      messageId: "R5",
      inReplyTo: "A5",
      kind: "completed",
      text: "scratch-vm ready",
    },
    { type: "observe", placement: "orchestrator@mbp", ready: false },
  ),
];

// What the shell last saw of the sample's sessions, taken at the end of its
// last run: the orchestrator's session mid-turn (it is answering incus's
// question), knowledge@mini working on T4 and stopped at a permission
// prompt, environment@mbp idle with most of its window used. The sheet:
// the orchestrator on a dirty worktree with an open pull request whose
// checks fail, its tail ending in a running shell call, its subagents all
// done; knowledge@mini with two subagents open, one under the other, in a
// plain checkout with no pull request; environment@mbp's per-session reads
// failed that run (the run's report said so), so it has its checkout and
// nothing else, which is also how a closed session's sheet reads (the
// sample has no card with all three null: that is the no-sheet rendering of
// part 1). Together with `sampleJournal` it is what the published sample is
// built from.
export const telemetry: Telemetry = {
  version: "jev-router-telemetry/1",
  at: "2026-09-30T09:44:51.000Z",
  placements: {
    "orchestrator@mbp": {
      seen: "2026-09-30T09:44:50.000Z",
      status: "running",
      attention: null,
      attentionAt: null,
      turnStartedAt: "2026-09-30T09:44:31.000Z",
      lastUserMessageAt: "2026-09-30T09:44:31.000Z",
      permissions: [],
      provider: "claude",
      model: "claude-opus-5-5",
      thinking: "high",
      mode: "auto",
      context: { used: 61_400, max: 200_000 },
      usage: { input: 1_240, cached: 418_900, output: 9_870, costUsd: 4.18 },
      error: null,
      title: "router orchestrator",
      cwd: "/home/me/Projects/jev-a2a/.paseo/worktrees/feat-notices",
      checkout: {
        project: "A2A",
        workspace: "feat-notices",
        directory: "/home/me/Projects/jev-a2a/.paseo/worktrees/feat-notices",
        kind: "worktree",
        branch: "feat/notices",
        remote: "git@github.com:me/jev-a2a.git",
        dirty: true,
        ahead: 3,
        behind: 0,
        diff: { additions: 412, deletions: 96 },
        pr: {
          number: 21,
          url: "https://github.com/me/jev-a2a/pull/21",
          title: "feat(router): notices to participant senders",
          state: "OPEN",
          draft: false,
          merged: false,
          mergeable: "MERGEABLE",
          checks: "failure",
          review: "pending",
        },
        status: "running",
        activityAt: "2026-09-30T09:44:40.000Z",
      },
      subagents: {
        counts: { running: 0, completed: 3, failed: 0, canceled: 0 },
        running: [],
      },
      activity: {
        turns: 1,
        items: [
          {
            at: "2026-09-30T09:44:31.000Z",
            kind: "user_message",
            text: "[router T5 N1] incus asks about your request. Answer with: router answer …",
            tool: null,
            status: null,
          },
          {
            at: "2026-09-30T09:44:33.000Z",
            kind: "reasoning",
            text: "The question is which kernel the lab image should boot.",
            tool: null,
            status: null,
          },
          {
            at: "2026-09-30T09:44:35.000Z",
            kind: "tool_call",
            text: "research/lab-images.md",
            tool: "Read",
            status: "completed",
          },
          {
            at: "2026-09-30T09:44:39.000Z",
            kind: "assistant_message",
            text: "The lab image boots 6.12 LTS; answering incus with that.",
            tool: null,
            status: null,
          },
          {
            at: "2026-09-30T09:44:40.000Z",
            kind: "tool_call",
            text: "router answer --as A1 --task T5 --delivery D5 --question Q1 --text '6.12 LTS'",
            tool: "Bash",
            status: "running",
          },
        ],
      },
    },
    "knowledge@mini": {
      seen: "2026-09-30T09:44:50.000Z",
      status: "running",
      attention: "permission",
      attentionAt: "2026-09-30T09:40:48.000Z",
      turnStartedAt: "2026-09-30T09:40:05.000Z",
      lastUserMessageAt: "2026-09-30T09:40:04.000Z",
      permissions: [
        {
          id: "perm-1",
          name: "Bash",
          title: "Run rg over the vault",
          kind: "tool",
        },
      ],
      provider: "codex",
      model: "gpt-5.5",
      thinking: "medium",
      mode: "default",
      context: { used: 88_200, max: 272_000 },
      usage: { input: 3_020, cached: 905_300, output: 21_410, costUsd: 11.02 },
      error: null,
      title: "vault curator",
      cwd: "/Users/agent/vault",
      checkout: {
        project: "vault",
        workspace: "main",
        directory: "/Users/agent/vault",
        kind: "local_checkout",
        branch: "main",
        remote: null,
        dirty: false,
        ahead: null,
        behind: null,
        diff: null,
        pr: null,
        status: "needs_input",
        activityAt: "2026-09-30T09:40:48.000Z",
      },
      subagents: {
        counts: { running: 2, completed: 5, failed: 0, canceled: 1 },
        running: [
          {
            id: "toolu_01sweep",
            title: "worker",
            description:
              "Sweep the vault for notes that cite the retired runbook.",
            status: "running",
            startedAt: "2026-09-30T09:40:10.000Z",
            updatedAt: "2026-09-30T09:40:47.000Z",
            parent: null,
          },
          {
            id: "toolu_01grep",
            title: "Explore",
            description: "List every note under ops/ that links runbook-2024.",
            status: "running",
            startedAt: "2026-09-30T09:40:22.000Z",
            updatedAt: "2026-09-30T09:40:47.000Z",
            parent: "toolu_01sweep",
          },
        ],
      },
      activity: {
        turns: 1,
        items: [
          {
            at: "2026-09-30T09:40:04.000Z",
            kind: "user_message",
            text: "[router T4 M4] Task from the router. When done, run: router reply …",
            tool: null,
            status: null,
          },
          {
            at: "2026-09-30T09:40:10.000Z",
            kind: "tool_call",
            text: "Sweep the vault for notes that cite the retired runbook.",
            tool: "Agent",
            status: "running",
          },
          {
            at: "2026-09-30T09:40:48.000Z",
            kind: "tool_call",
            text: "rg -l runbook-2024 /Users/agent/vault/ops",
            tool: "Bash",
            status: "running",
          },
        ],
      },
    },
    "environment@mbp": {
      seen: "2026-09-30T09:44:51.000Z",
      status: "idle",
      attention: "finished",
      attentionAt: "2026-09-30T09:23:40.000Z",
      turnStartedAt: null,
      lastUserMessageAt: "2026-09-30T09:21:12.000Z",
      permissions: [],
      provider: "claude",
      model: "claude-sonnet-5-5",
      thinking: "low",
      mode: "acceptEdits",
      context: { used: 171_500, max: 200_000 },
      usage: { input: 880, cached: 1_204_000, output: 44_120, costUsd: 9.61 },
      error: null,
      title: "environment",
      cwd: "/home/me",
      checkout: {
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
        activityAt: "2026-09-30T09:23:40.000Z",
      },
      subagents: null,
      activity: null,
    },
  },
};
