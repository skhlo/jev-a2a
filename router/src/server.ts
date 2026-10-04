// The two HTTP surfaces of `router serve`, as request listeners that take
// their dependencies, so the guards can be tested without a process; and
// `bind`, which puts a listener on its address or says why it cannot.
//
// Events: replies and answers from other hosts, behind the bearer token.
// Board: the page, its view model as JSON, and its actions, on loopback
// behind Tailscale Serve, which stamps the viewer's login on each request.
// Serve strips its mount path, so board routes match by suffix.
import { timingSafeEqual } from "node:crypto";
import type {
  IncomingMessage,
  RequestListener,
  ServerResponse,
} from "node:http";
import {
  actionEvent,
  boardModel,
  boardState,
  identify,
  messageTimes,
  type Actor,
} from "./board.ts";
import { renderBoard } from "./board-page.ts";
import type { RouterConfig } from "./config.ts";
import { readJournal } from "./journal.ts";
import { fold } from "./shell.ts";
import type { Event, Outcome } from "./types.ts";

export type Run = { outcome: Outcome; report: string[] };

export type ServerDeps = {
  config: RouterConfig;
  // Applies one event as one shell run; callers serialize.
  handle(event: Event): Promise<Run>;
  // The events endpoint is the agents' door: `by` must be a participant
  // session, so the shared token cannot act as a person, and for a request
  // or a choice the session a placement binds now. A reply or an answer
  // from a replaced session still reaches the core, which knows whether
  // that session holds the delivery.
  sessionOf(by: string): SessionStatus;
  log?: (line: string) => void;
  // The board's clock; a test fixes it to read a fixture's record.
  now?: () => number;
};

const EVENT_TYPES = ["submit", "choose", "update", "answer"];
const NEEDS_CURRENT = ["submit", "choose"];

export type SessionStatus = "current" | "replaced" | null;

// Whether `by` is a session the record knows, read without the journal
// lock, as the board reads it: the events endpoint must not contend with
// the run it is about to queue.
export const sessionReader =
  (config: RouterConfig) =>
  (by: string): SessionStatus => {
    const state = fold(config, readJournal(config.home));
    if (!state.sessions[by]) return null;
    return Object.values(state.placements).some((p) => p.session === by)
      ? "current"
      : "replaced";
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
  token: string,
): RequestListener {
  const wanted = Buffer.from(token);
  const authorized = (header: string | undefined): boolean => {
    const given = Buffer.from(header?.replace(/^Bearer\s+/i, "") ?? "");
    return given.length === wanted.length && timingSafeEqual(given, wanted);
  };
  return (req, res) => {
    const reply = (status: number, payload: unknown): void => {
      res.writeHead(status, { "content-type": "application/json" });
      res.end(JSON.stringify(payload));
    };
    if (req.method === "GET" && req.url === "/health")
      return reply(200, { ok: true });
    if (!authorized(req.headers.authorization))
      return reply(401, { ok: false, code: "unauthorized" });
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
      let session: SessionStatus;
      try {
        session = deps.sessionOf(typeof event.by === "string" ? event.by : "");
      } catch (error: unknown) {
        return failed(error);
      }
      if (
        session === null ||
        (session === "replaced" && NEEDS_CURRENT.includes(String(event.type)))
      )
        return reply(403, {
          ok: false,
          code: "unauthenticated",
          message:
            session === null
              ? "serve takes events from a participant session."
              : "A replaced session cannot submit or choose.",
        });
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
// neither (curl, the client script) are not browsers acting on a page.
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

export function boardListener(deps: ServerDeps): RequestListener {
  const { config } = deps;
  const log = deps.log ?? ((): void => undefined);
  const now = deps.now ?? Date.now;
  const model = (at: number, actor: Actor | null) => {
    const entries = readJournal(config.home);
    return boardModel(
      boardState(config, entries, at),
      config,
      at,
      messageTimes(entries),
      actor,
    );
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
    if (!path.endsWith("/") && !path.endsWith("/board.json")) {
      // Under a mount such as /router, the page's relative links need the
      // trailing slash.
      res.writeHead(302, { location: `${path}/` }).end();
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
      // it; the palette is the page's cookie, which renderBoard checks.
      res.end(
        renderBoard(view, {
          notice: url.searchParams.get("notice"),
          task: url.searchParams.get("task"),
          theme: cookie(req.headers.cookie, "router-theme"),
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

export type { IncomingMessage, ServerResponse };
