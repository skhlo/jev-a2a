// The board's fixture: a small deployment and a journal with one task of
// each kind a requester needs to see. No delivery is stuck, so the operator
// has nothing to resolve. The board tests, the server tests and the
// sample generator all read it, so the committed sample shows what the tests
// check. Its times are fixed and realistic, and nothing in it comes from a
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

// One shell run as the shell records it: the clock moves to the run's time,
// then its events follow, each stamped with that time.
const run = (clock: string, ...events: Event[]): Entry[] => {
  const at = new Date(`2026-09-30T${clock}:00Z`).toISOString();
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
