#!/usr/bin/env -S node --no-warnings
// The `router` command on every host. With a configuration this is the
// router host, and router-host.ts runs. Without one, a reply host sends
// reply, submit, answer and choose to the router at $ROUTER_URL
// (reply-host.ts). The choice comes first, so a reply host loads nothing
// that needs a package.
import { existsSync } from "node:fs";
import { join } from "node:path";
import { configPathOf, loadSecrets } from "./config.ts";
import { runReplyHost } from "./reply-host.ts";
import { invocation, USAGE, UsageError } from "./request.ts";

const inv = invocation(process.argv.slice(2), process.env);
if (inv.values.help || !inv.command) {
  console.log(USAGE);
  process.exit(inv.command ? 0 : 2);
}

const configPath = configPathOf(inv.values.config, process.env);
if (existsSync(configPath)) await import("./router-host.ts");
else {
  const secrets = join(configPath, "..", "secrets.env");
  loadSecrets(secrets);
  const url = process.env.ROUTER_URL;
  const token = process.env.ROUTER_TOKEN;
  if (!url || !token) {
    console.error(
      `No configuration at ${configPath}, and no ROUTER_URL and ROUTER_TOKEN (in the environment or ${secrets}) to reach the router from this host.`,
    );
    process.exit(2);
  }
  try {
    process.exit(
      await runReplyHost(inv, url, token, {
        out: (line) => console.log(line),
        err: (line) => console.error(line),
      }),
    );
  } catch (error: unknown) {
    if (!(error instanceof UsageError)) throw error;
    console.error(error.message);
    process.exit(2);
  }
}
