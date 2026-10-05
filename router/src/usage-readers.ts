// The usage readers: each account's sources, read with this host's own
// logins. A port of API Dash's providers.ts. Requests are bounded in time and
// size and refuse redirects, so a credential never follows one. Credentials
// are read for the request and dropped: never written, cached, logged or put
// in a reading, and a provider's error text never becomes a message. A
// credential helper (a `!command` in Pi's auth.json) is never run.
//
// Codex: `account/rateLimits/read` and `account/usage/read` from `codex
// app-server` over stdio; the app-server keeps its own login and may refresh
// it, so its auth file is never read here. Claude: the OAuth usage endpoint
// with Claude Code's credential file, which Claude Code itself refreshes;
// the router never refreshes it, and an expired one reads as such. DeepSeek
// and OpenRouter: their APIs, with keys from the environment or Pi's
// auth.json, and OpenRouter's management key from the environment (the
// router's secrets.env).
import { spawn } from "node:child_process";
import { readFile } from "node:fs/promises";
import { homedir, tmpdir } from "node:os";
import { join } from "node:path";
import { createInterface } from "node:readline";
import {
  aged,
  claudeReading,
  codexReading,
  createUsageStore,
  deepseekReading,
  isStale,
  LABEL,
  openrouterReading,
  ReadError,
  record,
  said,
} from "./usage.ts";
import type {
  AccountId,
  Loader,
  Metric,
  Reading,
  UsageDetail,
  UsageStore,
} from "./usage.ts";
import { codexDetails, openrouterDetails } from "./usage-details.ts";

async function jsonFile(path: string): Promise<Record<string, unknown>> {
  try {
    return record(JSON.parse(await readFile(path, "utf8")));
  } catch {
    return {};
  }
}
// A key as stored, unless it is empty, holds a control character (a line
// break among them) or is a credential helper's command.
function usableKey(value: unknown): string | undefined {
  return typeof value === "string" &&
    value.trim() &&
    !value.startsWith("!") &&
    !/[\x00-\x1f\x7f]/.test(value)
    ? value.trim()
    : undefined;
}
// `<PROVIDER>_API_KEY`, else the provider's API-key entry in Pi's auth.json.
async function apiKey(
  home: string,
  provider: "openrouter" | "deepseek",
  env: NodeJS.ProcessEnv,
): Promise<string | undefined> {
  const fromEnv = usableKey(env[`${provider.toUpperCase()}_API_KEY`]);
  if (fromEnv) return fromEnv;
  const auth = await jsonFile(join(home, ".pi/agent/auth.json"));
  const credential = record(auth[provider]);
  return credential.type === "api_key" ? usableKey(credential.key) : undefined;
}

// Credentials the Codex child has no use for: the router's token, Jev's
// key, an inherited Claude Code token and the API keys the other readers
// send. childEnv drops these and every name in `secrets`, the names the
// router's secrets file sets (loadSecrets).
const ROUTER_SECRETS = [
  "ROUTER_TOKEN",
  "TYPESAFE_API_KEY",
  "CLAUDE_CODE_OAUTH_TOKEN",
  "OPENROUTER_API_KEY",
  "OPENROUTER_MANAGEMENT_KEY",
  "DEEPSEEK_API_KEY",
];
export const childEnv = (
  env: NodeJS.ProcessEnv,
  secrets: readonly string[] = [],
): NodeJS.ProcessEnv =>
  Object.fromEntries(
    Object.entries(env).filter(
      ([key]) => !ROUTER_SECRETS.includes(key) && !secrets.includes(key),
    ),
  );

// The provider refused the credential (HTTP 401 or 403). A loader turns it
// into what to do about it, for the credential it sent.
class RefusedError extends ReadError {
  status: number;
  constructor(status: number) {
    super(`The provider refused the credential (HTTP ${status}).`);
    this.status = status;
  }
}

// A GET with a bearer key: twelve seconds, a megabyte, no redirect. Every
// failure is one of the router's sentences: the platform's own error text
// (a refused redirect, a header it would not send) can carry the key.
const timedOut = (error: unknown): boolean =>
  error instanceof Error && error.name === "TimeoutError";
export const FETCH_LIMITS = { timeoutMs: 12_000, maxBytes: 1_000_000 };
export async function fetchJson(
  url: string,
  key: string,
  headers: Record<string, string> = {},
  limits: typeof FETCH_LIMITS = FETCH_LIMITS,
): Promise<unknown> {
  let response: Response;
  try {
    response = await fetch(url, {
      headers: {
        Authorization: `Bearer ${key}`,
        Accept: "application/json",
        ...headers,
      },
      redirect: "error",
      signal: AbortSignal.timeout(limits.timeoutMs),
    });
  } catch (error: unknown) {
    throw new ReadError(
      timedOut(error)
        ? "The usage request timed out."
        : "The usage request could not be made.",
    );
  }
  if (response.status === 401 || response.status === 403)
    throw new RefusedError(response.status);
  if (!response.ok)
    throw new ReadError(`The usage request failed (HTTP ${response.status}).`);
  if (!response.body) throw new ReadError("The usage response was empty.");
  let size = 0;
  const chunks: Uint8Array[] = [];
  try {
    for await (const chunk of response.body) {
      size += chunk.byteLength;
      if (size > limits.maxBytes)
        throw new ReadError("The usage response was too large.");
      chunks.push(chunk);
    }
  } catch (error: unknown) {
    if (error instanceof ReadError) throw error;
    throw new ReadError(
      timedOut(error)
        ? "The usage request timed out."
        : "The usage response was cut short.",
    );
  }
  try {
    return JSON.parse(Buffer.concat(chunks).toString("utf8")) as unknown;
  } catch {
    throw new ReadError("The usage response was not JSON.");
  }
}

// One request to the Codex app-server over stdio: initialize, then
// `account/rateLimits/read` ("codex") or `account/usage/read`
// ("codex-usage"), then a bounded shutdown. It settles once the child has
// closed. The child runs in the temporary directory, without the router's
// own credentials in its environment.
export function readUsageRpc(
  command: string,
  args: string[],
  protocol: "codex" | "codex-usage",
  timeoutMs = 15_000,
  env: NodeJS.ProcessEnv = childEnv(process.env),
): Promise<unknown> {
  return new Promise((resolve, reject) => {
    const child = spawn(command, args, {
      cwd: tmpdir(),
      env,
      stdio: ["pipe", "pipe", "ignore"],
    });
    const lines = createInterface({ input: child.stdout });
    let outcome: { value?: unknown; error?: Error } | undefined;
    let settled = false;
    let initialized = false;
    let outputSize = 0;
    let stop: NodeJS.Timeout | undefined;
    let closeDeadline: NodeJS.Timeout | undefined;
    const settle = (closeError?: Error) => {
      if (settled) return;
      settled = true;
      clearTimeout(timeout);
      clearTimeout(stop);
      clearTimeout(closeDeadline);
      const error = outcome?.error ?? closeError;
      if (error) reject(error);
      else resolve(outcome?.value);
    };
    const timeout = setTimeout(
      () => finish(undefined, new ReadError("Codex usage timed out.")),
      timeoutMs,
    );
    const finish = (value?: unknown, error?: Error) => {
      if (outcome || settled) return;
      outcome = error ? { value, error } : { value };
      clearTimeout(timeout);
      lines.close();
      child.stdin.end();
      child.stdout.resume();
      child.kill("SIGTERM");
      stop = setTimeout(() => {
        child.kill("SIGKILL");
        closeDeadline = setTimeout(
          () => settle(new ReadError("The Codex app-server did not close.")),
          1000,
        );
      }, 1000);
    };
    const send = (message: Record<string, unknown>) =>
      child.stdin.write(JSON.stringify(message) + "\n");
    child.stdin.on("error", () =>
      finish(undefined, new ReadError("Codex usage connection closed.")),
    );
    child.stdout.prependListener("data", (chunk: Buffer) => {
      outputSize += chunk.length;
      if (outputSize > 1_000_000)
        finish(undefined, new ReadError("Codex usage response too large."));
    });
    child.on("error", () =>
      finish(undefined, new ReadError("The codex CLI is not available.")),
    );
    child.once("close", () => {
      lines.close();
      // A valid response starts our own shutdown. The app-server may turn
      // that signal into a nonzero exit code; it does not void the reading.
      settle(!outcome ? new ReadError("Codex usage exited early.") : undefined);
    });
    lines.on("line", (line) => {
      if (outcome || settled) return;
      if (line.length > 1_000_000)
        return finish(
          undefined,
          new ReadError("Codex usage response too large."),
        );
      let response: Record<string, unknown>;
      try {
        response = record(JSON.parse(line));
      } catch {
        return;
      }
      if (response.id === 1 && !initialized) {
        if (response.error || !("result" in response))
          return finish(
            undefined,
            new ReadError("Codex usage initialization failed."),
          );
        initialized = true;
        send({ method: "initialized" });
        send({
          method:
            protocol === "codex-usage"
              ? "account/usage/read"
              : "account/rateLimits/read",
          id: 2,
          params: {},
        });
      } else if (response.id === 2 && initialized) {
        finish(
          response.result,
          response.error || !("result" in response)
            ? new ReadError("Codex usage unavailable.")
            : undefined,
        );
      }
    });
    send({
      method: "initialize",
      id: 1,
      params: {
        clientInfo: { name: "jev_router", title: "Jev router", version: "1" },
      },
    });
  });
}

// Claude Code's OAuth access token, from the credential file Claude Code
// keeps and refreshes ($CLAUDE_CONFIG_DIR, else ~/.claude) and from nowhere
// else, so its expiry always applies. A CLAUDE_CODE_OAUTH_TOKEN inherited
// from an agent's environment is not used.
async function claudeToken(
  home: string,
  env: NodeJS.ProcessEnv,
  now: number,
): Promise<string> {
  const dir = env.CLAUDE_CONFIG_DIR || join(home, ".claude");
  const file = await jsonFile(join(dir, ".credentials.json"));
  const oauth = record(file.claudeAiOauth);
  const token = usableKey(oauth.accessToken);
  if (!token)
    throw new ReadError(
      "No Claude login on this host. Open Claude Code and run /login.",
    );
  if (typeof oauth.expiresAt === "number" && oauth.expiresAt <= now)
    throw new ReadError("Claude login expired; open Claude Code.");
  return token;
}

// A source that keeps its last value: a failure, a missing value or an
// older one returns the previous value as failed, with the error. Only
// normalized values are kept, never a payload or a credential.
type Kept<T> = { value: T | null; failed: boolean; error: unknown };
function retained<T extends { observedAt: number }, A extends unknown[]>(
  load: (...args: A) => Promise<T | null>,
) {
  let previous: T | null = null;
  return async (...args: A): Promise<Kept<T>> => {
    try {
      const value = await load(...args);
      if (value === null) throw new Error("Source not read.");
      if (previous && value.observedAt < previous.observedAt)
        throw new Error("Source older than the kept value.");
      previous = value;
      return { value, failed: false, error: null };
    } catch (error: unknown) {
      return { value: previous, failed: true, error };
    }
  };
}

// An account from its current allowance and its histories, which are read
// and kept apart: history alone is a reading with the allowance
// unavailable, and each failure adds a notice naming what failed. Nothing
// at all throws the allowance's error.
function combine(
  source: string,
  allowance: Kept<Reading>,
  histories: (Kept<UsageDetail> & { name: string })[],
  now: number,
  notices: string[],
): Reading {
  const details = histories.flatMap(({ value, failed }) =>
    value
      ? [
          {
            ...value,
            status:
              failed || aged(value.observedAt, now)
                ? ("stale" as const)
                : ("ready" as const),
          },
        ]
      : [],
  );
  if (!allowance.value && !details.length)
    throw allowance.error instanceof ReadError
      ? allowance.error
      : new Error("Usage unavailable.");
  const base = allowance.value ?? {
    allowance: "unavailable" as const,
    source,
    observedAt: Math.max(...details.map((d) => d.observedAt)),
    windows: [],
    metrics: [],
    notice: null,
    details: [],
  };
  return {
    ...base,
    allowance: !allowance.value
      ? "unavailable"
      : allowance.failed || isStale(allowance.value, now)
        ? "stale"
        : "ready",
    details,
    notice:
      [
        base.notice,
        ...notices,
        ...histories
          .filter((h) => h.failed)
          .map((h) => `${h.name} could not be refreshed.`),
      ]
        .filter(Boolean)
        .join(" ") || null,
  };
}

// What a refused credential reads as, per credential: who refused what,
// and the next step.
const REFUSED = {
  claude: ["Claude", "login", "open Claude Code and run /login."],
  deepseek: [
    "DeepSeek",
    "API key",
    "check the provider API key (DEEPSEEK_API_KEY or Pi's auth.json).",
  ],
  openrouterKey: [
    "OpenRouter",
    "API key",
    "check the provider API key (OPENROUTER_API_KEY or Pi's auth.json).",
  ],
  openrouterManagement: [
    "OpenRouter",
    "management key",
    "check OPENROUTER_MANAGEMENT_KEY.",
  ],
} as const;

export type ReaderIo = {
  readUsageRpc?: typeof readUsageRpc;
  fetchJson?: typeof fetchJson;
  clock?: () => number;
};

// Where and how the loaders read: as `home`'s user with `env` (the
// router's own by default), through `io` (the real process, request and
// clock by default). `secrets` names the router's own secrets beyond the
// fixed ones, which the Codex child does not get.
export type LoaderOptions = {
  home: string;
  env?: NodeJS.ProcessEnv;
  io?: ReaderIo;
  secrets?: readonly string[];
};

// One loader per account. Each source is kept apart, so one that fails
// never hides another.
export function createLoaders({
  home,
  env = process.env,
  io = {},
  secrets = [],
}: LoaderOptions): Record<AccountId, Loader> {
  const rpc = io.readUsageRpc ?? readUsageRpc;
  const fetchUsage = io.fetchJson ?? fetchJson;
  const clock = io.clock ?? Date.now;
  const appServer = ["app-server", "--listen", "stdio://"];
  // A provider request whose refused credential reads as the next step:
  // `who` refused `what`, then `next`.
  const request = async (
    url: string,
    key: string,
    [who, what, next]: readonly [string, string, string],
    headers: Record<string, string> = {},
  ): Promise<unknown> => {
    try {
      return await fetchUsage(url, key, headers);
    } catch (error: unknown) {
      if (error instanceof RefusedError)
        throw new ReadError(
          `${who} refused the ${what} (HTTP ${error.status}): ${next}`,
        );
      throw error;
    }
  };
  const codexEnv = childEnv(env, secrets);
  const codexLimits = retained(async () =>
    codexReading(
      await rpc("codex", appServer, "codex", 15_000, codexEnv),
      clock(),
    ),
  );
  const codexHistory = retained(async () =>
    codexDetails(
      await rpc("codex", appServer, "codex-usage", 15_000, codexEnv),
      clock(),
    ),
  );
  const openrouterKey = retained(async (key: string | undefined) =>
    key
      ? openrouterReading(
          await request(
            "https://openrouter.ai/api/v1/key",
            key,
            REFUSED.openrouterKey,
          ),
          null,
          clock(),
        )
      : null,
  );
  const openrouterCredits = retained(async (key: string | undefined) =>
    key
      ? openrouterReading(
          null,
          await request(
            "https://openrouter.ai/api/v1/credits",
            key,
            REFUSED.openrouterManagement,
          ),
          clock(),
        )
      : null,
  );
  const openrouterHistory = retained(async (key: string | undefined) =>
    key
      ? openrouterDetails(
          await request(
            "https://openrouter.ai/api/v1/activity",
            key,
            REFUSED.openrouterManagement,
          ),
          clock(),
        )
      : null,
  );
  return {
    codex: async () => {
      const [limits, history] = await Promise.all([
        codexLimits(),
        codexHistory(),
      ]);
      return combine(
        "Codex account usage",
        limits,
        [{ name: "Token activity", ...history }],
        clock(),
        limits.failed
          ? [said(limits.error, "Current limits could not be refreshed.")]
          : [],
      );
    },
    // One source: a failure keeps the last reading, in the store.
    claude: async () => {
      const token = await claudeToken(home, env, clock());
      return claudeReading(
        await request(
          "https://api.anthropic.com/api/oauth/usage",
          token,
          REFUSED.claude,
          { "anthropic-beta": "oauth-2025-04-20" },
        ),
        clock(),
      );
    },
    deepseek: async () => {
      const key = await apiKey(home, "deepseek", env);
      if (!key)
        throw new ReadError(
          "No DeepSeek API key on this host: set DEEPSEEK_API_KEY or add one to Pi's auth.json.",
        );
      return deepseekReading(
        await request(
          "https://api.deepseek.com/user/balance",
          key,
          REFUSED.deepseek,
        ),
        clock(),
      );
    },
    // The key's usage needs its API key; the account's balance and spending
    // need a management key. Without one the account reads its key alone,
    // and says the balance needs the management key.
    openrouter: async () => {
      const key = await apiKey(home, "openrouter", env);
      const management = usableKey(env.OPENROUTER_MANAGEMENT_KEY);
      if (!key && !management)
        throw new ReadError(
          "No OpenRouter key on this host: set OPENROUTER_API_KEY or add one to Pi's auth.json, and OPENROUTER_MANAGEMENT_KEY for the account.",
        );
      const [usage, credits, history] = await Promise.all([
        openrouterKey(key),
        openrouterCredits(management),
        openrouterHistory(management),
      ]);
      const values = [credits.value, usage.value].filter(
        (v): v is Reading => v !== null,
      );
      const metrics: Metric[] = values.flatMap((v) => v.metrics);
      if (!management && !credits.value)
        metrics.unshift({
          label: LABEL.accountBalance,
          value: "No management key",
          unit: null,
        });
      const notices = [
        !management
          ? "A management key is required for the account balance and spending (OPENROUTER_MANAGEMENT_KEY)."
          : credits.failed
            ? said(credits.error, "The account balance could not be refreshed.")
            : null,
        !key
          ? "No OpenRouter API key on this host, so key usage is not read."
          : usage.failed
            ? said(usage.error, "Key usage could not be refreshed.")
            : null,
      ].filter((n): n is string => n !== null);
      const allowance: Kept<Reading> = {
        value: values.length
          ? {
              allowance: "ready",
              source: "OpenRouter API",
              observedAt: Math.min(...values.map((v) => v.observedAt)),
              windows: values.flatMap((v) => v.windows),
              metrics,
              notice: null,
              details: [],
            }
          : null,
        failed: Boolean(
          (credits.failed && credits.value) || (usage.failed && usage.value),
        ),
        // The reason in the router's words, when either source gave one.
        error:
          [usage.error, credits.error].find((e) => e instanceof ReadError) ??
          usage.error ??
          credits.error,
      };
      return combine(
        "OpenRouter activity",
        allowance,
        management ? [{ name: "Model & provider spending", ...history }] : [],
        clock(),
        notices,
      );
    },
  };
}

// The store serve and `router usage` read: `accounts`, as the user the
// router runs as, keeping the Codex child from the secrets file's `secrets`.
// A test gives its own home, environment and I/O.
export function usageStore(
  accounts: readonly AccountId[],
  secrets: readonly string[],
  options: Omit<LoaderOptions, "home" | "secrets"> & { home?: string } = {},
): UsageStore {
  const loaders = createLoaders({ home: homedir(), ...options, secrets });
  return createUsageStore(
    Object.fromEntries(accounts.map((id) => [id, loaders[id]])),
  );
}
