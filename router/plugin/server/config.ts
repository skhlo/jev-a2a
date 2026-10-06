// What the plugin reads of the router's configuration. A plugin cannot
// import the router's modules (Paseo compiles only its own directory), so
// a test holds these to the router's own answers.
import { readFileSync } from "node:fs";
import { homedir } from "node:os";
import { join } from "node:path";

export const isRecord = (value: unknown): value is Record<string, unknown> =>
  value !== null && typeof value === "object" && !Array.isArray(value);

// The router's configuration file as src/config.ts finds it: --config is
// the CLI's, so $ROUTER_CONFIG (the daemon's, which serve's need not be) or
// the default path.
export const configPath = (env: Record<string, string | undefined>): string =>
  env.ROUTER_CONFIG ?? join(homedir(), ".config", "jev-router", "config.json");

// Read on each use, so a change needs no reload: serve.board (127.0.0.1:7678
// when unset), where serve answers the nudge and the board's API; and the
// sessions the placements bind, since another agent's turn cannot make a
// delivery ready.
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

// An error's message with fetch's cause: fetch's own message is "fetch
// failed", and the reason is its cause.
export function reason(error: unknown): string {
  const cause =
    error instanceof Error && error.cause instanceof Error
      ? `: ${error.cause.message}`
      : "";
  return `${error instanceof Error ? error.message : String(error)}${cause}`;
}
