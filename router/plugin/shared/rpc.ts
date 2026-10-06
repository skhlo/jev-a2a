// The plugin's RPCs, shared by its server and the app. Each mirrors what
// serve's board API returns (src/board-api.ts), which a test holds to
// these schemas: a field the router adds and a schema lacks fails it.
import { defineRpc } from "@getpaseo/plugin";
import { z } from "zod";

const role = z.enum(["requester", "operator"]);
const routingReason = z.enum([
  "no_owner",
  "low_confidence",
  "invalid_judgment",
  "routing_unavailable",
]);
const terminalStatus = z.enum(["completed", "partial", "failed", "canceled"]);
const status = z.enum([
  "routing",
  "needs_recipient",
  "queued",
  "delivering",
  "working",
  "uncertain",
  "needs_answer",
  ...terminalStatus.options,
]);
const sendOutcome = z.enum([
  "pending",
  "attempting",
  "accepted",
  "unknown",
  "withdrawn",
]);
const updateKind = z.enum(["working", "question", "completed", "failed"]);

const actor = z.object({
  login: z.string(),
  principals: z.array(z.object({ principal: z.string(), role })),
});

const needsYouItem = z.discriminatedUnion("kind", [
  z.object({
    kind: z.literal("choose"),
    taskId: z.string(),
    reason: routingReason,
    suggestions: z.array(z.string()),
  }),
  z.object({
    kind: z.literal("answer"),
    taskId: z.string(),
    deliveryId: z.string(),
    questionId: z.string(),
    text: z.string(),
  }),
  z.object({
    kind: z.literal("resolve"),
    taskId: z.string(),
    deliveryId: z.string(),
    messageId: z.string(),
    reason: z.enum(["task_ended", "session_replaced", "unknown_send"]),
  }),
]);

// `by` names the principal who canceled the task; null when the router
// ended it.
const final = z.object({
  status: terminalStatus,
  reason: z.string().nullable(),
  completed: z.number(),
  of: z.number(),
  by: z.string().nullable(),
});

// One task as its row shows it; `rev` changes whenever the task does.
// `question` is the waiting question's text (its needs-you item carries
// the ids an answer names); `answered` is the answer the latest delivery's
// open turn took, null once the agent has replied to it.
const taskHead = z.object({
  id: z.string(),
  title: z.string(),
  status,
  recipient: z.string().nullable(),
  via: z.string().nullable(),
  source: z.string(),
  messageId: z.string(),
  sentAt: z.string().nullable(),
  deadline: z.string(),
  final: final.nullable(),
  reason: routingReason.nullable(),
  judgment: z
    .object({ choice: z.string(), probability: z.number().nullable() })
    .nullable(),
  question: z.string().nullable(),
  latest: z
    .object({
      id: z.string(),
      sendKind: z.string(),
      outcome: z.string(),
      update: z.object({ kind: updateKind, text: z.string() }).nullable(),
      answered: z
        .object({ text: z.string(), at: z.string().nullable() })
        .nullable(),
    })
    .nullable(),
  // "no reply <age>" while a delivery has had no reply for 30 minutes.
  stale: z.string().nullable(),
  rev: z.string(),
});

const summary = z.object({
  rev: z.string(),
  at: z.string(),
  actor: actor.nullable(),
  needsYou: z.array(
    z.object({
      principal: z.string(),
      role: z.string(),
      items: z.array(needsYouItem),
    }),
  ),
  placements: z.array(
    z.object({
      key: z.string(),
      participant: z.string(),
      host: z.string(),
      ready: z.boolean(),
      hold: z.boolean(),
    }),
  ),
  open: z.array(taskHead),
  finished: z.array(taskHead),
});

const update = z.object({
  messageId: z.string(),
  inReplyTo: z.string(),
  kind: updateKind,
  text: z.string(),
});

const delivery = z.object({
  id: z.string(),
  placement: z.string(),
  session: z.string().nullable(),
  send: z.object({
    kind: z.string(),
    messageId: z.string(),
    outcome: z.string(),
  }),
  sends: z.array(
    z.object({
      messageId: z.string(),
      kind: z.enum(["request", "answer"]),
      text: z.string(),
      outcome: sendOutcome,
    }),
  ),
  question: z.object({ id: z.string(), text: z.string() }).nullable(),
  updates: z.array(update),
  latest: update.nullable(),
  end: z
    .object({
      reason: z.string(),
      text: z.string().exactOptional(),
      messageId: z.string().exactOptional(),
      by: z.string().exactOptional(),
    })
    .nullable(),
  waits: z
    .object({
      reason: z.enum([
        "session_replaced",
        "in_flight",
        "held",
        "not_ready",
        "queued_behind",
      ]),
      behind: z.string().nullable(),
    })
    .nullable(),
});

const task = z.object({
  id: z.string(),
  status,
  a2a: z.string(),
  source: z.string(),
  messageId: z.string(),
  recipient: z.string().nullable(),
  chosenBy: z.enum(["address", "judgment", "sender"]).nullable(),
  text: z.string(),
  deadline: z.string(),
  routing: z
    .discriminatedUnion("state", [
      z.object({
        state: z.literal("judging"),
        suggestions: z.array(z.string()),
        reason: z.null(),
      }),
      z.object({
        state: z.literal("needs_recipient"),
        suggestions: z.array(z.string()),
        reason: routingReason,
      }),
    ])
    .nullable(),
  judgments: z.array(
    z.object({
      choice: z.string(),
      probabilities: z.record(z.string(), z.number()).nullable(),
      model: z.string().nullable(),
      valid: z.boolean(),
      threshold: z.number(),
    }),
  ),
  final: final.nullable(),
  deliveries: z.array(delivery),
  via: z.string().nullable(),
  notices: z.array(
    z.object({
      key: z.string(),
      kind: z.enum(["question", "choose", "final"]),
      session: z.string().nullable(),
      outcome: sendOutcome,
    }),
  ),
  log: z.array(
    z.object({ n: z.number(), actor: z.string(), text: z.string() }),
  ),
});

// A task in full with the times of its messages, by message id.
const fullTask = z.object({
  rev: z.string(),
  task,
  times: z.record(z.string(), z.string()),
});

// What an accepted action returns: the router's message, the board's new
// rev, and the task it changed (task.submit: the new one). A refused
// action fails with the router's reason.
export const acted = z.object({
  message: z.string(),
  rev: z.string(),
  task: fullTask.nullable(),
});

// The app polls this; given the rev it holds, an unchanged board answers
// `unchanged` alone.
export const boardSummary = defineRpc({
  name: "board.summary",
  input: z.object({ sinceRev: z.string().optional() }),
  output: z.union([
    z.object({ unchanged: z.literal(true), rev: z.string() }),
    summary,
  ]),
});

// Null for a task no longer on the board (an older finished one).
export const boardTask = defineRpc({
  name: "board.task",
  input: z.object({ id: z.string() }),
  output: fullTask.nullable(),
});

// An action can outlast the 30 s RPC limit while serve finishes a run, and
// still be recorded. A request or an answer therefore takes the app's own
// messageId: mint one per submit or answer and send the same one on a
// retry, so the router recognises the repeat instead of making a second.
// The router's rule for a message id.
const messageId = z
  .string()
  .regex(/^[A-Za-z0-9._:-]{1,64}$/, "1-64 letters, digits or . _ : -")
  .optional();

// The question's ids are in its needs-you item.
export const taskAnswer = defineRpc({
  name: "task.answer",
  input: z.object({
    taskId: z.string(),
    deliveryId: z.string(),
    questionId: z.string(),
    text: z.string(),
    messageId,
  }),
  output: acted,
});

export const taskChoose = defineRpc({
  name: "task.choose",
  input: z.object({ taskId: z.string(), recipient: z.string() }),
  output: acted,
});

// messageId is the send the needs-you item names, so a resolve meant for
// one send cannot land on a later one. Evidence defaults to a line saying
// it came from the app.
export const taskResolve = defineRpc({
  name: "task.resolve",
  input: z.object({
    deliveryId: z.string(),
    messageId: z.string(),
    outcome: z.enum(["finished", "not_sent"]),
    evidence: z.string().optional(),
  }),
  output: acted,
});

export const taskCancel = defineRpc({
  name: "task.cancel",
  input: z.object({ taskId: z.string() }),
  output: acted,
});

export const taskHold = defineRpc({
  name: "task.hold",
  input: z.object({ placement: z.string() }),
  output: acted,
});

export const taskRelease = defineRpc({
  name: "task.release",
  input: z.object({ placement: z.string() }),
  output: acted,
});

// `to` names the recipient; without it Jev routes the request.
export const taskSubmit = defineRpc({
  name: "task.submit",
  input: z.object({ text: z.string(), to: z.string().optional(), messageId }),
  output: acted,
});
