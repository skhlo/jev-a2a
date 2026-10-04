// Shapes shared by the core, the shell and the tests. The contract is
// ../../research/jev-router-spec.md; the core enforces it, these only name it.

export type Role = "requester" | "operator";

export type Participant = {
  id: string;
  name?: string;
  kind: "agent" | "service";
  hosts: string[];
  // The adapter deduplicates by the router's message key, so an unknown send
  // may be retried with the same key.
  idempotent: boolean;
  responsibility: string;
};

export type Policy = {
  threshold: number;
  deadline: number;
  maxText: number;
  maxOpenTasks: number;
};

export type Config = {
  policy: Policy;
  participants: Participant[];
  principals?: Record<string, Role>;
  permissions?: Record<string, string[]>;
};

export type SendOutcome =
  "pending" | "attempting" | "accepted" | "unknown" | "withdrawn";
export type AdapterOutcome = "accepted" | "not_sent" | "unknown";
export type TrailStep =
  "attempting" | AdapterOutcome | "reply_seen" | "withdrawn";

export type Send = {
  messageId: string;
  kind: "request" | "answer";
  text: string;
  outcome: SendOutcome;
  trail: TrailStep[];
};

export type UpdateKind = "working" | "question" | "completed" | "failed";

export type Update = {
  messageId: string;
  inReplyTo: string;
  kind: UpdateKind;
  text: string;
  digest: string;
};

export type DeliveryEnd = {
  reason: string;
  text?: string;
  messageId?: string;
  by?: string;
};

export type Delivery = {
  id: string;
  taskId: string;
  participant: string;
  // Whether the adapter deduplicates, as configured when the delivery was
  // created.
  idempotent: boolean;
  host: string;
  placement: string;
  session: string | null;
  sends: Send[];
  question: { id: string; text: string } | null;
  updates: Update[];
  end: DeliveryEnd | null;
};

export type RoutingReason =
  "no_owner" | "low_confidence" | "invalid_judgment" | "routing_unavailable";

export type Routing =
  | { state: "judging"; suggestions: string[]; reason: null }
  | { state: "needs_recipient"; suggestions: string[]; reason: RoutingReason };

export type Judgment = {
  choice: string;
  probabilities: Record<string, number> | null;
  model: string | null;
  valid: boolean;
  // The dispatch threshold this judgment was held to.
  threshold: number;
};

export type TerminalStatus = "completed" | "partial" | "failed" | "canceled";
export type Status =
  | "routing"
  | "needs_recipient"
  | "queued"
  | "delivering"
  | "working"
  | "uncertain"
  | "needs_answer"
  | TerminalStatus;

export type Final = {
  status: TerminalStatus;
  reason: string | null;
  completed: number;
  of: number;
};

// What a participant sender has been told about its task: a question it
// must answer, a recipient it must choose, or the final word. Keyed by
// what it reports, so each is sent once; the outcome follows a send's.
export type NoticeKind = "question" | "choose" | "final";
export type NoticeDue = { key: string; kind: NoticeKind };
export type Notice = NoticeDue & {
  // The text of the first attempt; a repeat sends the same text under the
  // same key, as a send does.
  text: string;
  // Whether the sender's adapter deduplicates by key, as configured when
  // the notice was first attempted; decides whether unknown is repeated.
  idempotent: boolean;
  // The session the notice went to, set at the attempt.
  session: string | null;
  // withdrawn: the question or choice stopped standing before it was told.
  outcome: SendOutcome;
  trail: TrailStep[];
};

export type Task = {
  id: string;
  source: string;
  messageId: string;
  text: string;
  to: string | null;
  hosts: string[] | null;
  // The placement a participant sender submitted from; notices go there.
  // Null for a person.
  via: string | null;
  notices: Notice[];
  deadline: number;
  // Participants the sender could address when it asked.
  permitted: string[];
  routing: Routing | null;
  judgments: Judgment[];
  recipient: string | null;
  chosenBy: "address" | "judgment" | "sender" | null;
  deliveries: Delivery[];
  late: { deliveryId: string; kind: UpdateKind; text: string }[];
  final: Final | null;
  status: Status;
};

export type Placement = {
  participant: string;
  host: string;
  session: string;
  ready: boolean;
  hold: boolean;
};

export type Accepted = {
  ok: true;
  message: string;
  taskId?: string;
  duplicate?: boolean;
  actor?: string;
};
export type Rejected = { ok: false; code: string; message: string };
export type Outcome = Accepted | Rejected;

export type State = {
  config: Required<Config>;
  now: number;
  boot: number;
  placements: Record<string, Placement>;
  sessions: Record<string, { participant: string; host: string }>;
  receipts: Record<string, { taskId: string; digest: string }>;
  tasks: Task[];
  nextTask: number;
  nextDelivery: number;
  log: { n: number; actor: string; text: string }[];
  last: Outcome | null;
};

export type Event =
  | { type: "configured"; config: Config }
  | {
      type: "submit";
      by: string;
      messageId: string;
      text: string;
      to?: string | null;
      hosts?: string[] | null;
    }
  | {
      type: "judged";
      taskId: string;
      choice: string;
      probabilities: Record<string, number>;
      model?: string | null;
      // Recorded for tuning; the core does not read them.
      confidence?: number | null;
      usage?: unknown;
      ms?: number;
    }
  | { type: "judgeFailed"; taskId: string; reason?: string }
  | { type: "choose"; by: string; taskId: string; to: string }
  | { type: "attempt"; deliveryId: string }
  | {
      type: "adapterResult";
      deliveryId: string;
      messageId: string;
      outcome: AdapterOutcome;
    }
  | {
      type: "update";
      by: string;
      taskId: string;
      messageId: string;
      inReplyTo: string;
      kind: UpdateKind;
      text?: string;
    }
  | {
      type: "answer";
      by: string;
      taskId: string;
      messageId: string;
      questionId: string;
      text: string;
    }
  | { type: "cancel"; by: string; taskId: string }
  | {
      type: "resolve";
      by: string;
      deliveryId: string;
      messageId: string;
      outcome: "finished" | "not_sent";
      evidence: string;
    }
  | {
      type: "observe";
      placement: string;
      ready?: boolean;
      hold?: boolean;
      session?: string;
    }
  | { type: "noticeAttempt"; taskId: string; key: string; text: string }
  | {
      type: "noticeResult";
      taskId: string;
      key: string;
      outcome: AdapterOutcome;
    }
  | { type: "restart" }
  | { type: "tick"; now: number };

export type Command =
  | { type: "judge"; taskId: string; question: JudgmentQuestion }
  | { type: "deliver"; deliveryId: string; messageId: string }
  | ({ type: "notify"; taskId: string } & NoticeDue);

export type JudgmentQuestion = {
  state: { request: string };
  instructions: string;
  criteria: Record<string, string>;
};

export type StuckReason = "task_ended" | "session_replaced" | "unknown_send";

export type NeedsYouItem =
  | {
      kind: "choose";
      taskId: string;
      reason: RoutingReason;
      suggestions: string[];
    }
  | {
      kind: "answer";
      taskId: string;
      deliveryId: string;
      questionId: string;
      text: string;
    }
  | {
      kind: "resolve";
      taskId: string;
      deliveryId: string;
      messageId: string;
      reason: StuckReason;
    };

export type BlockedReason =
  | "closed"
  | "not_pending"
  | "session_replaced"
  | "in_flight"
  | "held"
  | "not_ready"
  | "queued_behind";
