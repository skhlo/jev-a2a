// The imperative shell. One run: lock the journal, fold it into state, mark
// interrupted attempts unknown, move the clock, apply the caller's event,
// then perform the core's commands for every placement this router can reach
// and record each result. Nothing survives a run except the journal.
import {
  allDeliveries,
  blockedReason,
  commands,
  currentSend,
  findDelivery,
  findNotice,
  findTask,
  initial,
  noticeWaits,
  reduce,
  validateConfig,
  waitsOnSessions,
} from "./core.ts";
import type { RouterConfig } from "./config.ts";
import {
  openJournal,
  readJournalSince,
  type Entry,
  type JournalMark,
} from "./journal.ts";
import { RouterBug, type Adapter } from "./paseo.ts";
import {
  emptySnapshot,
  TELEMETRY_VERSION,
  type AgentSnapshot,
  type Telemetry,
} from "./telemetry.ts";
import type { JudgeResult } from "./jev.ts";
import type {
  Command,
  Config,
  Event,
  JudgmentQuestion,
  NoticeDue,
  Outcome,
  State,
  Task,
} from "./types.ts";

export type Shell = {
  readonly state: State;
  // Applies an event; appends it to the journal when the core accepts it
  // and it changed the record (a tick that ended nothing and an
  // observation that changed nothing are applied, not appended).
  apply(event: Event): Outcome;
  // Performs every deliverable command for this host, returning what happened.
  deliver(): Promise<string[]>;
  // Whether a later look at this host's sessions could release something
  // without any event: work waiting on an idle or an unconfirmed send.
  waits(): boolean;
  close(): Promise<void>;
};

export type ShellOptions = {
  // One adapter per host, created on first use.
  adapter: (endpoint: string) => Promise<Adapter>;
  // Asks Jev; null when Jev is not configured, so unaddressed requests wait.
  judge: ((question: JudgmentQuestion) => Promise<JudgeResult>) | null;
  now?: () => number;
  // Where each run's observations go beyond the record: the board's
  // telemetry file. Absent, none is kept (tests).
  telemetry?: (telemetry: Telemetry) => void;
  // Test hook for the crash-recovery acceptance: exit at a chosen point.
  crash?: "after_attempt" | "after_send" | undefined;
  // The record as serve's kept fold holds it (see journalFolder): its state
  // and whether the journal has a `configured` line. It is read once the
  // run holds the lock, so no other writer appends while it is read.
  // Folding the whole journal instead blocked serve's event loop for a full
  // replay on every run. Absent, the run folds the journal itself, as the
  // CLI's one-shot commands do.
  record?: () => Readonly<{ state: State; configured: boolean }>;
};

// A journal holds only accepted events, so a rejection on replay means the
// record and the code disagree; nothing sensible can be shown or done.
// The part of the deployment configuration the core reasons about, in the
// shape the core stores it, so it can be compared with the recorded one.
export function coreConfig(config: RouterConfig): Required<Config> {
  return {
    policy: config.policy,
    participants: config.participants,
    principals: config.principals ?? {},
    permissions: config.permissions ?? {},
  };
}

// Key order is not meaning; compare configurations by content.
const canonical = (value: unknown): string =>
  JSON.stringify(value, (_key, v: unknown) =>
    v !== null && typeof v === "object" && !Array.isArray(v)
      ? Object.fromEntries(
          Object.entries(v as Record<string, unknown>).sort(([a], [b]) =>
            a < b ? -1 : a > b ? 1 : 0,
          ),
        )
      : v,
  );

// Placements this router serves: a configured agent on a configured host.
export const servedBy =
  (config: RouterConfig, state: State) =>
  (placement: string): boolean => {
    const host = state.placements[placement]?.host;
    return (
      config.agents[placement] !== undefined &&
      host !== undefined &&
      config.hosts[host] !== undefined
    );
  };

const configuredIn = (entries: Entry[]): Entry["event"] | undefined =>
  entries.find((e) => e.event.type === "configured")?.event;

// A record that predates its first `configured` line was written under that
// configuration, not under today's: start from it, so the rules of the time
// hold for the whole record.
export function fold(config: RouterConfig, entries: Entry[]): State {
  const first = configuredIn(entries);
  return foldMore(
    initial(first ? validateConfig(first.config) : coreConfig(config)),
    entries,
  );
}

// Folds `entries` onto `state`, the fold of the record before them. The core
// returns a new state for each event, so `state` itself is left as it was.
function foldMore(state: State, entries: Entry[]): State {
  for (const { event } of entries) {
    // The journal holds events the core accepted; the core re-validates on
    // replay and the throw below catches anything that no longer fits.
    state = reduce(state, event as Event);
    if (!state.last?.ok)
      throw new Error(
        `Journal replay rejected ${JSON.stringify(event)}: ${state.last?.message}`,
      );
  }
  return state;
}

// The journal folded without the lock and kept between reads: a read folds
// only the lines appended since the last one onto the state it left, as a
// replay clones the state at every event (1.2 to 2.4 s a read on a live
// record) and the journal changes at least every serve.poll. A journal that
// is not the one read before (cut back, replaced) is folded from the start,
// and so is one whose first `configured` line has just arrived, as that
// line sets where the fold starts. A read returns the state and the lines
// it folded: those since the last read (`from` "mark") or the whole record
// (`from` "start"), and whether the journal has a `configured` line.
export type JournalFold = Readonly<{
  state: State;
  entries: Entry[];
  from: "start" | "mark";
  configured: boolean;
}>;
export function journalFolder(config: RouterConfig): () => JournalFold {
  let state: State | null = null;
  let mark: JournalMark | null = null;
  let configured = false;
  return () => {
    let got = readJournalSince(config.home, mark);
    if (got.from === "mark" && !configured && configuredIn(got.entries))
      got = readJournalSince(config.home, null);
    state =
      state && got.from === "mark"
        ? foldMore(state, got.entries)
        : fold(config, got.entries);
    if (got.from === "start") configured = !!configuredIn(got.entries);
    mark = got.mark;
    return { state, entries: got.entries, from: got.from, configured };
  };
}

export async function openShell(
  config: RouterConfig,
  options: ShellOptions,
): Promise<Shell> {
  const journal = await openJournal(config.home);
  const now = options.now ?? Date.now;
  let state: State;
  const adapters = new Map<string, Adapter>();
  const adapterFor = async (host: string): Promise<Adapter> => {
    const entry = config.hosts[host];
    if (!entry) throw new Error(`No endpoint configured for host ${host}`);
    let adapter = adapters.get(host);
    if (!adapter) {
      adapter = await options.adapter(entry.paseo);
      adapters.set(host, adapter);
    }
    return adapter;
  };
  let configured: boolean;
  try {
    if (options.record) ({ state, configured } = options.record());
    else {
      const entries = journal.entries();
      state = fold(config, entries);
      configured = Boolean(configuredIn(entries));
    }
  } catch (error) {
    journal.release();
    throw error;
  }

  // Every run applies a tick and one observation per placement, and a quiet
  // router's journal must not grow with them. A tick that ended nothing is
  // held back and appended only when a recorded event follows it in this
  // run, since a later submit's deadline is measured from it; an
  // observation is appended only when it changed the placement's
  // readiness, session or hold. In memory the run sees every event.
  let heldTick: Event | null = null;
  const alreadyRecorded = (event: Event, next: State): boolean => {
    if (event.type === "tick")
      return state.tasks.every(
        (task, i) => Boolean(task.final) === Boolean(next.tasks[i]?.final),
      );
    if (event.type === "observe") {
      const before = state.placements[event.placement];
      const after = next.placements[event.placement];
      return (
        before?.ready === after?.ready &&
        before?.session === after?.session &&
        before?.hold === after?.hold
      );
    }
    return false;
  };
  const apply = (event: Event): Outcome => {
    const next = reduce(state, event);
    const outcome = next.last;
    if (!outcome) throw new Error("reduce left no outcome");
    if (outcome.ok) {
      if (!alreadyRecorded(event, next)) {
        if (heldTick) journal.append(heldTick);
        heldTick = null;
        journal.append(event);
      } else if (event.type === "tick") heldTick = event;
      state = next;
    }
    return outcome;
  };

  // The configuration in force is part of the record, so a replay uses the
  // rules that applied at the time. Record it first, and again whenever it
  // changes.
  if (
    !configured ||
    canonical(coreConfig(config)) !== canonical(state.config)
  ) {
    const recorded = reduce(state, {
      type: "configured",
      config: coreConfig(config),
    });
    if (!recorded.last?.ok) {
      journal.release();
      throw new Error(`Configuration rejected: ${recorded.last?.message}`);
    }
    journal.append({ type: "configured", config: coreConfig(config) });
    state = recorded;
  }

  // A send or a notice left "attempting" means the previous run died
  // mid-send.
  if (
    allDeliveries(state).some((d) =>
      d.sends.some((s) => s.outcome === "attempting"),
    ) ||
    state.tasks.some((t) => t.notices.some((n) => n.outcome === "attempting"))
  )
    apply({ type: "restart" });
  apply({ type: "tick", now: now() });

  const isServed = servedBy(config, state);
  const served = Object.entries(config.agents).filter(([key]) => isServed(key));

  async function observeAll(report: string[]): Promise<void> {
    const snapshots: Record<string, AgentSnapshot> = {};
    for (const [key, agentId] of served) {
      const placement = state.placements[key];
      if (!placement) continue;
      const at = new Date(now()).toISOString();
      let seen: Awaited<ReturnType<Adapter["observe"]>>;
      try {
        seen = await (await adapterFor(placement.host)).observe(agentId, at);
      } catch (error: unknown) {
        // Readiness is what this run saw; an earlier run's idle must not
        // carry over a failed look.
        apply({ type: "observe", placement: key, ready: false });
        const message = error instanceof Error ? error.message : String(error);
        snapshots[key] = emptySnapshot(at, "unreachable", message);
        report.push(
          `${key}: ${placement.host} unreachable (${message}); not ready`,
        );
        continue;
      }
      snapshots[key] = seen?.snapshot ?? emptySnapshot(at, "missing");
      const ready = seen?.ready ?? false;
      const event: Event =
        placement.session === agentId
          ? { type: "observe", placement: key, ready }
          : { type: "observe", placement: key, session: agentId, ready };
      const outcome = apply(event);
      report.push(
        seen
          ? `${key}: ${seen.status}${seen.pendingPermissions ? `, ${seen.pendingPermissions} permission(s) waiting` : ""}${placement.hold ? ", held" : ""}`
          : `${key}: agent ${agentId} not found on this daemon`,
      );
      if (!outcome.ok) report.push(`${key}: ${outcome.message}`);
      // A sheet read that failed cost one field, not the observation; the
      // line is a telemetry line, which a wake run logs.
      for (const note of seen?.notes ?? [])
        report.push(`telemetry: ${key}: ${note}`);
    }
    // Telemetry is a side file: a failure to write it is reported, and the
    // run goes on to its sends.
    try {
      options.telemetry?.({
        version: TELEMETRY_VERSION,
        at: new Date(now()).toISOString(),
        placements: snapshots,
      });
    } catch (error: unknown) {
      report.push(
        `telemetry not written: ${error instanceof Error ? error.message : String(error)}`,
      );
    }
  }

  function envelope(taskId: string, deliveryId: string): string {
    const delivery = findDelivery(state, deliveryId);
    if (!delivery) throw new Error(`${deliveryId} vanished`);
    const send = currentSend(delivery);
    const replyCommand = config.hosts[delivery.host]?.replyCommand ?? "router";
    const reply = `${replyCommand} reply --task ${taskId} --in-reply-to ${send.messageId} --kind completed --text "<result>"`;
    const head =
      send.kind === "answer"
        ? `[router ${taskId} ${send.messageId}] Answer to your question. When done, run: ${reply}`
        : `[router ${taskId} ${send.messageId}] Task from the router. When done, run: ${reply}`;
    return `${head} (use --kind question to ask the sender something, --kind working for progress, --kind failed if you cannot do it).\n\n${send.text}`;
  }

  // What a participant sender is told, with the client command that answers
  // it: `--as` names the session, which the CLI on the router host needs
  // and the client ignores (it is always $PASEO_AGENT_ID). A final notice
  // carries each delivery's last word.
  function noticeText(task: Task, due: NoticeDue): string {
    const { key } = due;
    const placement = state.placements[task.via ?? ""];
    const command =
      config.hosts[placement?.host ?? ""]?.replyCommand ?? "router";
    const as = `--as ${placement?.session ?? "<session>"}`;
    const head = `[router ${task.id} ${key}]`;
    if (due.kind === "question") {
      const delivery = task.deliveries.find((d) => d.id === due.deliveryId);
      return `${head} ${delivery?.participant ?? task.recipient ?? "The recipient"} asks about your request. Answer with: ${command} answer ${as} --task ${task.id} --delivery ${due.deliveryId} --question ${due.questionId} --text "<answer>" (or --text-file <path>).\n\n${delivery?.question?.text ?? ""}`;
    }
    if (due.kind === "choose") {
      const routing =
        task.routing?.state === "needs_recipient" ? task.routing : null;
      const suggested = routing?.suggestions.length
        ? `; suggested ${routing.suggestions.join(", ")}`
        : "";
      return `${head} The router could not pick a recipient for your request (${(routing?.reason ?? "unknown").replaceAll("_", " ")}${suggested}). Choose with: ${command} choose ${as} --task ${task.id} --to <participant>, one of: ${task.permitted.join(", ")}.\n\n${task.text}`;
    }
    // Each delivery's last word, with the session and message it came
    // from, so the prompt alone says who answered.
    const short = (id: string): string =>
      /^[0-9a-f]{8}-[0-9a-f]{4}-/.test(id) ? id.slice(0, 8) : id;
    const words = task.deliveries
      .map((d) => {
        const end = d.end;
        if (!end) return `${d.participant}@${d.host}: no result`;
        const from = [
          end.by ? `session ${short(end.by)}` : "",
          end.messageId ?? "",
        ]
          .filter(Boolean)
          .join(" ");
        return `${d.participant}@${d.host} ${end.reason}${from ? ` (${from})` : ""}${end.text ? `:\n${end.text}` : ""}`;
      })
      .join("\n\n");
    return `${head} Your request is ${task.final?.status ?? "closed"}${task.final?.reason ? ` (${task.final.reason})` : ""}, told at ${new Date(now()).toISOString()}. No reply is needed.\n\n${words}`;
  }

  // Each due notice for a sender this router can reach, through the same
  // adapter and idle gate as a delivery.
  async function notifyAll(report: string[]): Promise<void> {
    for (;;) {
      const next = commands(state).find(
        (c): c is Extract<Command, { type: "notify" }> =>
          c.type === "notify" && isServed(findTask(state, c.taskId)?.via ?? ""),
      );
      if (!next) break;
      const task = findTask(state, next.taskId);
      if (!task || task.via === null) break;
      const agentId = config.agents[task.via];
      if (!agentId) {
        report.push(`${task.id}: no agent configured for ${task.via}`);
        break;
      }
      // A repeat sends the first attempt's text under the same key.
      const text = findNotice(task, next.key)?.text ?? noticeText(task, next);
      const attempted = apply({
        type: "noticeAttempt",
        taskId: task.id,
        key: next.key,
        text,
      });
      report.push(attempted.message);
      if (!attempted.ok) break;
      const host = state.placements[task.via]?.host ?? "";
      let outcome: Awaited<ReturnType<Adapter["send"]>>;
      try {
        outcome = await (
          await adapterFor(host)
        ).send(agentId, `N/${task.id}/${next.key}`, text);
      } catch (error: unknown) {
        if (error instanceof RouterBug) throw error;
        report.push(
          `${task.id} notice ${next.key}: ${host} unreachable (${error instanceof Error ? error.message : String(error)})`,
        );
        outcome = "unknown";
      }
      const acked = apply({
        type: "noticeResult",
        taskId: task.id,
        key: next.key,
        outcome,
      });
      report.push(acked.message);
    }
    for (const task of state.tasks) {
      if (task.via === null || !isServed(task.via)) continue;
      for (const { key, why } of noticeWaits(state, task))
        report.push(
          `${task.id} notice ${key} waits: ${why.replaceAll("_", " ")}`,
        );
    }
  }

  // One Jev call per unaddressed request. The event carries what the core
  // needs plus confidence, usage and latency for tuning the threshold later.
  async function judgeAll(report: string[]): Promise<void> {
    const pending = commands(state).filter(
      (c): c is Extract<Command, { type: "judge" }> => c.type === "judge",
    );
    for (const c of pending) {
      if (!options.judge) {
        report.push(
          `${c.taskId} waits for a recipient: Jev is not configured (TYPESAFE_API_KEY).`,
        );
        continue;
      }
      const result = await options.judge(c.question);
      const outcome = apply(
        result.ok
          ? {
              type: "judged",
              taskId: c.taskId,
              choice: result.choice,
              probabilities: result.probabilities,
              model: result.model,
              confidence: result.confidence,
              usage: result.usage,
              ms: result.ms,
            }
          : { type: "judgeFailed", taskId: c.taskId, reason: result.reason },
      );
      report.push(
        `${outcome.message}${result.ok ? ` (confidence ${result.confidence ?? "?"}, ${result.ms} ms, ${result.model ?? "model unknown"})` : ""}`,
      );
    }
  }

  async function deliver(): Promise<string[]> {
    const report: string[] = [];
    await judgeAll(report);
    await observeAll(report);
    for (;;) {
      const work = commands(state);
      const next = work.find(
        (c): c is Extract<typeof c, { type: "deliver" }> =>
          c.type === "deliver" &&
          isServed(findDelivery(state, c.deliveryId)?.placement ?? ""),
      );
      if (!next) break;
      const delivery = findDelivery(state, next.deliveryId);
      if (!delivery) break;
      const agentId = config.agents[delivery.placement];
      if (!agentId) {
        report.push(
          `${delivery.id}: no agent configured for ${delivery.placement}`,
        );
        break;
      }
      const attempted = apply({ type: "attempt", deliveryId: delivery.id });
      report.push(attempted.message);
      if (!attempted.ok) break;
      if (options.crash === "after_attempt") process.exit(70);
      const key = `${delivery.id}/${next.messageId}`;
      let outcome: Awaited<ReturnType<Adapter["send"]>>;
      try {
        outcome = await (
          await adapterFor(delivery.host)
        ).send(agentId, key, envelope(delivery.taskId, delivery.id));
      } catch (error: unknown) {
        // A key conflict is the router contradicting its own record; stop
        // here with the send left "attempting" for the operator.
        if (error instanceof RouterBug) throw error;
        // The host could not be reached at all: nothing was sent.
        report.push(
          `${delivery.id}: ${delivery.host} unreachable (${error instanceof Error ? error.message : String(error)})`,
        );
        outcome = "unknown";
      }
      if (options.crash === "after_send") process.exit(71);
      const acked = apply({
        type: "adapterResult",
        deliveryId: delivery.id,
        messageId: next.messageId,
        outcome,
      });
      report.push(acked.message);
    }
    // Say why the rest waits, once per open delivery this router serves.
    for (const d of allDeliveries(state)) {
      if (!isServed(d.placement) || !findTask(state, d.taskId)) continue;
      const why = blockedReason(state, d);
      if (why && why !== "closed" && why !== "not_pending")
        report.push(`${d.id} waits: ${why.replaceAll("_", " ")}`);
    }
    await notifyAll(report);
    return report;
  }

  return {
    get state() {
      return state;
    },
    apply,
    deliver,
    waits: () => waitsOnSessions(state, isServed),
    async close() {
      try {
        await Promise.all([...adapters.values()].map((a) => a.close()));
      } finally {
        journal.release();
      }
    },
  };
}
