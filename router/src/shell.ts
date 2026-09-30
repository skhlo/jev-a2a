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
  findTask,
  initial,
  reduce,
} from "./core.ts";
import type { RouterConfig } from "./config.ts";
import { openJournal, type Journal } from "./journal.ts";
import type { Adapter } from "./paseo.ts";
import type { Judgment } from "./jev.ts";
import type {
  Command,
  Event,
  JudgmentQuestion,
  Outcome,
  State,
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
  judge: ((question: JudgmentQuestion) => Promise<Judgment>) | null;
  now?: () => number;
  // Test hook for the crash-recovery acceptance: exit at a chosen point.
  crash?: "after_attempt" | "after_send" | undefined;
};

export function fold(config: RouterConfig, journal: Journal): State {
  let state = initial(config);
  for (const { event } of journal.entries()) {
    state = reduce(state, event as Event);
    if (!state.last?.ok)
      throw new Error(
        `Journal replay rejected ${JSON.stringify(event)}: ${state.last?.message}`,
      );
  }
  return state;
}

export function openShell(config: RouterConfig, options: ShellOptions): Shell {
  const journal = openJournal(config.home);
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
  try {
    state = fold(config, journal);
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

  // A send left "attempting" means the previous run died mid-send.
  if (
    allDeliveries(state).some((d) =>
      d.sends.some((s) => s.outcome === "attempting"),
    )
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
        report.push(
          `${key}: ${placement.host} unreachable (${error instanceof Error ? error.message : String(error)})`,
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
