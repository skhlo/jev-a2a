// `router roster ...`: changes to the roster made the way they were made by
// hand, with the checks the hand steps relied on. The configuration is
// written beside itself, loaded to check it, kept as a dated copy and then
// swapped in; serve restarts to read it, and its first run is watched.
//
// `repoint` points a placement at a new session after its Paseo session
// was replaced: a daemon restart closes terminals, and a reopened terminal
// or a cleared agent context gets a new id.
import {
  chmodSync,
  copyFileSync,
  readFileSync,
  realpathSync,
  renameSync,
  rmSync,
  statSync,
  writeFileSync,
} from "node:fs";
import { loadConfig, terminalOf } from "./config.ts";
import { own } from "./core.ts";
import { refuse } from "./request.ts";
import type { State } from "./types.ts";

export type RosterDeps = {
  configPath: string;
  // The record as it stands, read without the lock.
  record(): State;
  // The session as the Paseo daemon on `host` names it; null when the
  // daemon does not know it.
  resolve(host: string, session: string): Promise<string | null>;
  // Restarts serve and waits until it answers.
  restart(): Promise<void>;
  sleep(ms: number): Promise<void>;
  now(): Date;
  log(line: string): void;
};

// serve's first run observes every placement; a slow host takes a while.
const BIND_SECONDS = 90;

const isRecord = (value: unknown): value is Record<string, unknown> =>
  value !== null && typeof value === "object" && !Array.isArray(value);

// Writes `next` as the configuration once it loads, keeping the old one
// as a dated copy; the copy's path. Through a symlink, the file it names
// is the one replaced. The file keeps its indent and mode.
function swapConfig(path: string, next: unknown, now: Date): string {
  const real = realpathSync(path);
  const indent = /\n([ \t]+)"/.exec(readFileSync(real, "utf8"))?.[1] ?? "  ";
  const mode = statSync(real).mode & 0o7777;
  const candidate = `${real}.new`;
  writeFileSync(candidate, `${JSON.stringify(next, null, indent)}\n`);
  chmodSync(candidate, mode);
  try {
    loadConfig(candidate);
  } catch (error: unknown) {
    rmSync(candidate, { force: true });
    refuse(
      (error instanceof Error ? error.message : String(error)).replaceAll(
        candidate,
        path,
      ),
    );
  }
  const stamp = now.toISOString().replace(/[-:]|\.\d+/g, "");
  const backup = `${real}.bak-${stamp}`;
  copyFileSync(real, backup);
  renameSync(candidate, real);
  return backup;
}

// The configuration file, as written, with `placement` at `session`. A
// terminal takes no message key, so its participant's sends are not
// repeated (see checkTerminal in config.ts); an agent has no terminal CLI.
function pointed(
  path: string,
  placement: string,
  session: string,
  log: (line: string) => void,
): Record<string, unknown> {
  const file: unknown = JSON.parse(readFileSync(path, "utf8"));
  if (!isRecord(file) || !isRecord(file.agents))
    return refuse("The configuration has no agents.");
  file.agents[placement] = session;
  if (terminalOf(session) !== null) {
    const participant = placement.slice(0, placement.lastIndexOf("@"));
    const entry = (Array.isArray(file.participants) ? file.participants : [])
      .filter(isRecord)
      .find((p) => p.id === participant);
    if (entry?.idempotent === true) {
      entry.idempotent = false;
      log(`${participant} is idempotent: false now, for a terminal.`);
    }
  } else if (
    isRecord(file.terminals) &&
    own(file.terminals, placement) !== undefined
  ) {
    delete file.terminals[placement];
    log(`terminals.${placement} removed: ${session} is an agent.`);
  }
  return file;
}

// After a restart: whether serve's first run binds `session` at
// `placement`, looking once a second.
async function watchBind(
  placement: string,
  session: string,
  deps: RosterDeps,
): Promise<number> {
  for (let tries = 0; tries < BIND_SECONDS; tries++) {
    const entry = own(deps.record().placements, placement);
    if (entry?.session === session) {
      deps.log(
        `${placement}: serve binds ${session}, ${entry.ready ? "ready" : "not ready yet"}.`,
      );
      return 0;
    }
    await deps.sleep(1000);
  }
  deps.log(
    `${placement}: serve has not bound ${session} in ${BIND_SECONDS} seconds; its first run may still be going. router status shows when it does; if it never does, see serve's log and run this again.`,
  );
  return 1;
}

// `router roster repoint <participant@host> <session>`: 0 when serve binds
// the placement to the session. Asked again after a restart that bound
// nothing, it restarts serve without writing the file again.
export async function repoint(
  placement: string,
  session: string,
  deps: RosterDeps,
): Promise<number> {
  const config = loadConfig(deps.configPath);
  const configured =
    own(config.agents, placement) ??
    refuse(`${placement} is not a placement in agents.`);
  const host = placement.slice(placement.lastIndexOf("@") + 1);
  const state = deps.record();
  const before = own(state.placements, placement)?.session;
  if (configured === session && before === session) {
    deps.log(`${placement} is at ${session} already.`);
    return 0;
  }
  // The core takes no session it has seen, so a placement never goes back
  // to its old one: another placement's, or this one's before.
  const seen = own(state.sessions, session);
  if (seen && before !== session)
    refuse(
      `The record knows ${session} already, as ${seen.participant}@${seen.host}'s; a placement takes a session it has not seen.`,
    );
  const other = Object.keys(config.agents).find(
    (key) => key !== placement && config.agents[key] === session,
  );
  if (other) refuse(`${other} is at ${session} already.`);
  const resolved = await deps
    .resolve(host, session)
    .catch((error: unknown) =>
      refuse(
        `Cannot reach Paseo on ${host}: ${error instanceof Error ? error.message : String(error)}`,
      ),
    );
  if (resolved === null) refuse(`Paseo on ${host} does not know ${session}.`);
  // The daemon finds an agent by a prefix or a title too, but the record
  // binds the id as written.
  if (resolved !== session)
    refuse(
      `Paseo on ${host} knows ${session} as ${resolved}; name it by that id.`,
    );
  // A configuration already changed (a restart that failed) only needs
  // serve to read it.
  if (configured !== session) {
    const file = pointed(deps.configPath, placement, session, deps.log);
    const backup = swapConfig(deps.configPath, file, deps.now());
    deps.log(
      `${placement}: ${configured} -> ${session}; the old configuration is ${backup}.`,
    );
  }
  const open = state.tasks
    .flatMap((task) => task.deliveries)
    .filter((d) => before && d.session === before && d.end == null).length;
  if (open)
    deps.log(
      `${open} open ${open === 1 ? "delivery" : "deliveries"} went to the old session ${before}; router needs-you lists what they need.`,
    );
  await deps.restart();
  return watchBind(placement, session, deps);
}
