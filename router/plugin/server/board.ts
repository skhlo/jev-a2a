// The board's RPCs. Each forwards to serve's board API on this host
// (src/board-api.ts in the router), which builds the board from the record
// serve keeps folded and acts as the CLI here does without --as.
import type { PluginRpcContract } from "@getpaseo/plugin";
import { z } from "zod";
import * as rpc from "../shared/rpc.ts";
import { isRecord, reason, routerConfig } from "./config.ts";

// What the board uses of Paseo's PluginServerContext, so a test can stand
// in for it.
export type Handles = {
  handle<I extends z.ZodType, O extends z.ZodType>(
    contract: PluginRpcContract<I, O>,
    handler: (input: z.output<I>) => Promise<z.input<O>>,
  ): void;
};

export type BoardDeps = {
  env: Record<string, string | undefined>;
  // How long a request to serve may take: inside Paseo's 30 s limit, so a
  // slow run says what it means.
  timeoutMs?: number;
};

// What serve answers an action with; the plugin returns the task and rev,
// or fails with the router's reason.
const served = z.object({
  outcome: z.object({ ok: z.boolean(), message: z.string() }),
  rev: z.string(),
  task: z.unknown(),
});

// What a request to serve may say past serve's own answer: `orNull` when a
// 404 is an answer (no such task), `slow` what to add when serve takes too
// long (whether an action may have been recorded, and what to do).
type Ask = { body?: unknown; orNull?: boolean; slow?: string };

// One request to serve's API, with a JSON body for an action: the JSON it
// answers, null for a 404 when `orNull` says so, or an error with its
// reason.
async function api(
  { env, timeoutMs = 25_000 }: BoardDeps,
  path: string,
  { body, orNull = false, slow = "" }: Ask = {},
): Promise<unknown> {
  const { board } = routerConfig(env);
  let response: Response;
  try {
    const signal = AbortSignal.timeout(timeoutMs);
    response = await fetch(
      `http://${board}/api/${path}`,
      body === undefined
        ? { signal }
        : {
            method: "POST",
            headers: { "content-type": "application/json" },
            body: JSON.stringify(body),
            signal,
          },
    );
  } catch (error: unknown) {
    if (error instanceof Error && error.name === "TimeoutError")
      throw new Error(
        `The router's serve did not answer in ${timeoutMs / 1000} s.${slow}`,
      );
    throw new Error(
      `The router's serve does not answer at ${board}: ${reason(error)}`,
    );
  }
  const text = await response.text();
  let json: unknown;
  try {
    json = JSON.parse(text);
  } catch {
    throw new Error(
      `The router's serve at ${board} answered ${response.status} without JSON; it may be older than the plugin.`,
    );
  }
  if (response.status === 404 && orNull) return null;
  if (!response.ok)
    throw new Error(
      isRecord(json) && typeof json.message === "string"
        ? json.message
        : `The router's serve answered ${response.status}.`,
    );
  return json;
}

export function serveBoard(
  server: Handles,
  deps: BoardDeps = { env: process.env },
): void {
  const query = (
    path: string,
    params: Record<string, string | undefined>,
    ask: Ask = {},
  ) =>
    api(
      deps,
      `${path}?${new URLSearchParams(
        Object.entries(params).flatMap(([k, v]): [string, string][] =>
          v === undefined ? [] : [[k, v]],
        ),
      )}`,
      ask,
    );
  const act = async (action: string, input: object) => {
    const slow =
      action === "submit" || action === "answer"
        ? " It may still be recorded; a retry with the same messageId is safe."
        : " It may still be recorded; refetch the task before trying again.";
    const done = served.parse(
      await api(deps, "action", { body: { action, ...input }, slow }),
    );
    if (!done.outcome.ok) throw new Error(done.outcome.message);
    return rpc.acted.parse({
      message: done.outcome.message,
      rev: done.rev,
      task: done.task,
    });
  };
  server.handle(rpc.boardSummary, async ({ sinceRev }) =>
    rpc.boardSummary.output.parse(await query("summary", { sinceRev })),
  );
  server.handle(rpc.boardTask, async ({ id }) =>
    rpc.boardTask.output.parse(await query("task", { id }, { orNull: true })),
  );
  server.handle(rpc.taskAnswer, (input) => act("answer", input));
  server.handle(rpc.taskChoose, (input) => act("choose", input));
  server.handle(rpc.taskResolve, (input) => act("resolve", input));
  server.handle(rpc.taskCancel, (input) => act("cancel", input));
  server.handle(rpc.taskHold, (input) => act("hold", input));
  server.handle(rpc.taskRelease, (input) => act("release", input));
  server.handle(rpc.taskSubmit, (input) => act("submit", input));
}
