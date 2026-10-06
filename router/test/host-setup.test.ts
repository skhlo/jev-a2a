// Host setup from the router host: what it refuses, the token it adds for a
// host that has none and the restart that makes serve take it, against the
// real events door; and the script it runs on the host, run here as the
// host's shell would read it, with HOME in a scratch directory, cloning a
// scratch repository that holds this src/.
import test from "node:test";
import assert from "node:assert/strict";
import { execFileSync, spawn } from "node:child_process";
import { createServer, type RequestListener } from "node:http";
import {
  cpSync,
  mkdirSync,
  readFileSync,
  statSync,
  writeFileSync,
} from "node:fs";
import { join } from "node:path";
import { scratch } from "./test-scratch.ts";
import {
  httpsOrigin,
  remoteCommand,
  serveCheck,
  setupHost,
  type SetupDeps,
} from "../src/host-setup.ts";
import { doorKeys, eventsListener } from "../src/server.ts";
import { UsageError } from "../src/request.ts";
import type { RouterConfig } from "../src/config.ts";
import base from "../src/example-config.ts";

const config: RouterConfig = {
  ...base,
  home: "/nowhere",
  hosts: {
    mbp: { paseo: "ws://127.0.0.1:6767/ws", replyCommand: "router" },
    mini: { paseo: "ssh://mini", replyCommand: "router" },
  },
  agents: {},
  terminals: {},
  serve: {
    listen: "100.64.0.1:7677",
    board: "127.0.0.1:7678",
    identities: {},
    wake: 0,
    poll: 0,
  },
  jev: { model: "jev-latest" },
  telemetry: { sheet: true },
  usage: null,
};

// Listens on a free loopback port; the URL's address.
async function listening(
  t: test.TestContext,
  listener: RequestListener,
): Promise<string> {
  const server = createServer(listener);
  await new Promise<void>((resolve) => server.listen(0, "127.0.0.1", resolve));
  t.after(() => server.close());
  const address = server.address();
  if (address === null || typeof address === "string")
    throw new Error("no port");
  return `127.0.0.1:${address.port}`;
}

test("host setup: an scp-style origin is cloned over https", () => {
  const cases: [string, string][] = [
    [
      "git@github.com:skhlo/jev-a2a.git",
      "https://github.com/skhlo/jev-a2a.git",
    ],
    ["https://github.com/me/repo.git", "https://github.com/me/repo.git"],
    ["/srv/repo", "/srv/repo"],
  ];
  for (const [origin, https] of cases)
    assert.equal(httpsOrigin(origin), https, origin);
});

test("host setup: asks serve first, restarts it until it takes the host's token, and sets the host to serve's commit", async (t) => {
  const secrets = join(scratch(t, "host-setup-"), "secrets.env");
  writeFileSync(secrets, "TYPESAFE_API_KEY=k", { mode: 0o600 });
  // The router's secrets.env as serve reads it when it starts.
  const secretsEnv = (): Record<string, string> =>
    Object.fromEntries(
      readFileSync(secrets, "utf8")
        .split("\n")
        .filter(Boolean)
        .map((line) => [
          line.slice(0, line.indexOf("=")),
          line.slice(line.indexOf("=") + 1),
        ]),
    );
  // serve's events door, as started before the token existed; a restart
  // starts it again from secrets.env.
  const door = (env: Record<string, string>): RequestListener =>
    eventsListener(
      {
        config,
        handle: () => Promise.reject(new Error("no events here")),
        sessionOf: () => null,
        commit: "c0ffee",
      },
      doorKeys(config, env),
    );
  let serve = door({});
  const listen = await listening(t, (request, response) =>
    serve(request, response),
  );
  const calls: { ssh: unknown; command: string; stdin: string }[] = [];
  let restarts = 0;
  let remoteCode = 0;
  const deps = (env: Record<string, string | undefined> = {}): SetupDeps => ({
    origin: "git@github.com:me/repo.git",
    env,
    secrets,
    ask: serveCheck(listen),
    restart: () => {
      restarts++;
      serve = door(secretsEnv());
      return Promise.resolve();
    },
    remote: (ssh, command, stdin) => {
      calls.push({ ssh, command, stdin });
      return Promise.resolve(remoteCode);
    },
    log: () => undefined,
  });
  const refused = (
    host: string,
    message: RegExp,
    routerConfig = config,
    given = deps(),
  ) =>
    assert.rejects(
      setupHost(host, routerConfig, given),
      (error) => error instanceof UsageError && message.test(error.message),
      host,
    );
  await refused("nas", /^nas is not in hosts/);
  await refused("constructor", /^constructor is not in hosts/);
  await refused("mbp", /not over ssh/);
  for (const listen of ["127.0.0.1:7677", "0.0.0.0:7677", "[::]:7677"])
    await refused("mini", /no other host reaches/, {
      ...config,
      serve: { ...config.serve, listen },
    });
  await refused("mini", /no origin/, config, { ...deps(), origin: null });
  await refused(
    "mini",
    /^serve does not answer at 100\.64\.0\.1:7677/,
    config,
    {
      ...deps({ ROUTER_TOKEN_MINI: "x" }),
      ask: () => Promise.reject(new Error("ECONNREFUSED")),
    },
  );
  assert.equal(calls.length + restarts, 0);

  // No token yet: one is added, serve refuses it until a restart, and the
  // host is set to the commit serve reports.
  assert.equal(await setupHost("mini", config, deps()), 0);
  const token = secretsEnv().ROUTER_TOKEN_MINI ?? "";
  assert.match(token, /^[0-9a-f]{64}$/);
  assert.equal(
    readFileSync(secrets, "utf8"),
    `TYPESAFE_API_KEY=k\nROUTER_TOKEN_MINI=${token}\n`,
  );
  assert.equal(restarts, 1);
  assert.deepEqual(calls[0], {
    ssh: {
      options: ["-T", "-o", "BatchMode=yes", "-o", "ConnectTimeout=10"],
      destination: "mini",
    },
    command: remoteCommand([
      "https://github.com/me/repo.git",
      "c0ffee",
      "http://100.64.0.1:7677",
    ]),
    stdin: `${token}\n`,
  });
  // A token serve takes: no restart.
  assert.equal(await setupHost("mini", config, deps(secretsEnv())), 0);
  assert.equal(restarts, 1);
  // A restart that never happened (serve still on its old keys): the next
  // run restarts it, rather than handing the host a token serve refuses.
  serve = door({});
  assert.equal(await setupHost("mini", config, deps(secretsEnv())), 0);
  assert.equal(restarts, 2);
  // serve refuses the token even after a restart: nothing reaches the host.
  const before = calls.length;
  await refused(
    "mini",
    /^serve answers ROUTER_TOKEN_MINI with 401, not as mini's/,
    config,
    {
      ...deps({ ROUTER_TOKEN_MINI: "not-in-secrets" }),
      restart: () => Promise.resolve(),
    },
  );
  assert.equal(calls.length, before);
  // A failed check there fails setup.
  remoteCode = 2;
  assert.equal(await setupHost("mini", config, deps(secretsEnv())), 1);
});

test("host setup: the script sets the host to the router's exact commit, writes the wrapper and secrets, and ends with a passing check", async (t) => {
  const dir = scratch(t, "host-setup-run-");
  // The repository the host clones: this src/, committed.
  const origin = join(dir, "origin");
  cpSync(
    join(import.meta.dirname, "..", "src"),
    join(origin, "router", "src"),
    {
      recursive: true,
    },
  );
  const git = (...args: string[]): string =>
    execFileSync(
      "git",
      [
        "-C",
        origin,
        "-c",
        "user.name=t",
        "-c",
        "user.email=t@example.com",
        ...args,
      ],
      { encoding: "utf8" },
    ).trim();
  const commitNote = (name: string): string => {
    writeFileSync(join(origin, "router", name), `${name}\n`);
    git("add", "-A");
    git("commit", "-q", "-m", name);
    return git("rev-parse", "HEAD");
  };
  git("init", "-q", "-b", "main");
  const first = commitNote("first");
  const later = commitNote("later");
  // The router's serve, as far as `router check` asks it: it runs `runs`.
  let runs = first;
  const url = `http://${await listening(t, (request, response) => {
    const mine = request.headers.authorization === "Bearer tok";
    response.writeHead(mine ? 200 : 401, {
      "content-type": "application/json",
    });
    response.end(
      JSON.stringify(
        mine
          ? { ok: true, host: "mini", commit: runs }
          : { ok: false, code: "unauthorized", commit: runs },
      ),
    );
  })}`;

  const home = join(dir, "home");
  const config = join(home, ".config", "jev-router");
  mkdirSync(config, { recursive: true });
  const secrets = join(config, "secrets.env");
  writeFileSync(secrets, "KEPT=1\n  ROUTER_TOKEN=old\n", { mode: 0o644 });
  // A stray file where the new secrets are written must not lend them its
  // mode.
  writeFileSync(join(config, "secrets.env.new"), "", { mode: 0o644 });
  // The host's login shell, reading the command line ssh hands it.
  const onHost = (at: string, stdin = "tok\n") =>
    new Promise<{ code: number | null; out: string }>((resolve) => {
      runs = at;
      const child = spawn("sh", ["-c", remoteCommand([origin, at, url])], {
        env: { HOME: home, PATH: process.env.PATH },
      });
      let out = "";
      child.stdout.on("data", (chunk) => (out += chunk));
      child.stderr.on("data", (chunk) => (out += chunk));
      child.on("close", (code) => resolve({ code, out }));
      child.stdin.end(stdin);
    });
  const repo = join(home, ".local", "share", "jev-router", "repo");
  const head = () =>
    execFileSync("git", ["-C", repo, "rev-parse", "HEAD"], {
      encoding: "utf8",
    }).trim();

  // A fresh clone lands on origin's newest commit; the host is set back to
  // the router's older one.
  const installed = await onHost(first);
  assert.equal(installed.code, 0, installed.out);
  assert.match(installed.out, /^token: accepted for mini$/m);
  assert.match(
    installed.out,
    new RegExp(`^commit: ${first.slice(0, 7)} on both$`, "m"),
  );
  assert.equal(head(), first);
  assert.equal(
    readFileSync(join(home, ".local", "bin", "router"), "utf8"),
    `#!/bin/sh\nexport NODE_COMPILE_CACHE="$HOME/.cache/jev-router"\nexec node --no-warnings "${repo}/router/src/cli.ts" "$@"\n`,
  );
  assert.equal(
    readFileSync(secrets, "utf8"),
    `KEPT=1\nROUTER_URL=${url}\nROUTER_TOKEN=tok\n`,
  );
  assert.equal(statSync(secrets).mode & 0o777, 0o600);

  // The router moves on, then to a commit off main (a branch later
  // squash-merged): the host follows it either way.
  assert.equal((await onHost(later)).code, 0);
  assert.equal(head(), later);
  git("checkout", "-q", "-b", "side", first);
  const side = commitNote("side");
  git("checkout", "-q", "main");
  assert.equal((await onHost(side)).code, 0);
  assert.equal(head(), side);
  assert.equal((await onHost(later)).code, 0);
  assert.equal(head(), later);

  // A commit the origin does not have, and a host with a configuration,
  // are refused before anything changes.
  const unpushed = await onHost("0123456789abcdef0123456789abcdef01234567");
  assert.equal(unpushed.code, 2);
  assert.match(unpushed.out, /is not in .*push the router's commit first/);
  writeFileSync(join(config, "config.json"), "{}\n");
  const refused = await onHost(later, "other\n");
  assert.equal(refused.code, 2);
  assert.match(refused.out, /config\.json exists/);
  assert.match(readFileSync(secrets, "utf8"), /^ROUTER_TOKEN=tok$/m);
  assert.equal(head(), later);
});
