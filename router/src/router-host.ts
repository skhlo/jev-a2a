// The `router` command on the router host, the one with a configuration
// (cli.ts loads it then): the configuration and secrets, serve, eval and
// usage, the commands on the record, and exit codes.
import { join } from "node:path";
import { createServer } from "node:http";
import { mkdirSync, watch } from "node:fs";
import {
  configPathOf,
  loadConfig,
  loadSecrets,
  terminalClis,
  USAGE_EVERY,
  type RouterConfig,
} from "./config.ts";
import { own, responsibilityTexts } from "./core.ts";
import {
  serveRunner,
  recordReader,
  sessionReader,
  waitsReader,
  bind,
  BindError,
  boardListener,
  doorKeys,
  eventsListener,
  keepReading,
} from "./server.ts";
import { ACCOUNT_IDS, usageView } from "./usage.ts";
import { usageStore } from "./usage-readers.ts";
import { createPaseoAdapter } from "./paseo.ts";
import { judge } from "./jev.ts";
import {
  curve,
  evaluate,
  readSet,
  renderEval,
  unanswered,
  type Labeled,
} from "./eval.ts";
import { openShell, type ShellOptions } from "./shell.ts";
import { writeTelemetry } from "./telemetry.ts";
import { actingAs, runCommand } from "./commands.ts";
import { invocation, UsageError } from "./request.ts";

const inv = invocation(process.argv.slice(2), process.env);
const { command, values } = inv;
const configPath = configPathOf(values.config, process.env);
// An invalid configuration is a reason a restart cannot change: exit 2, so
// the service unit stays down with the message.
const config = ((): RouterConfig => {
  try {
    return loadConfig(configPath);
  } catch (error: unknown) {
    return fail(error instanceof Error ? error.message : String(error));
  }
})();
// The names the secrets file sets, which no child process the router
// starts for usage inherits.
const secretNames = loadSecrets(join(configPath, "..", "secrets.env"));

function fail(message: string): never {
  console.error(message);
  process.exit(2);
}

const crash = process.env.ROUTER_CRASH;
const apiKey = process.env.TYPESAFE_API_KEY;
const shellOptions: ShellOptions = {
  adapter: (endpoint) =>
    createPaseoAdapter(endpoint, {
      sheet: config.telemetry.sheet,
      clis: terminalClis(config),
    }),
  judge: apiKey
    ? (question) => judge(question, { ...config.jev, apiKey })
    : null,
  telemetry: (telemetry) => writeTelemetry(config.home, telemetry),
  crash:
    crash === "after_attempt" || crash === "after_send" ? crash : undefined,
};

// A mistake in a command's options exits 2 with the message.
try {
  if (command === "serve") await serve(config);
  else if (command === "eval") await evaluateSet(config);
  else if (command === "usage") await readUsage(config);
  else
    process.exit(
      await runCommand(inv, config, () => openShell(config, shellOptions), {
        out: (line) => console.log(line),
        err: (line) => console.error(line),
      }),
    );
} catch (error: unknown) {
  if (error instanceof UsageError) fail(error.message);
  throw error;
}

// `router serve`: events from participants on other hosts, and the board. Each
// event is one shell run, and runs are handled one at a time so the journal
// lock is never contended from inside the server.
async function serve(config: RouterConfig): Promise<void> {
  // Each host that sends events has its own token. Naming the hosts that
  // have one shows a token whose name matches no host.
  const keys = doorKeys(config, process.env);
  console.log(
    keys.length
      ? `events from ${keys.map((key) => key.host).join(", ")}, each with its own token`
      : "events: no host has a token, so the door refuses every event",
  );
  // Runs are serialized by the runner; while anything waits only for a
  // session, it looks again every serve.wake seconds, and with serve.poll
  // set it runs that long after the end of any run regardless. The CLI on this host
  // writes the record without passing through serve, so the runner also
  // watches the journal file.
  mkdirSync(config.home, { recursive: true });
  // One kept fold of the record for all of serve (see recordReader).
  const record = recordReader(config);
  const runner = serveRunner({
    open: () => openShell(config, { ...shellOptions, record }),
    delayMs: config.serve.wake * 1000,
    pollMs: config.serve.poll * 1000,
    waits: waitsReader(config, record),
    log: (line) => console.log(line),
    watch: (onChange) => {
      const watcher = watch(config.home, (_kind, name) => {
        if (name === "journal.jsonl") onChange();
      });
      watcher.on("error", (error: Error) =>
        console.error(`watch: ${error.message}; wake runs follow events only`),
      );
      return watcher;
    },
  });
  const handle = runner.handle;
  // With a usage section, the accounts are read on their own cadence,
  // apart from the runs, and held in memory for the board.
  const usage = config.usage;
  const store = usage && usageStore(usage.accounts, secretNames);
  const reading =
    store &&
    keepReading(store, usage.every * 1000, {
      log: (line) => console.error(line),
    });
  const deps = {
    config,
    handle,
    record,
    sessionOf: sessionReader(record),
    log: (line: string) => console.log(line),
    usage: store && (() => ({ ...store.state(), every: usage.every })),
  };
  const events = createServer(eventsListener(deps, keys));
  const board = createServer(boardListener(deps));
  // A permanent failure exits 2 and the service unit does not restart it; an
  // address that has not appeared yet exits 75 (EX_TEMPFAIL) and it does.
  try {
    await bind(events, config.serve.listen, "events", deps);
    await bind(board, config.serve.board, "board", deps);
  } catch (error: unknown) {
    if (!(error instanceof BindError)) throw error;
    console.error(error.message);
    process.exit(error.transient ? 75 : 2);
  }
  console.log(`router serve listening on http://${config.serve.listen}`);
  console.log(`router board on http://${config.serve.board}`);
  // A first run binds the sessions and picks up what waited across the
  // restart; the watcher arms the loop for what the CLI adds later.
  runner.start();
  await new Promise<void>((resolve) => {
    const stop = (): void => {
      runner.stop();
      reading?.stop();
      board.close();
      events.close(() => resolve());
    };
    process.once("SIGINT", stop);
    process.once("SIGTERM", stop);
  });
}

// `router usage`: every configured account read once (all four without a
// usage section), printed as the board model carries it, for checking the
// readers on a host. Private account data, to this terminal only; the
// journal is not opened.
async function readUsage(config: RouterConfig): Promise<void> {
  const store = usageStore(config.usage?.accounts ?? ACCOUNT_IDS, secretNames);
  await store.refresh();
  const state = {
    ...store.state(),
    every: config.usage?.every ?? USAGE_EVERY,
  };
  console.log(JSON.stringify(usageView(state, Date.now()), null, 2));
}

// `router eval`: the labeled set against this config's responsibility texts,
// as the requester would be routed. Jev is asked; the journal is not opened.
async function evaluateSet(config: RouterConfig): Promise<void> {
  if (!apiKey) fail("TYPESAFE_API_KEY is not set; add it to secrets.env.");
  const sender = actingAs(inv, config, "requester");
  const permitted = own(config.permissions ?? {}, sender) ?? [];
  if (!permitted.length) fail(`${sender} may address nobody.`);
  const responsibilities = responsibilityTexts(config.participants, permitted);
  const path =
    values.set ?? join(import.meta.dirname, "..", "eval", "requests.jsonl");
  let set: Labeled[];
  try {
    set = readSet(path, [...permitted, "none"]);
  } catch (error: unknown) {
    fail(`${path}: ${error instanceof Error ? error.message : String(error)}`);
  }
  const model = values.model ?? config.jev.model;
  const verdicts = await evaluate(set, responsibilities, (question) =>
    judge(question, { ...config.jev, model, apiKey }),
  );
  for (const line of renderEval(verdicts, curve(verdicts), model))
    console.log(line);
  // Unanswered requests read as hand-backs in the curve; do not pass for a
  // clean run.
  if (unanswered(verdicts)) process.exit(1);
}
