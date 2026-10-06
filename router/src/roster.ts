// `router roster ...`: changes to the roster made the way they were made by
// hand, with the checks the hand steps relied on. The configuration is
// written beside itself, loaded to check it, kept as a dated copy and then
// swapped in; serve restarts to read it, and its first run is watched.
//
// `repoint` points a placement at a new session after its Paseo session
// was replaced: a daemon restart closes terminals, and a reopened terminal
// or a cleared agent context gets a new id.
import {
  copyFileSync,
  readFileSync,
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
  // Whether the Paseo daemon on `host` knows the session.
  known(host: string, session: string): Promise<boolean>;
  // Restarts serve and waits until it answers.
  restart(): Promise<void>;
  sleep(ms: number): Promise<void>;
  now(): Date;
  log(line: string): void;
};

const isRecord = (value: unknown): value is Record<string, unknown> =>
  value !== null && typeof value === "object" && !Array.isArray(value);

// A section of the configuration file as it is written, to edit in place.
const section = (file: Record<string, unknown>, key: string) => {
  const value = file[key] ?? {};
  if (!isRecord(value)) return refuse(`${key} is not an object.`);
  file[key] = value;
  return value;
};

// Writes `next` as the configuration once it loads, keeping the old one
// as a dated copy; the copy's path. The file keeps its indent and mode.
function swapConfig(path: string, next: unknown, now: Date): string {
  const indent = /\n( +)"/.exec(readFileSync(path, "utf8"))?.[1]?.length ?? 2;
  const candidate = `${path}.new`;
  writeFileSync(candidate, `${JSON.stringify(next, null, indent)}\n`, {
    mode: statSync(path).mode & 0o777,
  });
  try {
    loadConfig(candidate);
  } catch (error: unknown) {
    rmSync(candidate, { force: true });
    refuse(error instanceof Error ? error.message : String(error));
  }
  const stamp = now.toISOString().replace(/[-:]|\.\d+/g, "");
  const backup = `${path}.bak-${stamp}`;
  copyFileSync(path, backup);
  renameSync(candidate, path);
  return backup;
}

// After a restart: whether serve's first run binds `session` at
// `placement`, looking once a second for half a minute.
async function bound(
  placement: string,
  session: string,
  deps: RosterDeps,
): Promise<number> {
  for (let tries = 0; tries < 30; tries++) {
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
    `${placement}: serve has not bound ${session} after 30 seconds; see router status and serve's log.`,
  );
  return 1;
}

// `router roster repoint <participant@host> <session>`: 0 when serve binds
// the placement to the session.
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
  const participant = placement.slice(0, placement.lastIndexOf("@"));
  const state = deps.record();
  const before = own(state.placements, placement)?.session;
  if (configured === session && before === session) {
    deps.log(`${placement} is at ${session} already.`);
    return 0;
  }
  // A configuration already changed (a restart that failed) only needs
  // serve to read it.
  if (configured !== session) {
    const seen = own(state.sessions, session);
    if (seen)
      refuse(
        `The record knows ${session} already, as ${seen.participant}@${seen.host}'s; a placement takes a session it has not seen.`,
      );
    const known = await deps
      .known(host, session)
      .catch((error: unknown) =>
        refuse(
          `Cannot reach Paseo on ${host}: ${error instanceof Error ? error.message : String(error)}`,
        ),
      );
    if (!known) refuse(`Paseo on ${host} does not know ${session}.`);
    const file: unknown = JSON.parse(readFileSync(deps.configPath, "utf8"));
    if (!isRecord(file)) return refuse("The configuration is not an object.");
    section(file, "agents")[placement] = session;
    if (terminalOf(session) !== null) {
      // A terminal takes no message key, so its participant's sends are
      // not repeated (see checkTerminal in config.ts).
      const entry = (Array.isArray(file.participants) ? file.participants : [])
        .filter(isRecord)
        .find((p) => p.id === participant);
      if (entry?.idempotent === true) {
        entry.idempotent = false;
        deps.log(`${participant} is idempotent: false now, for a terminal.`);
      }
    } else if (
      isRecord(file.terminals) &&
      own(file.terminals, placement) !== undefined
    ) {
      delete file.terminals[placement];
      deps.log(`terminals.${placement} removed: ${session} is an agent.`);
    }
    const backup = swapConfig(deps.configPath, file, deps.now());
    deps.log(
      `${placement}: ${configured} -> ${session}; the old configuration is ${backup}.`,
    );
  }
  const open = state.tasks
    .flatMap((task) => task.deliveries)
    .filter((d) => before && d.session === before && d.end == null);
  if (open.length)
    deps.log(
      `${open.length} open deliveries went to the old session ${before}; router needs-you lists what they need.`,
    );
  await deps.restart();
  return bound(placement, session, deps);
}
