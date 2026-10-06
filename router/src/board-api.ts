// The board as the router's Paseo plugin reads it (router/plugin): a
// summary the app polls, with a rev that changes only when what it shows
// changes; one task in full; and the actions, as the page's forms post
// them. Built from the same model as the page, so the two agree. The
// field list is the plugin design's (skhlo/designs PR #21, jev-a2a v0.14,
// commit f7f4efb).
import { createHash } from "node:crypto";
import { firstPrincipal, type RouterConfig } from "./config.ts";
import {
  actionEvent,
  type ActionResult,
  type Actor,
  type BoardModel,
  type TaskView,
  type UpdateView,
} from "./board.ts";
import { staleTask } from "./board-parts.ts";
import { answerOf, headline } from "./board-tasks.ts";
import { newMessageId } from "./request.ts";
import type { Event, Role } from "./types.ts";

// A short digest of a value's JSON: equal values, equal revs.
const digest = (value: unknown): string =>
  createHash("sha256").update(JSON.stringify(value)).digest("hex").slice(0, 16);

// The times of a task's own messages: its request, the sends and the
// replies.
function timesOf(
  t: TaskView,
  times: Readonly<Record<string, string>>,
): Record<string, string> {
  const ids = [
    t.messageId,
    ...t.deliveries.flatMap((d) => [
      ...d.sends.map((s) => s.messageId),
      ...d.updates.map((u) => u.messageId),
    ]),
  ];
  return Object.fromEntries(
    ids.flatMap((id): [string, string][] => {
      const at = times[id];
      return at ? [[id, at]] : [];
    }),
  );
}

// A task's rev: it changes whenever the task or its messages' times do, so
// the app refetches the selected task's detail only then.
const taskRev = (t: TaskView, own: Record<string, string>): string =>
  digest({ t, own });

// One task as its list row needs it. `question` is the waiting question's
// text; the needs-you item carries what an answer names. `answered` is the
// answer the latest delivery's open turn took, as the page shows it.
export type TaskHead = {
  id: string;
  title: string;
  status: TaskView["status"];
  recipient: string | null;
  via: string | null;
  source: string;
  messageId: string;
  sentAt: string | null;
  deadline: string;
  final: TaskView["final"];
  reason: NonNullable<TaskView["routing"]>["reason"] | null;
  judgment: { choice: string; probability: number | null } | null;
  question: string | null;
  latest: {
    id: string;
    sendKind: string;
    outcome: string;
    update: Pick<UpdateView, "kind" | "text"> | null;
    answered: { text: string; at: string | null } | null;
  } | null;
  stale: string | null;
  rev: string;
};

function headOf(
  t: TaskView,
  at: string,
  times: Readonly<Record<string, string>>,
): TaskHead {
  const judged = t.judgments.at(-1);
  const last = t.deliveries.at(-1);
  const answer = last ? answerOf(last)?.send : undefined;
  const own = timesOf(t, times);
  return {
    id: t.id,
    title: headline(t.text),
    status: t.status,
    recipient: t.recipient,
    via: t.via,
    source: t.source,
    messageId: t.messageId,
    sentAt: own[t.messageId] ?? null,
    deadline: t.deadline,
    final: t.final,
    reason: t.routing?.reason ?? null,
    judgment: judged
      ? {
          choice: judged.choice,
          probability: judged.probabilities?.[judged.choice] ?? null,
        }
      : null,
    question: t.deliveries.find((d) => d.question)?.question?.text ?? null,
    latest: last
      ? {
          id: last.id,
          sendKind: last.send.kind,
          outcome: last.send.outcome,
          update: last.latest
            ? { kind: last.latest.kind, text: last.latest.text }
            : null,
          answered: answer
            ? { text: answer.text, at: own[answer.messageId] ?? null }
            : null,
        }
      : null,
    stale: staleTask(t, at, own),
    rev: taskRev(t, own),
  };
}

export type BoardSummary = {
  rev: string;
  at: string;
  actor: BoardModel["actor"];
  needsYou: BoardModel["needsYou"];
  placements: {
    key: string;
    participant: string;
    host: string;
    ready: boolean;
    hold: boolean;
  }[];
  open: TaskHead[];
  finished: TaskHead[];
};

// The summary; `rev` covers everything but the clock, so an unchanged
// board answers a poll with `unchanged`.
export function summarize(model: BoardModel): BoardSummary {
  const body = {
    actor: model.actor,
    needsYou: model.needsYou,
    placements: model.placements.map(
      ({ key, participant, host, ready, hold }) => ({
        key,
        participant,
        host,
        ready,
        hold,
      }),
    ),
    open: model.open.map((t) => headOf(t, model.at, model.times)),
    finished: model.finished.map((t) => headOf(t, model.at, model.times)),
  };
  return { rev: digest(body), at: model.at, ...body };
}

export type BoardTask = {
  rev: string;
  task: TaskView;
  times: Record<string, string>;
};

// One task in full with its messages' times, or null when the board has no
// such task (an older finished one is not on the board).
export function fullTask(model: BoardModel, id: string): BoardTask | null {
  const t = [...model.open, ...model.finished].find((task) => task.id === id);
  if (!t) return null;
  const times = timesOf(t, model.times);
  return { rev: taskRev(t, times), task: t, times };
}

// Who the Paseo app acts as: the person the CLI on the router host acts as
// without --as, the first principal of each role. Anyone whose app reaches
// the router host's daemon can already run that CLI through an agent there.
export function appActor(config: RouterConfig): Actor | null {
  const roles: Role[] = ["requester", "operator"];
  const principals = roles.flatMap((role) => {
    const first = firstPrincipal(config, role);
    return first ? [first] : [];
  });
  return principals.length ? { login: "paseo", principals } : null;
}

const isRecord = (value: unknown): value is Record<string, unknown> =>
  value !== null && typeof value === "object" && !Array.isArray(value);

// An action the app posts, as the event it stands for: a request for
// `submit`, and for the rest the fields of the page's forms, which
// actionEvent (board.ts) reads. A request or an answer keeps a messageId
// the app gives, so a retry after a timeout is a repeat the core
// recognises, not a second one. A resolve without evidence says it came
// from the app.
export function apiEvent(
  body: unknown,
  actor: Actor,
  roles: Record<string, Role>,
): ActionResult {
  if (!isRecord(body)) return { ok: false, message: "A JSON object." };
  const text = (name: string): string => {
    const value = body[name];
    return typeof value === "string" ? value : "";
  };
  if (text("action") === "submit") {
    const by = actor.principals.find((p) => roles[p] === "requester");
    if (!by)
      return {
        ok: false,
        message: `${actor.login} has no requester principal.`,
      };
    if (!text("text").trim()) return { ok: false, message: "Missing text." };
    const event: Event = {
      type: "submit",
      by,
      messageId: text("messageId").trim() || newMessageId(),
      text: text("text").trim(),
      to: text("to").trim() || null,
      hosts: null,
    };
    return { ok: true, event };
  }
  const form = new URLSearchParams();
  const put = (field: string, value: string): void => {
    if (value) form.set(field, value);
  };
  const action = text("action");
  put("action", action === "release" ? "hold" : action);
  put("task", text("taskId"));
  put("to", text("recipient"));
  put("question", text("questionId"));
  put("delivery", text("deliveryId"));
  put("message", text("messageId"));
  put("text", text("text"));
  put("outcome", text("outcome"));
  put("placement", text("placement"));
  if (action === "hold") form.set("hold", "1");
  if (action === "resolve")
    put(
      "evidence",
      text("evidence") ||
        `Marked ${text("outcome").replace("_", " ")} in the Paseo app.`,
    );
  return actionEvent(form, actor, roles);
}

// The task an action changed, to return with its result: the one it
// names, the one holding the resolved delivery, or the request just made.
export function actedOn(event: Event, model: BoardModel): string | null {
  const tasks = [...model.open, ...model.finished];
  switch (event.type) {
    case "answer":
    case "choose":
    case "cancel":
      return event.taskId;
    case "resolve":
      return (
        tasks.find((t) => t.deliveries.some((d) => d.id === event.deliveryId))
          ?.id ?? null
      );
    case "submit":
      return tasks.find((t) => t.messageId === event.messageId)?.id ?? null;
    default:
      return null;
  }
}
