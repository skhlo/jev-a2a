// The usage readers over their two I/O boundaries, the Codex app-server
// over stdio and the providers' HTTP, with task subprocesses, a local
// server and fixture payloads only: no production credentials, clients or
// requests. Ported from API Dash's tests where the reader survived the port.
import test from "node:test";
import assert from "node:assert/strict";
import { once } from "node:events";
import { mkdir, mkdtemp, readFile, rm, writeFile } from "node:fs/promises";
import { createServer, type ServerResponse } from "node:http";
import { tmpdir } from "node:os";
import { join } from "node:path";
import {
  childEnv,
  createLoaders,
  FETCH_LIMITS,
  fetchJson,
  readUsageRpc,
  type ReaderIo,
} from "./usage-readers.ts";
import {
  createUsageStore,
  ReadError,
  snapshot,
  type Reading,
  type UsageDetail,
} from "./usage.ts";
import { loadSecrets } from "./config.ts";
import {
  NOW,
  openrouterKeyOnly,
  openrouterManaged,
  openrouterPayloads,
} from "./board-fixture.ts";

const now = Date.parse("2026-09-13T12:00:00Z");
const codexQuota = {
  rateLimits: { primary: { usedPercent: 25, windowDurationMins: 300 } },
};
const codexHistory = {
  summary: { lifetimeTokens: 120, peakDailyTokens: 90 },
  dailyUsageBuckets: [
    { startDate: "2026-09-11", tokens: 90 },
    { startDate: "2026-09-10", tokens: 30 },
  ],
  threadUsage: { threadId: "private-id", prose: "private-prose" },
};
const metric = (value: Reading | UsageDetail, label: string) =>
  value.metrics.find((m) => m.label === label)?.value;

async function fixtureHome(t: { after(fn: () => Promise<void>): void }) {
  const home = await mkdtemp(join(tmpdir(), "usage-readers-"));
  t.after(() => rm(home, { recursive: true }));
  return home;
}

// No native process and no network unless a test scripts one.
const io = (overrides: ReaderIo = {}): ReaderIo => ({
  readUsageRpc: async () => {
    throw new Error("Unexpected native process.");
  },
  fetchJson: async () => {
    throw new Error("Unexpected network request.");
  },
  clock: () => now,
  ...overrides,
});

test("the Codex RPC sends initialization and the one read, and settles only after the child closed", async (t) => {
  const home = await fixtureHome(t);
  const closed = join(home, "closed");
  const fixture = `
    const fs = require('node:fs');
    const seen = [];
    process.on('SIGTERM', () => setTimeout(() => { fs.writeFileSync(${JSON.stringify(closed)}, 'closed'); process.exit(0); }, 80));
    require('node:readline').createInterface({input:process.stdin}).on('line', line => {
      const message = JSON.parse(line); seen.push(message);
      if (message.id === 1) console.log(JSON.stringify({id:1,result:{}}));
      if (message.id === 2) console.log(JSON.stringify({id:2,result:{seen, cwd: process.cwd(), env: Object.keys(process.env)}}));
    });
    setInterval(() => {}, 1000);
  `;
  const result = (await readUsageRpc(
    process.execPath,
    ["-e", fixture],
    "codex-usage",
    3000,
    childEnv({
      ...process.env,
      ROUTER_TOKEN: "x",
      OPENROUTER_API_KEY: "y",
      USAGE_TEST_MARKER: "1",
    }),
  )) as {
    seen: { method: string; params?: unknown }[];
    cwd: string;
    env: string[];
  };
  assert.deepEqual(
    result.seen.map((m) => m.method),
    ["initialize", "initialized", "account/usage/read"],
  );
  assert.deepEqual(result.seen[2]?.params, {});
  assert.equal(await readFile(closed, "utf8"), "closed");
  // It runs in the temporary directory, with the environment it was given:
  // the marker arrives, the router's credentials do not.
  assert.equal(result.cwd, tmpdir());
  assert.ok(result.env.includes("USAGE_TEST_MARKER"));
  assert.ok(!result.env.includes("ROUTER_TOKEN"));
  assert.ok(!result.env.includes("OPENROUTER_API_KEY"));
  const limits = await readUsageRpc(
    process.execPath,
    ["-e", fixture],
    "codex",
    3000,
  );
  assert.equal(
    (limits as { seen: { method: string }[] }).seen[2]?.method,
    "account/rateLimits/read",
  );
});

test("the Codex child gets the router's environment without its secrets: the fixed names and every name its secrets file sets", async (t) => {
  const home = await fixtureHome(t);
  const seen = join(home, "env.json");
  // The real spawn, with a stand-in for codex that writes the names of its
  // environment and answers both reads.
  const fixture = `
    const fs = require('node:fs');
    fs.writeFileSync(${JSON.stringify(seen)}, JSON.stringify(Object.keys(process.env)));
    require('node:readline').createInterface({input:process.stdin}).on('line', line => {
      const m = JSON.parse(line);
      if (m.id === 1) console.log(JSON.stringify({id:1,result:{}}));
      if (m.id === 2) console.log(JSON.stringify({id:2,result:{rateLimits:{primary:{usedPercent:1}},dailyUsageBuckets:[]}}));
    });
    process.on('SIGTERM', () => process.exit(0));
  `;
  const file = join(home, "secrets.env");
  await writeFile(file, "USAGE_TEST_FILE_SECRET=from-file\n");
  const names = loadSecrets(file);
  t.after(() => {
    delete process.env.USAGE_TEST_FILE_SECRET;
  });
  const fixed = [
    "ROUTER_TOKEN",
    "TYPESAFE_API_KEY",
    "CLAUDE_CODE_OAUTH_TOKEN",
    "OPENROUTER_API_KEY",
    "OPENROUTER_MANAGEMENT_KEY",
    "DEEPSEEK_API_KEY",
  ];
  const env = {
    ...process.env,
    ...Object.fromEntries(fixed.map((name) => [name, "secret"])),
    USAGE_TEST_MARKER: "harmless",
  };
  const loaders = createLoaders(
    home,
    env,
    io({
      readUsageRpc: (_command, _args, protocol, timeoutMs, childEnv) =>
        readUsageRpc(
          process.execPath,
          ["-e", fixture],
          protocol,
          timeoutMs,
          childEnv,
        ),
    }),
    names,
  );
  await loaders.codex();
  const keys: unknown = JSON.parse(await readFile(seen, "utf8"));
  assert.ok(Array.isArray(keys));
  assert.ok(keys.includes("USAGE_TEST_MARKER"));
  for (const name of [...fixed, "USAGE_TEST_FILE_SECRET"])
    assert.ok(!keys.includes(name), name);
});

test("a reading stays good when the app-server exits nonzero on our shutdown", async () => {
  const fixture = `
    process.on('SIGTERM', () => process.exit(143));
    require('node:readline').createInterface({input:process.stdin}).on('line', line => {
      const m = JSON.parse(line);
      if(m.id) console.log(JSON.stringify({id:m.id,result:m.id === 2 ? {config:{creditUsagePercent:25}} : {}}));
    });
    setInterval(() => {}, 1000);
  `;
  assert.deepEqual(
    await readUsageRpc(process.execPath, ["-e", fixture], "codex-usage"),
    { config: { creditUsagePercent: 25 } },
  );
});

test("the RPC bounds shutdown when the child ignores a graceful stop", async () => {
  const fixture = `
    process.on('SIGTERM', () => {});
    require('node:readline').createInterface({input:process.stdin}).on('line', line => {
      const m = JSON.parse(line);
      if(m.id) console.log(JSON.stringify({id:m.id,result:m.id === 2 ? {pid:process.pid} : {}}));
    });
    setInterval(() => {}, 1000);
  `;
  const started = Date.now();
  const result = (await readUsageRpc(
    process.execPath,
    ["-e", fixture],
    "codex-usage",
    3000,
  )) as { pid: number };
  assert.ok(Date.now() - started < 4000);
  assert.throws(() => process.kill(result.pid, 0), { code: "ESRCH" });
});

for (const [name, fixture, error] of [
  ["time", "setInterval(() => {}, 1000)", /timed out/],
  [
    "size in bytes",
    "process.stdout.write('é'.repeat(500001)); setInterval(() => {}, 1000)",
    /too large/,
  ],
  [
    "cumulative size",
    "process.stdout.write((' '.repeat(1000) + '\\n').repeat(1000)); setInterval(() => {}, 1000)",
    /too large/,
  ],
  ["early exit", "process.exit(7)", /exited early|connection closed/],
  [
    "protocol error",
    "require('node:readline').createInterface({input:process.stdin}).on('line', () => console.log(JSON.stringify({id:1,error:{message:'private-secret'}})))",
    /initialization failed/,
  ],
] as const) {
  test(`the RPC rejects a ${name} failure in its own words`, async () => {
    const failure = await readUsageRpc(
      process.execPath,
      ["-e", fixture],
      "codex-usage",
      name === "time" ? 100 : 3000,
    ).catch((e: unknown) => e);
    assert.ok(failure instanceof ReadError);
    assert.match(failure.message, error);
    assert.ok(!failure.message.includes("private"));
  });
}

test("the RPC rejects a missing CLI, and closes the child before rejecting a timeout", async (t) => {
  const home = await fixtureHome(t);
  const closed = join(home, "closed");
  const fixture = `
    process.on('SIGTERM', () => setTimeout(() => { require('node:fs').writeFileSync(${JSON.stringify(closed)}, 'closed'); process.exit(0); }, 80));
    setInterval(() => {}, 1000);
  `;
  await assert.rejects(
    readUsageRpc(process.execPath, ["-e", fixture], "codex-usage", 300),
    /timed out/,
  );
  assert.equal(await readFile(closed, "utf8"), "closed");
  await assert.rejects(
    readUsageRpc(join(home, "nonexistent-cli"), [], "codex-usage"),
    /codex CLI is not available/,
  );
});

test("a provider request never follows a redirect with its credential, and says what failed in its own words", async (t) => {
  let destination = false;
  const server = createServer((req, res) => {
    if (req.url === "/redirect")
      res.writeHead(302, { Location: "/secret-target" }).end();
    else if (req.url === "/denied")
      res.writeHead(401).end("token fixture-key is invalid");
    else if (req.url === "/html") res.end("<html>private provider page</html>");
    else {
      destination = true;
      res.end("{}");
    }
  });
  server.listen(0, "127.0.0.1");
  await once(server, "listening");
  t.after(() => new Promise<void>((resolve) => server.close(() => resolve())));
  const address = server.address();
  assert.ok(address && typeof address === "object");
  const base = `http://127.0.0.1:${address.port}`;
  await assert.rejects(fetchJson(`${base}/redirect`, "fixture-key"), {
    name: "ReadError",
    message: "The usage request could not be made.",
  });
  assert.equal(destination, false);
  // A header the platform will not send fails in the router's words, never
  // the platform's, which would quote the key.
  const header = await fetchJson(`${base}/ok`, "fixture\nprivate-key").catch(
    (e: unknown) => e,
  );
  assert.ok(header instanceof ReadError);
  assert.equal(header.message, "The usage request could not be made.");
  for (const [path, words] of [
    ["/denied", "The usage request failed (HTTP 401)."],
    ["/html", "The usage response was not JSON."],
  ] as const) {
    const failure = await fetchJson(`${base}${path}`, "fixture-key").catch(
      (e: unknown) => e,
    );
    assert.ok(failure instanceof ReadError);
    assert.equal(failure.message, words);
  }
  assert.deepEqual(await fetchJson(`${base}/ok`, "fixture-key"), {});
});

test("a provider request reads at most a megabyte and waits at most twelve seconds", async (t) => {
  assert.deepEqual(FETCH_LIMITS, { timeoutMs: 12_000, maxBytes: 1_000_000 });
  const held: ServerResponse[] = [];
  const server = createServer((req, res) => {
    if (req.url === "/large") {
      res.writeHead(200, { "content-type": "application/json" });
      // Eleven chunks of 100 kB, past the megabyte.
      const chunk = Buffer.alloc(100_000, 0x20);
      for (let i = 0; i < 11; i += 1) res.write(chunk);
      res.end("{}");
    } else held.push(res);
  });
  server.listen(0, "127.0.0.1");
  await once(server, "listening");
  t.after(
    () =>
      new Promise<void>((resolve) => {
        for (const res of held) res.destroy();
        server.close(() => resolve());
      }),
  );
  const address = server.address();
  assert.ok(address && typeof address === "object");
  const base = `http://127.0.0.1:${address.port}`;
  const failure = (promise: Promise<unknown>) =>
    promise.then(
      () => assert.fail("expected a failure"),
      (e: unknown) => e,
    );
  const large = await failure(fetchJson(`${base}/large`, "fixture-key"));
  assert.ok(large instanceof ReadError);
  assert.equal(large.message, "The usage response was too large.");
  // The same bound at a test's scale: a request that never answers ends
  // with the router's sentence well before the test's own two seconds.
  let guard: NodeJS.Timeout | undefined;
  const slow = await failure(
    Promise.race([
      fetchJson(
        `${base}/hang`,
        "fixture-key",
        {},
        {
          ...FETCH_LIMITS,
          timeoutMs: 50,
        },
      ),
      new Promise((_, reject) => {
        guard = setTimeout(() => reject(new Error("no time limit")), 2000);
      }),
    ]),
  );
  clearTimeout(guard);
  assert.ok(slow instanceof ReadError, String(slow));
  assert.equal(slow.message, "The usage request timed out.");
});

test("a source that fails with the provider's own text reads as the router's fixed sentence", async (t) => {
  const home = await fixtureHome(t);
  const leak = "private-provider-error";
  const codex = await createLoaders(
    home,
    {},
    io({
      readUsageRpc: async (_command, _args, protocol) => {
        if (protocol === "codex") throw new Error(leak);
        return codexHistory;
      },
    }),
  ).codex();
  assert.equal(codex.allowance, "unavailable");
  assert.equal(codex.notice, "Current limits could not be refreshed.");
  const openrouter = await createLoaders(
    home,
    {
      OPENROUTER_API_KEY: "fixture-api",
      OPENROUTER_MANAGEMENT_KEY: "fixture-management",
    },
    io({
      fetchJson: async (url) => {
        if (url.endsWith("/activity")) return { data: [] };
        throw new Error(leak);
      },
    }),
  ).openrouter();
  assert.equal(
    openrouter.notice,
    "The account balance could not be refreshed. Key usage could not be refreshed.",
  );
  assert.equal(JSON.stringify([codex, openrouter]).includes(leak), false);
});

test("Codex quota and history fail apart and keep their original times", async (t) => {
  const home = await fixtureHome(t);
  let time = now;
  let quota: unknown = codexQuota;
  let history: unknown = codexHistory;
  const readers = io({
    readUsageRpc: async (_command, args, protocol) => {
      assert.deepEqual(args, ["app-server", "--listen", "stdio://"]);
      if (quota === "refused" && protocol === "codex")
        throw new ReadError("Codex usage unavailable.");
      return protocol === "codex-usage" ? history : quota;
    },
    clock: () => time,
  });
  const load = createLoaders(home, {}, readers).codex;
  const first = await load();
  assert.equal(first.allowance, "ready");
  const activity = first.details[0];
  assert.ok(activity);
  assert.equal(metric(activity, "Lifetime tokens"), 120);
  assert.equal(first.notice, null);
  assert.equal(JSON.stringify(first).includes("private-"), false);

  time += 60_000;
  history = { error: "private-provider-error" };
  const badHistory = await load();
  assert.equal(badHistory.windows[0]?.usedPercent, 25);
  assert.equal(badHistory.observedAt, time);
  assert.equal(badHistory.details[0]?.observedAt, now);
  assert.equal(badHistory.details[0]?.status, "stale");
  assert.equal(badHistory.notice, "Token activity could not be refreshed.");

  quota = {};
  history = codexHistory;
  time += 60_000;
  const badQuota = await load();
  assert.equal(badQuota.allowance, "stale");
  assert.equal(badQuota.observedAt, now + 60_000);
  assert.equal(badQuota.details[0]?.observedAt, time);
  assert.equal(badQuota.details[0]?.status, "ready");
  assert.match(badQuota.notice ?? "", /did not return subscription usage/);

  // A fresh loader whose limits were refused reads history alone.
  quota = "refused";
  const historyOnly = await createLoaders(home, {}, readers).codex();
  assert.equal(historyOnly.allowance, "unavailable");
  assert.deepEqual(historyOnly.windows, []);
  assert.equal(historyOnly.details.length, 1);
  assert.equal(historyOnly.notice, "Codex usage unavailable.");
  // And with nothing at all, the account says why.
  history = {};
  await assert.rejects(createLoaders(home, {}, readers).codex(), {
    message: "Codex usage unavailable.",
  });
});

test("the store reports history alone as unavailable and ages the detail apart", async (t) => {
  const home = await fixtureHome(t);
  let time = now;
  let quota: unknown = {};
  const load = createLoaders(
    home,
    {},
    io({
      readUsageRpc: async (_c, _a, protocol) =>
        protocol === "codex-usage" ? codexHistory : quota,
      clock: () => time,
    }),
  ).codex;
  const store = createUsageStore({ codex: load }, () => time);
  await store.refresh();
  const at = (t: number) => snapshot(store.state().accounts, t)[0];
  assert.equal(at(time)?.status, "unavailable");
  assert.equal(at(time)?.reading?.details[0]?.status, "ready");
  time += 11 * 60_000;
  assert.equal(at(time)?.status, "unavailable");
  assert.equal(at(time)?.reading?.details[0]?.status, "stale");
  quota = codexQuota;
  await store.refresh();
  assert.equal(at(time)?.status, "ready");
});

test("Claude reads Claude Code's credential file, says when it expired, and never uses an inherited token", async (t) => {
  const home = await fixtureHome(t);
  await mkdir(join(home, ".claude"));
  const credentials = join(home, ".claude/.credentials.json");
  const used: string[] = [];
  let answer: unknown = { five_hour: { utilization: 0 } };
  const readers = io({
    fetchJson: async (url, key, headers) => {
      assert.equal(url, "https://api.anthropic.com/api/oauth/usage");
      assert.equal(headers?.["anthropic-beta"], "oauth-2025-04-20");
      used.push(key);
      if (answer instanceof Error) throw answer;
      return answer;
    },
  });
  const inherited = { CLAUDE_CODE_OAUTH_TOKEN: "agent-token" };
  const load = createLoaders(home, inherited, readers).claude;
  await assert.rejects(load(), {
    message: "No Claude login on this host. Open Claude Code and run /login.",
  });
  await writeFile(
    credentials,
    JSON.stringify({
      claudeAiOauth: {
        accessToken: "file-token",
        refreshToken: "never-used",
        expiresAt: now + 3_600_000,
      },
    }),
  );
  const reading = await load();
  assert.equal(reading.windows[0]?.usedPercent, 0);
  assert.equal(reading.observedAt, now);
  assert.equal(JSON.stringify(reading).includes("token"), false);
  await writeFile(
    credentials,
    JSON.stringify({
      claudeAiOauth: { accessToken: "file-token", expiresAt: now - 1 },
    }),
  );
  await assert.rejects(load(), {
    message: "Claude login expired; open Claude Code.",
  });
  // No variable stands in for the file, so its expiry always applies.
  await assert.rejects(
    createLoaders(
      home,
      { ...inherited, ROUTER_CLAUDE_OAUTH_TOKEN: "router-token" },
      readers,
    ).claude(),
    { message: "Claude login expired; open Claude Code." },
  );
  // CLAUDE_CONFIG_DIR moves the file, as it does for Claude Code.
  const moved = join(home, "moved");
  await mkdir(moved);
  await writeFile(
    join(moved, ".credentials.json"),
    JSON.stringify({
      claudeAiOauth: { accessToken: "moved-token", expiresAt: now + 60_000 },
    }),
  );
  await createLoaders(home, { CLAUDE_CONFIG_DIR: moved }, readers).claude();
  assert.deepEqual(used, ["file-token", "moved-token"]);
  assert.ok(!used.includes("agent-token"));
  assert.ok(!used.includes("never-used"));
  // A provider's error never becomes the message.
  answer = new Error("private provider error");
  await writeFile(
    credentials,
    JSON.stringify({ claudeAiOauth: { accessToken: "file-token" } }),
  );
  const store = createUsageStore({ claude: load }, () => now);
  await store.refresh();
  assert.equal(
    store.state().accounts[0]?.error,
    "Could not refresh. Open Claude Code and run /login, then /usage.",
  );
});

test("DeepSeek takes its key from the environment or Pi's auth.json, never a credential helper", async (t) => {
  const home = await fixtureHome(t);
  const keys: string[] = [];
  const readers = io({
    fetchJson: async (url, key) => {
      assert.equal(url, "https://api.deepseek.com/user/balance");
      keys.push(key);
      return { balance_infos: [{ currency: "USD", total_balance: "1" }] };
    },
  });
  await assert.rejects(createLoaders(home, {}, readers).deepseek(), {
    message:
      "No DeepSeek API key on this host: set DEEPSEEK_API_KEY or add one to Pi's auth.json.",
  });
  await mkdir(join(home, ".pi/agent"), { recursive: true });
  const auth = join(home, ".pi/agent/auth.json");
  await writeFile(
    auth,
    JSON.stringify({ deepseek: { type: "api_key", key: "!pass show x" } }),
  );
  await assert.rejects(
    createLoaders(home, {}, readers).deepseek(),
    /No DeepSeek/,
  );
  await writeFile(
    auth,
    JSON.stringify({ deepseek: { type: "api_key", key: "pi-key" } }),
  );
  await createLoaders(home, {}, readers).deepseek();
  await createLoaders(
    home,
    { DEEPSEEK_API_KEY: "env-key" },
    readers,
  ).deepseek();
  // A key with a control character in it is no key: Pi's is used instead.
  for (const bad of ["env\u0007key", "env\tkey", "env\u007fkey"])
    await createLoaders(home, { DEEPSEEK_API_KEY: bad }, readers).deepseek();
  assert.deepEqual(keys, ["pi-key", "env-key", "pi-key", "pi-key", "pi-key"]);
});

test("OpenRouter without a management key reads the key alone and says what the balance needs, as the fixture shows it", async (t) => {
  const home = await fixtureHome(t);
  const readers = io({
    fetchJson: async (url, key) => {
      assert.equal(url, "https://openrouter.ai/api/v1/key");
      assert.equal(key, "fixture-api");
      return openrouterPayloads.key;
    },
    clock: () => NOW,
  });
  const reading = await createLoaders(
    home,
    { OPENROUTER_API_KEY: "fixture-api" },
    readers,
  ).openrouter();
  assert.deepEqual(reading, openrouterKeyOnly(NOW));
  assert.equal(reading.allowance, "ready");
  await assert.rejects(createLoaders(home, {}, readers).openrouter(), {
    message:
      "No OpenRouter key on this host: set OPENROUTER_API_KEY or add one to Pi's auth.json, and OPENROUTER_MANAGEMENT_KEY for the account.",
  });
});

test("OpenRouter with a management key reads credits, key and spending, as the fixture shows it", async (t) => {
  const home = await fixtureHome(t);
  const reading = await createLoaders(
    home,
    {
      OPENROUTER_API_KEY: "fixture-api",
      OPENROUTER_MANAGEMENT_KEY: "fixture-management",
    },
    io({
      fetchJson: async (url, key) => {
        const name = new URL(url).pathname.split("/").at(-1) ?? "";
        assert.equal(
          key,
          name === "key" ? "fixture-api" : "fixture-management",
        );
        return openrouterPayloads[name as keyof typeof openrouterPayloads];
      },
      clock: () => NOW,
    }),
  ).openrouter();
  assert.deepEqual(reading, openrouterManaged(NOW));
});

test("OpenRouter with a management key alone says the credits' own reason when nothing reads", async (t) => {
  const home = await fixtureHome(t);
  const load = createLoaders(
    home,
    { OPENROUTER_MANAGEMENT_KEY: "fixture-management" },
    io({
      fetchJson: async () => {
        throw new ReadError("The usage request failed (HTTP 401).");
      },
    }),
  ).openrouter;
  const store = createUsageStore({ openrouter: load }, () => now);
  await store.refresh();
  assert.equal(
    store.state().accounts[0]?.error,
    "The usage request failed (HTTP 401).",
  );
});

test("OpenRouter key, credits and history keep their values apart, including history alone", async (t) => {
  const home = await fixtureHome(t);
  let time = now;
  const payloads: Record<string, unknown> = {
    key: { data: { usage_daily: 2, limit_remaining: 8 } },
    credits: { data: { total_credits: 20, total_usage: 5 } },
    activity: { data: [{ date: "2026-09-11", usage: 3 }] },
  };
  const readers = io({
    clock: () => time,
    fetchJson: async (url) => {
      const name = new URL(url).pathname.split("/").at(-1) ?? "";
      return payloads[name];
    },
  });
  const env = {
    OPENROUTER_API_KEY: "fixture-api",
    OPENROUTER_MANAGEMENT_KEY: "fixture-management",
  };
  const load = createLoaders(home, env, readers).openrouter;
  const first = await load();
  assert.equal(metric(first, "Account balance"), 15);
  payloads.activity = {};
  time += 60_000;
  const noHistory = await load();
  assert.equal(noHistory.allowance, "ready");
  assert.equal(noHistory.details[0]?.status, "stale");
  assert.equal(noHistory.details[0]?.observedAt, now);
  assert.equal(
    noHistory.notice,
    "Model & provider spending could not be refreshed.",
  );
  payloads.credits = {};
  payloads.key = { data: { usage_daily: 4 } };
  payloads.activity = { data: [{ date: "2026-09-12", usage: 5 }] };
  time += 60_000;
  const noCredits = await load();
  assert.equal(metric(noCredits, "Account balance"), 15);
  assert.equal(metric(noCredits, "Key spend today"), 4);
  assert.equal(noCredits.allowance, "stale");
  assert.equal(noCredits.observedAt, now + 60_000);
  assert.equal(noCredits.details[0]?.observedAt, time);
  assert.match(noCredits.notice ?? "", /did not return account or key usage/);
  payloads.key = {};
  const onlyHistory = await createLoaders(home, env, readers).openrouter();
  assert.equal(onlyHistory.allowance, "unavailable");
  assert.deepEqual(onlyHistory.metrics, []);
  const spending = onlyHistory.details[0];
  assert.ok(spending);
  assert.equal(metric(spending, "OpenRouter spend"), 5);
});
