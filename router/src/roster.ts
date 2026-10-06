// `router roster ...`: changes to the roster made the way they were made by
// hand, with the checks the hand steps relied on. A candidate configuration
// is checked as loadConfig reads it and, when a responsibility text
// changes, judged against the labeled requests; then the file is kept as a
// dated copy, the candidate swapped in, and serve restarted to read it and
// watched until its first run has.
//
// The hand removal replayed a copy of the journal under the new file; this
// does not. The record takes any configuration validateConfig accepts (a
// `configured` event is refused for nothing else), history replays under
// the configurations the journal recorded, and placements are never
// removed, only no longer served. Watching the first run is the check.
//
// `repoint` points a placement at a new session after its Paseo session
// was replaced: a daemon restart closes terminals, and a reopened terminal
// or a cleared agent context gets a new id. `add`, `remove` and `refresh`
// change the participants; a text is read over ssh as committed on its
// repository's main on the host that owns it.
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
import {
  evaluate,
  failures,
  parseSet,
  verdictLine,
  type Labeled,
} from "./eval.ts";
import { HOST_PATH, shellCommand } from "./host-setup.ts";
import type { JudgeResult } from "./jev.ts";
import { sshArgs } from "./paseo.ts";
import { refuse } from "./request.ts";
import type { JudgmentQuestion, State } from "./types.ts";

// A responsibility file as read: the commit of main it was read at, with
// its date, and the file.
export type Read = { at: string; text: string };

export type RosterDeps = {
  configPath: string;
  // The record as it stands, read without the lock.
  record(): State;
  // The session as the Paseo daemon on `host` names it; null when the
  // daemon does not know it.
  resolve(host: string, session: string): Promise<string | null>;
  // A responsibility file on `host`, as its repository's main has it.
  read(host: string, path: string): Promise<Read>;
  // Jev's answer to a routing question, for the eval, asked as the
  // requester `router eval` routes as.
  judge(question: JudgmentQuestion): Promise<JudgeResult>;
  requester(): string;
  // The labeled requests: router/eval/requests.jsonl in this checkout.
  setPath: string;
  // Restarts serve and waits until it answers.
  restart(): Promise<void>;
  sleep(ms: number): Promise<void>;
  now(): Date;
  log(line: string): void;
};

// serve's first run observes every placement; a slow host takes a while.
const WATCH_SECONDS = 90;
const STILL = `its first run may still be going. router status shows when it does; if it never does, see serve's log`;

const isRecord = (value: unknown): value is Record<string, unknown> =>
  value !== null && typeof value === "object" && !Array.isArray(value);
const records = (value: unknown): Record<string, unknown>[] =>
  Array.isArray(value) ? value.filter(isRecord) : [];
const messageOf = (error: unknown): string =>
  error instanceof Error ? error.message : String(error);
const participantOf = (placement: string): string =>
  placement.slice(0, placement.lastIndexOf("@"));
const hostOf = (placement: string): string =>
  placement.slice(placement.lastIndexOf("@") + 1);
const plural = (count: number, one: string, many: string): string =>
  `${count} ${count === 1 ? one : many}`;

// `left<separator>right`, both sides given.
function split(text: string, separator: string): [string, string] | null {
  const at = text.indexOf(separator);
  const right = text.slice(at + separator.length);
  return at > 0 && right ? [text.slice(0, at), right] : null;
}

// What reads a responsibility file on its host, as `sh -c` with the path:
// main's commit and date on the first line, then the file as committed on
// main, so an edit not merged there is not read. No fetch: a host may have
// no login for its origin, or no origin. A path under ~/ is the host
// user's.
const READ = `set -e
${HOST_PATH}
case $1 in "~/"*) file="$HOME/\${1#"~/"}" ;; *) file=$1 ;; esac
cd "$(dirname "$file")"
git log -1 --format='%h %cs' main
git show "main:./$(basename "$file")"
`;

// An endpoint on this machine.
const LOCAL = /^(127\.|localhost$|\[::1\]$)/;

// The file at `path` on the host whose Paseo is at `endpoint`: over that
// ssh, or here when the endpoint is on this machine.
export function readOver(endpoint: string, path: string): Promise<Read> {
  const ssh = endpoint.startsWith("ssh://") ? sshArgs(endpoint) : null;
  if (!ssh && !LOCAL.test(new URL(endpoint).hostname))
    return Promise.reject(
      new Error(`${endpoint} is neither ssh nor this machine.`),
    );
  const [file, args]: [string, string[]] = ssh
    ? ["ssh", [...ssh.options, ssh.destination, shellCommand(READ, [path])]]
    : ["sh", ["-c", READ, "sh", path]];
  return new Promise((resolve, reject) => {
    execFile(file, args, { timeout: 60_000 }, (error, stdout, stderr) => {
      const newline = stdout.indexOf("\n");
      if (error) reject(new Error(stderr.trim() || error.message));
      else
        resolve({
          at: stdout.slice(0, newline),
          text: stdout.slice(newline + 1),
        });
    });
  });
}

// A participant's text in a responsibility file `from`: its `## <id>`
// section, up to the next heading of the same level or above, or the whole
// file when it has no sections. HTML comments, notes to whoever edits the
// file, are not read, as the file shows when rendered.
function textIn(file: string, id: string, from: string): string {
  const shown = file.replace(/<!--[\s\S]*?-->/g, "");
  if (shown.includes("<!--")) refuse(`${from} has a <!-- that never ends.`);
  const lines = shown.split("\n");
  const start = lines.findIndex((line) => line.trimEnd() === `## ${id}`);
  if (start < 0) {
    if (lines.some((line) => line.startsWith("## ")))
      refuse(`${from} has sections, and none is ## ${id}.`);
    return shown.trim();
  }
  const end = lines.findIndex(
    (line, index) => index > start && /^#{1,2} /.test(line),
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
  const [host, path] =
    split(from, ":") ?? refuse(`${from} is not <host>:<path>.`);
  if (!own(config.hosts, host)) refuse(`${host} is not in hosts.`);
  const read = await deps
    .read(host, path)
    .catch((error: unknown) =>
      refuse(`Cannot read ${path} on ${host}: ${messageOf(error)}`),
    );
  const text =
    textIn(read.text, id, from) || refuse(`${from} has no text for ${id}.`);
  deps.log(
    `${id}'s text: ${text.length} characters from ${from}, main at ${read.at}.`,
  );
  return text;
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

// `next` once it loads as loadConfig would read it and, given a labeled
// set, once the set judged with its texts sends nothing wrong at the
// threshold and every request is answered, as `router eval` rules. With
// `expected`, some request must expect that participant.
async function approved(
  next: Record<string, unknown>,
  set: string | null,
  deps: RosterDeps,
  expected?: string,
): Promise<RouterConfig> {
  let candidate: RouterConfig;
  try {
    candidate = configOf(structuredClone(next), deps.configPath);
  } catch (error: unknown) {
    return refuse(messageOf(error));
  }
  if (set === null) return candidate;
  const permitted = own(candidate.permissions ?? {}, deps.requester()) ?? [];
  let items: Labeled[];
  try {
    items = parseSet(set, [...permitted, "none"]);
  } catch (error: unknown) {
    return refuse(`${deps.setPath}: ${messageOf(error)}`);
  }
  if (expected && !items.some((item) => item.expect === expected))
    refuse(
      `No request in ${deps.setPath} expects ${expected}; label some first.`,
    );
  deps.log(`Judging ${items.length} labeled requests with the new texts.`);
  const verdicts = await evaluate(
    items,
    responsibilityTexts(candidate.participants, permitted),
    deps.judge,
  );
  const threshold = candidate.policy.threshold;
  const failed = failures(verdicts, threshold);
  for (const v of failed) deps.log(verdictLine(v));
  if (failed.length)
    refuse(
      `The eval refuses it: ${failed.length} of ${items.length} requests sent wrong at ${threshold} or not answered. Nothing changed.`,
    );
  deps.log(
    `Eval: none of ${items.length} requests sent wrong at ${threshold}.`,
  );
  return candidate;
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
  const host = hostOf(placement);
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

// After a restart: whether serve's first run has done what `done` looks
// for in the record, looking once a second; it says what it found, or
// `failure` is logged.
async function watchRun(
  done: (state: State) => string | null,
  failure: string,
  deps: RosterDeps,
): Promise<number> {
  for (let tries = 0; tries < WATCH_SECONDS; tries++) {
    const found = done(deps.record());
    if (found) {
      deps.log(found);
      return 0;
    }
    await deps.sleep(1000);
  }
  deps.log(failure);
  return 1;
}

// Whether serve's first run binds `session` at `placement`.
const watchBind = (
  placement: string,
  session: string,
  deps: RosterDeps,
  next = "",
): Promise<number> =>
  watchRun(
    (state) => {
      const entry = own(state.placements, placement);
      return entry?.session === session
        ? `${placement}: serve binds ${session}, ${entry.ready ? "ready" : "not ready yet"}.`
        : null;
    },
    `${placement}: serve has not bound ${session} in ${WATCH_SECONDS} seconds; ${STILL}${next}.`,
    deps,
  );

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
    const file = pointed(deps.configPath, placement, session, deps.log);
    await approved(file, null, deps);
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
      `${plural(open, "open delivery", "open deliveries")} went to the old session ${before}; router needs-you lists what they need.`,
    );
  await deps.restart();
  return watchBind(placement, session, deps, " and run this again");
}

// `router roster add <participant> <host>:<path> <host>=<session>...`: the
// participant with its text from the file, a placement on each host, and
// grants all to all, as the roster has them: it may address everyone, and
// everyone it. The labeled requests must expect it somewhere. 0 when serve
// binds every placement.
export async function add(
  id: string,
  from: string,
  pairs: string[],
  deps: RosterDeps,
): Promise<number> {
  const config = loadConfig(deps.configPath);
  if (config.participants.some((p) => p.id === id))
    refuse(`${id} is in the roster already; refresh changes its text.`);
  // Placement key -> its session.
  const placements = new Map<string, string>();
  for (const pair of pairs) {
    const [host, session] =
      split(pair, "=") ?? refuse(`${pair} is not <host>=<session>.`);
    if (placements.has(`${id}@${host}`)) refuse(`${host} is named twice.`);
    placements.set(`${id}@${host}`, session);
  }
  const state = deps.record();
  for (const [placement, session] of placements)
    await checkSession(config, state, placement, session, deps);
  const text = await textFrom(from, id, config, deps);
  const file = fileOf(deps.configPath);
  const hosts = [...placements.keys()].map(hostOf);
  file.participants = [
    ...records(file.participants),
    {
      id,
      kind: "agent",
      hosts,
      idempotent: ![...placements.values()].some((s) => terminalOf(s) !== null),
      responsibility: text,
      responsibilityFrom: from,
    },
  ];
  const permissions = sectionOf(file, "permissions");
  for (const list of Object.values(permissions))
    if (Array.isArray(list) && !list.includes(id)) list.push(id);
  permissions[id] = config.participants.map((p) => p.id);
  Object.assign(sectionOf(file, "agents"), Object.fromEntries(placements));
  await approved(file, readFileSync(deps.setPath, "utf8"), deps, id);
  const backup = swapConfig(deps.configPath, file, deps.now());
  deps.log(
    `${id} added on ${hosts.join(", ")}; the old configuration is ${backup}.`,
  );
  await deps.restart();
  let code = 0;
  for (const [placement, session] of placements)
    code = Math.max(code, await watchBind(placement, session, deps));
  return code;
}

// The labeled requests with those expecting `id` expecting none, as
// written otherwise; how many changed.
function relabeled(set: string, id: string): { set: string; count: number } {
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
// placements go. The labeled requests that expected it expect none, in
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
  const { set, count } = relabeled(readFileSync(deps.setPath, "utf8"), id);
  await approved(file, set, deps);
  // The set first: a set that still expects a removed participant no
  // longer parses.
  if (count) {
    writeFileSync(deps.setPath, set);
    deps.log(
      `Relabeled ${plural(count, "request", "requests")} for ${id} to expect none in ${deps.setPath}; commit that.`,
    );
  }
  const backup = swapConfig(deps.configPath, file, deps.now());
  deps.log(`${id} removed; the old configuration is ${backup}.`);
  const open = deps
    .record()
    .tasks.flatMap((task) => task.deliveries)
    .filter((d) => d.participant === id && d.end == null).length;
  if (open)
    deps.log(
      `${id} has ${plural(open, "open delivery", "open deliveries")} in the record; router status shows ${open === 1 ? "it" : "them"}.`,
    );
  await deps.restart();
  return watchRun(
    (state) =>
      state.config.participants.some((p) => p.id === id)
        ? null
        : `serve runs without ${id}.`,
    `serve has not recorded the configuration without ${id} in ${WATCH_SECONDS} seconds; ${STILL}.`,
    deps,
  );
}

// `router roster refresh <participant> [<host>:<path>]`: its text read
// again from where it came from, or from the file named, which it keeps. A
// new text is judged, and serve restarted; a new source alone is only
// written down, since serve does not read it.
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
  await approved(
    file,
    changed ? readFileSync(deps.setPath, "utf8") : null,
    deps,
  );
  const backup = swapConfig(deps.configPath, file, deps.now());
  deps.log(
    `${id}'s text ${changed ? "is new" : "is unchanged"}, from ${source}; the old configuration is ${backup}.`,
  );
  if (!changed) return 0;
  await deps.restart();
  return watchRun(
    (state) =>
      state.config.participants.find((p) => p.id === id)?.responsibility ===
      text
        ? `serve runs with ${id}'s new text.`
        : null,
    `serve has not recorded ${id}'s new text in ${WATCH_SECONDS} seconds; ${STILL}.`,
    deps,
  );
}
