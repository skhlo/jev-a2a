// Jev router core: a pure, deterministic model of the communication contract.
// The shell authenticates callers, calls Jev and delivery adapters, and feeds
// their results back as events. This module decides; it performs no I/O.
// Contract: ../../research/jev-router-spec.md. Tests: core.test.ts.
//
// The core carries no deployment. A configuration supplies:
//   policy        threshold, deadline, maxText, maxOpenTasks
//   principals    authenticated non-participant identities -> "requester" | "operator"
//   participants  { id, name, kind, hosts, idempotent, responsibility }
//                 idempotent: the adapter deduplicates by the router's message
//                 key, so an unknown send may be retried with the same key
//   permissions   principal or participant id -> participant ids it may address
import type {
  Accepted,
  AdapterOutcome,
  BlockedReason,
  Command,
  Config,
  Delivery,
  Event,
  Final,
  JudgmentQuestion,
  NeedsYouItem,
  Notice,
  NoticeDue,
  Outcome,
  Participant,
  Rejected,
  Role,
  RoutingReason,
  Send,
  State,
  Status,
  StuckReason,
  Task,
  UpdateKind,
} from "./types.ts";

const ROLES: readonly Role[] = ["requester", "operator"];
const UPDATE_KINDS: readonly UpdateKind[] = [
  "working",
  "question",
  "completed",
  "failed",
];
const ADAPTER_OUTCOMES: readonly AdapterOutcome[] = [
  "accepted",
  "not_sent",
  "unknown",
];

const isRecord = (value: unknown): value is Record<string, unknown> =>
  value !== null && typeof value === "object" && !Array.isArray(value);
const positive = (value: unknown): value is number =>
  typeof value === "number" && Number.isFinite(value) && value > 0;
const includes = <T extends string>(
  list: readonly T[],
  value: unknown,
): value is T =>
  typeof value === "string" && (list as readonly string[]).includes(value);

export function validateConfig(config: unknown): Config {
  const fail = (message: string): never => {
    throw new Error(`Invalid router configuration: ${message}`);
  };
  if (!isRecord(config)) return fail("a configuration object is required");
  const { policy, participants, principals = {}, permissions = {} } = config;
  if (!isRecord(policy)) return fail("policy is required");
  if (
    typeof policy.threshold !== "number" ||
    !(policy.threshold > 0 && policy.threshold <= 1)
  )
    fail("policy.threshold must be in (0, 1]");
  for (const key of ["deadline", "maxText", "maxOpenTasks"])
    if (!positive(policy[key])) fail(`policy.${key} must be a positive number`);
  if (!Array.isArray(participants) || !participants.length)
    return fail("at least one participant is required");
  const ids = new Set<string>();
  for (const p of participants as unknown[]) {
    if (!isRecord(p) || typeof p.id !== "string" || !p.id || ids.has(p.id))
      return fail(
        `participant ids must be unique non-empty strings (${String(isRecord(p) ? p.id : p)})`,
      );
    ids.add(p.id);
    if (!includes(["agent", "service"], p.kind))
      fail(`${p.id} kind must be agent or service`);
    if (
      !Array.isArray(p.hosts) ||
      !p.hosts.length ||
      p.hosts.some((host: unknown) => typeof host !== "string" || !host) ||
      new Set(p.hosts).size !== p.hosts.length
    )
      fail(`${p.id} needs a non-empty list of distinct host names`);
    if (typeof p.responsibility !== "string" || !p.responsibility.trim())
      fail(`${p.id} needs a responsibility`);
    if (typeof p.idempotent !== "boolean")
      fail(`${p.id} must declare idempotent: true | false`);
  }
  if (!isRecord(principals)) return fail("principals must be an object");
  for (const [id, role] of Object.entries(principals)) {
    if (!includes(ROLES, role))
      fail(`principal ${id} has unknown role ${String(role)}`);
    if (ids.has(id)) fail(`principal ${id} collides with a participant id`);
  }
  if (!isRecord(permissions)) return fail("permissions must be an object");
  for (const [id, targets] of Object.entries(permissions)) {
    if (!ids.has(id) && !(id in principals))
      fail(`permissions name unknown principal ${id}`);
    if (!Array.isArray(targets))
      return fail(`permissions for ${id} must be a list`);
    for (const target of targets as unknown[])
      if (typeof target !== "string" || !ids.has(target))
        fail(`${id} may address unknown participant ${String(target)}`);
  }
  return config as unknown as Config;
}

const MESSAGE_ID = /^[A-Za-z0-9._:-]{1,64}$/;
const clone = <T>(value: T): T => structuredClone(value);
const placementKey = (participant: string, host: string): string =>
  `${participant}@${host}`;
const digest = (value: unknown): string => JSON.stringify(value);

export function initial(config: Config): State {
  validateConfig(config);
  const placements: State["placements"] = {};
  const sessions: State["sessions"] = {};
  addPlacements(config, placements, sessions);
  return {
    config: { principals: {}, permissions: {}, ...clone(config) },
    now: 0,
    boot: 1,
    placements,
    sessions,
    receipts: {},
    tasks: [],
    nextTask: 1,
    nextDelivery: 1,
    log: [],
    last: null,
  };
}

// ---- Queries shared by the reducer, the shell and the invariants ----

export const findTask = (state: State, id: string): Task | undefined =>
  state.tasks.find((task) => task.id === id);
// In task order, the order the needs-you lists keep. It is not creation
// order: a task that waited for a recipient gets its deliveries after newer
// tasks got theirs, so a placement's queue orders by `created` instead.
export const allDeliveries = (state: State): Delivery[] =>
  state.tasks.flatMap((task) => task.deliveries);
// A delivery's place in creation order: deliveries are numbered from one
// counter (D1, D2, ...).
const created = (delivery: Delivery): number => Number(delivery.id.slice(1));
export const findDelivery = (state: State, id: string): Delivery | undefined =>
  allDeliveries(state).find((d) => d.id === id);
const participant = (state: State, id: string): Participant | undefined =>
  state.config.participants.find((entry) => entry.id === id);
const mustTask = (state: State, id: string): Task => {
  const task = findTask(state, id);
  if (!task) throw new Error(`${id} has a delivery but no task`);
  return task;
};
// A withdrawn answer never left the router; the exchange continues on the
// message before it.
export const currentSend = (delivery: Delivery): Send => {
  const send = delivery.sends.findLast(
    (entry) => entry.outcome !== "withdrawn",
  );
  if (!send) throw new Error(`${delivery.id} has no request send`);
  return send;
};
export const isOpen = (delivery: Delivery): boolean => delivery.end === null;
// The pinned session is no longer the placement's current one.
const sessionReplaced = (state: State, delivery: Delivery): boolean =>
  delivery.session !== null &&
  state.placements[delivery.placement]?.session !== delivery.session;
// An unknown send may be repeated with the same key only when the adapter
// deduplicates by it.
const retryable = (_state: State, delivery: Delivery, send: Send): boolean =>
  send.outcome === "unknown" && delivery.idempotent;
// A send whose arrival is unconfirmed. It blocks other sends to its
// placement: the participant may be starting a turn it must not lose.
export const inFlight = (delivery: Delivery): boolean =>
  isOpen(delivery) &&
  delivery.session !== null &&
  ["attempting", "unknown"].includes(currentSend(delivery).outcome);
const isTerminal = (task: Task): boolean => task.final !== null;
// A notice whose adapter call has not returned. It blocks the session like
// an in-flight send. An unknown notice does not: nothing waits on it, and a
// deduplicating adapter repeats it, so there is no reconciliation to wait for.
const noticeInFlight = (state: State, session: string): boolean =>
  state.tasks.some((t) =>
    t.notices.some((n) => n.outcome === "attempting" && n.session === session),
  );

// A session that a placement no longer binds may finish its work but not
// start any: no new request, no choice of recipient.
function notCurrentSession(state: State, by: string): Rejected | null {
  const session = state.sessions[by];
  if (
    session &&
    state.placements[placementKey(session.participant, session.host)]
      ?.session !== by
  )
    return reject(
      "unauthenticated",
      "A replaced session cannot submit new work or choose a recipient.",
    );
  return null;
}

// Authenticated caller -> principal: a configured principal id, or the
// participant that owns the calling session.
function principalOf(state: State, by: unknown): string | null {
  if (typeof by !== "string") return null;
  if (state.config.principals[by]) return by;
  return state.sessions[by]?.participant ?? null;
}
const roleOf = (
  state: State,
  principal: string | null,
): Role | "participant" | null =>
  principal === null
    ? null
    : (state.config.principals[principal] ??
      (participant(state, principal) ? "participant" : null));

const mayAddress = (
  state: State,
  principal: string,
  participantId: string,
): boolean =>
  (state.config.permissions[principal] ?? []).includes(participantId);

// Shared checks. Each returns a rejection, or null when the input is fine.
const badMessageId = (id: unknown): Rejected | null =>
  typeof id === "string" && MESSAGE_ID.test(id)
    ? null
    : reject("invalid", "A message ID is 1-64 letters, digits or . _ : -");
const badText = (state: State, text: unknown): Rejected | null =>
  typeof text === "string" &&
  text.trim() &&
  text.length <= state.config.policy.maxText
    ? null
    : reject(
        "invalid",
        `Text must be non-empty and at most ${state.config.policy.maxText} characters.`,
      );
const notSender = (state: State, by: unknown, task: Task): Rejected | null =>
  principalOf(state, by) === task.source
    ? null
    : reject("forbidden", "Only the original sender can do this.");
// Same key and content: the earlier receipt. Same key, other content: conflict.
const priorReceipt = (
  state: State,
  key: string,
  content: string,
): Outcome | null => {
  const receipt = state.receipts[key];
  if (!receipt) return null;
  return receipt.digest === content
    ? ok(`${key} already recorded as ${receipt.taskId}. Nothing repeated.`, {
        taskId: receipt.taskId,
        duplicate: true,
      })
    : reject("conflict", `${key} already identifies different content.`);
};

// Why a delivery's current send cannot be attempted now, or null if it can.
export function blockedReason(
  state: State,
  delivery: Delivery,
): BlockedReason | null {
  const task = mustTask(state, delivery.taskId);
  const send = currentSend(delivery);
  const placement = state.placements[delivery.placement];
  if (!placement) throw new Error(`${delivery.id}: unknown placement`);
  if (isTerminal(task) || !isOpen(delivery)) return "closed";
  if (send.outcome !== "pending" && !retryable(state, delivery, send))
    return "not_pending";
  if (sessionReplaced(state, delivery)) return "session_replaced";
  const busy = placementBusy(state, delivery.placement, delivery);
  if (busy) return busy;
  if (delivery.session !== null) return null;
  // This delivery is open, unpinned and its task is open, so the queue has a
  // head: this delivery, or one created before it.
  return queueHead(state, delivery.placement)?.id === delivery.id
    ? null
    : "queued_behind";
}

// Why nothing may go to a placement now: a send (other than `except`) or a
// notice is unconfirmed there, a person holds it, or it was not seen idle.
function placementBusy(
  state: State,
  key: string,
  except: Delivery | null = null,
): BlockedReason | null {
  const placement = state.placements[key];
  if (!placement) return "closed";
  if (
    allDeliveries(state).some(
      (d) => d !== except && d.placement === key && inFlight(d),
    ) ||
    noticeInFlight(state, placement.session)
  )
    return "in_flight";
  if (placement.hold) return "held";
  if (!placement.ready) return "not_ready";
  return null;
}

// The delivery that goes next on a placement's queue: of its open, unpinned
// deliveries whose task is still open, the one created first. Null when the
// queue is empty. Pinned deliveries are not queued; they follow their session.
export function queueHead(state: State, placement: string): Delivery | null {
  let head: Delivery | null = null;
  for (const delivery of allDeliveries(state))
    if (
      delivery.placement === placement &&
      delivery.session === null &&
      isOpen(delivery) &&
      !isTerminal(mustTask(state, delivery.taskId)) &&
      (head === null || created(delivery) < created(head))
    )
      head = delivery;
  return head;
}

// Work the shell should perform next. The core never performs it itself.
export function commands(state: State): Command[] {
  const work: Command[] = [];
  for (const task of state.tasks) {
    if (task.routing?.state === "judging")
      work.push({
        type: "judge",
        taskId: task.id,
        question: judgmentQuestion(state, task),
      });
  }
  for (const delivery of allDeliveries(state)) {
    if (blockedReason(state, delivery) === null)
      work.push({
        type: "deliver",
        deliveryId: delivery.id,
        messageId: currentSend(delivery).messageId,
      });
  }
  for (const task of state.tasks)
    for (const due of dueNotices(state, task))
      if (noticeBlockedReason(state, task, due.key) === null)
        work.push({ type: "notify", taskId: task.id, ...due });
  return work;
}

// What a participant sender should be told about its task now, keyed so
// each is told once: an open question on a delivery, a recipient to
// choose while Jev's hand-back stands, and the final word. A question or a
// choice that no longer stands is not due, so it is never sent late.
export function dueNotices(state: State, task: Task): NoticeDue[] {
  if (task.via === null) return [];
  const due: NoticeDue[] = [];
  if (isTerminal(task)) due.push({ key: "final", kind: "final" });
  else {
    if (task.routing?.state === "needs_recipient")
      due.push({
        key: `choose/${task.judgments.length}`,
        kind: "choose",
      });
    for (const delivery of task.deliveries)
      if (
        isOpen(delivery) &&
        delivery.question &&
        !sessionReplaced(state, delivery)
      )
        due.push({
          key: `question/${delivery.id}/${delivery.question.id}`,
          kind: "question",
          deliveryId: delivery.id,
          questionId: delivery.question.id,
        });
  }
  return due;
}

export const findNotice = (task: Task, key: string): Notice | undefined =>
  task.notices.find((n) => n.key === key);

// Why a due notice cannot go to the sender now, or null if it can: it was
// told (or an attempt is unresolved and cannot be repeated); an unknown one
// may only be repeated at the session that may have it; the sender's
// placement is gone, held, busy with a send or a notice, or not idle.
export function noticeBlockedReason(
  state: State,
  task: Task,
  key: string,
): BlockedReason | "told" | null {
  const notice = findNotice(task, key);
  if (notice) {
    if (notice.outcome === "accepted") return "told";
    if (notice.outcome === "attempting" || notice.outcome === "withdrawn")
      return "not_pending";
    if (notice.outcome === "unknown") {
      if (!notice.idempotent) return "not_pending";
      if (state.placements[task.via ?? ""]?.session !== notice.session)
        return "session_replaced";
    }
  }
  return task.via === null ? "closed" : placementBusy(state, task.via);
}

// What a sender is still owed and why it waits, for the shell's report and
// `router status`: told, withdrawn and never-to-be-repeated notices are
// not waiting.
export function noticeWaits(
  state: State,
  task: Task,
): { key: string; why: NoticeWait }[] {
  const waits: { key: string; why: NoticeWait }[] = [];
  for (const due of dueNotices(state, task)) {
    const why = noticeBlockedReason(state, task, due.key);
    if (why && why !== "told" && why !== "closed" && why !== "not_pending")
      waits.push({ key: due.key, why });
  }
  return waits;
}
type NoticeWait = Exclude<BlockedReason, "closed" | "not_pending">;

// Whether anything waits only for a session to be seen idle, which a later
// look can release without any event. Only `not_ready` qualifies: a hold
// waits on a person, a queue on the delivery ahead, a replaced session on
// the operator, and `in_flight` on the send that holds the placement, whose
// own reason says whether a look would move it (a retryable unknown reads
// `not_ready` itself; a stuck one waits on the operator).
export function waitsOnSessions(
  state: State,
  served: (placement: string) => boolean = () => true,
): boolean {
  const wakes = (why: BlockedReason | null): boolean => why === "not_ready";
  for (const delivery of allDeliveries(state))
    if (served(delivery.placement) && wakes(blockedReason(state, delivery)))
      return true;
  return state.tasks.some(
    (task) =>
      task.via !== null &&
      served(task.via) &&
      noticeWaits(state, task).some((w) => wakes(w.why)),
  );
}

// One Choice over the participants the sender could address when it asked,
// plus an abstention.
export function judgmentQuestion(state: State, task: Task): JudgmentQuestion {
  return routingQuestion(
    responsibilityTexts(state.config.participants, task.permitted),
    task.text,
  );
}

// The texts Jev chooses among, in the order the sender's permissions list
// them; `router eval` builds its question from the same.
export function responsibilityTexts(
  participants: Participant[],
  permitted: string[],
): Record<string, string> {
  const texts: Record<string, string> = {};
  for (const id of permitted)
    texts[id] =
      participants.find((entry) => entry.id === id)?.responsibility ?? "";
  return texts;
}

// Whether a Choice answer is usable: the choice is an option, and the
// probabilities cover exactly the options and sum to 1.
export function validJudgment(
  options: string[],
  choice: string,
  probabilities: unknown,
): boolean {
  if (!isRecord(probabilities)) return false;
  const values = Object.values(probabilities);
  return (
    options.includes(choice) &&
    Object.keys(probabilities).length === options.length &&
    options.every((id) => id in probabilities) &&
    values.every((p) => typeof p === "number" && p >= 0 && p <= 1) &&
    Math.abs(values.reduce<number>((sum, p) => sum + (p as number), 0) - 1) <
      0.01
  );
}

// The question as Jev sees it, from the texts alone; `router eval` asks the
// same one, so what it measures is what the router sends.
export function routingQuestion(
  responsibilities: Record<string, string>,
  text: string,
): JudgmentQuestion {
  return {
    state: { request: text },
    instructions:
      "Which participant owns this request? Choose by responsibility, not by technology names mentioned. Choose none when no owner is clear.",
    criteria: {
      ...responsibilities,
      none: "No listed responsibility clearly owns this request, or it lacks context.",
    },
  };
}

function status(task: Task): Status {
  if (task.final) return task.final.status;
  if (task.routing)
    return task.routing.state === "judging" ? "routing" : "needs_recipient";
  const open = task.deliveries.filter(isOpen);
  if (open.some((d) => d.question)) return "needs_answer";
  const outcomes = open.map((d) => currentSend(d).outcome);
  if (outcomes.includes("unknown")) return "uncertain";
  if (outcomes.includes("accepted")) return "working";
  if (outcomes.includes("attempting")) return "delivering";
  return "queued";
}

// Why an open, pinned delivery needs an operator, or null if it does not:
// the router cannot confirm its send after the task ended, its session was
// replaced, or its send is unknown with no deduplicating retry.
function stuckReason(state: State, delivery: Delivery): StuckReason | null {
  if (!isOpen(delivery) || delivery.session === null) return null;
  const send = currentSend(delivery);
  if (send.outcome === "attempting") return null;
  if (isTerminal(mustTask(state, delivery.taskId)))
    return send.outcome === "accepted" ? null : "task_ended";
  if (sessionReplaced(state, delivery)) return "session_replaced";
  if (send.outcome === "unknown" && !retryable(state, delivery, send))
    return "unknown_send";
  return null;
}

// What a principal must decide, in task order. A requester gets its own
// tasks waiting for a recipient or for an answer the router can still
// deliver. An operator gets the stuck deliveries.
export function needsYou(state: State, principal: string): NeedsYouItem[] {
  const items: NeedsYouItem[] = [];
  if (roleOf(state, principal) === "operator") {
    for (const delivery of allDeliveries(state)) {
      const reason = stuckReason(state, delivery);
      if (reason)
        items.push({
          kind: "resolve",
          taskId: delivery.taskId,
          deliveryId: delivery.id,
          messageId: currentSend(delivery).messageId,
          reason,
        });
    }
    return items;
  }
  for (const task of state.tasks) {
    if (task.source !== principal || isTerminal(task)) continue;
    // A choice is only a choice while the sender may still address someone.
    if (
      task.routing?.state === "needs_recipient" &&
      (state.config.permissions[principal] ?? []).length
    )
      items.push({
        kind: "choose",
        taskId: task.id,
        reason: task.routing.reason,
        suggestions: task.routing.suggestions,
      });
    for (const delivery of task.deliveries)
      if (
        isOpen(delivery) &&
        delivery.question &&
        !sessionReplaced(state, delivery)
      )
        items.push({
          kind: "answer",
          taskId: task.id,
          deliveryId: delivery.id,
          questionId: delivery.question.id,
          text: delivery.question.text,
        });
  }
  return items;
}

// A2A v1.0 task state for a router status. Router detail travels in metadata.
export const A2A_STATE: Record<Status, string> = {
  routing: "TASK_STATE_SUBMITTED",
  queued: "TASK_STATE_SUBMITTED",
  delivering: "TASK_STATE_SUBMITTED",
  working: "TASK_STATE_WORKING",
  uncertain: "TASK_STATE_WORKING",
  needs_recipient: "TASK_STATE_INPUT_REQUIRED",
  needs_answer: "TASK_STATE_INPUT_REQUIRED",
  completed: "TASK_STATE_COMPLETED",
  partial: "TASK_STATE_COMPLETED",
  failed: "TASK_STATE_FAILED",
  canceled: "TASK_STATE_CANCELED",
};

// ---- Reducer ----

// Events arrive from a journal or a caller, so each handler checks the fields
// it relies on at runtime; the static type only names the intended shape.
type Handler<K extends Event["type"]> = (
  state: State,
  event: Extract<Event, { type: K }>,
) => Outcome;
type Handlers = { [K in Event["type"]]: Handler<K> };

// Every placement the configuration names, keeping the ones already known.
function addPlacements(
  config: Config,
  placements: State["placements"],
  sessions: State["sessions"],
): void {
  for (const participant of config.participants)
    for (const host of participant.hosts) {
      const key = placementKey(participant.id, host);
      if (placements[key]) continue;
      const session = `${key}#1`;
      placements[key] = {
        participant: participant.id,
        host,
        session,
        ready: true,
        hold: false,
      };
      sessions[session] = { participant: participant.id, host };
    }
}

export function reduce(previous: State, event: Event): State {
  const state = clone(previous);
  state.last = null;
  const handler = isRecord(event)
    ? (handlers as Record<string, Handler<Event["type"]> | undefined>)[
        String(event.type)
      ]
    : undefined;
  const outcome = handler
    ? handler(state, event)
    : reject("unknown_event", "Unknown event type.");
  if (!outcome.ok) {
    // A rejected event changes nothing except the log and its outcome.
    const unchanged = clone(previous);
    unchanged.last = outcome;
    unchanged.log.push({
      n: unchanged.log.length + 1,
      actor: "Router",
      text: outcome.message,
    });
    return unchanged;
  }
  const withdrawn = state.tasks.flatMap((task) => settle(state, task));
  state.last = outcome;
  if (outcome.message)
    state.log.push({
      n: state.log.length + 1,
      actor: outcome.actor ?? "Router",
      text: outcome.message,
    });
  for (const text of withdrawn)
    state.log.push({ n: state.log.length + 1, actor: "Router", text });
  return state;
}

const ok = (
  message: string,
  extra: Omit<Accepted, "ok" | "message"> = {},
): Accepted => ({ ok: true, message, ...extra });
const reject = (code: string, message: string): Rejected => ({
  ok: false,
  code,
  message,
});

const handlers: Handlers = {
  // The configuration in force from here on. The journal carries it, so a
  // replay judges each event by the rules that applied when it happened, and
  // a deployment can change policy, participants or permissions without
  // making its own record unreadable. Placements are only ever added: open
  // deliveries may still point at a participant that was removed.
  configured(state, { config }) {
    let next: Config;
    try {
      next = validateConfig(config);
    } catch (error: unknown) {
      return reject(
        "invalid",
        error instanceof Error ? error.message : String(error),
      );
    }
    state.config = { principals: {}, permissions: {}, ...clone(next) };
    addPlacements(next, state.placements, state.sessions);
    // A pending choice only suggests what the sender may still address.
    for (const task of state.tasks)
      if (task.routing?.state === "needs_recipient")
        task.routing.suggestions = task.routing.suggestions.filter((id) =>
          mayAddress(state, task.source, id),
        );
    return ok("Configuration recorded.");
  },

  submit(state, { by, messageId, text, to = null, hosts = null }) {
    const source = principalOf(state, by);
    if (!source || roleOf(state, source) === "operator")
      return reject(
        "unauthenticated",
        "Only the user or a current participant session can submit.",
      );
    const replaced = notCurrentSession(state, by);
    if (replaced) return replaced;
    const session = state.sessions[by];
    const invalid = badMessageId(messageId) ?? badText(state, text);
    if (invalid) return invalid;
    if (
      hosts !== null &&
      (to === null || !Array.isArray(hosts) || !hosts.length)
    )
      return reject(
        "invalid",
        "Hosts may only narrow an explicitly addressed request.",
      );
    const wanted = hosts === null ? null : [...new Set(hosts)].sort();
    const key = `${source}/${messageId}`;
    const content = digest({ text, to, hosts: wanted });
    const prior = priorReceipt(state, key, content);
    if (prior) return prior;
    if (to !== null) {
      const target = participant(state, to);
      if (!target)
        return reject("invalid", `${to} is not a registered participant.`);
      if (!mayAddress(state, source, to))
        return reject("forbidden", `${source} may not address ${to}.`);
      if (wanted && wanted.some((host) => !target.hosts.includes(host)))
        return reject("invalid", `${to} does not run on every requested host.`);
    }
    if (to === null && !(state.config.permissions[source] ?? []).length)
      return reject(
        "forbidden",
        `${source} may not address any participant, so there is nobody to route to.`,
      );
    const open = state.tasks.filter((task) => !isTerminal(task)).length;
    if (open >= state.config.policy.maxOpenTasks)
      return reject("capacity", "Too many open requests. Try again later.");

    const task: Task = {
      id: `T${state.nextTask++}`,
      source,
      messageId,
      text,
      to,
      hosts: wanted,
      // A participant sender hears back at the placement it sent from.
      via: session ? placementKey(source, session.host) : null,
      notices: [],
      deadline: state.now + state.config.policy.deadline,
      // Whom the sender could address when it asked; the judgment's options.
      permitted: [...(state.config.permissions[source] ?? [])],
      routing: { state: "judging", suggestions: [], reason: null },
      judgments: [],
      recipient: null,
      chosenBy: null,
      deliveries: [],
      late: [],
      final: null,
      status: "routing",
    };
    state.tasks.push(task);
    state.receipts[key] = { taskId: task.id, digest: content };
    if (to !== null) select(state, task, to, "address");
    return ok(`${task.id} recorded for ${key}. The caller may disconnect.`, {
      taskId: task.id,
    });
  },

  judged(state, { taskId, choice, probabilities, model = null }) {
    const task = findTask(state, taskId);
    if (!task || task.routing?.state !== "judging")
      return reject("not_routing", "No judgment is pending for this request.");
    const options = Object.keys(judgmentQuestion(state, task).criteria);
    const valid = validJudgment(options, choice, probabilities);
    const threshold = state.config.policy.threshold;
    task.judgments.push({
      choice,
      probabilities: valid ? probabilities : null,
      model,
      valid,
      threshold,
    });
    // Suggestions are the permitted options in Jev's order; the sender decides.
    const suggestions = valid
      ? Object.entries(probabilities)
          .filter(([id]) => id !== "none")
          .sort((a, b) => b[1] - a[1])
          .map(([id]) => id)
      : [];
    if (!valid) {
      askForRecipient(task, "invalid_judgment", []);
      return ok(
        `${task.id}: Jev output was invalid. The sender must name a recipient.`,
        { actor: "Jev" },
      );
    }
    const chosen = probabilities[choice] ?? 0;
    if (choice === "none" || chosen < threshold) {
      askForRecipient(
        task,
        choice === "none" ? "no_owner" : "low_confidence",
        suggestions,
      );
      return ok(
        `${task.id}: no confident owner (${choice} ${chosen}). The sender must choose.`,
        { actor: "Jev" },
      );
    }
    select(state, task, choice, "judgment");
    return ok(`${task.id}: Jev selected ${choice} at ${chosen}.`, {
      actor: "Jev",
    });
  },

  judgeFailed(state, { taskId, reason = "unavailable" }) {
    const task = findTask(state, taskId);
    if (!task || task.routing?.state !== "judging")
      return reject("not_routing", "No judgment is pending for this request.");
    askForRecipient(task, "routing_unavailable", []);
    return ok(`${task.id}: Jev ${reason}. The sender must name a recipient.`, {
      actor: "Jev",
    });
  },

  choose(state, { by, taskId, to }) {
    const task = findTask(state, taskId);
    if (!task) return reject("not_found", "No such request.");
    const forbidden =
      notSender(state, by, task) ?? notCurrentSession(state, by);
    if (forbidden) return forbidden;
    if (isTerminal(task) || task.routing?.state !== "needs_recipient")
      return reject(
        "not_waiting",
        "This request is not waiting for a recipient.",
      );
    if (!participant(state, to) || !mayAddress(state, task.source, to))
      return reject("forbidden", `${task.source} may not address ${to}.`);
    select(state, task, to, "sender");
    return ok(`${task.id}: sender chose ${to}.`);
  },

  attempt(state, { deliveryId }) {
    const delivery = findDelivery(state, deliveryId);
    if (!delivery) return reject("not_found", "No such delivery.");
    const reason = blockedReason(state, delivery);
    if (reason)
      return reject(
        "not_eligible",
        `${deliveryId} cannot be attempted: ${reason.replaceAll("_", " ")}.`,
      );
    const send = currentSend(delivery);
    const retry = send.outcome === "unknown";
    const placement = state.placements[delivery.placement];
    if (!placement) return reject("not_found", "No such placement.");
    delivery.session ??= placement.session;
    send.outcome = "attempting";
    send.trail.push("attempting");
    // The session is about to start a turn. Only a newer observation can
    // report it idle again; a stale "ready" would let the next send interrupt it.
    placement.ready = false;
    return ok(
      retry
        ? `Retrying ${delivery.id}/${send.messageId} with the same key. The adapter deduplicates, so this cannot run twice.`
        : `Recorded ${delivery.id}/${send.messageId} as attempting to ${delivery.session} before calling the adapter.`,
    );
  },

  adapterResult(state, { deliveryId, messageId, outcome }) {
    const delivery = findDelivery(state, deliveryId);
    const send = delivery && currentSend(delivery);
    if (!includes(ADAPTER_OUTCOMES, outcome))
      return reject("invalid", "Outcome is accepted, not_sent or unknown.");
    if (
      !delivery ||
      !send ||
      send.messageId !== messageId ||
      send.outcome !== "attempting"
    )
      return reject(
        "stale_ack",
        "This acknowledgment does not match an attempt in progress. It cannot overwrite later evidence.",
      );
    send.trail.push(outcome);
    if (outcome === "not_sent") {
      // Definitely not delivered: safe to queue again. The request may move to
      // a new session only if no earlier attempt could have reached this one.
      send.outcome = "pending";
      if (delivery.sends.length === 1 && !send.trail.includes("unknown"))
        delivery.session = null;
    } else send.outcome = outcome;
    return ok(`${delivery.id}/${messageId}: adapter reported ${outcome}.`, {
      actor: "Adapter",
    });
  },

  update(state, { by, taskId, messageId, inReplyTo, kind, text = "" }) {
    const task = findTask(state, taskId);
    if (!task) return reject("not_found", "No such request.");
    const delivery = task.deliveries.find(
      (d) => d.session !== null && d.session === by,
    );
    if (!delivery)
      return reject(
        "wrong_session",
        "Only the session pinned to a delivery of this request can reply.",
      );
    if (!includes(UPDATE_KINDS, kind))
      return reject("invalid", "Unknown reply kind.");
    const invalid = badMessageId(messageId);
    if (invalid) return invalid;
    const send = delivery.sends.find((entry) => entry.messageId === inReplyTo);
    if (!send || !send.trail.includes("attempting"))
      return reject(
        "wrong_message",
        "The reply does not answer a message sent on this delivery.",
      );
    const content = digest({ inReplyTo, kind, text });
    const seen = delivery.updates.find(
      (entry) => entry.messageId === messageId,
    );
    if (seen) {
      if (seen.digest !== content)
        return reject(
          "conflict",
          `Reply ${messageId} already has different content.`,
        );
      return ok(`Reply ${messageId} already recorded.`, { duplicate: true });
    }
    // A reply to the message before an answer that never left the router
    // means the participant moved on: the question was settled in the
    // session, and the queued answer is withdrawn.
    const queued = isOpen(delivery) ? currentSend(delivery) : null;
    if (
      queued &&
      queued !== send &&
      queued.kind === "answer" &&
      queued.outcome === "pending" &&
      delivery.sends[delivery.sends.indexOf(queued) - 1] === send
    ) {
      queued.outcome = "withdrawn";
      queued.trail.push("withdrawn");
    }
    const current = isOpen(delivery) && send === currentSend(delivery);
    if (current && kind === "question" && delivery.question)
      return reject(
        "question_open",
        "One question may be outstanding per delivery.",
      );
    delivery.updates.push({
      messageId,
      inReplyTo,
      kind,
      text,
      digest: content,
    });

    if (!isOpen(delivery))
      return ok(
        `${delivery.id}: reply ${messageId} kept as evidence; the delivery is already closed.`,
      );
    if (!current)
      return ok(
        `${delivery.id}: reply to earlier message ${inReplyTo} kept as history. It cannot advance the current exchange.`,
      );
    // A matching reply proves receipt, even before or instead of the adapter's acknowledgment.
    if (send.outcome !== "accepted") {
      send.outcome = "accepted";
      send.trail.push("reply_seen");
    }
    if (kind === "working") {
      // Progress after a question means it was settled in the session.
      const settled = delivery.question !== null;
      delivery.question = null;
      return ok(
        `${delivery.id}: ${text || "working"}.${settled ? " The open question was settled in the session." : ""}`,
        { actor: "Participant" },
      );
    }
    if (kind === "question") {
      delivery.question = { id: messageId, text };
      return ok(`${delivery.id} asks: ${text}`, { actor: "Participant" });
    }
    delivery.question = null;
    delivery.end = { reason: kind, text, messageId, by };
    if (task.final) {
      task.late.push({ deliveryId: delivery.id, kind, text });
      return ok(
        `${delivery.id}: late ${kind} result stored; ${task.id} stays ${task.final.status}.`,
        { actor: "Participant" },
      );
    }
    return ok(`${delivery.id}: ${kind} result stored.`, {
      actor: "Participant",
    });
  },

  answer(
    state,
    { by, taskId, messageId, questionId, deliveryId = null, text },
  ) {
    const task = findTask(state, taskId);
    if (!task) return reject("not_found", "No such request.");
    const invalid =
      notSender(state, by, task) ??
      badMessageId(messageId) ??
      badText(state, text);
    if (invalid) return invalid;
    const key = `${task.source}/${messageId}`;
    const content = digest({ taskId, questionId, deliveryId, text });
    const prior = priorReceipt(state, key, content);
    if (prior) return prior;
    if (task.final)
      return reject(
        "terminal",
        `${task.id} is ${task.final.status} and accepts no further messages.`,
      );
    if (
      deliveryId !== null &&
      !task.deliveries.some((d) => d.id === deliveryId)
    )
      return reject("not_found", `${task.id} has no delivery ${deliveryId}.`);
    const asking = task.deliveries.filter(
      (d) =>
        isOpen(d) &&
        d.question?.id === questionId &&
        (deliveryId === null || d.id === deliveryId),
    );
    if (asking.length > 1)
      return reject(
        "ambiguous",
        `${asking.map((d) => d.id).join(" and ")} both ask under ${questionId}; pass the delivery.`,
      );
    const delivery = asking[0];
    if (!delivery)
      return reject(
        "no_question",
        "That question is not open. It may already be answered.",
      );
    delivery.question = null;
    delivery.sends.push({
      messageId,
      kind: "answer",
      text,
      outcome: "pending",
      trail: [],
    });
    state.receipts[key] = { taskId: task.id, digest: content };
    return ok(
      `${task.id}: answer ${messageId} queued for the pinned session ${delivery.session}.`,
    );
  },

  cancel(state, { by, taskId }) {
    const task = findTask(state, taskId);
    if (!task) return reject("not_found", "No such request.");
    const forbidden = notSender(state, by, task);
    if (forbidden) return forbidden;
    if (task.final)
      return reject(
        "not_cancelable",
        `${task.id} is already ${task.final.status}.`,
      );
    if (task.deliveries.some((d) => d.session !== null || !isOpen(d)))
      return reject(
        "not_cancelable",
        "Work may have reached a participant. Only never-sent requests can be canceled.",
      );
    for (const delivery of task.deliveries)
      delivery.end = { reason: "canceled" };
    task.final = { ...verdict(task), status: "canceled", reason: "sender" };
    return ok(`${task.id} canceled before any delivery.`);
  },

  resolve(state, { by, deliveryId, messageId, outcome, evidence }) {
    if (roleOf(state, principalOf(state, by)) !== "operator")
      return reject("forbidden", "Only an operator can reconcile a delivery.");
    const delivery = findDelivery(state, deliveryId);
    if (!delivery || !isOpen(delivery) || delivery.session === null)
      return reject(
        "not_pinned",
        "Only an open, pinned delivery needs reconciliation.",
      );
    const send = currentSend(delivery);
    if (send.messageId !== messageId)
      return reject(
        "wrong_message",
        "Reconcile the delivery's current message.",
      );
    if (typeof evidence !== "string" || !evidence.trim())
      return reject("invalid", "Record the evidence checked.");
    const allowed =
      send.outcome === "accepted" ? ["finished"] : ["finished", "not_sent"];
    if (send.outcome === "attempting")
      return reject(
        "in_progress",
        "An attempt is in progress. Wait for its outcome or a restart.",
      );
    if (!includes(allowed, outcome))
      return reject(
        "invalid",
        `An ${send.outcome} message can only be resolved as ${allowed.join(" or ")}.`,
      );
    delivery.question = null;
    delivery.end = { reason: `resolved_${outcome}`, text: evidence, by };
    return ok(
      `${delivery.id} reconciled as ${outcome} by the operator. Nothing was resent.`,
    );
  },

  // Like attempt, for a notice: recorded before the adapter is called, with
  // the sender's session so a later observer can tell whom it reached.
  noticeAttempt(state, { taskId, key, text }) {
    const task = findTask(state, taskId);
    if (!task) return reject("not_found", "No such request.");
    const due = dueNotices(state, task).find((d) => d.key === key);
    if (!due)
      return reject("not_due", `${task.id}: nothing to tell under ${key}.`);
    if (typeof text !== "string" || !text.trim())
      return reject("invalid", "A notice needs text.");
    const reason = noticeBlockedReason(state, task, key);
    if (reason)
      return reject(
        "not_eligible",
        `${task.id} notice ${key} cannot be sent: ${reason.replaceAll("_", " ")}.`,
      );
    const placement = state.placements[task.via ?? ""];
    if (!placement) return reject("not_found", "No such placement.");
    const notice = findNotice(task, key) ?? recordNotice(state, task, due);
    if (notice.text === null) notice.text = text;
    else if (notice.text !== text)
      return reject(
        "conflict",
        `${task.id} notice ${key} was first attempted with different text.`,
      );
    notice.session = placement.session;
    notice.outcome = "attempting";
    notice.trail.push("attempting");
    placement.ready = false;
    return ok(
      `Recorded notice ${task.id}/${key} as attempting to ${placement.session} before calling the adapter.`,
    );
  },

  noticeResult(state, { taskId, key, outcome }) {
    const task = findTask(state, taskId);
    if (!task) return reject("not_found", "No such request.");
    const notice = findNotice(task, key);
    if (!includes(ADAPTER_OUTCOMES, outcome))
      return reject("invalid", "Outcome is accepted, not_sent or unknown.");
    if (!notice || notice.outcome !== "attempting")
      return reject(
        "stale_ack",
        `${task.id} notice ${key} has no attempt in progress.`,
      );
    notice.trail.push(outcome);
    notice.outcome = outcome === "not_sent" ? "pending" : outcome;
    return ok(
      `${task.id}/${key}: notice ${outcome === "not_sent" ? "not sent; it will be retried" : outcome}.`,
      { actor: "Adapter" },
    );
  },

  // ready: the adapter saw a session it may send to. hold: a person is using the
  // session and the router must not send to it, idle or not.
  observe(state, { placement, ready, hold, session }) {
    const entry = state.placements[placement];
    if (!entry) return reject("not_found", "No such placement.");
    if (session !== undefined && session !== entry.session) {
      if (typeof session !== "string" || state.sessions[session])
        return reject("invalid", "A new session needs a new identity.");
      entry.session = session;
      // A new session has not been observed idle yet. A hold belongs to
      // the person, not the session, so it stays until released.
      entry.ready = ready === true;
      state.sessions[session] = {
        participant: entry.participant,
        host: entry.host,
      };
    } else if (ready !== undefined) entry.ready = Boolean(ready);
    if (hold !== undefined) entry.hold = Boolean(hold);
    return ok(
      `${placement}: ${entry.ready ? "ready" : "not ready"}${entry.hold ? ", held" : ""}, session ${entry.session}.`,
      { actor: "Adapter" },
    );
  },

  restart(state) {
    state.boot++;
    let uncertain = 0;
    const interrupted = [
      ...allDeliveries(state).flatMap((d) => d.sends),
      ...state.tasks.flatMap((t) => t.notices),
    ];
    for (const attempt of interrupted)
      if (attempt.outcome === "attempting") {
        attempt.outcome = "unknown";
        attempt.trail.push("unknown");
        uncertain++;
      }
    return ok(
      `Router boot ${state.boot}: ${uncertain} interrupted attempt(s) marked unknown. Nothing replayed.`,
    );
  },

  tick(state, { now }) {
    if (typeof now !== "number" || now < state.now)
      return reject("invalid", "Time only moves forward.");
    state.now = now;
    const expired: string[] = [];
    for (const task of state.tasks)
      if (!isTerminal(task) && now >= task.deadline) {
        task.routing = null;
        task.final = verdict(task, "deadline");
        expired.push(`${task.id} ${task.final.status}`);
      }
    // A clock that ended nothing is not news: no log line, so a polling
    // router's log stays what happened.
    return ok(
      expired.length
        ? `Deadline passed: ${expired.join(", ")}. Unconfirmed sends keep holding their sessions until they end or are reconciled.`
        : "",
    );
  },
};

function askForRecipient(
  task: Task,
  reason: RoutingReason,
  suggestions: string[],
): void {
  task.routing = { state: "needs_recipient", reason, suggestions };
}

function select(
  state: State,
  task: Task,
  participantId: string,
  chosenBy: NonNullable<Task["chosenBy"]>,
): void {
  const entry = participant(state, participantId);
  if (!entry) throw new Error(`${participantId} is not a participant`);
  task.routing = null;
  task.recipient = participantId;
  task.chosenBy = chosenBy;
  task.deliveries = (task.hosts ?? entry.hosts).map((host) => ({
    // The number is the delivery's place in creation order; a placement
    // queues by it.
    id: `D${state.nextDelivery++}`,
    taskId: task.id,
    participant: participantId,
    // Whether the adapter deduplicates, as configured when this delivery
    // was created; the participant may be reconfigured later.
    idempotent: entry.idempotent,
    host,
    placement: placementKey(participantId, host),
    session: null,
    sends: [
      {
        messageId: task.messageId,
        kind: "request",
        text: task.text,
        outcome: "pending",
        trail: [],
      },
    ],
    question: null,
    updates: [],
    end: null,
  }));
}

// The final word on a task from its deliveries so far: completed when every
// host answered, partial when some did (the record says which), failed when
// none did. Results after this point are kept as evidence, not counted.
function verdict(task: Task, reason = "delivery"): Final {
  const of = task.deliveries.length;
  const completed = task.deliveries.filter(
    (d) => d.end?.reason === "completed",
  ).length;
  const status =
    of && completed === of ? "completed" : completed ? "partial" : "failed";
  return {
    status,
    reason: status === "completed" ? null : reason,
    completed,
    of,
  };
}

function recordNotice(state: State, task: Task, due: NoticeDue): Notice {
  const notice: Notice = {
    ...due,
    text: null,
    idempotent: participant(state, task.source)?.idempotent ?? false,
    session: null,
    outcome: "pending",
    trail: [],
  };
  task.notices.push(notice);
  return notice;
}

// Close what can no longer happen, then derive status. Returns a log line
// for each notice withdrawn: a question or a choice that stopped standing
// before the sender was told is never told late.
function settle(state: State, task: Task): string[] {
  if (isTerminal(task)) {
    // Nothing new is sent after a deadline: never-sent deliveries expire.
    for (const delivery of task.deliveries)
      if (isOpen(delivery) && delivery.session === null)
        delivery.end = { reason: "expired" };
  } else if (task.deliveries.length && task.deliveries.every((d) => !isOpen(d)))
    task.final = verdict(task);
  task.status = status(task);
  // What the sender is owed is recorded as soon as it is due, so a notice
  // that is never sent still shows, and its withdrawal is logged.
  const due = dueNotices(state, task);
  for (const d of due)
    if (!findNotice(task, d.key)) recordNotice(state, task, d);
  const dueKeys = due.map((d) => d.key);
  const withdrawn: string[] = [];
  for (const notice of task.notices)
    if (
      ["pending", "unknown"].includes(notice.outcome) &&
      !dueKeys.includes(notice.key)
    ) {
      notice.outcome = "withdrawn";
      notice.trail.push("withdrawn");
      withdrawn.push(
        `${task.id} notice ${notice.key} withdrawn: the ${notice.kind === "choose" ? "choice" : "question"} no longer stands.`,
      );
    }
  return withdrawn;
}
