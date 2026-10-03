// The guards on both HTTP surfaces, exercised over real sockets on port 0.
import test from "node:test";
import assert from "node:assert/strict";
import { createServer, type Server } from "node:http";
import { mkdtempSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import {
  bind,
  BindError,
  boardListener,
  eventsListener,
  sameSite,
  type Bindable,
  type BindOptions,
  type Run,
} from "./server.ts";
import { BOARD_VERSION } from "./board.ts";
import { config as fixture, journal, NOW } from "./board-fixture.ts";
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

const isRecord = (value: unknown): value is Record<string, unknown> =>
  value !== null && typeof value === "object" && !Array.isArray(value);

// A JSON body as the object a consumer reads fields from.
async function jsonObject(res: Response): Promise<Record<string, unknown>> {
  const body: unknown = await res.json();
  assert.ok(isRecord(body), "a JSON object");
  return body;
}

const taskIds = (list: unknown): unknown[] => {
  assert.ok(Array.isArray(list));
  return list.map((task: unknown) => (isRecord(task) ? task.id : undefined));
};

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

test("board: asked for JSON, the board serves its model, identified as the page is", async () => {
  const record = mkdtempSync(join(tmpdir(), "server-model-"));
  writeFileSync(
    join(record, "journal.jsonl"),
    journal.map((entry) => `${JSON.stringify(entry)}\n`).join(""),
  );
  const server = createServer(
    boardListener({
      config: { ...fixture, home: record },
      handle,
      now: () => NOW,
    }),
  );
  const url = await serve(server);
  const json = { accept: "application/json" };
  const me = { "tailscale-user-login": "me@example.com" };
  try {
    // Nobody identified: the model, with no actor.
    const anonymous = await fetch(`${url}/`, { headers: json });
    assert.equal(anonymous.status, 200);
    assert.equal(anonymous.headers.get("content-type"), "application/json");
    const nobody = await jsonObject(anonymous);
    assert.equal(nobody.version, BOARD_VERSION);
    assert.equal(nobody.actor, null);
    const stranger = await fetch(`${url}/`, {
      headers: { ...json, "tailscale-user-login": "x@example.com" },
    });
    assert.equal((await jsonObject(stranger)).actor, null);
    // A known login: who it is and the role of each of its principals.
    const mine = await jsonObject(
      await fetch(`${url}/`, { headers: { ...json, ...me } }),
    );
    assert.deepEqual(mine.actor, {
      login: "me@example.com",
      principals: [
        { principal: "you", role: "requester" },
        { principal: "operator", role: "operator" },
      ],
    });
    // board.json is the same model under the same identity.
    assert.deepEqual(
      await jsonObject(await fetch(`${url}/board.json`, { headers: me })),
      mine,
    );
    // The page and the JSON for the same request: one time, one task list.
    const page = await fetch(`${url}/`, { headers: me });
    assert.equal(page.headers.get("content-type"), "text/html; charset=utf-8");
    const html = await page.text();
    const at = mine.at;
    assert.ok(typeof at === "string");
    assert.equal(at, new Date(NOW).toISOString());
    assert.ok(html.includes(`Updated ${at.slice(11, 16)}Z`));
    assert.deepEqual(
      [...html.matchAll(/<details class="thread" id="t-(T\d+)"/g)]
        .map((m) => m[1])
        .sort(),
      [...taskIds(mine.open), ...taskIds(mine.finished)].sort(),
    );
    // JSON when it is ranked above HTML, or ranked equal and named more
    // exactly; a browser gets the page.
    const served = async (accept: string): Promise<string | null> => {
      const res = await fetch(`${url}/`, { headers: { accept } });
      await res.arrayBuffer();
      return res.headers.get("content-type");
    };
    assert.equal(
      await served(
        "text/html,application/xhtml+xml,application/xml;q=0.9,*/*;q=0.8",
      ),
      "text/html; charset=utf-8",
    );
    assert.equal(await served("*/*"), "text/html; charset=utf-8");
    assert.equal(
      await served("application/json, text/html"),
      "text/html; charset=utf-8",
    );
    assert.equal(
      await served("text/html;q=0.5, application/json"),
      "application/json",
    );
    // A client that names JSON and accepts anything else, as axios does.
    assert.equal(
      await served("application/json, text/plain, */*"),
      "application/json",
    );
    assert.equal(await served("text/*, application/json"), "application/json");
    assert.equal(
      await served("application/*, text/html"),
      "text/html; charset=utf-8",
    );
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

test(
  "bind: a taken port is permanent; an absent address is waited for, then given up as transient",
  { timeout: 10_000 },
  async () => {
    const first = createServer();
    const url = await serve(first);
    const port = new URL(url).port;
    const second = createServer();
    const third = createServer();
    try {
      await assert.rejects(
        bind(second, `127.0.0.1:${port}`, "board"),
        (error: unknown) =>
          error instanceof BindError &&
          !error.transient &&
          /^The board address 127\.0\.0\.1:\d+ is in use\. Is router serve already running\?$/.test(
            error.message,
          ),
      );
      // 192.0.2.1 is documentation space and on no interface here.
      await assert.rejects(
        bind(third, "192.0.2.1:0", "events", { waitMs: 0 }),
        (error: unknown) =>
          error instanceof BindError &&
          error.transient &&
          error.message ===
            "The events address 192.0.2.1:0 did not appear within 0s.",
      );
    } finally {
      first.close();
      second.close();
      third.close();
    }
    // A fake server that models Node: listeners stay attached after a
    // failed listen unless removed. It fails `failures` times, then binds.
    const fake = (
      failures: number,
    ): Bindable & { attempts: number; attached: () => number } => {
      const handlers = new Map<string, Set<(error?: Error) => void>>();
      const emit = (event: string, error?: Error): void => {
        for (const handler of handlers.get(event) ?? []) handler(error);
      };
      const server = {
        attempts: 0,
        attached: () =>
          [...handlers.values()].reduce((n, set) => n + set.size, 0),
        listen: () => {
          server.attempts += 1;
          const error = Object.assign(new Error("listen EADDRNOTAVAIL"), {
            code: "EADDRNOTAVAIL",
          });
          setImmediate(() =>
            server.attempts <= failures
              ? emit("error", error)
              : emit("listening"),
          );
        },
        once: (event: string, handler: (error?: Error) => void) => {
          handlers.set(event, (handlers.get(event) ?? new Set()).add(handler));
        },
        removeListener: (event: string, handler: (error?: Error) => void) => {
          handlers.get(event)?.delete(handler);
        },
      };
      return server;
    };
    const clock = (): BindOptions & { lines: string[]; slept: number[] } => {
      let t = 0;
      const o = {
        lines: [] as string[],
        slept: [] as number[],
        waitMs: 5_000,
        pollMs: 2_000,
        log: (line: string) => o.lines.push(line),
        now: () => t,
        sleep: (ms: number) => {
          o.slept.push(ms);
          t += ms;
          return Promise.resolve();
        },
      };
      return o;
    };
    // Two failures, then the address is there: reported once.
    const late = fake(2);
    const a = clock();
    await bind(late, "[::1]:7677", "events", a);
    assert.equal(late.attempts, 3);
    assert.deepEqual(a.slept, [2_000, 2_000]);
    assert.deepEqual(a.lines, [
      "The events address [::1]:7677 is not on this host yet; waiting.",
    ]);
    assert.equal(late.attached(), 0, "no listener left behind");
    // Never there: retried until the deadline, then given up as transient.
    const never = fake(Infinity);
    const b = clock();
    await assert.rejects(
      bind(never, "[::1]:7677", "events", b),
      (error: unknown) => error instanceof BindError && error.transient,
    );
    assert.equal(never.attempts, 4, "0s, 2s, 4s, and once past 5s");
    assert.equal(b.lines.length, 1);
    assert.equal(never.attached(), 0);
  },
);
