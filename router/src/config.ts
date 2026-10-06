// A deployment's configuration file: the core's configuration plus what the
// shell needs to reach its participants on each machine.
import { existsSync, readFileSync } from "node:fs";
import { homedir } from "node:os";
import { join } from "node:path";
import { own, validateConfig } from "./core.ts";
import type { Config, Participant, Role } from "./types.ts";
import { ACCOUNT_IDS, type AccountId } from "./usage.ts";

// A placement's session in `agents`: a Paseo agent id, or `terminal:<id>`
// for an agent CLI in a Paseo terminal (see paseo.ts). The terminal it
// names, or null for an agent.
const TERMINAL = "terminal:";
export const terminalOf = (session: string): string | null =>
  session.startsWith(TERMINAL) ? session.slice(TERMINAL.length) || null : null;
// Paseo's terminal ids are UUIDs; the short form a table prints matches
// nothing the daemon lists.
const TERMINAL_ID =
  /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/i;

// The CLIs a terminal placement may run, each with its own idea of an
// empty prompt (see paseo.ts); Claude Code unless `terminals` names another.
const TERMINAL_CLIS = ["claude", "codex"] as const;
export type TerminalCli = (typeof TERMINAL_CLIS)[number];
const isTerminalCli = (value: unknown): value is TerminalCli =>
  TERMINAL_CLIS.some((cli) => cli === value);

// Where the configuration is: --config, $ROUTER_CONFIG, or the default. Its
// folder holds secrets.env too.
export const configPathOf = (
  given: string | undefined,
  env: Record<string, string | undefined>,
): string =>
  given ??
  env.ROUTER_CONFIG ??
  join(homedir(), ".config", "jev-router", "config.json");

// The calling session as the record names it: a Paseo agent's id, or the
// terminal the CLI runs in. Null outside a participant session.
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
  // Placement key -> the CLI in its terminal, for a terminal placement that
  // does not run Claude Code.
  terminals: Record<string, TerminalCli>;
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

// Each named terminal session's CLI, keyed by the session (`terminal:<id>`)
// as the adapter is handed it.
export const terminalClis = (
  config: Pick<RouterConfig, "agents" | "terminals">,
): Record<string, TerminalCli> =>
  Object.fromEntries(
    Object.entries(config.terminals).flatMap(([key, cli]) => {
      const session = config.agents[key];
      return session ? [[session, cli]] : [];
    }),
  );

// Seconds between usage reads when the usage section names none.
export const USAGE_EVERY = 120;

// Who acts in a role when no one is named: the first configured principal
// in it, as the CLI acts without --as and the Paseo app always does.
export const firstPrincipal = (
  config: RouterConfig,
  role: Role,
): string | null =>
  Object.entries(config.principals ?? {}).find(([, r]) => r === role)?.[0] ??
  null;

const isRecord = (value: unknown): value is Record<string, unknown> =>
  value !== null && typeof value === "object" && !Array.isArray(value);
const isAccountId = (value: unknown): value is AccountId =>
  ACCOUNT_IDS.some((id) => id === value);

export function loadConfig(path: string): RouterConfig {
  return configOf(JSON.parse(readFileSync(path, "utf8")), path);
}

// A configuration as loadConfig reads it from `path`, which a refusal names.
export function configOf(raw: unknown, path: string): RouterConfig {
  const config = validateConfig(raw);
  const extra = raw as Record<string, unknown>;
  try {
    const hosts = hostsOf(extra.hosts);
    const agents = agentsOf(extra.agents ?? {}, config.participants, hosts);
    const terminals = terminalsOf(extra.terminals ?? {}, agents);
    const serve = serveOf(extra.serve, config.principals ?? {});
    const jev = jevOf(extra.jev);
    const telemetry = telemetryOf(extra.telemetry);
    const usage = usageOf(extra.usage);
    return {
      ...config,
      home:
        text(extra.home, "") ||
        join(homedir(), ".local", "state", "jev-router"),
      hosts,
      agents,
      terminals,
      serve,
      jev,
      telemetry,
      usage,
    };
  } catch (error: unknown) {
    if (!(error instanceof Refusal)) throw error;
    throw new Error(`Invalid router configuration (${path}): ${error.message}`);
  }
}

// A section that breaks a rule; loadConfig names the file.
class Refusal extends Error {}
function refuse(message: string): never {
  throw new Refusal(message);
}

// A string that is not empty, else the fallback.
const text = (value: unknown, fallback: string): string =>
  typeof value === "string" && value ? value : fallback;
// Seconds from `min` to an hour; `fallback` when absent.
const seconds = (
  name: string,
  value: unknown,
  { fallback, min }: { fallback: number; min: number },
): number => {
  const given = value === undefined ? fallback : value;
  if (typeof given !== "number" || !(given >= min && given <= 3600))
    refuse(`${name} is a number of seconds, ${min} to 3600`);
  return given;
};
// An optional section's fields; none when it is absent.
const section = (value: unknown): Record<string, unknown> =>
  isRecord(value) ? value : {};

function hostsOf(value: unknown): Record<string, HostConfig> {
  if (!isRecord(value) || !Object.keys(value).length)
    refuse("hosts maps each machine to its Paseo endpoint");
  const hosts: Record<string, HostConfig> = {};
  for (const [name, entry] of Object.entries(value)) {
    if (!isRecord(entry) || typeof entry.paseo !== "string" || !entry.paseo)
      refuse(`hosts.${name}.paseo is a websocket URL or ssh://host`);
    hosts[name] = {
      paseo: entry.paseo,
      replyCommand: text(entry.replyCommand, "router"),
    };
  }
  return hosts;
}

function agentsOf(
  value: unknown,
  participants: Participant[],
  hosts: Record<string, HostConfig>,
): Record<string, string> {
  if (!isRecord(value))
    refuse("agents maps placement keys to Paseo agent ids or terminal:<id>");
  const placements = new Map(
    participants.flatMap((participant) =>
      participant.hosts.map(
        (host): [string, { participant: Participant; host: string }] => [
          `${participant.id}@${host}`,
          { participant, host },
        ],
      ),
    ),
  );
  const sessions: Record<string, string> = {};
  for (const [key, id] of Object.entries(value)) {
    const { participant, host } =
      placements.get(key) ?? refuse(`agents names unknown placement ${key}`);
    if (!own(hosts, host))
      refuse(`agents.${key}: host ${host} is not in hosts`);
    if (typeof id !== "string" || !id)
      refuse(`agents.${key} must be an agent id or terminal:<id>`);
    if (id.startsWith(TERMINAL)) checkTerminal(key, id, participant);
    sessions[key] = id;
  }
  return sessions;
}

function checkTerminal(
  key: string,
  id: string,
  participant: Participant,
): void {
  if (!TERMINAL_ID.test(terminalOf(id) ?? ""))
    refuse(
      `agents.${key} must name a terminal by its full id (paseo terminal ls --all --json)`,
    );
  // A terminal takes no message key, so an unknown send to it must wait
  // for a person rather than be retried (see idempotent in core.ts).
  if (participant.idempotent)
    refuse(
      `agents.${key} is a terminal, which takes no message key, so ${participant.id} must be idempotent: false`,
    );
}

function terminalsOf(
  value: unknown,
  agents: Record<string, string>,
): Record<string, TerminalCli> {
  if (!isRecord(value))
    refuse('terminals maps terminal placements to a CLI, e.g. "codex"');
  const terminals: Record<string, TerminalCli> = {};
  for (const [key, cli] of Object.entries(value)) {
    if (terminalOf(own(agents, key) ?? "") === null)
      refuse(`terminals.${key} names no terminal placement in agents`);
    if (!isTerminalCli(cli))
      refuse(`terminals.${key} must be one of ${TERMINAL_CLIS.join(", ")}`);
    terminals[key] = cli;
  }
  return terminals;
}

function serveOf(
  value: unknown,
  principals: Record<string, Role>,
): RouterConfig["serve"] {
  const serve = section(value);
  const board = text(serve.board, "127.0.0.1:7678");
  // The board trusts Tailscale Serve's login header, so it must only be
  // reachable through Serve: loopback, never an interface address.
  if (!/^(127\.0\.0\.1|localhost|\[::1\]):\d+$/.test(board))
    refuse(`serve.board must be a loopback address, not ${board}`);
  const wake = seconds("serve.wake", serve.wake, { fallback: 20, min: 0 });
  const poll = seconds("serve.poll", serve.poll, { fallback: 0, min: 0 });
  return {
    listen: text(serve.listen, "127.0.0.1:7677"),
    board,
    identities: identitiesOf(serve.identities, principals),
    wake,
    poll,
  };
}

function identitiesOf(
  value: unknown,
  principals: Record<string, Role>,
): Record<string, string[]> {
  if (value === undefined) return {};
  if (!isRecord(value))
    refuse("serve.identities maps a tailnet login to a list of principals");
  const configured = (list: unknown): list is string[] =>
    Array.isArray(list) &&
    list.every((p) => typeof p === "string" && Object.hasOwn(principals, p));
  const identities: Record<string, string[]> = {};
  for (const [login, list] of Object.entries(value)) {
    if (!configured(list))
      refuse(`serve.identities.${login} must list configured principals`);
    identities[login] = list;
  }
  return identities;
}

function jevOf(value: unknown): RouterConfig["jev"] {
  const jev = section(value);
  return {
    model: text(jev.model, "jev-latest"),
    ...(typeof jev.url === "string" && jev.url ? { url: jev.url } : {}),
    ...(typeof jev.timeoutMs === "number" ? { timeoutMs: jev.timeoutMs } : {}),
  };
}

function telemetryOf(value: unknown): RouterConfig["telemetry"] {
  const { sheet } = section(value);
  if (sheet !== undefined && typeof sheet !== "boolean")
    refuse("telemetry.sheet is true or false");
  return { sheet: sheet ?? true };
}

function usageOf(value: unknown): RouterConfig["usage"] {
  if (value === undefined) return null;
  if (!isRecord(value)) refuse('usage is an object such as { "every": 120 }');
  const every = seconds("usage.every", value.every, {
    fallback: USAGE_EVERY,
    min: 30,
  });
  const listed: unknown = value.accounts ?? ACCOUNT_IDS;
  if (
    !Array.isArray(listed) ||
    !listed.length ||
    !listed.every(isAccountId) ||
    new Set(listed).size !== listed.length
  )
    refuse(
      `usage.accounts lists accounts once each, among ${ACCOUNT_IDS.join(", ")}`,
    );
  return {
    every,
    accounts: ACCOUNT_IDS.filter((id) => listed.includes(id)),
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
