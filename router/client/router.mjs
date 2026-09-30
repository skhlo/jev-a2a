#!/usr/bin/env node
// Thin router client for a host that does not run the router: the same
// `router reply` syntax as the CLI, posted to `router serve` over the tailnet.
// Reads ROUTER_URL and ROUTER_TOKEN from the environment or from
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

const { values, positionals } = parseArgs({
  args: process.argv.slice(2),
  allowPositionals: true,
  options: {
    task: { type: "string" },
    "in-reply-to": { type: "string" },
    kind: { type: "string" },
    text: { type: "string" },
    message: { type: "string" },
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

const [command] = positionals;
if (command !== "reply")
  fail(
    "This host's router client supports: router reply --task T --in-reply-to M --kind K [--text ...]",
  );
const by = process.env.PASEO_AGENT_ID;
if (!by)
  fail("Replies come from a participant session: $PASEO_AGENT_ID is unset.");
for (const key of ["task", "in-reply-to", "kind"])
  if (!values[key]) fail(`--${key} is required.`);

const event = {
  type: "update",
  by,
  taskId: values.task,
  messageId:
    values.message ??
    `m-${Date.now().toString(36)}-${Math.random().toString(16).slice(2, 8)}`,
  inReplyTo: values["in-reply-to"],
  kind: values.kind,
  text: values.text ?? "",
};

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
