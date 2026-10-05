// The board: what waits on a person and what the router is doing, read from
// the record. `boardModel` is pure and is what the board returns as JSON;
// board-page.ts renders it as the page, and `actionEvent` turns the page's
// forms into events. Nothing here writes.
import { randomBytes } from "node:crypto";
import {
  A2A_STATE,
  blockedReason,
  currentSend,
  isOpen,
  needsYou,
  queueHead,
  reduce,
} from "./core.ts";
import { fold } from "./shell.ts";
import type { RouterConfig } from "./config.ts";
import type { AgentSnapshot, Telemetry } from "./telemetry.ts";
import { usageView, type UsageState, type UsageView } from "./usage.ts";
import type { Entry } from "./journal.ts";
import type {
  BlockedReason,
  Delivery,
  Event,
  Final,
  NeedsYouItem,
  Notice,
  NoticeKind,
  Role,
  Send,
  SendOutcome,
  State,
  Task,
  Update,
  UpdateKind,
} from "./types.ts";

// The view model is a published contract: the BoardModel type below (with
// AgentSnapshot and its sheet types in telemetry.ts, UsageView and its types
// in usage.ts), the sample generated from the board fixture
// (board.sample.json), and the notes in docs/board-model.md. A design binds
// its template to these names. A change that removes or renames a field
// raises the major version here; adding a field does not. Times are ISO
// strings, as the journal records them.
export const BOARD_VERSION = "jev-router-board/1";

// An agent's reply, without the digest the core keeps to recognise a repeat.
export type UpdateView = Omit<Update, "digest">;

// Why an open delivery's send waits: the core's blocked reasons, without the
// two that mean it is not waiting (it ended, or its send already left).
export type WaitReason = Exclude<BlockedReason, "closed" | "not_pending">;

export type DeliveryView = {
  id: string;
  placement: string;
  session: string | null;
  send: { kind: string; messageId: string; outcome: string };
  sends: Pick<Send, "messageId" | "kind" | "text" | "outcome">[];
  question: { id: string; text: string } | null;
  updates: UpdateView[];
  latest: UpdateView | null;
  end: Delivery["end"];
  // Why the send waits, and for `queued_behind` the delivery at the head of
  // the placement's queue, which goes next. Null when nothing holds it back.
  waits: { reason: WaitReason; behind: string | null } | null;
};

export type TaskView = {
  id: string;
  status: Task["status"];
  a2a: string;
  source: string;
  messageId: string;
  recipient: string | null;
  // How the recipient was named: on the request, by Jev, or by the sender
  // after Jev handed the choice back.
  chosenBy: Task["chosenBy"];
  text: string;
  deadline: string;
  routing: Task["routing"];
  // Every judgment with its full probability table and model version.
  judgments: Task["judgments"];
  // `by` names the principal who canceled the task; null when the router
  // ended it.
  final: (Final & { by: string | null }) | null;
  deliveries: DeliveryView[];
  // The placement a participant sender submitted from, and what it has
  // been told there (a question to answer, a recipient to choose, the
  // final word), each with the send outcome of the notice; both null and
  // empty for a person's task.
  via: string | null;
  notices: {
    key: string;
    kind: NoticeKind;
    session: string | null;
    outcome: Notice["outcome"];
  }[];
  // This task's lines in the router's log, as `router status <task>` shows
  // them, so a template never matches log text itself.
  log: State["log"];
};

// A placement this router serves, as `router status` lists it.
export type PlacementView = {
  key: string;
  participant: string;
  host: string;
  session: string;
  ready: boolean;
  hold: boolean;
  // The open delivery pinned to the current session, the latest one when
  // there are several; null when the session has none. A delivery is pinned
  // at the attempt, so `outcome` says whether its current send (the request
  // or the latest answer, message `messageId`) reached the session
  // (accepted) or is still attempting, unknown or pending. `question` is the question
  // the session is waiting on, null once answered: the latest update stays
  // a question after the answer, so the two together tell asking from
  // answered.
  delivery: {
    id: string;
    taskId: string;
    excerpt: string;
    messageId: string;
    outcome: SendOutcome;
    question: { id: string; text: string; at: string | null } | null;
    latest: { kind: UpdateKind; at: string | null } | null;
  } | null;
  // What the router last saw of the session beyond its readiness, from the
  // telemetry file; null when the file has no entry for the placement.
  agent: AgentSnapshot | null;
};

// Who is viewing, with the role of each principal the login may act as.
export type ActorView = {
  login: string;
  principals: { principal: string; role: Role }[];
};

export type BoardModel = {
  version: typeof BOARD_VERSION;
  at: string;
  // Null when the request is not identified: the page then only reads.
  actor: ActorView | null;
  needsYou: { principal: string; role: string; items: NeedsYouItem[] }[];
  placements: PlacementView[];
  open: TaskView[];
  finished: TaskView[];
  // When each message was recorded, by message id.
  times: Record<string, string>;
  log: State["log"];
  // When the placements' snapshots were taken; null without telemetry.
  telemetryAt: string | null;
  // The accounts' usage, for the rail's Usage section and the usage
  // pop-up; null when the configuration has no usage section.
  usage: UsageView | null;
};

const FINISHED_SHOWN = 10;
const LOG_SHOWN = 20;
const TASK_LOG_SHOWN = 8;
const EXCERPT_LENGTH = 90;

// The record as of `now`, folded in memory: deadlines that passed since the
// last run show as passed, and the journal is untouched.
export function boardState(
  config: RouterConfig,
  entries: Entry[],
  now: number,
): State {
  return asOf(fold(config, entries), now);
}

// The same from a fold already made, which a reader may keep between
// requests while the journal is unchanged; the fold itself is left as it
// was.
export const asOf = (folded: State, now: number): State =>
  reduce(folded, { type: "tick", now });

export function messageTimes(entries: Entry[]): Record<string, string> {
  const times: Record<string, string> = {};
  for (const { at, event } of entries)
    if (
      ["submit", "update", "answer"].includes(String(event.type)) &&
      typeof event.messageId === "string"
    )
      times[event.messageId] = at;
  return times;
}

// The model as `actor` sees it at `now`. A pure function of the record, the
// configuration and the time, so the JSON and the page built from one call
// agree, and a fixture reproduces it.
export function boardModel(
  state: State,
  config: RouterConfig,
  now: number,
  times: Record<string, string> = {},
  actor: Actor | null = null,
  telemetry: Telemetry | null = null,
  usage: UsageState | null = null,
): BoardModel {
  const tasks = state.tasks.map((task) => taskView(task, state)).reverse();
  // Oldest first. Tasks list in submission order, which is not creation
  // order for deliveries: a task that waited for a recipient gets its
  // delivery after newer tasks got theirs.
  const deliveries = state.tasks
    .flatMap((task) => task.deliveries.map((delivery) => ({ task, delivery })))
    .sort((a, b) => created(a.delivery) - created(b.delivery));
  return {
    version: BOARD_VERSION,
    at: new Date(now).toISOString(),
    // Roles come from the configuration the actions are checked against, so
    // a template offers only the forms that will be accepted.
    actor: actor && {
      login: actor.login,
      principals: actor.principals.flatMap((principal) => {
        const role = config.principals?.[principal];
        return role ? [{ principal, role }] : [];
      }),
    },
    needsYou: Object.entries(state.config.principals).map(
      ([principal, role]) => ({
        principal,
        role,
        items: needsYou(state, principal),
      }),
    ),
    placements: Object.entries(state.placements)
      .filter(([key]) => key in config.agents)
      .map(([key, p]) => {
        // The newest open delivery on the current session.
        const pinned = deliveries.findLast(
          ({ delivery }) =>
            delivery.placement === key &&
            delivery.session === p.session &&
            isOpen(delivery),
        );
        const latest = pinned?.delivery.updates.at(-1);
        const question = pinned?.delivery.question ?? null;
        return {
          key,
          participant: p.participant,
          host: p.host,
          session: p.session,
          ready: p.ready,
          hold: p.hold,
          delivery: pinned
            ? {
                id: pinned.delivery.id,
                taskId: pinned.task.id,
                excerpt: excerpt(pinned.task.text),
                messageId: currentSend(pinned.delivery).messageId,
                outcome: currentSend(pinned.delivery).outcome,
                question: question
                  ? { ...question, at: times[question.id] ?? null }
                  : null,
                latest: latest
                  ? { kind: latest.kind, at: times[latest.messageId] ?? null }
                  : null,
              }
            : null,
          agent: telemetry?.placements[key] ?? null,
        };
      }),
    open: tasks.filter((t) => !t.final),
    finished: tasks.filter((t) => t.final).slice(0, FINISHED_SHOWN),
    times,
    log: state.log.slice(-LOG_SHOWN),
    telemetryAt: telemetry?.at ?? null,
    usage: usage && usageView(usage, now),
  };
}

// A delivery's place in creation order: the core numbers deliveries from
// one counter (D1, D2, ...).
const created = (delivery: Delivery): number => Number(delivery.id.slice(1));

const excerpt = (text: string): string =>
  text.length > EXCERPT_LENGTH ? `${text.slice(0, EXCERPT_LENGTH)}…` : text;

const updateView = ({
  messageId,
  inReplyTo,
  kind,
  text,
}: Update): UpdateView => ({ messageId, inReplyTo, kind, text });

// Why a delivery waits, as the core decides it. Ended deliveries and sends
// that already left do not wait; the shell's run report skips the same two.
function waits(state: State, delivery: Delivery): DeliveryView["waits"] {
  const reason = blockedReason(state, delivery);
  if (reason === null || reason === "closed" || reason === "not_pending")
    return null;
  return {
    reason,
    behind:
      reason === "queued_behind"
        ? (queueHead(state, delivery.placement)?.id ?? null)
        : null,
  };
}

function taskView(task: Task, state: State): TaskView {
  return {
    id: task.id,
    status: task.status,
    a2a: A2A_STATE[task.status],
    source: `${task.source}/${task.messageId}`,
    messageId: task.messageId,
    recipient: task.recipient,
    chosenBy: task.chosenBy,
    text: task.text,
    deadline: new Date(task.deadline).toISOString(),
    routing: task.routing,
    judgments: task.judgments,
    // Only the sender may cancel a task, so a canceled task was canceled by
    // its source; every other end is the router's.
    final: task.final && {
      ...task.final,
      by: task.final.status === "canceled" ? task.source : null,
    },
    via: task.via,
    notices: task.notices.map(({ key, kind, session, outcome }) => ({
      key,
      kind,
      session,
      outcome,
    })),
    deliveries: task.deliveries.map((d) => {
      const send = currentSend(d);
      const last = d.updates.at(-1);
      return {
        id: d.id,
        placement: d.placement,
        session: d.session,
        send: {
          kind: send.kind,
          messageId: send.messageId,
          outcome: send.outcome,
        },
        sends: d.sends.map(({ messageId, kind, text, outcome }) => ({
          messageId,
          kind,
          text,
          outcome,
        })),
        question: d.question,
        updates: d.updates.map(updateView),
        latest: last ? updateView(last) : null,
        end: d.end,
        waits: waits(state, d),
      };
    }),
    log: taskLog(state.log, task.id),
  };
}

// A task's last lines in the router's log, shared with `router status
// <task>`. The id is matched as a whole word, so T1 does not collect the
// lines of T12.
export function taskLog(log: State["log"], taskId: string): State["log"] {
  const word = new RegExp(`\\b${taskId}\\b`);
  return log.filter((entry) => word.test(entry.text)).slice(-TASK_LOG_SHOWN);
}

// The CLI's wording for a needs-you item, shared with `router needs-you`.
export function describeNeed(item: NeedsYouItem): string {
  switch (item.kind) {
    case "choose":
      return `${item.taskId}: choose a recipient (${item.reason}${item.suggestions.length ? `; suggested ${item.suggestions.join(", ")}` : ""})`;
    case "answer":
      return `${item.taskId}: answer ${item.questionId} on ${item.deliveryId} "${item.text}"`;
    case "resolve":
      return `${item.deliveryId}: resolve ${item.messageId} (${item.reason})`;
  }
}

// Who is looking, as Tailscale Serve reports it, and which principals the
// configuration lets that login act as. Null when the request did not come
// through Serve or the login is not mapped: the page then only reads.
export type Actor = { login: string; principals: string[] };

export function identify(
  headers: Record<string, string | string[] | undefined>,
  identities: Record<string, string[]>,
): Actor | null {
  const login = headers["tailscale-user-login"];
  if (typeof login !== "string" || !login) return null;
  const principals = identities[login];
  return principals?.length ? { login, principals } : null;
}

// Message ids the router mints for answers: time-ordered, unique enough.
export const newMessageId = (): string =>
  `m-${Date.now().toString(36)}-${randomBytes(3).toString("hex")}`;

export type ActionResult =
  { ok: true; event: Event } | { ok: false; message: string };

// A form post from the page as the event it stands for. `by` is the actor's
// principal in the role the action needs; the core enforces the rest.
export function actionEvent(
  form: URLSearchParams,
  actor: Actor,
  roles: Record<string, Role>,
): ActionResult {
  const field = (name: string): string => form.get(name)?.trim() ?? "";
  const as = (role: Role): string | null =>
    actor.principals.find((p) => roles[p] === role) ?? null;
  const need = (role: Role): string | ActionResult => {
    const by = as(role);
    return (
      by ?? { ok: false, message: `${actor.login} has no ${role} principal.` }
    );
  };
  const required = (...names: string[]): ActionResult | null => {
    const missing = names.filter((n) => !field(n));
    return missing.length
      ? { ok: false, message: `Missing ${missing.join(", ")}.` }
      : null;
  };
  switch (field("action")) {
    case "choose": {
      const by = need("requester");
      if (typeof by !== "string") return by;
      return (
        required("task", "to") ?? {
          ok: true,
          event: { type: "choose", by, taskId: field("task"), to: field("to") },
        }
      );
    }
    case "answer": {
      const by = need("requester");
      if (typeof by !== "string") return by;
      return (
        required("task", "question", "text") ?? {
          ok: true,
          event: {
            type: "answer",
            by,
            taskId: field("task"),
            messageId: newMessageId(),
            questionId: field("question"),
            // The form names the delivery; an older page may not.
            deliveryId: field("delivery") || null,
            text: field("text"),
          },
        }
      );
    }
    case "cancel": {
      const by = need("requester");
      if (typeof by !== "string") return by;
      return (
        required("task") ?? {
          ok: true,
          event: { type: "cancel", by, taskId: field("task") },
        }
      );
    }
    case "resolve": {
      const by = need("operator");
      if (typeof by !== "string") return by;
      const outcome = field("outcome");
      if (outcome !== "finished" && outcome !== "not_sent")
        return { ok: false, message: "Outcome is finished or not_sent." };
      return (
        required("delivery", "message", "evidence") ?? {
          ok: true,
          event: {
            type: "resolve",
            by,
            deliveryId: field("delivery"),
            messageId: field("message"),
            outcome,
            evidence: field("evidence"),
          },
        }
      );
    }
    case "hold":
      return (
        required("placement") ?? {
          ok: true,
          event: {
            type: "observe",
            placement: field("placement"),
            hold: field("hold") === "1",
          },
        }
      );
    default:
      return { ok: false, message: `Unknown action "${field("action")}".` };
  }
}
