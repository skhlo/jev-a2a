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
} from "./core.ts";
import type { RouterConfig } from "./config.ts";
import { openJournal, type Entry } from "./journal.ts";
import { RouterBug, type Adapter } from "./paseo.ts";
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
  // Applies an event; appends it to the journal only when the core accepts it.
  apply(event: Event): Outcome;
  // Performs every deliverable command for this host, returning what happened.
  deliver(): Promise<string[]>;
  close(): Promise<void>;
};

export type ShellOptions = {
  // One adapter per host, created on first use.
  adapter: (endpoint: string) => Promise<Adapter>;
  // Asks Jev; null when Jev is not configured, so unaddressed requests wait.
  judge: ((question: JudgmentQuestion) => Promise<JudgeResult>) | null;
  now?: () => number;
  // Test hook for the crash-recovery acceptance: exit at a chosen point.
  crash?: "after_attempt" | "after_send" | undefined;
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

// A record that predates its first `configured` line was written under that
// configuration, not under today's: start from it, so the rules of the time
// hold for the whole record.
export function fold(config: RouterConfig, entries: Entry[]): State {
  const first = entries.find((e) => e.event.type === "configured")?.event;
  let state = initial(
    first ? validateConfig(first.config) : coreConfig(config),
  );
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
  const entries = journal.entries();
  try {
    state = fold(config, entries);
  } catch (error) {
    journal.release();
    throw error;
  }

  const apply = (event: Event): Outcome => {
    const next = reduce(state, event);
    const outcome = next.last;
    if (!outcome) throw new Error("reduce left no outcome");
    if (outcome.ok) {
      journal.append(event);
      state = next;
    }
    return outcome;
  };

  // The configuration in force is part of the record, so a replay uses the
  // rules that applied at the time. Record it first, and again whenever it
  // changes.
  if (
    !entries.some(({ event }) => event.type === "configured") ||
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

  // Placements this router serves: a configured agent on a configured host.
  const served = Object.entries(config.agents).filter(([key]) => {
    const host = state.placements[key]?.host;
    return host !== undefined && config.hosts[host] !== undefined;
  });
  const isServed = (placement: string): boolean =>
    served.some(([key]) => key === placement);

  async function observeAll(report: string[]): Promise<void> {
    for (const [key, agentId] of served) {
      const placement = state.placements[key];
      if (!placement) continue;
      let seen: Awaited<ReturnType<Adapter["observe"]>>;
      try {
        seen = await (await adapterFor(placement.host)).observe(agentId);
      } catch (error: unknown) {
        // Readiness is what this run saw; an earlier run's idle must not
        // carry over a failed look.
        apply({ type: "observe", placement: key, ready: false });
        report.push(
          `${key}: ${placement.host} unreachable (${error instanceof Error ? error.message : String(error)}); not ready`,
        );
        continue;
      }
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
    const { key, kind } = due;
    const placement = state.placements[task.via ?? ""];
    const command =
      config.hosts[placement?.host ?? ""]?.replyCommand ?? "router";
    const as = `--as ${placement?.session ?? "<session>"}`;
    const head = `[router ${task.id} ${key}]`;
    if (due.kind === "question") {
      const delivery = task.deliveries.find((d) => d.id === due.deliveryId);
      return `${head} ${delivery?.participant ?? task.recipient ?? "The recipient"} asks about your request. Answer with: ${command} answer ${as} --task ${task.id} --delivery ${due.deliveryId} --question ${due.questionId} --text "<answer>" (or --text-file <path>).\n\n${delivery?.question?.text ?? ""}`;
    }
    if (kind === "choose") {
      const routing =
        task.routing?.state === "needs_recipient" ? task.routing : null;
      const suggested = routing?.suggestions.length
        ? `; suggested ${routing.suggestions.join(", ")}`
        : "";
      return `${head} The router could not pick a recipient for your request (${(routing?.reason ?? "unknown").replaceAll("_", " ")}${suggested}). Choose with: ${command} choose ${as} --task ${task.id} --to <participant>, one of: ${task.permitted.join(", ")}.\n\n${task.text}`;
    }
    const words = task.deliveries
      .map((d) => {
        const end = d.end;
        if (!end) return `${d.participant}@${d.host}: no result`;
        return `${d.participant}@${d.host} ${end.reason}${end.text ? `:\n${end.text}` : ""}`;
      })
      .join("\n\n");
    return `${head} Your request is ${task.final?.status ?? "closed"}${task.final?.reason ? ` (${task.final.reason})` : ""}. No reply is needed.\n\n${words}`;
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
    async close() {
      try {
        await Promise.all([...adapters.values()].map((a) => a.close()));
      } finally {
        journal.release();
      }
    },
  };
}
