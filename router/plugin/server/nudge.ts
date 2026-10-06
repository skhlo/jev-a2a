// When a placement's session ends a turn on this daemon, the plugin asks
// serve for a run now (POST /nudge on the board's address), so a delivery
// or a notice waiting for that session goes out at once instead of at the
// next look, up to serve.wake seconds later. Serve decides whether
// anything waits; the plugin only says when to look. A terminal placement
// is not a Paseo agent and has no turns to hook, so it waits for the look.
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

// The router's configuration file as src/config.ts finds it: --config is
// the CLI's, so $ROUTER_CONFIG (the daemon's, which serve's need not be) or
// the default path. A plugin cannot import the router's modules (Paseo
// compiles only its own directory), so a test holds the two to the same
// answer.
export const configPath = (env: Record<string, string | undefined>): string =>
  env.ROUTER_CONFIG ?? join(homedir(), ".config", "jev-router", "config.json");

// What the plugin reads of that file, on each turn's end so a change needs
// no reload: serve.board (127.0.0.1:7678 when unset), and the sessions the
// placements bind, since another agent's turn cannot make a delivery
// ready.
export function routerConfig(env: Record<string, string | undefined>): {
  board: string;
  sessions: Set<string>;
} {
  const config: unknown = JSON.parse(readFileSync(configPath(env), "utf8"));
  const serve = isRecord(config) ? config.serve : undefined;
  const board = isRecord(serve) ? serve.board : undefined;
  const agents = isRecord(config) ? config.agents : undefined;
  return {
    board: typeof board === "string" && board ? board : "127.0.0.1:7678",
    sessions: new Set(
      Object.values(isRecord(agents) ? agents : {}).filter(
        (id): id is string => typeof id === "string",
      ),
    ),
  };
}

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
      // fetch's own message is "fetch failed"; the reason is its cause.
      const cause =
        error instanceof Error && error.cause instanceof Error
          ? `: ${error.cause.message}`
          : "";
      const message = `${error instanceof Error ? error.message : String(error)}${cause}`;
      if (message !== failing) deps.log(`nudge: ${message}`);
      failing = message;
    }
  });
}
