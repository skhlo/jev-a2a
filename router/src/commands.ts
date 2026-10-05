// The router's command line: its options, and the commands that read or
// change the record. A mistake in the options is refused before the
// journal opens; the command then works through one shell, closed on every
// path.
import { parseArgs } from "node:util";
import { callerSession, type RouterConfig } from "./config.ts";
import {
  A2A_STATE,
  currentSend,
  findTask,
  needsYou,
  noticeWaits,
  UPDATE_KINDS,
} from "./core.ts";
import { describeNeed, newMessageId, taskLog } from "./board.ts";
import type { Shell } from "./shell.ts";
import { agentLine, readTelemetry } from "./telemetry.ts";
import { textOption } from "./text.ts";
import type { Event, Role, State, Task } from "./types.ts";

export const USAGE = `router: a prompt with an envelope and a record

  router submit [--to <participant> [--hosts a,b]] [--message <id>] [--as <principal>] (<text...> | --text-file <path>)
                                               without --to, Jev picks the recipient
  router choose --task <T> --to <participant> [--as <principal>]
                                               answer a needs_recipient
  router run                                   observe placements, deliver what is eligible
  router serve                                 accept events from other hosts over HTTP; serve the board
  router eval [--set <file>] [--model <id>] [--as <principal>]
                                               judge the labeled set with this config's texts; nothing recorded
  router usage                                 read the usage accounts once and print them (private data)
  router status [<task>]                       the record
  router needs-you [--as <principal|participant>]
                                               decisions waiting on a person, or owed to a participant sender
  router reply --task <T> --in-reply-to <M> --kind working|question|completed|failed [--text ... | --text-file <path>] [--message <id>]
  router answer --task <T> --question <Q> [--delivery <D>] (--text ... | --text-file <path>) [--message <id>] [--as <principal>]
  router observe <participant@host> --hold | --release
  router resolve --delivery <D> --message <M> --outcome finished|not_sent --evidence ... [--as <operator>]
  router cancel <task> [--as <principal>]

Options: --config <path> (default $ROUTER_CONFIG or ~/.config/jev-router/config.json).
A participant's reply is authenticated by its session (never --as):
$PASEO_AGENT_ID, or terminal:$PASEO_TERMINAL_ID in a Paseo terminal; over
HTTP, by $ROUTER_TOKEN from secrets.env. A participant session on this host
submits, chooses and answers with --as <its session id>.`;

const parse = (args: string[]) =>
  parseArgs({
    args,
    allowPositionals: true,
    options: {
      config: { type: "string" },
      set: { type: "string" },
      model: { type: "string" },
      to: { type: "string" },
      hosts: { type: "string" },
      message: { type: "string" },
      as: { type: "string" },
      task: { type: "string" },
      "in-reply-to": { type: "string" },
      kind: { type: "string" },
      text: { type: "string" },
      "text-file": { type: "string" },
      question: { type: "string" },
      delivery: { type: "string" },
      outcome: { type: "string" },
      evidence: { type: "string" },
      hold: { type: "boolean" },
      release: { type: "boolean" },
      help: { type: "boolean", short: "h" },
    },
  });

// What the caller asked for: the command, its options and the words after
// it, and the environment that says who is asking.
type Invocation = {
  command: string | undefined;
  values: ReturnType<typeof parse>["values"];
  rest: string[];
  env: Record<string, string | undefined>;
};

export function invocation(argv: string[], env: Invocation["env"]): Invocation {
  const { values, positionals } = parse(argv);
  const [command, ...rest] = positionals;
  return { command, values, rest, env };
}

// A mistake in what the caller asked: an option, or a task the record does
// not hold. cli.ts prints it and exits 2.
export class UsageError extends Error {
  override name = "UsageError";
}
function refuse(message: string): never {
  throw new UsageError(message);
}

// The principal the caller acts as: --as, $ROUTER_AS, or the first
// configured principal in the role.
export function actingAs(
  inv: Invocation,
  config: RouterConfig,
  role: Role,
): string {
  const chosen = inv.values.as ?? inv.env.ROUTER_AS;
  if (chosen) return chosen;
  const first = Object.entries(config.principals ?? {}).find(
    ([, r]) => r === role,
  );
  return (
    first?.[0] ??
    refuse(`No ${role} principal in the configuration; pass --as.`)
  );
}

// Where a command's lines go: the record to `out`, trouble reading the
// telemetry to `err`.
type Io = { out: (line: string) => void; err: (line: string) => void };

// A command once its options are checked: its work on the record, and the
// exit code.
type Work = (shell: Shell, io: Io) => Promise<number>;

// A command's arguments, read the way every command reads them.
const argsOf = (inv: Invocation, config: RouterConfig) => ({
  ...inv,
  config,
  as: (role: Role): string => actingAs(inv, config, role),
  need: (name: keyof Invocation["values"]): string => {
    const value = inv.values[name];
    return typeof value === "string" && value
      ? value
      : refuse(`--${name} is required.`);
  },
  text: (): string => {
    try {
      return textOption(inv.values.text, inv.values["text-file"]);
    } catch (error: unknown) {
      return refuse(error instanceof Error ? error.message : String(error));
    }
  },
});
type Args = ReturnType<typeof argsOf>;

const delivering: Work = async (shell, io) => {
  for (const line of await shell.deliver()) io.out(line);
  return 0;
};
// An event, then the deliveries it made possible; 1 when the core refuses
// it.
const recording =
  (event: Event): Work =>
  async (shell, io) => {
    const outcome = shell.apply(event);
    io.out(outcome.message);
    return outcome.ok ? delivering(shell, io) : 1;
  };

// `status <task>`: the task, its deliveries and its log.
const taskStatus =
  (id: string): Work =>
  async (shell, io) => {
    const task = findTask(shell.state, id) ?? refuse(`No task ${id}.`);
    for (const line of describe(task, shell.state)) io.out(line);
    return 0;
  };

// `status`: a line per task, then each configured placement with its
// telemetry.
const overview =
  (config: RouterConfig): Work =>
  async (shell, io) => {
    if (!shell.state.tasks.length) io.out("No tasks recorded.");
    for (const task of shell.state.tasks) io.out(oneLine(task));
    const telemetry = readTelemetry(config.home, io.err);
    for (const [key, p] of Object.entries(shell.state.placements))
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

const COMMANDS: Record<string, (o: Args) => Work> = {
  submit: (o) => {
    // The text is the remaining words or a file, not both.
    if (o.values["text-file"] !== undefined && o.rest.length)
      refuse("Pass the text as words or with --text-file, not both.");
    const text = (
      o.values["text-file"] === undefined ? o.rest.join(" ") : o.text()
    ).trim();
    if (!text) refuse("Give the request text after the options.");
    return recording({
      type: "submit",
      by: o.as("requester"),
      messageId: o.values.message ?? newMessageId(),
      text,
      to: o.values.to ?? null,
      hosts: o.values.hosts ? o.values.hosts.split(",") : null,
    });
  },
  choose: (o) =>
    recording({
      type: "choose",
      by: o.as("requester"),
      taskId: o.need("task"),
      to: o.need("to"),
    }),
  run: () => delivering,
  reply: (o) => {
    // A reply's identity is the session's own, never chosen by hand.
    const by =
      callerSession(o.env) ??
      refuse(
        "Replies come from a participant session: $PASEO_AGENT_ID and $PASEO_TERMINAL_ID are unset.",
      );
    const named = o.need("kind");
    const kind =
      UPDATE_KINDS.find((k) => k === named) ??
      refuse("--kind is working, question, completed or failed.");
    return recording({
      type: "update",
      by,
      taskId: o.need("task"),
      messageId: o.values.message ?? newMessageId(),
      inReplyTo: o.need("in-reply-to"),
      kind,
      text: o.text(),
    });
  },
  answer: (o) =>
    recording({
      type: "answer",
      by: o.as("requester"),
      taskId: o.need("task"),
      messageId: o.values.message ?? newMessageId(),
      questionId: o.need("question"),
      deliveryId: o.values.delivery ?? null,
      text: o.text() || refuse("An answer needs text that is not empty."),
    }),
  observe: (o) => {
    const placement =
      o.rest[0] || refuse("Name the placement, for example scratch@mbp.");
    if (o.values.hold === o.values.release) refuse("Pass --hold or --release.");
    return recording({
      type: "observe",
      placement,
      hold: o.values.hold === true,
    });
  },
  resolve: (o) => {
    const outcome = o.need("outcome");
    if (outcome !== "finished" && outcome !== "not_sent")
      refuse("--outcome is finished or not_sent.");
    return recording({
      type: "resolve",
      by: o.as("operator"),
      deliveryId: o.need("delivery"),
      messageId: o.need("message"),
      outcome,
      evidence: o.need("evidence"),
    });
  },
  cancel: (o) => {
    const taskId = o.rest[0] || refuse("Name the task.");
    return recording({ type: "cancel", by: o.as("requester"), taskId });
  },
  "needs-you": (o) => {
    const who = o.as("requester");
    return async (shell, io) => {
      const items = needsYou(shell.state, who);
      if (!items.length) io.out(`Nothing waits on ${who}.`);
      for (const item of items) io.out(describeNeed(item));
      return 0;
    };
  },
  status: (o) => (o.rest[0] ? taskStatus(o.rest[0]) : overview(o.config)),
};

// Runs a command that reads or changes the record; a mistake in what the
// caller asked throws a UsageError.
export async function runCommand(
  inv: Invocation,
  config: RouterConfig,
  open: () => Promise<Shell>,
  io: Io,
): Promise<number> {
  const name = inv.command ?? "";
  const command = Object.hasOwn(COMMANDS, name) ? COMMANDS[name] : undefined;
  if (!command) return refuse(`Unknown command ${name}.\n\n${USAGE}`);
  const work = command(argsOf(inv, config));
  const shell = await open();
  try {
    return await work(shell, io);
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
  for (const entry of taskLog(state.log, task.id))
    lines.push(`  ${entry.n}. ${entry.actor}: ${entry.text}`);
  return lines;
}
