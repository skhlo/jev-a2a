// The router command on a reply host, one with no configuration: reply,
// submit, answer and choose go to the router's `serve` over HTTP as the
// participant session, built by the same rules as on the router host, and
// `check` says whether this host and the router work together. It loads
// nothing that needs a package.
import { checkoutCommit } from "./checkout.ts";
import { callerSession } from "./config.ts";
import { argsOf, EVENTS, refuse, type Invocation, type Io } from "./request.ts";

const SENT = ["reply", "submit", "answer", "choose"];

const isRecord = (value: unknown): value is Record<string, unknown> =>
  value !== null && typeof value === "object" && !Array.isArray(value);

const short = (commit: string | null): string =>
  commit ? commit.slice(0, 7) : "an unknown commit";

// What the router answered to a request: its status and JSON body.
async function ask(
  url: string,
  path: string,
  init: RequestInit = {},
): Promise<{ ok: boolean; status: number; body: Record<string, unknown> }> {
  const response = await fetch(new URL(path, url), init);
  const body: unknown = await response.json().catch(() => ({}));
  return {
    ok: response.ok,
    status: response.status,
    body: isRecord(body) ? body : {},
  };
}

const unreachable = (url: string, error: unknown): string =>
  `Cannot reach the router at ${url}: ${error instanceof Error ? error.message : String(error)}`;

// `router check`: whether the router answers, takes this host's token and
// runs this checkout's commit, from one request. 0 when all three hold.
async function check(url: string, token: string, io: Io): Promise<number> {
  let answer: Awaited<ReturnType<typeof ask>>;
  try {
    answer = await ask(url, "/check", {
      headers: { authorization: `Bearer ${token}` },
    });
  } catch (error: unknown) {
    io.err(unreachable(url, error));
    return 1;
  }
  const { ok, status, body } = answer;
  const host = ok && typeof body.host === "string" ? body.host : null;
  const theirs = typeof body.commit === "string" ? body.commit : null;
  const ours = checkoutCommit();
  const same = theirs !== null && theirs === ours;
  io.out(`router: ${url} answers`);
  io.out(
    host
      ? `token: accepted for ${host}`
      : status === 401
        ? "token: refused"
        : `token: the router answered ${status}`,
  );
  io.out(
    same
      ? `commit: ${short(ours)} on both`
      : `commit: the router runs ${short(theirs)}, this host ${short(ours)}`,
  );
  return host && same ? 0 : 1;
}

// Sends the command's event and prints the router's answer and report: 0
// when it was accepted, 1 when refused or the router cannot be reached; a
// mistake in what the caller asked throws a UsageError.
export async function runReplyHost(
  inv: Invocation,
  url: string,
  token: string,
  io: Io,
): Promise<number> {
  const name = inv.command ?? "";
  if (name === "check") return check(url, token, io);
  const build = SENT.includes(name) ? EVENTS[name] : undefined;
  if (!build)
    refuse(
      `This host has no configuration: it sends reply, submit, answer and choose to the router at ${url}, and router check checks it; other commands run on the router host.`,
    );
  // The session is the caller on every command. The router's notices name
  // it with --as, for the router host; naming anyone else is refused.
  const session =
    callerSession(inv.env) ??
    refuse(
      "On a reply host, router acts as the participant session: $PASEO_AGENT_ID and $PASEO_TERMINAL_ID are unset.",
    );
  const named = inv.values.as ?? inv.env.ROUTER_AS;
  if (named && named !== session)
    refuse(
      `On a reply host, router acts as its own session ${session}, not ${named}.`,
    );
  const event = build(argsOf(inv, () => session));
  let sent: Awaited<ReturnType<typeof ask>>;
  try {
    sent = await ask(url, "/events", {
      method: "POST",
      headers: {
        authorization: `Bearer ${token}`,
        "content-type": "application/json",
      },
      body: JSON.stringify(event),
    });
  } catch (error: unknown) {
    io.err(unreachable(url, error));
    return 1;
  }
  const answer = sent.body;
  io.out(
    typeof answer.message === "string"
      ? answer.message
      : JSON.stringify(answer),
  );
  if (Array.isArray(answer.report))
    for (const line of answer.report) io.out(String(line));
  // The router says which commit it runs; a host left behind is told.
  const theirs = typeof answer.commit === "string" ? answer.commit : null;
  const ours = theirs && checkoutCommit();
  if (theirs && ours && theirs !== ours)
    io.err(
      `This host's router is at ${short(ours)}, the router's at ${short(theirs)}: run router host setup for this host on the router host.`,
    );
  return sent.ok && answer.ok === true ? 0 : 1;
}
