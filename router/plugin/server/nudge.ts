// When an agent's turn ends on this daemon, the plugin asks serve for a run
// now (POST /nudge on the board's address), so a delivery or a notice
// waiting for that session goes out at once instead of at the next look,
// up to serve.wake seconds later. Serve decides whether anything waits;
// the plugin only says when to look.
import { readFileSync } from "node:fs";
import { homedir } from "node:os";
import { join } from "node:path";

// What the plugin uses of Paseo's PluginServerContext, so it typechecks
// without the SDK package.
export type Hooks = {
  on(
    name: "agent.turn_ended",
    callback: (
      event: unknown,
      context: { signal: AbortSignal },
    ) => Promise<void>,
  ): unknown;
};

const isRecord = (value: unknown): value is Record<string, unknown> =>
  value !== null && typeof value === "object" && !Array.isArray(value);

// serve.board from the router's configuration, as src/config.ts reads it:
// --config is the CLI's, so $ROUTER_CONFIG or the default path, and
// 127.0.0.1:7678 when unset. A plugin cannot import the router's modules
// (Paseo compiles only its own directory), so a test holds the two to the
// same answer. Read on each nudge, so a changed address needs no reload.
export function boardAddress(env: Record<string, string | undefined>): string {
  const path =
    env.ROUTER_CONFIG ??
    join(homedir(), ".config", "jev-router", "config.json");
  const config: unknown = JSON.parse(readFileSync(path, "utf8"));
  const serve = isRecord(config) ? config.serve : undefined;
  const board = isRecord(serve) ? serve.board : undefined;
  return typeof board === "string" && board ? board : "127.0.0.1:7678";
}

export type NudgeDeps = {
  env: Record<string, string | undefined>;
  log(line: string): void;
};

// Registers the hook. A failure (serve down, the configuration unreadable)
// is logged once until a nudge gets through again, since a turn ends
// often; the next turn's nudge is the retry.
export function nudgeOnTurnEnd(
  server: Hooks,
  deps: NudgeDeps = { env: process.env, log: (line) => console.error(line) },
): void {
  let failing: string | null = null;
  server.on("agent.turn_ended", async (_event, { signal }) => {
    try {
      const response = await fetch(`http://${boardAddress(deps.env)}/nudge`, {
        method: "POST",
        signal,
      });
      const text = await response.text();
      if (response.status !== 202)
        throw new Error(`serve answered ${response.status}: ${text}`);
      if (failing !== null) deps.log("nudge: reaches serve again");
      failing = null;
    } catch (error: unknown) {
      const message = error instanceof Error ? error.message : String(error);
      if (message !== failing) deps.log(`nudge: ${message}`);
      failing = message;
    }
  });
}
