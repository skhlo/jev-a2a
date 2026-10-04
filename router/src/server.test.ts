// The guards on both HTTP surfaces, exercised over real sockets on port 0.
import test from "node:test";
import assert from "node:assert/strict";
import { createServer, type Server } from "node:http";
import { existsSync, mkdtempSync, readFileSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import {
  bind,
  BindError,
  boardListener,
  eventsListener,
  sameSite,
  serveRunner,
  sessionReader,
  waitsReader,
  type Bindable,
  type BindOptions,
  type Run,
  type SessionStatus,
} from "./server.ts";
import { BOARD_VERSION } from "./board.ts";
import {
  config as fixture,
  extend,
  journal,
  NOW,
  replacedJournal,
  telemetry,
} from "./board-fixture.ts";
import type { RouterConfig } from "./config.ts";
import { writeTelemetry } from "./telemetry.ts";
import type { Entry } from "./journal.ts";
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
    wake: 0,
    poll: 0,
  },
  jev: { model: "jev-latest" },
  telemetry: { sheet: true },
};

// Every caller is a current session unless a test says otherwise.
const sessionOf = (): SessionStatus => "current";

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
  const server = createServer(
    eventsListener({ config, handle, sessionOf }, "secret"),
  );
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
    // Events the serve endpoint does not take: the core's own events that a
    // client has no business sending, like a tick or a configuration.
    const forbidden = await post(
      auth,
      JSON.stringify({ type: "tick", now: 1 }),
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
    // A participant's own requests and choices pass the same gate; the
    // core decides whether the session may make them.
    for (const event of [
      { type: "submit", by: "A1", messageId: "m2", text: "x", to: "incus" },
      { type: "choose", by: "A1", taskId: "T2", to: "incus" },
    ]) {
      const res = await post(auth, JSON.stringify(event));
      assert.equal(res.status, 200);
      assert.equal(handled.at(-1)?.type, event.type);
    }
    assert.equal(handled.length, 3);
    // The shell's own events stay out, whoever signs them.
    const attempt = await post(
      auth,
      JSON.stringify({ type: "attempt", deliveryId: "D1" }),
    );
    assert.equal(attempt.status, 400);
    assert.match(
      String(((await attempt.json()) as { message: string }).message),
      /serve accepts submit, choose, update and answer events/,
    );
    assert.equal(handled.length, 3);
  } finally {
    server.close();
  }
});

test("events: a person is refused; a replaced session may reply and answer but not submit or choose", async () => {
  const seen: Event[] = [];
  const server = createServer(
    eventsListener(
      {
        config,
        handle: (event) => {
          seen.push(event);
          return handle(event);
        },
        sessionOf: (by) =>
          by === "A1" ? "current" : by === "A0" ? "replaced" : null,
      },
      "secret",
    ),
  );
  const url = await serve(server);
  const post = (event: Record<string, unknown>) =>
    fetch(`${url}/events`, {
      method: "POST",
      headers: { authorization: "Bearer secret" },
      body: JSON.stringify(event),
    });
  try {
    const refused = [
      // The shared token acting as the person, or as nobody.
      { type: "submit", by: "you", messageId: "m", text: "x" },
      {
        type: "answer",
        by: "you",
        taskId: "T1",
        messageId: "m",
        questionId: "Q",
      },
      { type: "submit", messageId: "m", text: "x" },
      // A replaced session asking for new work.
      { type: "choose", by: "A0", taskId: "T1", to: "incus" },
      { type: "submit", by: "A0", messageId: "m", text: "x" },
    ];
    for (const event of refused) {
      const res = await post(event);
      assert.equal(res.status, 403, JSON.stringify(event));
      assert.partialDeepStrictEqual(await res.json(), {
        ok: false,
        code: "unauthenticated",
      });
    }
    assert.equal(seen.length, 0);
    // A replaced session finishing its work still reaches the core, which
    // knows whether that session holds the delivery.
    const passed = [
      {
        type: "update",
        by: "A0",
        taskId: "T1",
        messageId: "m",
        inReplyTo: "M",
        kind: "completed",
      },
      {
        type: "answer",
        by: "A0",
        taskId: "T1",
        messageId: "m",
        questionId: "Q",
      },
      { type: "submit", by: "A1", messageId: "m", text: "x", to: "incus" },
    ];
    for (const event of passed)
      assert.equal((await post(event)).status, 200, JSON.stringify(event));
    assert.equal(seen.length, 3);
  } finally {
    server.close();
  }
});

test("sessionReader: reads the record without the journal lock and tells a current session from a replaced one", () => {
  const record = mkdtempSync(join(tmpdir(), "server-sessions-"));
  writeFileSync(
    join(record, "journal.jsonl"),
    replacedJournal.map((entry) => `${JSON.stringify(entry)}\n`).join(""),
  );
  const sessionOf = sessionReader({ ...fixture, home: record });
  assert.equal(sessionOf("A1"), "current");
  assert.equal(sessionOf("K2"), "current");
  assert.equal(sessionOf("K1"), "replaced");
  assert.equal(sessionOf("you"), null);
  assert.equal(sessionOf(""), null);
  // Nothing was written: the record is as long as the fixture.
  assert.equal(
    readFileSync(join(record, "journal.jsonl"), "utf8").split("\n").length,
    replacedJournal.length + 1,
  );
  assert.ok(!existsSync(join(record, "journal.lock")));
});

test("waitsReader: reads the record without the lock and says whether a served session is worth looking at again", () => {
  const record = mkdtempSync(join(tmpdir(), "server-waits-"));
  const write = (entries: Entry[]): void =>
    writeFileSync(
      join(record, "journal.jsonl"),
      entries.map((entry) => `${JSON.stringify(entry)}\n`).join(""),
    );
  const waits = waitsReader({ ...fixture, home: record });
  // The fixture: a question open, a session working, a placement held.
  // Nothing there moves by looking again.
  write(journal);
  assert.equal(waits(), false);
  // A request queued for the busy knowledge session does.
  write(
    extend({
      type: "submit",
      by: "you",
      messageId: "M9",
      text: "Later",
      to: "knowledge",
    }),
  );
  assert.equal(waits(), true);
  // The same request to a placement this router does not serve does not.
  write(
    extend({
      type: "submit",
      by: "you",
      messageId: "M9",
      text: "Later",
      to: "incus",
    }),
  );
  assert.equal(waits(), false);
  assert.ok(!existsSync(join(record, "journal.lock")));
});

// A runner over fake timers, a fake watcher and a scripted shell: what each
// run does is a list of strings, and `waits` scripts the state after it.
function fakeRunner(script: {
  waits: () => boolean;
  recordWaits?: () => boolean;
  fail?: () => Error | null;
  // Whether the core rejects the next event.
  reject?: () => boolean;
  delayMs?: number;
  pollMs?: number;
  // The run's report; the default has an observation, a wait and a change.
  report?: () => string[];
}) {
  const pending: { fn: () => void; ms: number }[] = [];
  const timers = {
    set: (fn: () => void, ms: number) => {
      const handle = { fn, ms };
      pending.push(handle);
      return handle;
    },
    clear: (handle: { fn: () => void; ms: number }) => {
      const at = pending.indexOf(handle);
      if (at >= 0) pending.splice(at, 1);
    },
  };
  const log: string[] = [];
  const runs: (string | null)[] = [];
  let release: (() => void) | null = null;
  let change: (() => void) | null = null;
  const runner = serveRunner({
    open: () => {
      const failure = script.fail?.() ?? null;
      if (failure) return Promise.reject(failure);
      return Promise.resolve({
        apply: (event: Event) => {
          runs.push(event.type);
          return script.reject?.()
            ? { ok: false as const, code: "invalid", message: "no" }
            : { ok: true as const, message: `applied ${event.type}` };
        },
        deliver: async () => {
          // A run holds until the test releases it, so a journal change
          // during a run can be simulated.
          await new Promise<void>((resolve) => {
            release = resolve;
          });
          release = null;
          return (
            script.report?.() ?? [
              "orchestrator@mbp: idle",
              "D1 waits: not ready",
              "Recorded D2/M2 as attempting to A1 before calling the adapter.",
            ]
          );
        },
        waits: script.waits,
        close: () => Promise.resolve(),
      });
    },
    delayMs: script.delayMs ?? 20_000,
    pollMs: script.pollMs ?? 0,
    waits: script.recordWaits ?? (() => false),
    log: (line) => log.push(line),
    watch: (onChange) => {
      change = onChange;
      return { close: () => (change = null) };
    },
    timers,
    settleMs: 500,
  });
  // Lets the queued promise chain advance.
  const settle = async (): Promise<void> => {
    for (let i = 0; i < 6; i++) await Promise.resolve();
  };
  const finishRun = async (): Promise<void> => {
    await settle();
    assert.ok(release, "a run is in progress");
    (release as () => void)();
    await settle();
  };
  // Fires the next armed timer (the wake, the poll or the watcher's
  // settle), or the one with the given delay.
  const fire = async (ms?: number): Promise<void> => {
    const at = ms === undefined ? 0 : pending.findIndex((t) => t.ms === ms);
    assert.ok(at >= 0, `a ${ms}ms timer was armed`);
    const next = pending.splice(at, 1)[0];
    assert.ok(next, "a timer was armed");
    next.fn();
    await settle();
  };
  return {
    runner,
    pending,
    log,
    settle,
    timers: () => pending.map((t) => t.ms),
    inRun: () => release !== null,
    finishRun,
    fire,
    journalChanged: () => {
      assert.ok(change, "the watcher is in place");
      (change as () => void)();
    },
  };
}

test("runner: an event run arms one look while work waits; the look runs deliver only and re-arms until nothing waits", async () => {
  let waiting = true;
  const f = fakeRunner({ waits: () => waiting });
  const handled = f.runner.handle({
    type: "submit",
    by: "you",
    messageId: "M1",
    text: "x",
  });
  await f.finishRun();
  const run = await handled;
  assert.equal(run.outcome.message, "applied submit");
  assert.deepEqual(f.timers(), [20_000], "one look armed");
  // The look: no event, deliver, logs only what changed.
  await f.fire();
  assert.ok(f.inRun());
  assert.deepEqual(f.timers(), [], "nothing armed while the look runs");
  await f.finishRun();
  assert.deepEqual(f.log, [
    "wake: Recorded D2/M2 as attempting to A1 before calling the adapter.",
  ]);
  assert.deepEqual(f.timers(), [20_000], "armed again from the run's end");
  // The run that finds nothing waiting leaves the loop quiet.
  waiting = false;
  await f.fire();
  await f.finishRun();
  assert.deepEqual(f.timers(), []);
  f.runner.stop();
});

test("runner: a look logs a telemetry complaint once while it lasts, and again after a run without it", async () => {
  let lines = [
    "orchestrator@mbp: idle",
    "telemetry: orchestrator@mbp: activity of A1 not read: timeline gone",
    "telemetry not written: EISDIR",
  ];
  const f = fakeRunner({ waits: () => true, report: () => lines });
  f.runner.start();
  await f.settle();
  await f.finishRun();
  await f.fire();
  await f.finishRun();
  assert.deepEqual(f.log, [
    "start: telemetry: orchestrator@mbp: activity of A1 not read: timeline gone",
    "start: telemetry not written: EISDIR",
  ]);
  // One complaint clears: the other is still not repeated.
  lines = lines.slice(0, 2);
  await f.fire();
  await f.finishRun();
  assert.equal(f.log.length, 2);
  // A clean run resets: the complaint is news again when it returns.
  lines = ["orchestrator@mbp: idle"];
  await f.fire();
  await f.finishRun();
  lines = [
    "telemetry: orchestrator@mbp: activity of A1 not read: timeline gone",
  ];
  await f.fire();
  await f.finishRun();
  assert.deepEqual(f.log.slice(2), [
    "wake: telemetry: orchestrator@mbp: activity of A1 not read: timeline gone",
  ]);
  f.runner.stop();
});

test("runner: the journal watcher arms a look from the record when idle, and is ignored while a run is in progress", async () => {
  let recordWaits = false;
  const f = fakeRunner({ waits: () => false, recordWaits: () => recordWaits });
  f.runner.start();
  await f.settle();
  // The first run is in progress; it writes the journal too.
  assert.ok(f.inRun());
  f.journalChanged();
  assert.deepEqual(f.timers(), [500]);
  await f.fire(500);
  assert.deepEqual(f.timers(), [], "a change during a run does not arm");
  await f.finishRun();
  assert.deepEqual(f.log, [
    "start: Recorded D2/M2 as attempting to A1 before calling the adapter.",
  ]);
  assert.deepEqual(f.timers(), []);
  // The CLI appends: the record now waits, and the look is armed.
  recordWaits = true;
  f.journalChanged();
  f.journalChanged();
  assert.deepEqual(f.timers(), [500], "one settle timer for a burst");
  await f.fire(500);
  assert.deepEqual(f.timers(), [20_000]);
  f.journalChanged();
  await f.fire(500);
  assert.deepEqual(f.timers(), [20_000], "never two looks");
  // stop clears everything and the watcher is closed.
  f.runner.stop();
  assert.deepEqual(f.timers(), []);
  assert.throws(() => f.journalChanged(), /watcher/);
});

test("runner: a look that fails is logged and tried again at the interval; a zero interval never looks", async () => {
  let fail: Error | null = null;
  const f = fakeRunner({ waits: () => true, fail: () => fail });
  const handled = f.runner.handle({
    type: "choose",
    by: "you",
    taskId: "T1",
    to: "x",
  });
  await f.finishRun();
  await handled;
  assert.deepEqual(f.timers(), [20_000]);
  fail = new Error("Another router run has held the journal");
  await f.fire();
  assert.deepEqual(f.log, ["wake: Another router run has held the journal"]);
  assert.deepEqual(f.timers(), [20_000], "armed again after the failure");
  f.runner.stop();

  const off = fakeRunner({ waits: () => true, delayMs: 0 });
  const h = off.runner.handle({
    type: "choose",
    by: "you",
    taskId: "T1",
    to: "x",
  });
  await off.finishRun();
  await h;
  assert.deepEqual(off.timers(), []);
  off.runner.stop();
});

test("runner: the poll runs after any run whether or not anything waits, is measured from each run's end, and stops with the runner", async () => {
  let waiting = false;
  const f = fakeRunner({ waits: () => waiting, pollMs: 30_000 });
  f.runner.start();
  await f.settle();
  assert.deepEqual(f.timers(), [], "nothing armed while the first run runs");
  await f.finishRun();
  assert.deepEqual(f.timers(), [30_000], "the poll, with nothing waiting");
  // The poll runs deliver only and logs like a wake.
  await f.fire(30_000);
  assert.ok(f.inRun());
  assert.deepEqual(f.timers(), [], "a run disarms the poll");
  await f.finishRun();
  assert.deepEqual(f.log, [
    "start: Recorded D2/M2 as attempting to A1 before calling the adapter.",
    "poll: Recorded D2/M2 as attempting to A1 before calling the adapter.",
  ]);
  assert.deepEqual(f.timers(), [30_000]);
  // An event run disarms the pending poll and arms a new one from its own
  // end: the handle after the run is not the one before it.
  const before = f.pending[0];
  waiting = true;
  const handled = f.runner.handle({
    type: "submit",
    by: "you",
    messageId: "M1",
    text: "x",
  });
  await f.settle();
  assert.deepEqual(f.timers(), [], "the event run disarmed the poll");
  await f.finishRun();
  await handled;
  assert.deepEqual(f.timers().sort(), [20_000, 30_000], "a look and a poll");
  assert.notEqual(
    f.pending.find((t) => t.ms === 30_000),
    before,
  );
  // A look's run disarms both and re-arms both; never two of either.
  await f.fire(20_000);
  assert.deepEqual(f.timers(), []);
  await f.finishRun();
  assert.deepEqual(f.timers().sort(), [20_000, 30_000]);
  f.runner.stop();
  assert.deepEqual(f.timers(), []);

  // A run that fails to open still arms the poll, and a look to retry.
  let fail: Error | null = new Error("paseo down");
  const g = fakeRunner({
    waits: () => false,
    pollMs: 30_000,
    fail: () => fail,
  });
  g.runner.start();
  await g.settle();
  assert.deepEqual(g.timers().sort(), [20_000, 30_000], "retry and poll");
  fail = null;
  // stop during a run: the run's end arms nothing.
  await g.fire(30_000);
  assert.ok(g.inRun());
  g.runner.stop();
  await g.finishRun();
  assert.deepEqual(g.timers(), []);
});

test("runner: a failed event run leaves a look armed, and a rejected event leaves the timers as they were", async () => {
  // Work waits and a look is armed; an event run that cannot open the
  // journal must not lose it.
  let fail: Error | null = null;
  const f = fakeRunner({ waits: () => true, fail: () => fail });
  const first = f.runner.handle({
    type: "submit",
    by: "you",
    messageId: "M1",
    text: "x",
  });
  await f.finishRun();
  await first;
  assert.deepEqual(f.timers(), [20_000]);
  fail = new Error("Another router run has held the journal");
  await assert.rejects(
    f.runner.handle({ type: "submit", by: "you", messageId: "M2", text: "y" }),
    /held the journal/,
  );
  assert.deepEqual(f.timers(), [20_000], "the look survives the failure");
  fail = null;
  f.runner.stop();

  // A rejected event is no look: the armed look and poll keep their time.
  let reject = false;
  const g = fakeRunner({
    waits: () => true,
    pollMs: 30_000,
    reject: () => reject,
  });
  const ok = g.runner.handle({
    type: "submit",
    by: "you",
    messageId: "M1",
    text: "x",
  });
  await g.finishRun();
  await ok;
  const before = [...g.pending];
  reject = true;
  const run = await g.runner.handle({
    type: "submit",
    by: "you",
    messageId: "M1",
    text: "x",
  });
  assert.equal(run.outcome.ok, false);
  assert.deepEqual(g.pending, before, "same handles, same delays");
  g.runner.stop();
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
    assert.ok(
      (await page.text()).includes(
        '<span data-path="actor.login">me@example.com</span>',
      ),
    );
    const anonymous = await (await fetch(`${url}/`)).text();
    assert.ok(anonymous.includes("reading only · not identified"));
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
    assert.ok(html.includes(`>${at.slice(11, 16)}Z</span>`));
    assert.deepEqual(
      [...html.matchAll(/<div class="task [^"]*"[^>]* data-task="(T\d+)"/g)]
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

// The forms of a page as a browser submits them: the hidden fields, the text
// fields, and the name and value of each button that submits the form.
const formsIn = (html: string) =>
  [...html.matchAll(/<form([^>]*)>([^]*?)<\/form>/g)].map((m) => {
    const body = m[2] ?? "";
    return {
      action: m[1]?.match(/action="([^"]+)"/)?.[1] ?? "",
      fields: [
        ...body.matchAll(
          /<input type="hidden" name="([^"]+)" value="([^"]*)">/g,
        ),
      ].map((f): [string, string] => [f[1] ?? "", f[2] ?? ""]),
      texts: [...body.matchAll(/<textarea[^>]*name="([^"]+)"/g)].map(
        (f) => f[1] ?? "",
      ),
      // A button with a form attribute submits another form.
      buttons: [...body.matchAll(/<button(?![^>]*\sform=)[^>]*>/g)].map(
        (b): [string, string] => [
          b[0].match(/name="([^"]+)"/)?.[1] ?? "",
          b[0].match(/value="([^"]*)"/)?.[1] ?? "",
        ],
      ),
    };
  });

test("board: the page opens the task in its URL, paints a known palette, and every form posts as before", async () => {
  const record = mkdtempSync(join(tmpdir(), "server-page-"));
  writeFileSync(
    join(record, "journal.jsonl"),
    replacedJournal.map((entry) => `${JSON.stringify(entry)}\n`).join(""),
  );
  const server = createServer(
    boardListener({
      config: { ...fixture, home: record },
      handle,
      now: () => NOW,
    }),
  );
  const url = await serve(server);
  const me = { "tailscale-user-login": "me@example.com" };
  const get = async (path: string, headers: Record<string, string> = {}) =>
    (await fetch(url + path, { headers })).text();
  const selected = (html: string) =>
    html
      .slice(html.indexOf('class="panel detail"'))
      .match(/data-task="([^"]+)"/)?.[1];
  try {
    // The first task that needs the viewer, unless the URL names a task.
    assert.equal(selected(await get("/", me)), "T1");
    assert.equal(selected(await get("/?task=T4", me)), "T4");
    assert.equal(selected(await get("/?task=T99", me)), "T1");
    const anonymous = await get("/?task=T4");
    assert.equal(selected(anonymous), "T4");
    assert.ok(!anonymous.includes("<form"));
    // The palette is the cookie's only when the cookie names one.
    const theme = async (cookie?: string) =>
      (await get("/", cookie ? { cookie } : {})).match(
        /<html lang="en" data-theme="([^"]*)">/,
      )?.[1];
    assert.equal(await theme(), "flexoki");
    assert.equal(await theme("router-theme=one-dark"), "one-dark");
    assert.equal(await theme("a=1; router-theme=one-dark; b=2"), "one-dark");
    assert.equal(await theme("router-theme=solarized"), "flexoki");
    assert.equal(
      await theme('router-theme="><script>alert(1)</script>'),
      "flexoki",
    );
    // Every form on the page, submitted by each of its buttons, runs its
    // action and returns to the page with the outcome.
    const before = handled.length;
    const posted = new Set<string>();
    for (const task of ["T1", "T2", "T3", "T4"]) {
      const at = `${url}/?task=${task}`;
      for (const form of formsIn(await get(`/?task=${task}`, me)))
        for (const [name, value] of form.buttons) {
          const body = new URLSearchParams(form.fields);
          for (const text of form.texts) body.set(text, "seen in the session");
          if (name) body.set(name, value);
          if (posted.has(body.toString())) continue;
          posted.add(body.toString());
          const res = await fetch(new URL(form.action, at), {
            method: "POST",
            headers: {
              ...me,
              "content-type": "application/x-www-form-urlencoded",
              "sec-fetch-site": "same-origin",
            },
            body,
            redirect: "manual",
          });
          assert.equal(res.status, 303, body.toString());
          assert.equal(
            res.headers.get("location"),
            `./?notice=handled%20${handled.at(-1)?.type}`,
          );
        }
    }
    const events = handled.slice(before);
    assert.deepEqual([...new Set(events.map((e) => e.type))].sort(), [
      "answer",
      "cancel",
      "choose",
      "observe",
      "resolve",
    ]);
    const find = (type: string, field: string, value: unknown) =>
      events.find(
        (e) =>
          e.type === type && (e as Record<string, unknown>)[field] === value,
      );
    assert.deepEqual(find("choose", "to", "knowledge"), {
      type: "choose",
      by: "you",
      taskId: "T1",
      to: "knowledge",
    });
    assert.deepEqual(find("cancel", "taskId", "T1"), {
      type: "cancel",
      by: "you",
      taskId: "T1",
    });
    const answer = find("answer", "taskId", "T2");
    assert.ok(answer?.type === "answer");
    assert.deepEqual(
      [answer.by, answer.questionId, answer.deliveryId, answer.text],
      ["you", "Q2", "D1", "seen in the session"],
    );
    // D3's send was accepted, so the form offers finished alone.
    assert.deepEqual(find("resolve", "deliveryId", "D3"), {
      type: "resolve",
      by: "operator",
      deliveryId: "D3",
      messageId: "M4",
      outcome: "finished",
      evidence: "seen in the session",
    });
    assert.deepEqual(find("observe", "placement", "environment@mbp"), {
      type: "observe",
      placement: "environment@mbp",
      hold: false,
    });
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

test("board: the model carries the telemetry file beside the record; a bad file is logged once and shown as none", async () => {
  const record = mkdtempSync(join(tmpdir(), "server-telemetry-"));
  writeFileSync(
    join(record, "journal.jsonl"),
    journal.map((entry) => `${JSON.stringify(entry)}\n`).join(""),
  );
  const logged: string[] = [];
  const server = createServer(
    boardListener({
      config: { ...fixture, home: record },
      handle,
      now: () => NOW,
      log: (line) => logged.push(line),
    }),
  );
  const url = await serve(server);
  const json = { accept: "application/json" };
  const model = async (): Promise<Record<string, unknown>> =>
    jsonObject(await fetch(`${url}/`, { headers: json }));
  try {
    // No file: no telemetry, nothing logged.
    let m = await model();
    assert.equal(m.telemetryAt, null);
    assert.ok(
      (m.placements as { agent: unknown }[]).every((p) => p.agent === null),
    );
    assert.equal(logged.length, 0);
    // The file the shell writes: each served placement carries its snapshot.
    writeTelemetry(record, telemetry);
    m = await model();
    assert.equal(m.telemetryAt, telemetry.at);
    assert.deepEqual(
      (m.placements as { key: string; agent: { status: string } }[]).map(
        (p) => [p.key, p.agent.status],
      ),
      [
        ["orchestrator@mbp", "running"],
        ["knowledge@mini", "running"],
        ["environment@mbp", "idle"],
        ["environment@mini", "running"],
      ],
    );
    // A damaged file: none again, and one log line however often the page
    // refreshes; a different damage is a new line; two damaged entries are
    // two lines, once; after a clean read the same damage is news again.
    writeFileSync(join(record, "telemetry.json"), "{");
    for (let i = 0; i < 3; i += 1)
      assert.equal((await model()).telemetryAt, null);
    writeFileSync(join(record, "telemetry.json"), '{"version":"x"}');
    await model();
    await model();
    writeFileSync(
      join(record, "telemetry.json"),
      JSON.stringify({ ...telemetry, placements: { a: 1, b: 2 } }),
    );
    for (let i = 0; i < 3; i += 1)
      assert.equal((await model()).telemetryAt, telemetry.at);
    writeTelemetry(record, telemetry);
    await model();
    writeFileSync(join(record, "telemetry.json"), "{");
    await model();
    assert.deepEqual(
      logged.map((line) => line.split(":")[0]),
      [
        "telemetry.json is not JSON",
        "telemetry.json is not a telemetry file",
        "telemetry.json",
        "telemetry.json",
        "telemetry.json is not JSON",
      ],
    );
    assert.deepEqual(logged.slice(2, 4), [
      "telemetry.json: the entry for a is not a snapshot",
      "telemetry.json: the entry for b is not a snapshot",
    ]);
  } finally {
    server.close();
  }
});
