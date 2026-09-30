// The guards on both HTTP surfaces, exercised over real sockets on port 0.
import test from "node:test";
import assert from "node:assert/strict";
import { createServer, type Server } from "node:http";
import { mkdtempSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import {
  bind,
  boardListener,
  eventsListener,
  sameSite,
  type Bindable,
  type Run,
} from "./server.ts";
import type { RouterConfig } from "./config.ts";
import type { Event } from "./types.ts";
import base from "./example-config.ts";

const home = mkdtempSync(join(tmpdir(), "server-"));
const config: RouterConfig = {
  ...base,
  home,
  hosts: { mbp: { paseo: "ws://x", replyCommand: "router" } },
  agents: { "orchestrator@mbp": "A1" },
  serve: {
    listen: "127.0.0.1:0",
    board: "127.0.0.1:0",
    identities: { "me@example.com": ["you", "operator"] },
  },
  jev: { model: "jev-latest" },
};

const handled: Event[] = [];
const handle = (event: Event): Promise<Run> => {
  handled.push(event);
  return Promise.resolve({
    outcome: { ok: true, message: `handled ${event.type}` },
    report: ["delivered"],
  });
};

async function serve(server: Server): Promise<string> {
  await new Promise<void>((resolve) =>
    server.listen(0, "127.0.0.1", () => resolve()),
  );
  const address = server.address();
  if (address === null || typeof address === "string")
    throw new Error("no port");
  return `http://127.0.0.1:${address.port}`;
}

test("events: health is open, everything else needs the exact token", async () => {
  const server = createServer(eventsListener({ config, handle }, "secret"));
  const url = await serve(server);
  try {
    assert.equal((await fetch(`${url}/health`)).status, 200);
    const post = (
      headers: Record<string, string>,
      body: string,
      path = "/events",
    ) => fetch(url + path, { method: "POST", headers, body });
    assert.equal((await post({}, "{}")).status, 401);
    assert.equal(
      (await post({ authorization: "Bearer secre" }, "{}")).status,
      401,
    );
    assert.equal(
      (await post({ authorization: "Bearer secretx" }, "{}")).status,
      401,
    );
    const auth = { authorization: "Bearer secret" };
    assert.equal((await post(auth, "{}", "/other")).status, 404);
    assert.equal((await post(auth, "{nope")).status, 400);
    const forbidden = await post(
      auth,
      JSON.stringify({ type: "submit", by: "you", text: "x" }),
    );
    assert.equal(forbidden.status, 400);
    assert.equal(
      ((await forbidden.json()) as { code: string }).code,
      "bad_event",
    );
    assert.equal(handled.length, 0);
    const ok = await post(
      auth,
      JSON.stringify({
        type: "update",
        by: "A1",
        taskId: "T1",
        messageId: "m",
        inReplyTo: "M1",
        kind: "completed",
      }),
    );
    assert.equal(ok.status, 200);
    assert.deepEqual(await ok.json(), {
      ok: true,
      message: "handled update",
      report: ["delivered"],
    });
    assert.equal(handled.length, 1);
  } finally {
    server.close();
  }
});

test("sameSite: browsers must come from the page; other clients pass", () => {
  assert.equal(sameSite({}), true);
  assert.equal(sameSite({ "sec-fetch-site": "same-origin" }), true);
  assert.equal(sameSite({ "sec-fetch-site": "none" }), true);
  assert.equal(sameSite({ "sec-fetch-site": "cross-site" }), false);
  assert.equal(sameSite({ "sec-fetch-site": "same-site" }), false);
  assert.equal(
    sameSite({
      origin: "https://mbp.example.ts.net",
      host: "mbp.example.ts.net",
    }),
    true,
  );
  assert.equal(
    sameSite({
      origin: "https://mbp.example.ts.net",
      "x-forwarded-host": "mbp.example.ts.net",
      host: "127.0.0.1:7678",
    }),
    true,
  );
  assert.equal(
    sameSite({ origin: "https://evil.example", host: "mbp.example.ts.net" }),
    false,
  );
  assert.equal(sameSite({ origin: "not a url", host: "x" }), false);
});

test("board: no identity or a forged site gets no action; a viewer's action runs and redirects", async () => {
  writeFileSync(
    join(home, "journal.jsonl"),
    `${JSON.stringify({ at: "t", event: { type: "tick", now: 1 } })}\n`,
  );
  const logged: string[] = [];
  const server = createServer(
    boardListener({ config, handle, log: (line) => logged.push(line) }),
  );
  const url = await serve(server);
  const before = handled.length;
  try {
    const post = (headers: Record<string, string>, body: string) =>
      fetch(`${url}/actions`, {
        method: "POST",
        headers: {
          "content-type": "application/x-www-form-urlencoded",
          ...headers,
        },
        body,
        redirect: "manual",
      });
    const me = { "tailscale-user-login": "me@example.com" };
    assert.equal((await post({}, "action=cancel&task=T1")).status, 403);
    assert.equal(
      (
        await post(
          { "tailscale-user-login": "x@example.com" },
          "action=cancel&task=T1",
        )
      ).status,
      403,
    );
    assert.equal(
      (
        await post(
          { ...me, "sec-fetch-site": "cross-site" },
          "action=cancel&task=T1",
        )
      ).status,
      403,
    );
    assert.equal(
      (
        await post(
          { ...me, origin: "https://evil.example" },
          "action=cancel&task=T1",
        )
      ).status,
      403,
    );
    assert.equal(handled.length, before);
    const bad = await post(
      { ...me, "sec-fetch-site": "same-origin" },
      "action=choose&task=T1",
    );
    assert.equal(bad.status, 303);
    assert.equal(bad.headers.get("location"), "./?notice=Missing%20to.");
    assert.equal(handled.length, before);
    const good = await post(
      { ...me, "sec-fetch-site": "same-origin" },
      "action=cancel&task=T1",
    );
    assert.equal(good.status, 303);
    assert.equal(good.headers.get("location"), "./?notice=handled%20cancel");
    assert.deepEqual(handled.at(-1), {
      type: "cancel",
      by: "you",
      taskId: "T1",
    });
    assert.match(logged.at(-1) ?? "", /me@example.com/);
    // Reads: the page, the JSON, whoami, and the redirect to the slash form.
    const page = await fetch(`${url}/`, { headers: me });
    assert.equal(page.status, 200);
    assert.match(await page.text(), /Acting as me@example.com/);
    const anonymous = await (await fetch(`${url}/`)).text();
    assert.match(anonymous, /Read only/);
    assert.ok(!anonymous.includes("<form"));
    const json = (await (await fetch(`${url}/board.json`)).json()) as {
      open: unknown[];
    };
    assert.deepEqual(json.open, []);
    const who = (await (
      await fetch(`${url}/whoami`, { headers: me })
    ).json()) as { login: string };
    assert.equal(who.login, "me@example.com");
    const moved = await fetch(`${url}/router`, { redirect: "manual" });
    assert.equal(moved.status, 302);
    assert.equal(moved.headers.get("location"), "/router/");
    assert.equal((await fetch(`${url}/`, { method: "PUT" })).status, 405);
  } finally {
    server.close();
  }
});

test("board: a record the code cannot replay is a 500, not a crash", async () => {
  const broken = mkdtempSync(join(tmpdir(), "server-broken-"));
  writeFileSync(
    join(broken, "journal.jsonl"),
    `${JSON.stringify({ at: "t", event: { type: "attempt", deliveryId: "D9" } })}\n`,
  );
  const server = createServer(
    boardListener({ config: { ...config, home: broken }, handle }),
  );
  const url = await serve(server);
  try {
    const page = await fetch(`${url}/`);
    assert.equal(page.status, 500);
    assert.match(await page.text(), /cannot be read/);
    // The process is still serving.
    assert.equal((await fetch(`${url}/whoami`)).status, 200);
  } finally {
    server.close();
  }
});

test("bind: a taken port is one sentence; an absent address is waited for, then given up", async () => {
  const first = createServer();
  const url = await serve(first);
  const port = new URL(url).port;
  try {
    await assert.rejects(
      bind(createServer(), `127.0.0.1:${port}`, "board"),
      /board address 127\.0\.0\.1:\d+ is in use\. Is router serve already running\?/,
    );
  } finally {
    first.close();
  }
  // 192.0.2.1 is documentation space and on no interface here.
  await assert.rejects(
    bind(createServer(), "192.0.2.1:0", "events", { waitMs: 0 }),
    /events cannot listen on 192\.0\.2\.1:0: .*EADDRNOTAVAIL/,
  );
  // Until the deadline, EADDRNOTAVAIL is retried and reported once.
  let attempts = 0;
  const lines: string[] = [];
  const slept: number[] = [];
  const late: Bindable = {
    listen: (_port, _host, ready) => {
      attempts += 1;
      if (attempts < 3) {
        const error = Object.assign(new Error("listen EADDRNOTAVAIL"), {
          code: "EADDRNOTAVAIL",
        });
        setImmediate(() => handler?.(error));
      } else setImmediate(ready);
    },
    once: (_event, h) => (handler = h),
    removeListener: () => (handler = undefined),
  };
  let handler: ((error: Error) => void) | undefined;
  let clock = 0;
  await bind(late, "[::1]:7677", "events", {
    waitMs: 10_000,
    pollMs: 2_000,
    log: (line) => lines.push(line),
    now: () => clock,
    sleep: (ms) => {
      slept.push(ms);
      clock += ms;
      return Promise.resolve();
    },
  });
  assert.equal(attempts, 3);
  assert.deepEqual(slept, [2_000, 2_000]);
  assert.deepEqual(lines, [
    "The events address [::1]:7677 is not on this host yet; waiting.",
  ]);
});
