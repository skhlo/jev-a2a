// `router host setup <host>`: a host that only replies, made ready from the
// router host over the ssh its Paseo endpoint already uses, so nobody types
// anything there. The host's checkout is cloned, or fast-forwarded, to the
// router's commit; the wrapper and its secrets.env are written; and
// `router check` there says whether the two work together.
import { spawn } from "node:child_process";
import { randomBytes } from "node:crypto";
import { appendFileSync, existsSync, readFileSync } from "node:fs";
import type { RouterConfig } from "./config.ts";
import { own } from "./core.ts";
import { sshArgs } from "./paseo.ts";
import { refuse } from "./request.ts";
import { tokenName } from "./server.ts";

export type SetupDeps = {
  // The commit the router runs and its checkout's origin, which the host
  // clones over https.
  commit: string | null;
  origin: string | null;
  // The router's environment and its secrets.env, where a host's token is
  // added when it has none.
  env: Record<string, string | undefined>;
  secrets: string;
  // Runs a shell command line on the host with `stdin` on its input, its
  // output shown as it comes; resolves the exit code.
  remote(ssh: string[], command: string, stdin: string): Promise<number>;
  // Restarts serve, so it takes a token just added, and waits for it.
  restart(): Promise<void>;
  log(line: string): void;
};

// What runs on the host, as `sh -c`: arguments are the clone URL, the
// commit and the router's URL; the token comes on stdin. It refuses a host
// with a configuration, which would make it a router host.
const SCRIPT = `set -e
clone=$1 commit=$2 url=$3
PATH="$HOME/.local/bin:$HOME/.local/share/mise/shims:/opt/homebrew/bin:/usr/local/bin:$PATH"
export PATH
IFS= read -r token
config="$HOME/.config/jev-router"
repo="$HOME/.local/share/jev-router/repo"
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
git -C "$repo" merge -q --ff-only "$commit"
mkdir -p "$HOME/.local/bin" "$config"
printf '#!/bin/sh\\nexport NODE_COMPILE_CACHE="$HOME/.cache/jev-router"\\nexec node --no-warnings %s/router/src/cli.ts "$@"\\n' "$repo" > "$HOME/.local/bin/router"
chmod +x "$HOME/.local/bin/router"
umask 077
{
  if [ -f "$config/secrets.env" ]; then
    grep -v -e '^ROUTER_URL=' -e '^ROUTER_TOKEN=' "$config/secrets.env" || true
  fi
  printf 'ROUTER_URL=%s\\nROUTER_TOKEN=%s\\n' "$url" "$token"
} > "$config/secrets.env.new"
mv "$config/secrets.env.new" "$config/secrets.env"
echo "router: $repo at $(git -C "$repo" rev-parse --short HEAD)"
exec "$HOME/.local/bin/router" check
`;

// A word the host's shell reads back unchanged.
const quote = (word: string): string => `'${word.replaceAll("'", `'\\''`)}'`;

// The command line ssh hands the host's login shell.
export const remoteCommand = (args: string[]): string =>
  ["sh", "-c", SCRIPT, "sh", ...args].map(quote).join(" ");

// The origin as a URL the host clones without a login: a GitHub-style ssh
// remote becomes https.
export function httpsOrigin(origin: string): string {
  const scp = /^[\w.-]+@([^:/]+):(.+)$/.exec(origin);
  if (scp) return `https://${scp[1]}/${scp[2]}`;
  const ssh = /^ssh:\/\/[^@/]+@([^:/]+)(?::\d+)?\/(.+)$/.exec(origin);
  if (ssh) return `https://${ssh[1]}/${ssh[2]}`;
  return origin;
}

// Sets up `host`: resolves the exit code of `router check` there.
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
  if (/^(127\.|localhost:|\[::1\]:)/.test(listen))
    refuse(
      `serve.listen is ${listen}, which no other host reaches; set the router's tailnet address.`,
    );
  const commit =
    deps.commit ??
    refuse("The router does not run from a git checkout to match.");
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
    deps.env[name] = token;
    deps.log(`${name} added to ${deps.secrets}; restarting serve to take it.`);
    await deps.restart();
  }
  deps.log(`Setting up ${host} at ${commit.slice(0, 7)}:`);
  return deps.remote(
    sshArgs(endpoint),
    remoteCommand([httpsOrigin(origin), commit, `http://${listen}`]),
    `${token}\n`,
  );
}

// The host's command line over ssh, its output passed through.
export const overSsh = (
  ssh: string[],
  command: string,
  stdin: string,
): Promise<number> =>
  new Promise((resolve, reject) => {
    const child = spawn("ssh", [...ssh, command], {
      stdio: ["pipe", "inherit", "inherit"],
    });
    child.on("error", reject);
    child.on("close", (code) => resolve(code ?? 1));
    child.stdin.end(stdin);
  });
