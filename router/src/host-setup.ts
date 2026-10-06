// `router host setup <host>`: a host that only replies, made ready from the
// router host over the ssh its Paseo endpoint already uses, so nobody types
// anything there. serve is asked first, with the host's token: it restarts
// when it does not take the token yet, and the commit it runs is the one
// the host's checkout is set to. Then the wrapper and the host's
// secrets.env are written, and `router check` there says whether the two
// work together.
import { spawn } from "node:child_process";
import { randomBytes } from "node:crypto";
import { appendFileSync, existsSync, readFileSync } from "node:fs";
import type { RouterConfig } from "./config.ts";
import { own } from "./core.ts";
import { sshArgs, type SshArgs } from "./paseo.ts";
import { refuse } from "./request.ts";
import { tokenName } from "./server.ts";

// serve's answer to GET /check with a token.
export type ServeCheck = {
  status: number;
  host: string | null;
  commit: string | null;
};

export type SetupDeps = {
  // The router checkout's origin, which the host clones over https.
  origin: string | null;
  // The router's environment and its secrets.env, where a host's token is
  // added when it has none.
  env: Record<string, string | undefined>;
  secrets: string;
  // Asks serve's /check with a token; throws when serve does not answer.
  ask(token: string): Promise<ServeCheck>;
  // Restarts serve, so it takes the tokens in secrets.env, and waits for it.
  restart(): Promise<void>;
  // Runs a shell command line on the host with `stdin` on its input, its
  // output shown as it comes; resolves the exit code.
  remote(ssh: SshArgs, command: string, stdin: string): Promise<number>;
  log(line: string): void;
};

// Where a script over ssh finds node and git: a command over ssh runs
// without the login profile that sets PATH.
export const HOST_PATH = `PATH="$HOME/.local/bin:$HOME/.local/share/mise/shims:/opt/homebrew/bin:/usr/local/bin:$PATH"
export PATH`;

// What runs on the host, as `sh -c`: arguments are the clone URL, the
// commit and the router's URL; the token comes on stdin. It refuses a host
// with a configuration, which would make it a router host, and a commit
// the origin does not have. Files are written beside their place and moved
// into it.
const SCRIPT = `set -e
clone=$1 commit=$2 url=$3
${HOST_PATH}
IFS= read -r token
config="$HOME/.config/jev-router"
repo="$HOME/.local/share/jev-router/repo"
bin="$HOME/.local/bin"
if [ -e "$config/config.json" ]; then
  echo "$config/config.json exists: with it this host runs as a router host." >&2
  exit 2
fi
if [ -d "$repo/.git" ]; then
  git -C "$repo" fetch -q origin
else
  mkdir -p "\${repo%/*}"
  git clone -q "$clone" "$repo"
fi
if ! git -C "$repo" cat-file -e "$commit^{commit}" 2>/dev/null; then
  echo "$commit is not in $clone: push the router's commit first." >&2
  exit 2
fi
git -C "$repo" checkout -q --detach "$commit"
mkdir -p "$bin" "$config"
rm -f "$bin/router.new"
printf '#!/bin/sh\\nexport NODE_COMPILE_CACHE="$HOME/.cache/jev-router"\\nexec node --no-warnings "%s/router/src/cli.ts" "$@"\\n' "$repo" > "$bin/router.new"
chmod +x "$bin/router.new"
mv -f "$bin/router.new" "$bin/router"
umask 077
rm -f "$config/secrets.env.new"
{
  if [ -f "$config/secrets.env" ]; then
    grep -v -e '^[[:space:]]*ROUTER_URL=' -e '^[[:space:]]*ROUTER_TOKEN=' "$config/secrets.env" || true
  fi
  printf 'ROUTER_URL=%s\\nROUTER_TOKEN=%s\\n' "$url" "$token"
} > "$config/secrets.env.new"
mv -f "$config/secrets.env.new" "$config/secrets.env"
echo "router: $repo at $(git -C "$repo" rev-parse --short HEAD)"
exec "$bin/router" check
`;

// A word the host's shell reads back unchanged.
const quote = (word: string): string => `'${word.replaceAll("'", `'\\''`)}'`;

// The command line ssh hands the host's login shell: `script` run by sh
// with `args`.
export const shellCommand = (script: string, args: string[]): string =>
  ["sh", "-c", script, "sh", ...args].map(quote).join(" ");
export const remoteCommand = (args: string[]): string =>
  shellCommand(SCRIPT, args);

// The origin as a URL the host clones without a login: an scp-style ssh
// remote (git@github.com:owner/repo.git) becomes https.
export function httpsOrigin(origin: string): string {
  const scp = /^[\w.-]+@([^:/]+):(.+)$/.exec(origin);
  return scp ? `https://${scp[1]}/${scp[2]}` : origin;
}

// An address no other host reaches: loopback, or every interface.
const UNREACHABLE = /^(127\.|localhost:|\[::1?\]:|0\.0\.0\.0:)/;

// Sets up `host`: 0 when `router check` there passes.
export async function setupHost(
  host: string,
  config: RouterConfig,
  deps: SetupDeps,
): Promise<number> {
  const endpoint =
    own(config.hosts, host)?.paseo ?? refuse(`${host} is not in hosts.`);
  if (!endpoint.startsWith("ssh://"))
    refuse(
      `The router reaches ${host} at ${endpoint}, not over ssh; host setup is for hosts it reaches over ssh.`,
    );
  const listen = config.serve.listen;
  if (UNREACHABLE.test(listen))
    refuse(
      `serve.listen is ${listen}, which no other host reaches; set the router's tailnet address.`,
    );
  const origin =
    deps.origin ?? refuse("The router's checkout has no origin to clone.");
  const name = tokenName(host);
  let token = deps.env[name];
  if (!token) {
    token = randomBytes(32).toString("hex");
    const before = existsSync(deps.secrets)
      ? readFileSync(deps.secrets, "utf8")
      : "";
    const gap = before && !before.endsWith("\n") ? "\n" : "";
    appendFileSync(deps.secrets, `${gap}${name}=${token}\n`, { mode: 0o600 });
    deps.log(`${name} added to ${deps.secrets}.`);
  }
  const ask = async (): Promise<ServeCheck> => {
    try {
      return await deps.ask(token);
    } catch (error: unknown) {
      return refuse(
        `serve does not answer at ${listen}: ${error instanceof Error ? error.message : String(error)}`,
      );
    }
  };
  let answer = await ask();
  if (answer.status === 401) {
    deps.log(`serve does not take ${name} yet; restarting it.`);
    await deps.restart();
    answer = await ask();
  }
  if (answer.status !== 200 || answer.host !== host)
    refuse(
      `serve answers ${name} with ${answer.status}${answer.host ? ` as ${answer.host}'s` : ""}, not as ${host}'s.`,
    );
  const commit =
    answer.commit ??
    refuse("serve does not say which commit it runs; restart it.");
  deps.log(
    `Setting up ${host} at ${commit.slice(0, 7)}, the commit serve runs:`,
  );
  const code = await deps.remote(
    sshArgs(endpoint),
    remoteCommand([httpsOrigin(origin), commit, `http://${listen}`]),
    `${token}\n`,
  );
  return code === 0 ? 0 : 1;
}

const isRecord = (value: unknown): value is Record<string, unknown> =>
  value !== null && typeof value === "object" && !Array.isArray(value);

// serve's /check at `listen`, as setup asks it.
export const serveCheck =
  (listen: string) =>
  async (token: string): Promise<ServeCheck> => {
    const response = await fetch(`http://${listen}/check`, {
      headers: { authorization: `Bearer ${token}` },
    });
    const body: unknown = await response.json().catch(() => ({}));
    const field = (key: string): string | null => {
      const value = isRecord(body) ? body[key] : undefined;
      return typeof value === "string" ? value : null;
    };
    return {
      status: response.status,
      host: field("host"),
      commit: field("commit"),
    };
  };

// The host's command line over ssh, its output passed through.
export const overSsh = (
  ssh: SshArgs,
  command: string,
  stdin: string,
): Promise<number> =>
  new Promise((resolve, reject) => {
    const child = spawn("ssh", [...ssh.options, ssh.destination, command], {
      stdio: ["pipe", "inherit", "inherit"],
    });
    child.on("error", reject);
    child.on("close", (code) => resolve(code ?? 1));
    child.stdin.end(stdin);
  });
