#!/usr/bin/env -S node --no-warnings
// The CLI is the shell: every command loads the journal, applies at most one
// event, performs the deliveries that became possible, and exits.
import { parseArgs } from "node:util";
import { homedir } from "node:os";
import { join } from "node:path";
import { randomBytes } from "node:crypto";
import { loadConfig, type RouterConfig } from "./config.ts";
import { A2A_STATE, currentSend, findTask, needsYou } from "./core.ts";
import { createPaseoAdapter } from "./paseo.ts";
import { openShell, type Shell } from "./shell.ts";
import type { Event, State, Task } from "./types.ts";

const USAGE = `router: a prompt with an envelope and a record

  router submit --to <participant> [--hosts a,b] [--message <id>] [--as <principal>] <text...>
  router run                                   observe placements, deliver what is eligible
  router status [<task>]                       the record
  router needs-you [--as <principal>]          decisions waiting on a person
  router reply --task <T> --in-reply-to <M> --kind working|question|completed|failed [--text ...] [--message <id>]
  router answer --task <T> --question <Q> --text ... [--message <id>] [--as <principal>]
  router observe <participant@host> --hold | --release
  router resolve --delivery <D> --message <M> --outcome finished|not_sent --evidence ... [--as <operator>]
  router cancel <task> [--as <principal>]

Options: --config <path> (default $ROUTER_CONFIG or ~/.config/jev-router/config.json).
A participant's reply is authenticated by $PASEO_AGENT_ID.`;

const { values, positionals } = parseArgs({
  args: process.argv.slice(2),
  allowPositionals: true,
  options: {
    config: { type: "string" },
    to: { type: "string" },
    hosts: { type: "string" },
    message: { type: "string" },
    as: { type: "string" },
    task: { type: "string" },
    "in-reply-to": { type: "string" },
    kind: { type: "string" },
    text: { type: "string" },
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

const requester = (): string => {
  const chosen = values.as ?? process.env.ROUTER_AS;
  if (chosen) return chosen;
  const first = Object.entries(config.principals ?? {}).find(
    ([, role]) => role === "requester",
  );
  if (!first) fail("No requester principal in the configuration; pass --as.");
  return first[0];
};
const operator = (): string => {
  const chosen = values.as ?? process.env.ROUTER_AS;
  if (chosen) return chosen;
  const first = Object.entries(config.principals ?? {}).find(
    ([, role]) => role === "operator",
  );
  if (!first) fail("No operator principal in the configuration; pass --as.");
  return first[0];
};
const need = (name: keyof typeof values): string => {
  const value = values[name];
  if (typeof value !== "string" || !value) fail(`--${name} is required.`);
  return value;
};
const newMessageId = (): string =>
  `m-${Date.now().toString(36)}-${randomBytes(3).toString("hex")}`;

function fail(message: string): never {
  console.error(message);
  process.exit(2);
}

const crash = process.env.ROUTER_CRASH;
const shell = openShell(config, {
  adapter: () => createPaseoAdapter(config.paseo.url),
  crash:
    crash === "after_attempt" || crash === "after_send" ? crash : undefined,
  replyCommand: process.env.ROUTER_REPLY_COMMAND ?? "router",
});

let exitCode = 0;
try {
  exitCode = await main(shell, config);
} finally {
  await shell.close();
}
process.exit(exitCode);

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
      const text = rest.join(" ").trim();
      if (!text) fail("Give the request text after the options.");
      if (!values.to)
        fail(
          "This slice delivers addressed requests only: pass --to <participant>.",
        );
      const event: Event = {
        type: "submit",
        by: requester(),
        messageId: values.message ?? newMessageId(),
        text,
        to: values.to,
        hosts: values.hosts ? values.hosts.split(",") : null,
      };
      return applyAndDeliver(event);
    }
    case "run":
      say(await shell.deliver());
      return 0;
    case "reply": {
      const by = process.env.PASEO_AGENT_ID ?? values.as;
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
        text: values.text ?? "",
      });
    }
    case "answer":
      return applyAndDeliver({
        type: "answer",
        by: requester(),
        taskId: need("task"),
        messageId: values.message ?? newMessageId(),
        questionId: need("question"),
        text: need("text"),
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
      for (const item of items)
        console.log(
          item.kind === "choose"
            ? `${item.taskId}: choose a recipient (${item.reason}${item.suggestions.length ? `; suggested ${item.suggestions.join(", ")}` : ""})`
            : item.kind === "answer"
              ? `${item.taskId}: answer ${item.questionId} "${item.text}"`
              : `${item.deliveryId}: resolve ${item.messageId} (${item.reason})`,
        );
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
          if (p.host === config.host)
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
  const recent = state.log.filter((entry) => entry.text.includes(task.id));
  for (const entry of recent.slice(-8))
    lines.push(`  ${entry.n}. ${entry.actor}: ${entry.text}`);
  return lines;
}
