// The board's fixture: a small deployment and a journal with one task of
// each kind a requester needs to see. No delivery is stuck, so the operator
// has nothing to resolve; `replacedJournal` adds one. The board tests, the
// server tests and the sample generator all read it, so the committed
// sample shows what the tests check. Its times are fixed and realistic, and nothing in it comes from a
// live record, which holds private request text.
import type { RouterConfig } from "./config.ts";
import type { Entry } from "./journal.ts";
import type { Event } from "./types.ts";
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
  },
  jev: { model: "jev-latest" },
};

// When the board is read: after the last event and before any deadline.
export const NOW = Date.parse("2026-09-30T09:45:00Z");

const stamp = (clock: string): string =>
  new Date(`2026-09-30T${clock}:00Z`).toISOString();

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
    key: "question/Q5",
    text: "[router T5 question/Q5] incus asks about your request.",
  },
  {
    type: "noticeResult",
    taskId: "T5",
    key: "question/Q5",
    outcome: "accepted",
  },
);
