// A deployment's configuration file: the core's configuration plus what the
// shell needs to reach its participants on each machine.
import { existsSync, readFileSync } from "node:fs";
import { homedir } from "node:os";
import { join } from "node:path";
import { validateConfig } from "./core.ts";
import type { Config } from "./types.ts";
import { ACCOUNT_IDS, type AccountId } from "./usage.ts";

// A placement's session in `agents`: a Paseo agent id, or `terminal:<id>`
// for Claude Code in a Paseo terminal (see paseo.ts). The terminal it
// names, or null for an agent.
const TERMINAL = "terminal:";
export const terminalOf = (session: string): string | null =>
  session.startsWith(TERMINAL) ? session.slice(TERMINAL.length) || null : null;
// Paseo's terminal ids are UUIDs; the short form a table prints matches
// nothing the daemon lists.
const TERMINAL_ID =
  /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/i;

// The calling session as the record names it: a Paseo agent's id, or the
// terminal Claude Code runs in. Null outside a participant session.
export const callerSession = (
  env: Record<string, string | undefined> = process.env,
): string | null =>
  env.PASEO_AGENT_ID ||
  (env.PASEO_TERMINAL_ID ? `${TERMINAL}${env.PASEO_TERMINAL_ID}` : null);

export type HostConfig = {
  // Paseo daemon endpoint: a websocket URL, or ssh://[user@]host[:port] to
  // tunnel to a loopback-bound daemon the way the Paseo CLI does.
  paseo: string;
  // What a participant on this host runs to reply; goes into the envelope.
  replyCommand: string;
};

export type RouterConfig = Config & {
  // Journal directory. Defaults to ~/.local/state/jev-router.
  home: string;
  // Machines named in participants[].hosts that this router can reach.
  hosts: Record<string, HostConfig>;
  // Placement key ("participant@host") -> its session: a Paseo agent id or
  // terminal:<id> (see terminalOf). Placements without an entry are not
  // served.
  agents: Record<string, string>;
  // Where `router serve` listens for events from other hosts, where it
  // serves the board (loopback; expose it through Tailscale Serve), and which
  // tailnet logins may act from the board, as which principals.
  serve: {
    listen: string;
    board: string;
    identities: Record<string, string[]>;
    // Seconds between runs while something waits for a session to be seen
    // idle; 0 leaves serve to run on events alone.
    wake: number;
    // Seconds after the end of any run before serve runs again regardless,
    // so the board's telemetry is at most this plus one run old; 0 polls
    // nothing.
    poll: number;
  };
  // Jev for unaddressed requests. The API key comes from TYPESAFE_API_KEY.
  jev: { model: string; url?: string; timeoutMs?: number };
  // Whether each run reads the health sheet (checkout, subagents, activity)
  // beyond the rail; off, a run costs one call per placement.
  telemetry: { sheet: boolean };
  // Which accounts `router serve` reads for the board's usage, every how
  // many seconds; null, the default, reads none and the board shows none.
  usage: { every: number; accounts: AccountId[] } | null;
};

// Seconds between usage reads when the usage section names none.
export const USAGE_EVERY = 120;

const isRecord = (value: unknown): value is Record<string, unknown> =>
  value !== null && typeof value === "object" && !Array.isArray(value);
const isAccountId = (value: unknown): value is AccountId =>
  ACCOUNT_IDS.some((id) => id === value);

export function loadConfig(path: string): RouterConfig {
  const raw: unknown = JSON.parse(readFileSync(path, "utf8"));
  const config = validateConfig(raw);
  const extra = raw as Record<string, unknown>;
  const fail = (message: string): never => {
    throw new Error(`Invalid router configuration (${path}): ${message}`);
  };
  if (!isRecord(extra.hosts) || !Object.keys(extra.hosts).length)
    return fail("hosts maps each machine to its Paseo endpoint");
  const hosts: Record<string, HostConfig> = {};
  for (const [name, entry] of Object.entries(extra.hosts)) {
    if (!isRecord(entry) || typeof entry.paseo !== "string" || !entry.paseo)
      return fail(`hosts.${name}.paseo is a websocket URL or ssh://host`);
    hosts[name] = {
      paseo: entry.paseo,
      replyCommand:
        typeof entry.replyCommand === "string" && entry.replyCommand
          ? entry.replyCommand
          : "router",
    };
  }
  const agents = extra.agents ?? {};
  if (!isRecord(agents))
    return fail(
      "agents maps placement keys to Paseo agent ids or terminal:<id>",
    );
  const known = new Map(
    config.participants.flatMap((p) =>
      p.hosts.map((h): [string, string] => [`${p.id}@${h}`, h]),
    ),
  );
  const agentIds: Record<string, string> = {};
  for (const [key, id] of Object.entries(agents)) {
    const host = known.get(key);
    if (!host) fail(`agents names unknown placement ${key}`);
    else if (!hosts[host]) fail(`agents.${key}: host ${host} is not in hosts`);
    if (typeof id !== "string" || !id)
      return fail(`agents.${key} must be an agent id or terminal:<id>`);
    const terminal = id.startsWith(TERMINAL) ? (terminalOf(id) ?? "") : null;
    if (terminal !== null && !TERMINAL_ID.test(terminal))
      fail(
        `agents.${key} must name a terminal by its full id (paseo terminal ls --all --json)`,
      );
    // A terminal takes no message key, so an unknown send to it must wait
    // for a person rather than be retried (see idempotent in core.ts).
    const participant = config.participants.find(
      (p) => `${p.id}@${host}` === key,
    );
    if (terminal !== null && participant?.idempotent)
      fail(
        `agents.${key} is a terminal, which takes no message key, so ${participant.id} must be idempotent: false`,
      );
    agentIds[key] = id;
  }
  const serve = isRecord(extra.serve) ? extra.serve : {};
  const board =
    typeof serve.board === "string" && serve.board
      ? serve.board
      : "127.0.0.1:7678";
  // The board trusts Tailscale Serve's login header, so it must only be
  // reachable through Serve: loopback, never an interface address.
  if (!/^(127\.0\.0\.1|localhost|\[::1\]):\d+$/.test(board))
    fail(`serve.board must be a loopback address, not ${board}`);
  const wake = serve.wake === undefined ? 20 : serve.wake;
  if (typeof wake !== "number" || !(wake >= 0 && wake <= 3600))
    return fail("serve.wake is a number of seconds, 0 to 3600");
  const poll = serve.poll === undefined ? 0 : serve.poll;
  if (typeof poll !== "number" || !(poll >= 0 && poll <= 3600))
    return fail("serve.poll is a number of seconds, 0 to 3600");
  const identities: Record<string, string[]> = {};
  if (serve.identities !== undefined) {
    if (!isRecord(serve.identities))
      fail("serve.identities maps a tailnet login to a list of principals");
    else
      for (const [login, list] of Object.entries(serve.identities)) {
        const principals: string[] = [];
        for (const p of Array.isArray(list) ? list : [undefined])
          if (typeof p === "string" && p in (config.principals ?? {}))
            principals.push(p);
          else
            return fail(
              `serve.identities.${login} must list configured principals`,
            );
        identities[login] = principals;
      }
  }
  const jev = isRecord(extra.jev) ? extra.jev : {};
  const telemetry = isRecord(extra.telemetry) ? extra.telemetry : {};
  if (telemetry.sheet !== undefined && typeof telemetry.sheet !== "boolean")
    return fail("telemetry.sheet is true or false");
  let usage: RouterConfig["usage"] = null;
  if (extra.usage !== undefined) {
    if (!isRecord(extra.usage))
      return fail('usage is an object such as { "every": 120 }');
    const every =
      extra.usage.every === undefined ? USAGE_EVERY : extra.usage.every;
    if (typeof every !== "number" || !(every >= 30 && every <= 3600))
      return fail("usage.every is a number of seconds, 30 to 3600");
    const listed: unknown = extra.usage.accounts ?? ACCOUNT_IDS;
    const ids = Array.isArray(listed) ? listed.filter(isAccountId) : [];
    if (
      !Array.isArray(listed) ||
      !ids.length ||
      ids.length !== listed.length ||
      new Set(ids).size !== ids.length
    )
      return fail(
        `usage.accounts lists accounts once each, among ${ACCOUNT_IDS.join(", ")}`,
      );
    usage = {
      every,
      accounts: ACCOUNT_IDS.filter((id) => ids.includes(id)),
    };
  }
  return {
    ...config,
    home:
      typeof extra.home === "string" && extra.home
        ? extra.home
        : join(homedir(), ".local", "state", "jev-router"),
    hosts,
    agents: agentIds,
    serve: {
      listen:
        typeof serve.listen === "string" && serve.listen
          ? serve.listen
          : "127.0.0.1:7677",
      board,
      identities,
      wake,
      poll,
    },
    jev: {
      model:
        typeof jev.model === "string" && jev.model ? jev.model : "jev-latest",
      ...(typeof jev.url === "string" && jev.url ? { url: jev.url } : {}),
      ...(typeof jev.timeoutMs === "number"
        ? { timeoutMs: jev.timeoutMs }
        : {}),
    },
    telemetry: { sheet: telemetry.sheet ?? true },
    usage,
  };
}

// KEY=VALUE lines from a secrets file next to the configuration, applied to
// the environment where the environment does not already set them. Secrets
// never live in the JSON configuration. Returns the names the file sets,
// applied or already in the environment, so a child process the router
// starts can be kept from all of them.
export function loadSecrets(path: string): string[] {
  if (!existsSync(path)) return [];
  const names: string[] = [];
  for (const line of readFileSync(path, "utf8").split("\n")) {
    const trimmed = line.trim();
    if (!trimmed || trimmed.startsWith("#")) continue;
    const eq = trimmed.indexOf("=");
    if (eq <= 0) continue;
    const key = trimmed.slice(0, eq).trim();
    const value = trimmed.slice(eq + 1).trim();
    if (!value) continue;
    names.push(key);
    if (process.env[key] === undefined) process.env[key] = value;
  }
  return names;
}
