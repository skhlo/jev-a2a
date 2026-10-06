// When a placement's session ends a turn on this daemon, the plugin asks
// serve for a run now (POST /nudge on the board's address), so a delivery
// or a notice waiting for that session goes out at once instead of at the
// next look, up to serve.wake seconds later. Serve decides whether
// anything waits; the plugin only says when to look. A terminal placement
// is not a Paseo agent and has no turns to hook, so it waits for the look.
import { isRecord, reason, routerConfig } from "./config.ts";

// What the plugin uses of Paseo's PluginServerContext, so a test can stand
// in for it.
export type Hooks = {
  on(
    name: "agent.turn_ended",
    callback: (
      event: unknown,
      context: { signal: AbortSignal },
    ) => Promise<void>,
  ): unknown;
};

// The agent whose turn ended, from the hook's event.
const agentOf = (event: unknown): string | null =>
  isRecord(event) && isRecord(event.agent) && typeof event.agent.id === "string"
    ? event.agent.id
    : null;

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
  server.on("agent.turn_ended", async (event, { signal }) => {
    try {
      const { board, sessions } = routerConfig(deps.env);
      const agent = agentOf(event);
      if (agent === null || !sessions.has(agent)) return;
      const response = await fetch(`http://${board}/nudge`, {
        method: "POST",
        signal,
      });
      const text = await response.text();
      if (response.status !== 202)
        throw new Error(`serve answered ${response.status}: ${text}`);
      if (failing !== null) deps.log("nudge: reaches serve again");
      failing = null;
    } catch (error: unknown) {
      const message = reason(error);
      if (message !== failing) deps.log(`nudge: ${message}`);
      failing = message;
    }
  });
}
