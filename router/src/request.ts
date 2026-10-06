// What a caller asks the router on the command line: the options, and the
// event each recording command stands for. It loads node's own modules,
// the core and the configuration's helpers, nothing that needs a package,
// so a reply host runs it from a checkout without an install.
import { randomBytes } from "node:crypto";
import { parseArgs } from "node:util";
import { callerSession } from "./config.ts";
import { UPDATE_KINDS } from "./core.ts";
import { textOption } from "./text.ts";
import type { Event, Role } from "./types.ts";

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
  router host setup <host>                     install or update router on a host the router reaches over ssh, with its token, and check it
  router check                                 on a host without a configuration: the router answers, takes this host's token, runs this commit
  router roster repoint <participant@host> <session>
                                               point a placement at a new Paseo session (agent id or terminal:<id>), restart serve, see it bound
  router roster add <participant> <host>:<path> <host>=<session>...
                                               add a participant, its text from the file's ## <participant> section on its repository's
                                               main branch, a placement per host, grants all to all; eval, restart serve, see them bound
  router roster remove <participant>           drop a participant, its grants and placements; its labeled requests expect none; eval, restart
  router roster refresh <participant> [<host>:<path>]
                                               read its text again from where it came from, or the file named; a new text: eval, restart serve
                                               (add, remove and refresh take --set <file> for a labeled set other than the bundled one)

Options: --config <path> (default $ROUTER_CONFIG or ~/.config/jev-router/config.json).
A participant's reply is authenticated by its session (never --as):
$PASEO_AGENT_ID, or terminal:$PASEO_TERMINAL_ID in a Paseo terminal. A
participant session on the router host submits, chooses and answers with
--as <its session id>. On a host without a configuration, reply, submit,
answer and choose go to the router at $ROUTER_URL as the session itself,
with $ROUTER_TOKEN, and check checks them; both are read from secrets.env
beside the configuration's path.`;

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
export type Invocation = {
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

// Where a command's lines go: what it reports to `out`, trouble to `err`.
export type Io = { out: (line: string) => void; err: (line: string) => void };

// A mistake in what the caller asked: an option, or a task the record does
// not hold. The command prints it and exits 2.
export class UsageError extends Error {
  override name = "UsageError";
}
export function refuse(message: string): never {
  throw new UsageError(message);
}

// Message ids the router mints: time-ordered, unique enough.
export const newMessageId = (): string =>
  `m-${Date.now().toString(36)}-${randomBytes(3).toString("hex")}`;

// A command's arguments, read the way every command reads them. `as` names
// whom the caller acts as in a role: on the router host a principal, on a
// reply host the participant session.
export const argsOf = (inv: Invocation, as: (role: Role) => string) => ({
  ...inv,
  as,
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
export type Args = ReturnType<typeof argsOf>;

// The event each recording command stands for.
export const EVENTS: Record<string, (o: Args) => Event> = {
  submit: (o) => {
    // The text is the remaining words or a file, not both, and never --text.
    if (o.values.text !== undefined)
      refuse(
        "A request takes its text as words or with --text-file, not --text.",
      );
    if (o.values["text-file"] !== undefined && o.rest.length)
      refuse("Pass the text as words or with --text-file, not both.");
    const text = (
      o.values["text-file"] === undefined ? o.rest.join(" ") : o.text()
    ).trim();
    if (!text) refuse("Give the request text after the options.");
    return {
      type: "submit",
      by: o.as("requester"),
      messageId: o.values.message ?? newMessageId(),
      text,
      to: o.values.to ?? null,
      hosts: o.values.hosts ? o.values.hosts.split(",") : null,
    };
  },
  choose: (o) => ({
    type: "choose",
    by: o.as("requester"),
    taskId: o.need("task"),
    to: o.need("to"),
  }),
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
    return {
      type: "update",
      by,
      taskId: o.need("task"),
      messageId: o.values.message ?? newMessageId(),
      inReplyTo: o.need("in-reply-to"),
      kind,
      text: o.text(),
    };
  },
  answer: (o) => ({
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
    return { type: "observe", placement, hold: o.values.hold === true };
  },
  resolve: (o) => {
    const outcome = o.need("outcome");
    if (outcome !== "finished" && outcome !== "not_sent")
      refuse("--outcome is finished or not_sent.");
    return {
      type: "resolve",
      by: o.as("operator"),
      deliveryId: o.need("delivery"),
      messageId: o.need("message"),
      outcome,
      evidence: o.need("evidence"),
    };
  },
  cancel: (o) => {
    const taskId = o.rest[0] || refuse("Name the task.");
    return { type: "cancel", by: o.as("requester"), taskId };
  },
};
