// `router roster ...`: changes to the roster made the way they were made by
// hand, with the checks the hand steps relied on. A candidate configuration
// is checked as loadConfig reads it and, when a responsibility text
// changes, judged against the labelled requests; then the file is kept as
// a dated copy, the candidate swapped in, and serve restarted to read it.
// The record takes any configuration that loads (a `configured` event only
// validates, and placements are only ever added), so no replay is needed.
//
// `repoint` points a placement at a new session after its Paseo session
// was replaced: a daemon restart closes terminals, and a reopened terminal
// or a cleared agent context gets a new id. `add`, `remove` and `refresh`
// change the participants; a text is read over ssh from its owner's main
// branch.
import { execFile } from "node:child_process";
import {
  chmodSync,
  copyFileSync,
  readFileSync,
  realpathSync,
  renameSync,
  statSync,
  writeFileSync,
} from "node:fs";
import {
  configOf,
  loadConfig,
  terminalOf,
  type RouterConfig,
} from "./config.ts";
import { own, responsibilityTexts } from "./core.ts";
import { evaluate, parseSet, type Labeled } from "./eval.ts";
import { shellCommand } from "./host-setup.ts";
import type { JudgeResult } from "./jev.ts";
import { sshArgs } from "./paseo.ts";
import { refuse } from "./request.ts";
import type { JudgmentQuestion, State } from "./types.ts";

export type RosterDeps = {
  configPath: string;
  // The record as it stands, read without the lock.
  record(): State;
  // The session as the Paseo daemon on `host` names it; null when the
  // daemon does not know it.
  resolve(host: string, session: string): Promise<string | null>;
  // A responsibility file on `host`, as its repository's main has it.
  read(host: string, path: string): Promise<string>;
  // Jev's answer to a routing question, for the eval.
  judge(question: JudgmentQuestion): Promise<JudgeResult>;
  // The labelled requests: router/eval/requests.jsonl in this checkout.
  setPath: string;
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
const records = (value: unknown): Record<string, unknown>[] =>
  Array.isArray(value) ? value.filter(isRecord) : [];
const messageOf = (error: unknown): string =>
  error instanceof Error ? error.message : String(error);
const participantOf = (placement: string): string =>
  placement.slice(0, placement.lastIndexOf("@"));
const plural = (count: number, one: string, many: string): string =>
  `${count} ${count === 1 ? one : many}`;

// What reads a responsibility file on its host, as `sh -c` with the path:
// the file as committed on its repository's main branch there, so an edit
// not merged is not read. No fetch: a host may have no login for its
// origin, or no origin. A path under ~/ is the host user's.
const READ = `set -e
PATH="$HOME/.local/bin:$HOME/.local/share/mise/shims:/opt/homebrew/bin:/usr/local/bin:$PATH"
case $1 in "~/"*) file="$HOME/\${1#"~/"}" ;; *) file=$1 ;; esac
cd "$(dirname "$file")"
git show "main:./$(basename "$file")"
`;

// The file at `path` on the host whose Paseo is at `endpoint`: over that
// ssh, or here when the endpoint is not ssh (the router host's own).
export function readOver(endpoint: string, path: string): Promise<string> {
  const ssh = endpoint.startsWith("ssh://") ? sshArgs(endpoint) : null;
  const [file, args]: [string, string[]] = ssh
    ? ["ssh", [...ssh.options, ssh.destination, shellCommand(READ, [path])]]
    : ["sh", ["-c", READ, "sh", path]];
  return new Promise((resolve, reject) => {
    execFile(file, args, { timeout: 60_000 }, (error, stdout, stderr) => {
      if (error) reject(new Error(stderr.trim() || error.message));
      else resolve(stdout);
    });
  });
}

// A participant's text in a responsibility file: its `## <id>` section, or
// the whole file when it has none. HTML comments, notes to whoever edits
// the file, are not read, as the file shows when rendered.
function textIn(file: string, id: string): string {
  const shown = file.replace(/<!--[\s\S]*?-->/g, "");
  const lines = shown.split("\n");
  const start = lines.findIndex((line) => line.trimEnd() === `## ${id}`);
  if (start < 0) return shown.trim();
  const end = lines.findIndex(
    (line, index) => index > start && line.startsWith("## "),
  );
  return lines
    .slice(start + 1, end < 0 ? undefined : end)
    .join("\n")
    .trim();
}

// The participant's text in `<host>:<path>`, read on the host.
async function textFrom(
  from: string,
  id: string,
  config: RouterConfig,
  deps: RosterDeps,
): Promise<string> {
  const colon = from.indexOf(":");
  const host = from.slice(0, colon);
  const path = from.slice(colon + 1);
  if (colon < 1 || !path) refuse(`${from} is not <host>:<path>.`);
  if (!own(config.hosts, host)) refuse(`${host} is not in hosts.`);
  const file = await deps
    .read(host, path)
    .catch((error: unknown) =>
      refuse(`Cannot read ${path} on ${host}: ${messageOf(error)}`),
    );
  return textIn(file, id) || refuse(`${from} has no text for ${id}.`);
}

// The configuration file as written, to edit.
function fileOf(path: string): Record<string, unknown> {
  const file: unknown = JSON.parse(readFileSync(path, "utf8"));
  return isRecord(file) ? file : refuse("The configuration is not an object.");
}

// A section of the file that maps names, made when it has none.
function sectionOf(
  file: Record<string, unknown>,
  key: string,
): Record<string, unknown> {
  const value = file[key];
  if (isRecord(value)) return value;
  const made: Record<string, unknown> = {};
  file[key] = made;
  return made;
}

// `next` as loadConfig would read it from `path`.
function checked(path: string, next: Record<string, unknown>): RouterConfig {
  try {
    return configOf(structuredClone(next), path);
  } catch (error: unknown) {
    return refuse(messageOf(error));
  }
}

// Writes `next` as the configuration, keeping the old one as a dated copy;
// the copy's path. Through a symlink, the file it names is the one
// replaced. The file keeps its indent and mode.
function swapConfig(
  path: string,
  next: Record<string, unknown>,
  now: Date,
): string {
  const real = realpathSync(path);
  const indent = /\n([ \t]+)"/.exec(readFileSync(real, "utf8"))?.[1] ?? "  ";
  const mode = statSync(real).mode & 0o7777;
  const candidate = `${real}.new`;
  writeFileSync(candidate, `${JSON.stringify(next, null, indent)}\n`);
  chmodSync(candidate, mode);
  const stamp = now.toISOString().replace(/[-:]|\.\d+/g, "");
  const backup = `${real}.bak-${stamp}`;
  copyFileSync(real, backup);
  renameSync(candidate, real);
  return backup;
}

// The labelled requests in `source` judged with `candidate`'s texts, as
// its requester is routed (as `router eval` does). Refused when Jev does
// not answer one, or sends one to the wrong participant at the threshold.
async function judged(
  candidate: RouterConfig,
  source: string,
  deps: RosterDeps,
  expected?: string,
): Promise<void> {
  const principals = candidate.principals ?? {};
  const requester =
    Object.keys(principals).find((id) => principals[id] === "requester") ??
    refuse("The configuration has no requester to route as.");
  const permitted = own(candidate.permissions ?? {}, requester) ?? [];
  let set: Labeled[];
  try {
    set = parseSet(source, [...permitted, "none"]);
  } catch (error: unknown) {
    return refuse(`${deps.setPath}: ${messageOf(error)}`);
  }
  if (expected && !set.some((item) => item.expect === expected))
    refuse(
      `No request in ${deps.setPath} expects ${expected}; label some first.`,
    );
  deps.log(`Judging ${set.length} labelled requests with the new texts.`);
  const verdicts = await evaluate(
    set,
    responsibilityTexts(candidate.participants, permitted),
    deps.judge,
  );
  const threshold = candidate.policy.threshold;
  const failed = verdicts.filter(
    (v) =>
      v.choice === null ||
      (v.choice !== v.expect && v.choice !== "none" && v.p >= threshold),
  );
  for (const v of failed)
    deps.log(
      `  ${v.expect} -> ${v.choice === null ? `no answer (${v.reason ?? "unknown"})` : `${v.choice} ${v.p.toFixed(2)}`}: ${v.text}`,
    );
  if (failed.length)
    refuse(
      `The eval refuses it: ${failed.length} of ${set.length} requests sent wrong at ${threshold} or not answered. Nothing changed.`,
    );
  deps.log(`Eval: none of ${set.length} requests sent wrong at ${threshold}.`);
}

// Puts `next` in place once it loads and, with a set, once the eval passes;
// the old file's copy.
async function change(
  next: Record<string, unknown>,
  set: string | null,
  deps: RosterDeps,
  expected?: string,
): Promise<string> {
  const candidate = checked(deps.configPath, next);
  if (set !== null) await judged(candidate, set, deps, expected);
  return swapConfig(deps.configPath, next, deps.now());
}

// Refuses a session `placement` cannot take: one the record has seen but
// as this placement's (the core takes no session it has seen, so a
// placement never goes back to its old one), one another placement is
// configured with, and one the host's Paseo does not know by that id.
async function checkSession(
  config: RouterConfig,
  state: State,
  placement: string,
  session: string,
  deps: RosterDeps,
): Promise<void> {
  const host = placement.slice(placement.lastIndexOf("@") + 1);
  const seen = own(state.sessions, session);
  if (seen && own(state.placements, placement)?.session !== session)
    refuse(
      `The record knows ${session} already, as ${seen.participant}@${seen.host}'s; a placement takes a session it has not seen.`,
    );
  const other = Object.keys(config.agents).find(
    (key) => key !== placement && config.agents[key] === session,
  );
  if (other) refuse(`${other} is at ${session} already.`);
  if (!own(config.hosts, host)) refuse(`${host} is not in hosts.`);
  const resolved = await deps
    .resolve(host, session)
    .catch((error: unknown) =>
      refuse(`Cannot reach Paseo on ${host}: ${messageOf(error)}`),
    );
  if (resolved === null) refuse(`Paseo on ${host} does not know ${session}.`);
  // The daemon finds an agent by a prefix or a title too, but the record
  // binds the id as written.
  if (resolved !== session)
    refuse(
      `Paseo on ${host} knows ${session} as ${resolved}; name it by that id.`,
    );
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
  const file = fileOf(path);
  sectionOf(file, "agents")[placement] = session;
  if (terminalOf(session) !== null) {
    const participant = participantOf(placement);
    const entry = records(file.participants).find((p) => p.id === participant);
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
  const state = deps.record();
  const before = own(state.placements, placement)?.session;
  if (configured === session && before === session) {
    deps.log(`${placement} is at ${session} already.`);
    return 0;
  }
  await checkSession(config, state, placement, session, deps);
  // A configuration already changed (a restart that failed) only needs
  // serve to read it.
  if (configured !== session) {
    const backup = await change(
      pointed(deps.configPath, placement, session, deps.log),
      null,
      deps,
    );
    deps.log(
      `${placement}: ${configured} -> ${session}; the old configuration is ${backup}.`,
    );
  }
  const open = state.tasks
    .flatMap((task) => task.deliveries)
    .filter((d) => before && d.session === before && d.end == null).length;
  if (open)
    deps.log(
      `${plural(open, "open delivery", "open deliveries")} went to the old session ${before}; router needs-you lists what they need.`,
    );
  await deps.restart();
  return watchBind(placement, session, deps);
}

// `router roster add <participant> <host>:<path> <host>=<session>...`: the
// participant with its text from the file, a placement on each host, and
// grants all to all, as the roster has them: it may address everyone, and
// everyone it. The labelled requests must expect it somewhere. 0 when
// serve binds every placement.
export async function add(
  id: string,
  from: string,
  placements: string[],
  deps: RosterDeps,
): Promise<number> {
  const config = loadConfig(deps.configPath);
  if (!/^[\w-]+$/.test(id))
    refuse(`${id} is not a participant id: use letters, digits, - and _.`);
  if (config.participants.some((p) => p.id === id))
    refuse(`${id} is in the roster already; refresh changes its text.`);
  const sessions = new Map<string, string>();
  for (const pair of placements) {
    const equals = pair.indexOf("=");
    const host = pair.slice(0, equals);
    const session = pair.slice(equals + 1);
    if (equals < 1 || !session) refuse(`${pair} is not <host>=<session>.`);
    if (sessions.has(host)) refuse(`${host} is named twice.`);
    sessions.set(host, session);
  }
  const state = deps.record();
  for (const [host, session] of sessions)
    await checkSession(config, state, `${id}@${host}`, session, deps);
  const text = await textFrom(from, id, config, deps);
  const file = fileOf(deps.configPath);
  const hosts = [...sessions.keys()];
  file.participants = [
    ...records(file.participants),
    {
      id,
      kind: "agent",
      hosts,
      idempotent: ![...sessions.values()].some((s) => terminalOf(s) !== null),
      responsibility: text,
      responsibilityFrom: from,
    },
  ];
  const permissions = sectionOf(file, "permissions");
  for (const list of Object.values(permissions))
    if (Array.isArray(list) && !list.includes(id)) list.push(id);
  permissions[id] = config.participants.map((p) => p.id);
  const agents = sectionOf(file, "agents");
  for (const [host, session] of sessions) agents[`${id}@${host}`] = session;
  const backup = await change(
    file,
    readFileSync(deps.setPath, "utf8"),
    deps,
    id,
  );
  deps.log(
    `${id} added on ${hosts.join(", ")}; the old configuration is ${backup}.`,
  );
  await deps.restart();
  let code = 0;
  for (const [host, session] of sessions)
    code = Math.max(code, await watchBind(`${id}@${host}`, session, deps));
  return code;
}

// The labelled requests with those expecting `id` expecting none, as
// written otherwise; how many changed.
function relabelled(set: string, id: string): { set: string; count: number } {
  let count = 0;
  const lines = set.split("\n").map((line) => {
    let item: unknown;
    try {
      item = JSON.parse(line);
    } catch {
      return line;
    }
    if (!isRecord(item) || item.expect !== id) return line;
    count++;
    return line.replace(/("expect"\s*:\s*)"(?:[^"\\]|\\.)*"/, '$1"none"');
  });
  return { set: lines.join("\n"), count };
}

// `router roster remove <participant>`: the participant, its grants and its
// placements go. The labelled requests that expected it expect none, in
// this checkout's set, for a person to commit.
export async function remove(id: string, deps: RosterDeps): Promise<number> {
  const config = loadConfig(deps.configPath);
  if (!config.participants.some((p) => p.id === id))
    refuse(`${id} is not in the roster.`);
  const file = fileOf(deps.configPath);
  file.participants = records(file.participants).filter((p) => p.id !== id);
  const permissions = sectionOf(file, "permissions");
  delete permissions[id];
  for (const [key, list] of Object.entries(permissions))
    if (Array.isArray(list))
      permissions[key] = list.filter((target) => target !== id);
  for (const key of ["agents", "terminals"]) {
    const section = file[key];
    if (isRecord(section))
      for (const placement of Object.keys(section))
        if (participantOf(placement) === id) delete section[placement];
  }
  const { set, count } = relabelled(readFileSync(deps.setPath, "utf8"), id);
  const backup = await change(file, set, deps);
  deps.log(`${id} removed; the old configuration is ${backup}.`);
  if (count) {
    writeFileSync(deps.setPath, set);
    deps.log(
      `Relabelled ${plural(count, "request", "requests")} for ${id} to expect none in ${deps.setPath}; commit that.`,
    );
  }
  const open = deps
    .record()
    .tasks.flatMap((task) => task.deliveries)
    .filter((d) => d.participant === id && d.end == null).length;
  if (open)
    deps.log(
      `${id} has ${plural(open, "open delivery", "open deliveries")} in the record; router status shows ${open === 1 ? "it" : "them"}.`,
    );
  await deps.restart();
  return 0;
}

// `router roster refresh <participant> [<host>:<path>]`: its text read
// again from where it came from, or from the file named, which it keeps.
export async function refresh(
  id: string,
  from: string | undefined,
  deps: RosterDeps,
): Promise<number> {
  const config = loadConfig(deps.configPath);
  const file = fileOf(deps.configPath);
  const entry =
    records(file.participants).find((p) => p.id === id) ??
    refuse(`${id} is not in the roster.`);
  const kept =
    typeof entry.responsibilityFrom === "string"
      ? entry.responsibilityFrom
      : undefined;
  const source =
    from ??
    kept ??
    refuse(
      `${id}'s text has no source yet: name it, router roster refresh ${id} <host>:<path>.`,
    );
  const text = await textFrom(source, id, config, deps);
  const changed = text !== entry.responsibility;
  if (!changed && source === kept) {
    deps.log(`${id}'s text is as ${source} has it already.`);
    return 0;
  }
  entry.responsibility = text;
  entry.responsibilityFrom = source;
  // Only a new text needs the eval.
  const backup = await change(
    file,
    changed ? readFileSync(deps.setPath, "utf8") : null,
    deps,
  );
  deps.log(
    `${id}'s text ${changed ? "is new" : "is unchanged"}, from ${source}; the old configuration is ${backup}.`,
  );
  await deps.restart();
  return 0;
}
