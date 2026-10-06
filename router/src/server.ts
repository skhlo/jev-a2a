// `router serve` without the process: its two HTTP surfaces as request
// listeners that take their dependencies, the runner that serializes runs
// and looks again while work waits for a session, and `bind`, which puts a
// listener on its address or says why it cannot.
//
// Events: replies, answers, requests and choices from other hosts, each
// behind its host's bearer token.
// Board: the page, its view model as JSON, and its actions, on loopback
// behind Tailscale Serve, which stamps the viewer's login on each request.
// Serve strips its mount path, so board routes match by suffix.
import { timingSafeEqual } from "node:crypto";
import type { IncomingMessage, RequestListener } from "node:http";
import {
  actionEvent,
  asOf,
  boardModel,
  identify,
  messageTimes,
  type Actor,
} from "./board.ts";
import { renderBoard } from "./board-page.ts";
import type { UsageState, UsageStore } from "./usage.ts";
import type { RouterConfig } from "./config.ts";
import { readTelemetry, type Telemetry } from "./telemetry.ts";
import { journalFolder, servedBy } from "./shell.ts";
import { own, waitsOnSessions } from "./core.ts";
import { refuse } from "./request.ts";
import type { Event, Outcome, State } from "./types.ts";

export type Run = { outcome: Outcome; report: string[] };

export type ServerDeps = {
  config: RouterConfig;
  // Applies one event as one shell run; callers serialize.
  handle(event: Event): Promise<Run>;
  // The events endpoint is the agents' door: `by` must be a participant
  // session, so a token cannot act as a person; a session on the token's
  // host; and for a request or a choice the session a placement binds now.
  // A reply or an answer from a replaced session still reaches the core,
  // which knows whether that session holds the delivery.
  sessionOf(by: string): KnownSession | null;
  log?: (line: string) => void;
  // The board's clock; a test fixes it to read a fixture's record.
  now?: () => number;
  // The usage store as it stands, for the board model; absent or null
  // when usage is off.
  usage?: (() => UsageState) | null;
};

const EVENT_TYPES = ["submit", "choose", "update", "answer"];
const NEEDS_CURRENT = ["submit", "choose"];

// A session the record knows: the host it runs on, and whether a
// placement binds it now.
export type KnownSession = { host: string; current: boolean };

// A token the events door takes, and the host whose sessions it acts for.
export type DoorKey = { host: string; token: string };

// Where a host's token is kept in the router's secrets.env.
const tokenName = (host: string): string =>
  `ROUTER_TOKEN_${host.toUpperCase().replace(/[^A-Z0-9]/g, "_")}`;

// The door's keys: each configured host's token. A token two hosts hold
// would act for whichever came first, so it is refused, naming both: two
// host names may also read one variable.
export function doorKeys(
  config: RouterConfig,
  env: Record<string, string | undefined>,
): DoorKey[] {
  const keys = Object.keys(config.hosts)
    .map((host) => ({ host, token: env[tokenName(host)] }))
    .filter((key): key is DoorKey => Boolean(key.token));
  for (const key of keys) {
    const first = keys.find((other) => other.token === key.token);
    if (first && first !== key)
      refuse(
        `${first.host} and ${key.host} have the same token; each host needs its own.`,
      );
  }
  return keys;
}

// Whether the record has work waiting only for a session this router
// serves, read without the lock, as the board reads it. Serve asks after
// its own runs and whenever another writer (the CLI on this host) appends.
export const waitsReader =
  (config: RouterConfig, record: RecordReader) => (): boolean => {
    const { state } = record();
    return waitsOnSessions(state, servedBy(config, state));
  };

// The serve runner: one run at a time through a queue (so the journal lock
// is never contended from inside the server), and a look again every
// `delayMs` while the record has work waiting only for a session to be seen
// idle, and, with `pollMs`, a run that long after any run regardless.
// Without a poll a quiet router arms nothing. Three things arm the loop: a
// run's own state at its end, a first run at start, and the journal growing
// under another writer (the CLI on this host), read without the lock.
// Serve's own appends also move the journal, so a change seen while a run
// is in progress is ignored: that run decides at its end, and both
// intervals count from there.
export type Timers<H> = {
  set: (fn: () => void, ms: number) => H;
  clear: (handle: H) => void;
};
const nodeTimers: Timers<NodeJS.Timeout> = {
  set: setTimeout,
  clear: clearTimeout,
};
export type RunnerShell = {
  apply(event: Event): Outcome;
  deliver(): Promise<string[]>;
  waits(): boolean;
  close(): Promise<void>;
};
export type RunnerDeps<H> = {
  open(): Promise<RunnerShell>;
  delayMs: number;
  // A run this long after the end of the last one, whether or not anything
  // waits, so the telemetry is at most this plus one run old; 0 runs on
  // demand only.
  pollMs: number;
  // Whether the record has work waiting for a served session, without the lock.
  waits(): boolean;
  log(line: string): void;
  // Calls back whenever the journal changes; null when nothing else writes.
  watch?: ((onChange: () => void) => { close(): void }) | null;
  timers?: Timers<H>;
  settleMs?: number;
};
export type Runner = {
  handle(event: Event): Promise<Run>;
  // The first run and the watcher; returns when both are in place.
  start(): void;
  stop(): void;
};

// A wake run logs what it changed, not the observations and "waits" lines
// that would repeat every interval.
const changed = (line: string): boolean =>
  !/^[^\s:]+@[^\s:]+: /.test(line) && !/ waits: /.test(line);

// A telemetry complaint (a sheet read that failed, a file not written) is
// the same every interval while its cause lasts: each is logged once, and
// heard again after a run without it.
const telemetryLine = (line: string): boolean => line.startsWith("telemetry");

export function serveRunner<H>(deps: RunnerDeps<H>): Runner {
  const timers = (deps.timers ?? nodeTimers) as Timers<H>;
  let queue: Promise<unknown> = Promise.resolve();
  let busy = false;
  let armed: H | null = null;
  let polled: H | null = null;
  let settle: H | null = null;
  let stopped = false;
  let watcher: { close(): void } | null = null;

  const armWake = (waiting: boolean): void => {
    if (!waiting || stopped || deps.delayMs <= 0 || armed !== null) return;
    armed = timers.set(() => {
      armed = null;
      void unattended("wake");
    }, deps.delayMs);
  };
  // The poll is measured from the end of the last run, whatever started
  // it, so runs never overlap and an active router polls no extra.
  const armPoll = (): void => {
    if (stopped || deps.pollMs <= 0 || polled !== null) return;
    polled = timers.set(() => {
      polled = null;
      void unattended("poll");
    }, deps.pollMs);
  };
  // A run that is about to look disarms both timers: it is the look they
  // were for, and its end arms them again from its own state. A rejected
  // event looks at nothing and leaves them be.
  const disarm = (): void => {
    if (armed !== null) timers.clear(armed);
    if (polled !== null) timers.clear(polled);
    armed = null;
    polled = null;
  };
  // One run: the event, if any, then every deliverable command; the look
  // is armed from the run's own state before the shell closes, the poll
  // after it. A run that fails leaves a look armed, so waiting work is
  // tried again at the interval rather than stalled until the next event.
  const runOnce = async (event: Event | null): Promise<Run> => {
    busy = true;
    try {
      const shell = await deps.open();
      try {
        const outcome: Outcome = event
          ? shell.apply(event)
          : { ok: true, message: "run" };
        if (!outcome.ok) return { outcome, report: [] };
        disarm();
        const report = await shell.deliver();
        armWake(shell.waits());
        return { outcome, report };
      } finally {
        await shell.close();
      }
    } catch (error: unknown) {
      armWake(true);
      throw error;
    } finally {
      busy = false;
      armPoll();
    }
  };
  const enqueue = (event: Event | null): Promise<Run> => {
    const run = queue.then(() => runOnce(event));
    queue = run.catch(() => undefined);
    return run;
  };
  // A run nobody asked for: its failure is logged and tried again at the
  // interval rather than lost.
  const complained = new Set<string>();
  const unattended = async (label: string): Promise<void> => {
    try {
      const { report } = await enqueue(null);
      const complaints = report.filter(telemetryLine);
      for (const line of report) {
        if (!changed(line)) continue;
        if (telemetryLine(line)) {
          if (complained.has(line)) continue;
          complained.add(line);
        }
        deps.log(`${label}: ${line}`);
      }
      if (complaints.length === 0) complained.clear();
    } catch (error: unknown) {
      deps.log(
        `${label}: ${error instanceof Error ? error.message : String(error)}`,
      );
    }
  };
  const onChange = (): void => {
    if (settle !== null) timers.clear(settle);
    settle = timers.set(() => {
      settle = null;
      if (busy || stopped) return;
      try {
        armWake(deps.waits());
      } catch (error: unknown) {
        deps.log(
          `watch: ${error instanceof Error ? error.message : String(error)}`,
        );
      }
    }, deps.settleMs ?? 500);
  };
  return {
    handle: (event) => enqueue(event),
    start() {
      watcher = deps.watch?.(onChange) ?? null;
      void unattended("start");
    },
    stop() {
      stopped = true;
      watcher?.close();
      disarm();
      if (settle !== null) timers.clear(settle);
      settle = null;
    },
  };
}

// The usage store's own cadence, apart from the runs: a refresh now, and
// the next `everyMs` after each one ends, so two never overlap. A refresh
// that rejects is logged in one fixed line, never its error, and the next
// one follows on schedule: serve stays up.
const REFRESH_FAILED =
  "usage: a refresh failed; the next one follows on schedule.";
export function keepReading<H>(
  store: Pick<UsageStore, "refresh">,
  everyMs: number,
  options: { log?: (line: string) => void; timers?: Timers<H> } = {},
): { stop(): void } {
  const timers = (options.timers ?? nodeTimers) as Timers<H>;
  const log = options.log ?? ((line: string) => console.error(line));
  let next: H | null = null;
  let stopped = false;
  const read = (): void => {
    next = null;
    void store
      .refresh()
      .catch(() => log(REFRESH_FAILED))
      .finally(() => {
        if (!stopped) next = timers.set(read, everyMs);
      });
  };
  read();
  return {
    stop() {
      stopped = true;
      if (next !== null) timers.clear(next);
      next = null;
    },
  };
}

// The record as serve keeps it: the journal's kept fold (see journalFolder)
// with the message times beside it. A read returns the same record until
// the journal changes. Serve makes one for the board, the wake and the
// events endpoint, which read it without the lock, and for its runs, which
// read it under the lock, so the record is folded once for all.
type KeptRecord = {
  state: State;
  times: Readonly<Record<string, string>>;
  configured: boolean;
};
export type RecordReader = () => KeptRecord;
export function recordReader(config: RouterConfig): RecordReader {
  const folded = journalFolder(config);
  let record: KeptRecord | null = null;
  return () => {
    const { state, entries, from, configured } = folded();
    if (!record || from === "start")
      record = {
        state,
        times: Object.freeze(messageTimes(entries)),
        configured,
      };
    else if (entries.length)
      record = {
        state,
        times: Object.freeze({ ...record.times, ...messageTimes(entries) }),
        configured,
      };
    return record;
  };
}

// The session `by` names, if the record knows it, read without the
// journal lock, as the board reads it: the events endpoint must not contend
// with the run it is about to queue.
export const sessionReader =
  (record: RecordReader) =>
  (by: string): KnownSession | null => {
    const { state } = record();
    const session = own(state.sessions, by);
    if (!session) return null;
    return {
      host: session.host,
      current: Object.values(state.placements).some((p) => p.session === by),
    };
  };

const isRecord = (value: unknown): value is Record<string, unknown> =>
  value !== null && typeof value === "object" && !Array.isArray(value);

function body(req: IncomingMessage): Promise<string> {
  return new Promise((resolve, reject) => {
    const chunks: Buffer[] = [];
    req.on("data", (chunk: Buffer) => chunks.push(chunk));
    req.on("end", () => resolve(Buffer.concat(chunks).toString("utf8")));
    req.on("error", reject);
  });
}

export function eventsListener(
  deps: ServerDeps,
  keys: DoorKey[],
): RequestListener {
  const wanted = keys.map((key) => ({ ...key, token: Buffer.from(key.token) }));
  // The key whose token the request presents, if any.
  const keyFor = (header: string | undefined) => {
    const given = Buffer.from(header?.replace(/^Bearer\s+/i, "") ?? "");
    return wanted.find(
      ({ token }) =>
        given.length === token.length && timingSafeEqual(given, token),
    );
  };
  return (req, res) => {
    const reply = (status: number, payload: unknown): void => {
      res.writeHead(status, { "content-type": "application/json" });
      res.end(JSON.stringify(payload));
    };
    if (req.method === "GET" && req.url === "/health")
      return reply(200, { ok: true });
    const key = keyFor(req.headers.authorization);
    if (!key) return reply(401, { ok: false, code: "unauthorized" });
    if (req.method !== "POST" || req.url !== "/events")
      return reply(404, { ok: false, code: "not_found" });
    body(req).then((text) => {
      let event: unknown;
      try {
        event = JSON.parse(text);
      } catch {
        return reply(400, { ok: false, code: "bad_json" });
      }
      if (!isRecord(event) || !EVENT_TYPES.includes(String(event.type)))
        return reply(400, {
          ok: false,
          code: "bad_event",
          message: `serve accepts ${EVENT_TYPES.slice(0, -1).join(", ")} and ${EVENT_TYPES.at(-1)} events`,
        });
      const failed = (error: unknown): void =>
        reply(500, {
          ok: false,
          code: "error",
          message: error instanceof Error ? error.message : String(error),
        });
      const by = typeof event.by === "string" ? event.by : "";
      let session: KnownSession | null;
      try {
        session = deps.sessionOf(by);
      } catch (error: unknown) {
        return failed(error);
      }
      const refused = (code: string, message: string): void =>
        reply(403, { ok: false, code, message });
      if (session === null)
        return refused(
          "unauthenticated",
          "serve takes events from a participant session.",
        );
      if (session.host !== key.host)
        return refused(
          "wrong_host",
          `This token is ${key.host}'s; ${by} is a session on ${session.host}.`,
        );
      if (!session.current && NEEDS_CURRENT.includes(String(event.type)))
        return refused(
          "unauthenticated",
          "A replaced session cannot submit or choose.",
        );
      // The core validates everything else and rejects what it does not know.
      deps
        .handle(event as Event)
        .then(
          ({ outcome, report }) => reply(200, { ...outcome, report }),
          failed,
        );
    });
  };
}

// A browser sends Sec-Fetch-Site on every request and Origin on every
// cross-site POST; a form on another page fails both. Clients that send
// neither (curl, `router` on a reply host) are not browsers acting on a page.
export function sameSite(
  headers: Record<string, string | string[] | undefined>,
): boolean {
  const site = headers["sec-fetch-site"];
  if (typeof site === "string")
    return site === "same-origin" || site === "none";
  const origin = headers.origin;
  if (typeof origin !== "string") return true;
  const host = headers["x-forwarded-host"] ?? headers.host;
  try {
    return typeof host === "string" && new URL(origin).host === host;
  } catch {
    return false;
  }
}

// One cookie's value from a Cookie header, or null.
function cookie(header: string | undefined, name: string): string | null {
  for (const pair of (header ?? "").split(";")) {
    const at = pair.indexOf("=");
    if (at > 0 && pair.slice(0, at).trim() === name)
      return pair.slice(at + 1).trim();
  }
  return null;
}

// Whether a request asks for the view model rather than the page: its Accept
// header ranks JSON above HTML, or ranks them equal and names JSON more
// exactly (`application/json, */*`). A browser ranks HTML first, and a
// client that names neither, or both alike, gets the page.
function wantsJson(accept: string | undefined): boolean {
  const ranges = (accept ?? "").split(",").map((range) => {
    const [type = "", ...params] = range
      .split(";")
      .map((part) => part.trim().toLowerCase());
    const q = params.find((param) => param.startsWith("q="));
    return { type, q: q ? Number(q.slice(2)) : 1 };
  });
  // The most specific range that matches decides a type's rank, and how
  // specific it was: 2 for the type itself, 1 for `type/*`, 0 for `*/*`.
  const rank = (type: string): { q: number; exact: number } => {
    const ladder = [type, `${type.split("/")[0]}/*`, "*/*"];
    for (const [i, name] of ladder.entries()) {
      const range = ranges.find((r) => r.type === name);
      if (range) return { q: range.q, exact: 2 - i };
    }
    return { q: 0, exact: 0 };
  };
  const json = rank("application/json");
  const html = rank("text/html");
  return (
    json.q > html.q ||
    (json.q > 0 && json.q === html.q && json.exact > html.exact)
  );
}

export function boardListener(
  deps: Omit<ServerDeps, "sessionOf"> & { record: RecordReader },
): RequestListener {
  const { config, record } = deps;
  const log = deps.log ?? ((): void => undefined);
  const now = deps.now ?? Date.now;
  // A bad telemetry file is logged once, not on every refresh: each
  // complaint is logged the first time it is heard, and the slate is wiped
  // once a read passes without one, so the same damage returning is news.
  const telemetryErrors = new Set<string>();
  const model = (at: number, actor: Actor | null) => {
    const { state, times } = record();
    return boardModel(
      asOf(state, at),
      config,
      at,
      times,
      actor,
      readTelemetryOnce(),
      deps.usage?.() ?? null,
    );
  };
  const readTelemetryOnce = (): Telemetry | null => {
    const heard = new Set<string>();
    const telemetry = readTelemetry(config.home, (message) => {
      heard.add(message);
      if (telemetryErrors.has(message)) return;
      telemetryErrors.add(message);
      log(message);
    });
    if (heard.size === 0) telemetryErrors.clear();
    return telemetry;
  };
  return (req, res) => {
    const url = new URL(req.url ?? "/", "http://board");
    const path = url.pathname;
    const actor = identify(req.headers, config.serve.identities);
    const plain = (status: number, text: string): void => {
      res.writeHead(status, { "content-type": "text/plain; charset=utf-8" });
      res.end(text);
    };
    const back = (notice: string): void => {
      res
        .writeHead(303, {
          location: `./${notice ? `?notice=${encodeURIComponent(notice)}` : ""}`,
        })
        .end();
    };
    if (req.method === "POST" && path.endsWith("/actions")) {
      if (!actor)
        return plain(
          403,
          "No tailnet identity, or a login the router does not know.",
        );
      if (!sameSite(req.headers))
        return plain(403, "Actions are accepted from the board page only.");
      body(req).then((text) => {
        const form = new URLSearchParams(text);
        const action = actionEvent(form, actor, config.principals ?? {});
        if (!action.ok) return back(action.message);
        log(`board: ${actor.login} ${JSON.stringify(action.event)}`);
        deps.handle(action.event).then(
          ({ outcome }) => back(outcome.message),
          (error: unknown) =>
            back(error instanceof Error ? error.message : String(error)),
        );
      });
      return;
    }
    if (req.method !== "GET") return plain(405, "GET or POST actions");
    if (path.endsWith("/whoami")) {
      res.writeHead(200, { "content-type": "application/json" });
      res.end(
        JSON.stringify({
          login: actor?.login ?? null,
          principals: actor?.principals ?? [],
          headers: Object.fromEntries(
            Object.entries(req.headers).filter(([k]) =>
              k.startsWith("tailscale-"),
            ),
          ),
        }),
      );
      return;
    }
    if (path.endsWith("/favicon.ico")) {
      // The board has no icon. Said at once, without reading the record:
      // the redirect below would send the browser to a whole board.
      res.writeHead(204, { "cache-control": "max-age=86400" }).end();
      return;
    }
    if (!path.endsWith("/") && !path.endsWith("/board.json")) {
      // Under a mount such as /router, the page's relative links need the
      // trailing slash. The location is relative too: Serve strips the
      // mount, so /router/usage arrives as /usage, and only the last
      // segment with its slash comes back to /router/usage/. The leading
      // ./ keeps a segment such as "https:evil.com" a path on this host
      // rather than a URL with its own scheme.
      res
        .writeHead(302, {
          location: `./${path.slice(path.lastIndexOf("/") + 1)}/`,
        })
        .end();
      return;
    }
    if (path.endsWith("/usage/")) {
      // The Usage tab is now the board's pop-up (v0.13): its address goes
      // back to the board, relative and on this host as above, with the
      // pop-up open while usage is on.
      res
        .writeHead(302, { location: `../${deps.usage ? "?usage" : ""}` })
        .end();
      return;
    }
    // A record the code cannot replay is reported, not fatal: the events
    // listener in the same process must stay up.
    let view: ReturnType<typeof model>;
    try {
      view = model(now(), actor);
    } catch (error: unknown) {
      const message = error instanceof Error ? error.message : String(error);
      log(`board: cannot read the record: ${message}`);
      return plain(500, `The record cannot be read: ${message}`);
    }
    // One model, as JSON or as the page, under the same identity.
    if (path.endsWith("/board.json") || wantsJson(req.headers.accept)) {
      res.writeHead(200, { "content-type": "application/json" });
      res.end(JSON.stringify(view));
    } else {
      res.writeHead(200, { "content-type": "text/html; charset=utf-8" });
      // The selected task is in the URL so a reload and a shared link open
      // it, and so is an open usage pop-up for a page without a script;
      // the palette is the page's cookie, which renderBoard checks.
      res.end(
        renderBoard(view, {
          notice: url.searchParams.get("notice"),
          task: url.searchParams.get("task"),
          theme: cookie(req.headers.cookie, "router-theme"),
          usage: url.searchParams.has("usage"),
        }),
      );
    }
  };
}

// What `bind` needs of a server: enough to be faked in a test.
type BindEvent = "error" | "listening";
export type Bindable = {
  listen(port: number, host: string): unknown;
  once(event: BindEvent, handler: (error?: Error) => void): unknown;
  removeListener(event: BindEvent, handler: (error?: Error) => void): unknown;
};

export type BindOptions = {
  // How long an address that is not on this host yet is waited for: at
  // boot the tailnet address arrives after the service starts.
  waitMs?: number;
  pollMs?: number;
  log?: (line: string) => void;
  now?: () => number;
  sleep?: (ms: number) => Promise<void>;
};

// Why a bind failed, in a plain message. `transient` means trying again
// later can succeed: the address may still appear.
export class BindError extends Error {
  override name = "BindError";
  readonly transient: boolean;
  constructor(message: string, transient: boolean) {
    super(message);
    this.transient = transient;
  }
}

const errorCode = (error: unknown): string | undefined =>
  error instanceof Error && "code" in error && typeof error.code === "string"
    ? error.code
    : undefined;

// Listens on `host:port`, or throws a BindError saying why not.
export async function bind(
  server: Bindable,
  address: string,
  what: "events" | "board",
  options: BindOptions = {},
): Promise<void> {
  const {
    waitMs = 120_000,
    pollMs = 2_000,
    log = () => undefined,
    now = Date.now,
    sleep = (ms) => new Promise((resolve) => setTimeout(resolve, ms)),
  } = options;
  const at = address.lastIndexOf(":");
  const host = address.slice(0, at).replace(/^\[|\]$/g, "");
  const port = Number(address.slice(at + 1));
  const attempt = (): Promise<void> =>
    new Promise((resolve, reject) => {
      const done = (error?: Error): void => {
        server.removeListener("error", done);
        server.removeListener("listening", done);
        if (error) reject(error);
        else resolve();
      };
      server.once("error", done);
      server.once("listening", done);
      server.listen(port, host);
    });
  const deadline = now() + waitMs;
  let waited = false;
  for (;;) {
    try {
      return await attempt();
    } catch (error: unknown) {
      const code = errorCode(error);
      if (code === "EADDRINUSE")
        throw new BindError(
          `The ${what} address ${address} is in use. Is router serve already running?`,
          false,
        );
      if (code === "EADDRNOTAVAIL") {
        if (now() >= deadline)
          throw new BindError(
            `The ${what} address ${address} did not appear within ${Math.round(waitMs / 1000)}s.`,
            true,
          );
        if (!waited)
          log(
            `The ${what} address ${address} is not on this host yet; waiting.`,
          );
        waited = true;
        await sleep(pollMs);
        continue;
      }
      const reason = error instanceof Error ? error.message : String(error);
      throw new BindError(
        `Cannot listen for ${what} on ${address}: ${reason}`,
        false,
      );
    }
  }
}
