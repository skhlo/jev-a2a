#!/usr/bin/env -S node --no-warnings
// The CLI is the shell: every command loads the journal, applies at most one
// event, performs the deliveries that became possible, and exits.
import { parseArgs } from "node:util";
import { homedir } from "node:os";
import { join } from "node:path";
import { createServer } from "node:http";
import { loadConfig, loadSecrets, type RouterConfig } from "./config.ts";
import {
  A2A_STATE,
  currentSend,
  findTask,
  needsYou,
  noticeWaits,
  responsibilityTexts,
} from "./core.ts";
import { describeNeed, newMessageId, taskLog } from "./board.ts";
import {
  sessionReader,
  bind,
  BindError,
  boardListener,
  eventsListener,
  type Run,
} from "./server.ts";
import { createPaseoAdapter } from "./paseo.ts";
import { judge } from "./jev.ts";
import {
  curve,
  evaluate,
  readSet,
  renderEval,
  unanswered,
  type Labeled,
} from "./eval.ts";
import { openShell, type Shell } from "./shell.ts";
import { textOption } from "./text.ts";
import type { Event, Role, State, Task } from "./types.ts";

const USAGE = `router: a prompt with an envelope and a record

  router submit [--to <participant>] [--hosts a,b] [--message <id>] [--as <principal>] (<text...> | --text-file <path>)
                                               without --to, Jev picks the recipient
  router choose --task <T> --to <participant> [--as <principal>]
                                               answer a needs_recipient
  router run                                   observe placements, deliver what is eligible
  router serve                                 accept events from other hosts over HTTP; serve the board
  router eval [--set <file>] [--model <id>] [--as <principal>]
                                               judge the labeled set with this config's texts; nothing recorded
  router status [<task>]                       the record
  router needs-you [--as <principal>]          decisions waiting on a person
  router reply --task <T> --in-reply-to <M> --kind working|question|completed|failed [--text ... | --text-file <path>] [--message <id>]
  router answer --task <T> --question <Q> [--delivery <D>] (--text ... | --text-file <path>) [--message <id>] [--as <principal>]
  router observe <participant@host> --hold | --release
  router resolve --delivery <D> --message <M> --outcome finished|not_sent --evidence ... [--as <operator>]
  router cancel <task> [--as <principal>]

Options: --config <path> (default $ROUTER_CONFIG or ~/.config/jev-router/config.json).
A participant's reply is authenticated by $PASEO_AGENT_ID (never --as); over
HTTP, by $ROUTER_TOKEN from secrets.env. A participant session on this host
submits, chooses and answers with --as <its session id>.`;

const { values, positionals } = parseArgs({
  args: process.argv.slice(2),
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

const [command, ...rest] = positionals;
if (values.help || !command) {
  console.log(USAGE);
  process.exit(command ? 0 : 2);
}

const configPath =
  values.config ??
  process.env.ROUTER_CONFIG ??
  join(homedir(), ".config", "jev-router", "config.json");
const config = loadConfig(configPath);
loadSecrets(join(configPath, "..", "secrets.env"));

// The principal the caller acts as: --as, $ROUTER_AS, or the first
// configured principal in the needed role.
const principalIn = (role: Role): string => {
  const chosen = values.as ?? process.env.ROUTER_AS;
  if (chosen) return chosen;
  const first = Object.entries(config.principals ?? {}).find(
    ([, r]) => r === role,
  );
  if (!first) fail(`No ${role} principal in the configuration; pass --as.`);
  return first[0];
};
const requester = (): string => principalIn("requester");
const operator = (): string => principalIn("operator");
const need = (name: keyof typeof values): string => {
  const value = values[name];
  if (typeof value !== "string" || !value) fail(`--${name} is required.`);
  return value;
};
const textArg = (): string => {
  try {
    return textOption(values.text, values["text-file"]);
  } catch (error: unknown) {
    fail(error instanceof Error ? error.message : String(error));
  }
};

function fail(message: string): never {
  console.error(message);
  process.exit(2);
}

const crash = process.env.ROUTER_CRASH;
const apiKey = process.env.TYPESAFE_API_KEY;
const open = (): Promise<Shell> =>
  openShell(config, {
    adapter: createPaseoAdapter,
    judge: apiKey
      ? (question) => judge(question, { ...config.jev, apiKey })
      : null,
    crash:
      crash === "after_attempt" || crash === "after_send" ? crash : undefined,
  });

if (command === "serve") {
  await serve(config);
} else if (command === "eval") {
  await evaluateSet(config);
} else {
  const shell = await open();
  let exitCode = 0;
  try {
    exitCode = await main(shell, config);
  } finally {
    await shell.close();
  }
  process.exit(exitCode);
}

// `router serve`: replies and answers from other hosts, and the board. Each
// event is one shell run, and runs are handled one at a time so the journal
// lock is never contended from inside the server.
async function serve(config: RouterConfig): Promise<void> {
  const token = process.env.ROUTER_TOKEN;
  if (!token) fail("ROUTER_TOKEN is not set; add it to secrets.env.");
  let queue: Promise<unknown> = Promise.resolve();
  const handle = (event: Event): Promise<Run> => {
    const run = queue.then(async () => {
      const shell = await open();
      try {
        const outcome = shell.apply(event);
        const report = outcome.ok ? await shell.deliver() : [];
        return { outcome, report };
      } finally {
        await shell.close();
      }
    });
    queue = run.catch(() => undefined);
    return run;
  };
  const deps = {
    config,
    handle,
    sessionOf: sessionReader(config),
    log: (line: string) => console.log(line),
  };
  const events = createServer(eventsListener(deps, token));
  const board = createServer(boardListener(deps));
  // A permanent failure exits 2 and the service unit does not restart it; an
  // address that has not appeared yet exits 75 (EX_TEMPFAIL) and it does.
  try {
    await bind(events, config.serve.listen, "events", deps);
    await bind(board, config.serve.board, "board", deps);
  } catch (error: unknown) {
    if (!(error instanceof BindError)) throw error;
    console.error(error.message);
    process.exit(error.transient ? 75 : 2);
  }
  console.log(`router serve listening on http://${config.serve.listen}`);
  console.log(`router board on http://${config.serve.board}`);
  await new Promise<void>((resolve) => {
    const stop = (): void => {
      board.close();
      events.close(() => resolve());
    };
    process.once("SIGINT", stop);
    process.once("SIGTERM", stop);
  });
}

// `router eval`: the labeled set against this config's responsibility texts,
// as the requester would be routed. Jev is asked; the journal is not opened.
async function evaluateSet(config: RouterConfig): Promise<void> {
  if (!apiKey) fail("TYPESAFE_API_KEY is not set; add it to secrets.env.");
  const sender = requester();
  const permitted = config.permissions?.[sender] ?? [];
  if (!permitted.length) fail(`${sender} may address nobody.`);
  const responsibilities = responsibilityTexts(config.participants, permitted);
  const path =
    values.set ?? join(import.meta.dirname, "..", "eval", "requests.jsonl");
  let set: Labeled[];
  try {
    set = readSet(path, [...permitted, "none"]);
  } catch (error: unknown) {
    fail(`${path}: ${error instanceof Error ? error.message : String(error)}`);
  }
  const model = values.model ?? config.jev.model;
  const verdicts = await evaluate(set, responsibilities, (question) =>
    judge(question, { ...config.jev, model, apiKey }),
  );
  for (const line of renderEval(verdicts, curve(verdicts), model))
    console.log(line);
  // Unanswered requests read as hand-backs in the curve; do not pass for a
  // clean run.
  if (unanswered(verdicts)) process.exit(1);
}

async function main(shell: Shell, config: RouterConfig): Promise<number> {
  const say = (lines: string[]): void => {
    for (const line of lines) console.log(line);
  };
  const applyAndDeliver = async (event: Event): Promise<number> => {
    const outcome = shell.apply(event);
    console.log(outcome.message);
    if (!outcome.ok) return 1;
    say(await shell.deliver());
    return 0;
  };

  switch (command) {
    case "submit": {
      // The text is the remaining words or a file, not both.
      if (values["text-file"] !== undefined && rest.length)
        fail("Pass the text as words or with --text-file, not both.");
      const text = (
        values["text-file"] === undefined ? rest.join(" ") : textArg()
      ).trim();
      if (!text) fail("Give the request text after the options.");
      const event: Event = {
        type: "submit",
        by: requester(),
        messageId: values.message ?? newMessageId(),
        text,
        to: values.to ?? null,
        hosts: values.hosts ? values.hosts.split(",") : null,
      };
      return applyAndDeliver(event);
    }
    case "choose":
      return applyAndDeliver({
        type: "choose",
        by: requester(),
        taskId: need("task"),
        to: need("to"),
      });
    case "run":
      say(await shell.deliver());
      return 0;
    case "reply": {
      // A reply's identity is the session's own, never chosen by hand.
      const by = process.env.PASEO_AGENT_ID;
      if (!by)
        fail(
          "Replies come from a participant session: $PASEO_AGENT_ID is unset.",
        );
      const kind = need("kind");
      if (!["working", "question", "completed", "failed"].includes(kind))
        fail("--kind is working, question, completed or failed.");
      return applyAndDeliver({
        type: "update",
        by,
        taskId: need("task"),
        messageId: values.message ?? newMessageId(),
        inReplyTo: need("in-reply-to"),
        kind: kind as "working" | "question" | "completed" | "failed",
        text: textArg(),
      });
    }
    case "answer":
      return applyAndDeliver({
        type: "answer",
        by: requester(),
        taskId: need("task"),
        messageId: values.message ?? newMessageId(),
        questionId: need("question"),
        deliveryId: values.delivery ?? null,
        text: textArg() || fail("An answer needs text that is not empty."),
      });
    case "observe": {
      const placement = rest[0];
      if (!placement) fail("Name the placement, for example scratch@mbp.");
      if (values.hold === values.release) fail("Pass --hold or --release.");
      return applyAndDeliver({
        type: "observe",
        placement,
        hold: values.hold === true,
      });
    }
    case "resolve": {
      const outcome = need("outcome");
      if (outcome !== "finished" && outcome !== "not_sent")
        fail("--outcome is finished or not_sent.");
      return applyAndDeliver({
        type: "resolve",
        by: operator(),
        deliveryId: need("delivery"),
        messageId: need("message"),
        outcome,
        evidence: need("evidence"),
      });
    }
    case "cancel": {
      const taskId = rest[0];
      if (!taskId) fail("Name the task.");
      return applyAndDeliver({ type: "cancel", by: requester(), taskId });
    }
    case "needs-you": {
      const who = values.as ?? process.env.ROUTER_AS ?? requester();
      const items = needsYou(shell.state, who);
      if (!items.length) console.log(`Nothing waits on ${who}.`);
      for (const item of items) console.log(describeNeed(item));
      return 0;
    }
    case "status": {
      const id = rest[0];
      if (id) {
        const task = findTask(shell.state, id);
        if (!task) fail(`No task ${id}.`);
        say(describe(task, shell.state));
      } else {
        if (!shell.state.tasks.length) console.log("No tasks recorded.");
        for (const task of shell.state.tasks) console.log(oneLine(task));
        for (const [key, p] of Object.entries(shell.state.placements))
          if (config.agents[key])
            console.log(
              `${key}: ${p.ready ? "ready" : "not ready"}${p.hold ? ", held" : ""} · session ${p.session}`,
            );
      }
      return 0;
    }
    default:
      fail(`Unknown command ${command}.\n\n${USAGE}`);
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
