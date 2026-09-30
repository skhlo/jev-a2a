// The two HTTP surfaces of `router serve`, as request listeners that take
// their dependencies, so the guards can be tested without a process.
//
// Events: replies and answers from other hosts, behind the bearer token.
// Board: the page and its actions, on loopback behind Tailscale Serve,
// which stamps the viewer's login on each request. Serve strips its mount
// path, so board routes match by suffix.
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
  renderBoard,
} from "./board.ts";
import type { RouterConfig } from "./config.ts";
import { readJournal } from "./journal.ts";
import type { Event, Outcome } from "./types.ts";

export type Run = { outcome: Outcome; report: string[] };

export type ServerDeps = {
  config: RouterConfig;
  // Applies one event as one shell run; callers serialize.
  handle(event: Event): Promise<Run>;
  log?: (line: string) => void;
};

const EVENT_TYPES = ["update", "answer"];

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
          message: `serve accepts ${EVENT_TYPES.join(" and ")} events`,
        });
      // The core validates everything else and rejects what it does not know.
      deps.handle(event as Event).then(
        ({ outcome, report }) => reply(200, { ...outcome, report }),
        (error: unknown) =>
          reply(500, {
            ok: false,
            code: "error",
            message: error instanceof Error ? error.message : String(error),
          }),
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

export function boardListener(deps: ServerDeps): RequestListener {
  const { config } = deps;
  const log = deps.log ?? ((): void => undefined);
  const model = (now: number) => {
    const entries = readJournal(config.home);
    return boardModel(
      boardState(config, entries, now),
      config,
      now,
      messageTimes(entries),
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
      view = model(Date.now());
    } catch (error: unknown) {
      const message = error instanceof Error ? error.message : String(error);
      log(`board: cannot read the record: ${message}`);
      return plain(500, `The record cannot be read: ${message}`);
    }
    if (path.endsWith("/board.json")) {
      res.writeHead(200, { "content-type": "application/json" });
      res.end(JSON.stringify(view));
    } else {
      res.writeHead(200, { "content-type": "text/html; charset=utf-8" });
      res.end(
        renderBoard(view, { actor, notice: url.searchParams.get("notice") }),
      );
    }
  };
}

// What `bind` needs of a server: enough to be faked in a test.
export type Bindable = {
  listen(port: number, host: string, ready: () => void): unknown;
  once(event: "error", handler: (error: Error) => void): unknown;
  removeListener(event: "error", handler: (error: Error) => void): unknown;
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

const errorCode = (error: unknown): string | undefined =>
  error instanceof Error && "code" in error && typeof error.code === "string"
    ? error.code
    : undefined;

// Listens on `host:port`, or throws one plain sentence saying why not.
export async function bind(
  server: Bindable,
  address: string,
  what: string,
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
      server.once("error", reject);
      server.listen(port, host, () => {
        server.removeListener("error", reject);
        resolve();
      });
    });
  const deadline = now() + waitMs;
  let waited = false;
  for (;;) {
    try {
      return await attempt();
    } catch (error: unknown) {
      const code = errorCode(error);
      if (code === "EADDRINUSE")
        throw new Error(
          `The ${what} address ${address} is in use. Is router serve already running? (systemctl --user status jev-router)`,
        );
      if (code === "EADDRNOTAVAIL" && now() < deadline) {
        if (!waited)
          log(
            `The ${what} address ${address} is not on this host yet; waiting.`,
          );
        waited = true;
        await sleep(pollMs);
        continue;
      }
      const reason = error instanceof Error ? error.message : String(error);
      throw new Error(`The ${what} cannot listen on ${address}: ${reason}`);
    }
  }
}

export type { IncomingMessage, ServerResponse };
