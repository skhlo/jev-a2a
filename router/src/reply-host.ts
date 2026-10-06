// The router command on a reply host, one with no configuration: reply,
// submit, answer and choose go to the router's `serve` over HTTP as the
// participant session, built by the same rules as on the router host. It
// loads nothing that needs a package.
import { callerSession } from "./config.ts";
import { argsOf, EVENTS, refuse, type Invocation, type Io } from "./request.ts";

const SENT = ["reply", "submit", "answer", "choose"];

const isRecord = (value: unknown): value is Record<string, unknown> =>
  value !== null && typeof value === "object" && !Array.isArray(value);

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
  const build = SENT.includes(name) ? EVENTS[name] : undefined;
  if (!build)
    refuse(
      `This host has no configuration: it sends reply, submit, answer and choose to the router at ${url}; other commands run on the router host.`,
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
  let response: Response;
  try {
    response = await fetch(new URL("/events", url), {
      method: "POST",
      headers: {
        authorization: `Bearer ${token}`,
        "content-type": "application/json",
      },
      body: JSON.stringify(event),
    });
  } catch (error: unknown) {
    io.err(
      `Cannot reach the router at ${url}: ${error instanceof Error ? error.message : String(error)}`,
    );
    return 1;
  }
  const body: unknown = await response.json().catch(() => ({}));
  const answer = isRecord(body) ? body : {};
  io.out(
    typeof answer.message === "string" ? answer.message : JSON.stringify(body),
  );
  if (Array.isArray(answer.report))
    for (const line of answer.report) io.out(String(line));
  return response.ok && answer.ok === true ? 0 : 1;
}
