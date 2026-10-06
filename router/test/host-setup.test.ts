// Host setup from the router host: what it refuses, the token it adds for a
// host that has none, and the script it runs there, run here as the host's
// shell would read it, with HOME in a scratch directory, cloning a scratch
// repository that holds this src/.
import test from "node:test";
import assert from "node:assert/strict";
import { execFileSync, spawn } from "node:child_process";
import { createServer } from "node:http";
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
  setupHost,
  type SetupDeps,
} from "../src/host-setup.ts";
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

test("host setup: an ssh origin is cloned over https", () => {
  const cases: [string, string][] = [
    [
      "git@github.com:skhlo/jev-a2a.git",
      "https://github.com/skhlo/jev-a2a.git",
    ],
    ["ssh://git@github.com/me/repo.git", "https://github.com/me/repo.git"],
    ["ssh://git@github.com:22/me/repo.git", "https://github.com/me/repo.git"],
    ["https://github.com/me/repo.git", "https://github.com/me/repo.git"],
    ["/srv/repo", "/srv/repo"],
  ];
  for (const [origin, https] of cases)
    assert.equal(httpsOrigin(origin), https, origin);
});

test("host setup: refuses what it cannot set up, and adds a token for a host that has none", async (t) => {
  const secrets = join(scratch(t, "host-setup-"), "secrets.env");
  writeFileSync(secrets, "TYPESAFE_API_KEY=k", { mode: 0o600 });
  const calls: { ssh: string[]; command: string; stdin: string }[] = [];
  let restarts = 0;
  const deps = (env: Record<string, string | undefined> = {}): SetupDeps => ({
    commit: "c0ffee",
    origin: "git@github.com:me/repo.git",
    env,
    secrets,
    remote: (ssh, command, stdin) => {
      calls.push({ ssh, command, stdin });
      return Promise.resolve(0);
    },
    restart: () => {
      restarts++;
      return Promise.resolve();
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
  await refused("mini", /no other host reaches/, {
    ...config,
    serve: { ...config.serve, listen: "127.0.0.1:7677" },
  });
  await refused("mini", /git checkout/, config, { ...deps(), commit: null });
  await refused("mini", /no origin/, config, { ...deps(), origin: null });
  assert.equal(calls.length + restarts, 0);

  const env: Record<string, string | undefined> = {};
  assert.equal(await setupHost("mini", config, deps(env)), 0);
  const token = env.ROUTER_TOKEN_MINI ?? "";
  assert.match(token, /^[0-9a-f]{64}$/);
  assert.equal(
    readFileSync(secrets, "utf8"),
    `TYPESAFE_API_KEY=k\nROUTER_TOKEN_MINI=${token}\n`,
  );
  assert.equal(restarts, 1);
  assert.deepEqual(calls[0], {
    ssh: ["-T", "-o", "BatchMode=yes", "-o", "ConnectTimeout=10", "mini"],
    command: remoteCommand([
      "https://github.com/me/repo.git",
      "c0ffee",
      "http://100.64.0.1:7677",
    ]),
    stdin: `${token}\n`,
  });
  // A host with a token keeps it, and serve is left running.
  assert.equal(await setupHost("mini", config, deps(env)), 0);
  assert.equal(restarts, 1);
  assert.equal(calls[1]?.stdin, `${token}\n`);
});

test("host setup: the script brings the host to the router's commit, writes the wrapper and secrets, and ends with a passing check", async (t) => {
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
  git("init", "-q", "-b", "main");
  git("add", "-A");
  git("commit", "-q", "-m", "router");
  let commit = git("rev-parse", "HEAD");
  // The router's serve, as far as `router check` asks it.
  const server = createServer((request, response) => {
    const mine = request.headers.authorization === "Bearer tok";
    response.writeHead(request.url === "/check" && !mine ? 401 : 200, {
      "content-type": "application/json",
    });
    response.end(
      JSON.stringify(
        request.url === "/check" && mine
          ? { ok: true, host: "mini", commit }
          : { ok: request.url !== "/check", commit },
      ),
    );
  });
  await new Promise<void>((resolve) => server.listen(0, "127.0.0.1", resolve));
  t.after(() => server.close());
  const address = server.address();
  if (address === null || typeof address === "string")
    throw new Error("no port");
  const url = `http://127.0.0.1:${address.port}`;

  const home = join(dir, "home");
  const config = join(home, ".config", "jev-router");
  mkdirSync(config, { recursive: true });
  const secrets = join(config, "secrets.env");
  writeFileSync(secrets, "KEPT=1\nROUTER_TOKEN=old\n", { mode: 0o644 });
  // The host's login shell, reading the command line ssh hands it.
  const onHost = (at: string, stdin = "tok\n") =>
    new Promise<{ code: number | null; out: string }>((resolve) => {
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

  const first = await onHost(commit);
  assert.equal(first.code, 0, first.out);
  assert.match(first.out, /^token: accepted for mini$/m);
  assert.match(
    first.out,
    new RegExp(`^commit: ${commit.slice(0, 7)} on both$`, "m"),
  );
  assert.equal(head(), commit);
  assert.equal(
    readFileSync(join(home, ".local", "bin", "router"), "utf8"),
    `#!/bin/sh\nexport NODE_COMPILE_CACHE="$HOME/.cache/jev-router"\nexec node --no-warnings ${repo}/router/src/cli.ts "$@"\n`,
  );
  assert.equal(
    readFileSync(secrets, "utf8"),
    `KEPT=1\nROUTER_URL=${url}\nROUTER_TOKEN=tok\n`,
  );
  assert.equal(statSync(secrets).mode & 0o777, 0o600);

  // The router moves on; running setup again fast-forwards the host.
  writeFileSync(join(origin, "router", "NOTE"), "moved on\n");
  git("add", "-A");
  git("commit", "-q", "-m", "later");
  commit = git("rev-parse", "HEAD");
  const again = await onHost(commit);
  assert.equal(again.code, 0, again.out);
  assert.equal(head(), commit);

  // A configuration there would make it a router host: refused before
  // anything changes.
  writeFileSync(join(config, "config.json"), "{}\n");
  const refused = await onHost(commit, "other\n");
  assert.equal(refused.code, 2);
  assert.match(refused.out, /config\.json exists/);
  assert.match(readFileSync(secrets, "utf8"), /^ROUTER_TOKEN=tok$/m);
});
