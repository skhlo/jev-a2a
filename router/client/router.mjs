#!/usr/bin/env node
// Thin router client for a host that does not run the router: the CLI's
// `reply`, `submit`, `answer` and `choose` syntax, posted to `router serve`
// over the tailnet as the participant session $PASEO_AGENT_ID. Reads
// ROUTER_URL and ROUTER_TOKEN from the environment or from
// ~/.config/jev-router/secrets.env. No dependencies.
import { readFileSync } from "node:fs";
import { homedir } from "node:os";
import { join } from "node:path";
import { parseArgs } from "node:util";

const secrets = join(homedir(), ".config", "jev-router", "secrets.env");
try {
  for (const line of readFileSync(secrets, "utf8").split("\n")) {
    const t = line.trim();
    const eq = t.indexOf("=");
    if (!t || t.startsWith("#") || eq <= 0) continue;
    const key = t.slice(0, eq).trim();
    const value = t.slice(eq + 1).trim();
    if (value && process.env[key] === undefined) process.env[key] = value;
  }
} catch {
  // No secrets file: the environment must carry the values.
}

const USAGE = `This host's router client supports:
  router reply --task T --in-reply-to M --kind K (--text ... | --text-file <path>)
  router submit [--to <participant>] [--hosts a,b] [--message <id>] (<text...> | --text-file <path>)
  router answer --task T --question Q [--delivery D] (--text ... | --text-file <path>) [--message <id>]
  router choose --task T --to <participant>
Every command acts as the participant session $PASEO_AGENT_ID.`;

const { values, positionals } = parseArgs({
  args: process.argv.slice(2),
  allowPositionals: true,
  options: {
    task: { type: "string" },
    "in-reply-to": { type: "string" },
    kind: { type: "string" },
    text: { type: "string" },
    "text-file": { type: "string" },
    message: { type: "string" },
    to: { type: "string" },
    hosts: { type: "string" },
    question: { type: "string" },
    delivery: { type: "string" },
    // Named in the router's notices for the CLI on the router host; here
    // the session is always $PASEO_AGENT_ID.
    as: { type: "string" },
  },
});

const fail = (message) => {
  console.error(message);
  process.exit(2);
};
const url = process.env.ROUTER_URL;
const token = process.env.ROUTER_TOKEN;
if (!url || !token)
  fail(`ROUTER_URL and ROUTER_TOKEN are required (see ${secrets}).`);

const [command, ...rest] = positionals;
if (!["reply", "submit", "answer", "choose"].includes(command)) fail(USAGE);
const by = process.env.PASEO_AGENT_ID;
if (!by)
  fail("The client acts as a participant session: $PASEO_AGENT_ID is unset.");
const required = (...keys) => {
  for (const key of keys) if (!values[key]) fail(`--${key} is required.`);
};

// --text-file carries text that a shell cannot quote in one argument; a
// submit may also take its text as the remaining arguments.
const textOf = (positional = []) => {
  let text = values.text ?? (positional.length ? positional.join(" ") : "");
  if (values["text-file"] !== undefined) {
    if (values.text !== undefined || positional.length)
      fail("Pass --text or --text-file, not both (nor text arguments).");
    try {
      text = readFileSync(values["text-file"], "utf8").trimEnd();
    } catch (error) {
      fail(`--text-file: ${error instanceof Error ? error.message : error}`);
    }
  }
  return text;
};
const messageId = () =>
  values.message ??
  `m-${Date.now().toString(36)}-${Math.random().toString(16).slice(2, 8)}`;

let event;
switch (command) {
  case "reply":
    required("task", "in-reply-to", "kind");
    event = {
      type: "update",
      by,
      taskId: values.task,
      messageId: messageId(),
      inReplyTo: values["in-reply-to"],
      kind: values.kind,
      text: textOf(),
    };
    break;
  case "submit": {
    const text = textOf(rest);
    if (!text) fail("A request needs text.");
    event = {
      type: "submit",
      by,
      messageId: messageId(),
      text,
      to: values.to ?? null,
      hosts: values.hosts ? values.hosts.split(",").filter(Boolean) : null,
    };
    break;
  }
  case "answer":
    required("task", "question");
    event = {
      type: "answer",
      by,
      taskId: values.task,
      messageId: messageId(),
      questionId: values.question,
      deliveryId: values.delivery ?? null,
      text: textOf(),
    };
    break;
  case "choose":
    required("task", "to");
    event = { type: "choose", by, taskId: values.task, to: values.to };
    break;
}

const response = await fetch(new URL("/events", url), {
  method: "POST",
  headers: {
    authorization: `Bearer ${token}`,
    "content-type": "application/json",
  },
  body: JSON.stringify(event),
});
const body = await response.json().catch(() => ({}));
console.log(body.message ?? JSON.stringify(body));
for (const line of body.report ?? []) console.log(line);
process.exit(response.ok && body.ok ? 0 : 1);
