// The router host's commands on the record: what reads it, and the
// recording commands applied through one shell, closed on every path. A
// mistake in the options is refused before the journal opens.
import { firstPrincipal, type RouterConfig } from "./config.ts";
import {
  A2A_STATE,
  currentSend,
  findTask,
  needsYou,
  noticeWaits,
  own,
  taskLog,
} from "./core.ts";
import { boardState, describeNeed } from "./board.ts";
import { readJournal } from "./journal.ts";
import {
  argsOf,
  EVENTS,
  refuse,
  USAGE,
  type Args,
  type Invocation,
  type Io,
} from "./request.ts";
import type { Shell } from "./shell.ts";
import { agentLine, readTelemetry } from "./telemetry.ts";
import type { Event, Role, State, Task } from "./types.ts";

// The principal the caller acts as: --as, $ROUTER_AS, or the first
// configured principal in the role.
export function actingAs(
  inv: Invocation,
  config: RouterConfig,
  role: Role,
): string {
  const chosen = inv.values.as ?? inv.env.ROUTER_AS;
  if (chosen) return chosen;
  return (
    firstPrincipal(config, role) ??
    refuse(`No ${role} principal in the configuration; pass --as.`)
  );
}

// A command once its options are checked: its work on the record, and the
// exit code. A reading reads the record as of now without the lock and
// records nothing, so it never waits for a run to end; the rest work
// through one shell.
type Writing = (shell: Shell, io: Io) => Promise<number>;
type Reading = (state: State, io: Io) => number;
type Work = { writes: Writing } | { reads: Reading };

const delivering: Writing = async (shell, io) => {
  for (const line of await shell.deliver()) io.out(line);
  return 0;
};
// An event, then the deliveries it made possible; 1 when the core refuses
// it.
const recording =
  (event: Event): Writing =>
  async (shell, io) => {
    const outcome = shell.apply(event);
    io.out(outcome.message);
    return outcome.ok ? delivering(shell, io) : 1;
  };

// `status <task>`: the task, its deliveries and its log.
const taskStatus =
  (id: string): Reading =>
  (state, io) => {
    const task = findTask(state, id) ?? refuse(`No task ${id}.`);
    for (const line of describe(task, state)) io.out(line);
    return 0;
  };

// `status`: a line per task, then each configured placement with its
// telemetry.
const overview =
  (config: RouterConfig): Reading =>
  (state, io) => {
    if (!state.tasks.length) io.out("No tasks recorded.");
    for (const task of state.tasks) io.out(oneLine(task));
    const telemetry = readTelemetry(config.home, io.err);
    for (const [key, p] of Object.entries(state.placements))
      if (config.agents[key]) {
        io.out(
          `${key}: ${p.ready ? "ready" : "not ready"}${p.hold ? ", held" : ""} · session ${p.session}`,
        );
        const agent = telemetry?.placements[key];
        if (agent) io.out(`  ${agentLine(agent)}`);
      }
    if (telemetry) io.out(`telemetry at ${telemetry.at}`);
    return 0;
  };

// The commands that read the record or deliver; the recording ones are
// request.ts's EVENTS.
const COMMANDS: Record<string, (o: Args, config: RouterConfig) => Work> = {
  run: () => ({ writes: delivering }),
  "needs-you": (o) => {
    const who = o.as("requester");
    return {
      reads: (state, io) => {
        const items = needsYou(state, who);
        if (!items.length) io.out(`Nothing waits on ${who}.`);
        for (const item of items) io.out(describeNeed(item));
        return 0;
      },
    };
  },
  status: (o, config) => ({
    reads: o.rest[0] ? taskStatus(o.rest[0]) : overview(config),
  }),
};

// Runs a command that reads or changes the record: a reading reads the
// journal as of now, a change goes through the shell `open` gives. A
// mistake in what the caller asked throws a UsageError.
export async function runCommand(
  inv: Invocation,
  config: RouterConfig,
  open: () => Promise<Shell>,
  io: Io,
): Promise<number> {
  const name = inv.command ?? "";
  const o = argsOf(inv, (role) => actingAs(inv, config, role));
  const event = own(EVENTS, name);
  const command = own(COMMANDS, name);
  const work: Work = event
    ? { writes: recording(event(o)) }
    : command
      ? command(o, config)
      : refuse(`Unknown command ${name}.\n\n${USAGE}`);
  if ("reads" in work)
    return work.reads(
      boardState(config, readJournal(config.home), Date.now()),
      io,
    );
  const shell = await open();
  try {
    return await work.writes(shell, io);
  } finally {
    await shell.close();
  }
}

function oneLine(task: Task): string {
  return `${task.id} ${task.status} · ${task.source}/${task.messageId} → ${task.recipient ?? "?"} · ${task.text.slice(0, 60)}`;
}

function describe(task: Task, state: State): string[] {
  const lines = [
    oneLine(task),
    `  A2A ${A2A_STATE[task.status]}${task.final ? ` · ${task.final.completed} of ${task.final.of} completed${task.final.reason ? ` · ${task.final.reason}` : ""}` : ""}`,
  ];
  for (const d of task.deliveries) {
    const send = currentSend(d);
    lines.push(
      `  ${d.id} ${d.placement} · session ${d.session ?? "unpinned"} · ${send.kind} ${send.messageId} ${send.outcome}${d.end ? ` · ended ${d.end.reason}` : ""}`,
    );
    if (d.question)
      lines.push(`    question ${d.question.id}: ${d.question.text}`);
    for (const u of d.updates)
      lines.push(`    ${u.kind} ${u.messageId} ↩ ${u.inReplyTo}: ${u.text}`);
  }
  // What a participant sender was told, and what it is still owed.
  if (task.via !== null) {
    for (const n of task.notices)
      lines.push(
        `  notice ${n.key} → ${task.via} · session ${n.session ?? "none"} · ${n.outcome}`,
      );
    for (const { key, why } of noticeWaits(state, task))
      lines.push(`  notice ${key} waits: ${why.replaceAll("_", " ")}`);
  }
  for (const entry of taskLog(state, task.id))
    lines.push(`  ${entry.n}. ${entry.actor}: ${entry.text}`);
  return lines;
}
