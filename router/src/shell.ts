// The imperative shell. One run: lock the journal, fold it into state, mark
// interrupted attempts unknown, move the clock, apply the caller's event,
// then perform the core's commands for placements on this host and record
// each result. Nothing survives a run except the journal.
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
import type { Event, Outcome, State } from "./types.ts";

export type Shell = {
  readonly state: State;
  // Applies an event; appends it to the journal only when the core accepts it.
  apply(event: Event): Outcome;
  // Performs every deliverable command for this host, returning what happened.
  deliver(): Promise<string[]>;
  close(): Promise<void>;
};

export type ShellOptions = {
  adapter: () => Promise<Adapter>;
  now?: () => number;
  // Test hook for the crash-recovery acceptance: exit at a chosen point.
  crash?: "after_attempt" | "after_send" | undefined;
  // Command the participant runs to reply; goes into the envelope verbatim.
  replyCommand?: string;
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
  const replyCommand = options.replyCommand ?? "router";
  let state: State;
  let adapter: Adapter | null = null;
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

  const local = Object.entries(config.agents).filter(
    ([key]) => state.placements[key]?.host === config.host,
  );

  async function observeAll(report: string[]): Promise<void> {
    if (!local.length) return;
    adapter ??= await options.adapter();
    for (const [key, agentId] of local) {
      const placement = state.placements[key];
      if (!placement) continue;
      const seen = await adapter.observe(agentId);
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
    const reply = `${replyCommand} reply --task ${taskId} --in-reply-to ${send.messageId} --kind completed --text "<result>"`;
    const head =
      send.kind === "answer"
        ? `[router ${taskId} ${send.messageId}] Answer to your question. When done, run: ${reply}`
        : `[router ${taskId} ${send.messageId}] Task from the router. When done, run: ${reply}`;
    return `${head} (use --kind question to ask the sender something, --kind working for progress, --kind failed if you cannot do it).\n\n${send.text}`;
  }

  async function deliver(): Promise<string[]> {
    const report: string[] = [];
    await observeAll(report);
    for (;;) {
      const work = commands(state);
      for (const c of work)
        if (c.type === "judge")
          report.push(
            `${c.taskId} has no recipient: Jev is not wired in this slice, submit with --to.`,
          );
      const next = work.find(
        (c): c is Extract<typeof c, { type: "deliver" }> =>
          c.type === "deliver" &&
          findDelivery(state, c.deliveryId)?.host === config.host,
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
      adapter ??= await options.adapter();
      const key = `${delivery.id}/${next.messageId}`;
      const outcome = await adapter.send(
        agentId,
        key,
        envelope(delivery.taskId, delivery.id),
      );
      if (options.crash === "after_send") process.exit(71);
      const acked = apply({
        type: "adapterResult",
        deliveryId: delivery.id,
        messageId: next.messageId,
        outcome,
      });
      report.push(acked.message);
    }
    // Say why the rest waits, once per open delivery on this host.
    for (const d of allDeliveries(state)) {
      if (d.host !== config.host || !findTask(state, d.taskId)) continue;
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
        await adapter?.close();
      } finally {
        journal.release();
      }
    },
  };
}
