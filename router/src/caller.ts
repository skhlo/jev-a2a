// Who is calling: the participant session its environment names, once the
// caller's process ancestry shows that environment is the caller's own.
//
// A Codex app-server that takes clients over a socket (the shared daemon
// a bare `codex` starts or attaches to) runs every client's commands with
// the environment of the terminal that started it, so its
// $PASEO_TERMINAL_ID may be another session's. Every Codex process above
// the caller must therefore be one that runs its own commands: an
// interactive Codex (resume and fork too), `codex exec`, or an app-server
// on stdio, as Paseo starts one per agent. A server for socket clients is
// refused, and so is any Codex the router does not recognise, or an
// ancestry it cannot read: unresolved is not allowed.
//
// This guards against an accidental attribution. It is not
// authentication: a process of the same user can set the variables, run
// a renamed binary, or leave the ancestry (a double fork under a
// subreaper, a separate pid namespace).
//
// It loads node's own modules only, as the reply host requires.
import { execFileSync } from "node:child_process";
import { readFileSync } from "node:fs";
import { TERMINAL } from "./config.ts";

// One process as a table reads it: its parent, when it started (in the
// table's own unit, compared only within one table), and its argv.
export type Proc = { ppid: number; start: number; argv: string[] };

// A process table: this process's pid, and each pid's entry, null once the
// process is gone. Opening or reading it may throw.
export type Processes = { self: number; look: (pid: number) => Proc | null };

const gone = (error: unknown): boolean =>
  error instanceof Error &&
  "code" in error &&
  (error.code === "ENOENT" || error.code === "ESRCH");

// Linux: /proc, one process at a time. A parent read after its child is
// checked by start time, so a pid reused in between is caught.
export function procfs(root = "/proc", self = process.pid): Processes {
  const look = (pid: number): Proc | null => {
    let stat: string;
    let cmdline: string;
    try {
      stat = readFileSync(`${root}/${pid}/stat`, "utf8");
      cmdline = readFileSync(`${root}/${pid}/cmdline`, "utf8");
    } catch (error: unknown) {
      if (gone(error)) return null;
      throw error;
    }
    // After the command name, which may hold spaces and parentheses:
    // state, ppid, and the start time 19 fields on (proc(5) fields 3, 4, 22).
    const fields = stat.slice(stat.lastIndexOf(")") + 2).split(" ");
    const ppid = Number(fields[1]);
    const start = Number(fields[19]);
    if (!Number.isInteger(ppid) || !Number.isInteger(start))
      throw new Error(`${root}/${pid}/stat does not read as proc(5) says`);
    const argv = cmdline.split("\0");
    if (argv.at(-1) === "") argv.pop();
    return { ppid, start, argv };
  };
  return { self, look };
}

const MONTHS = "JanFebMarAprMayJunJulAugSepOctNovDec";
const PS_LINE =
  /^\s*(\d+)\s+(\d+)\s+\w{3} (\w{3}) +(\d{1,2}) (\d\d):(\d\d):(\d\d) (\d{4})\s+(.*)$/;

// macOS: one `ps` snapshot. Its args are argv joined by spaces, so an
// argument holding a space reads as two; lstart counts whole seconds.
export function psTable(
  run: () => string = () =>
    execFileSync("ps", ["-A", "-ww", "-o", "pid=,ppid=,lstart=,args="], {
      encoding: "utf8",
      env: { ...process.env, LC_ALL: "C" },
    }),
  self = process.pid,
): Processes {
  const table = new Map<number, Proc>();
  for (const line of run().split("\n")) {
    if (!line.trim()) continue;
    const m = PS_LINE.exec(line);
    if (!m) throw new Error(`ps printed a line it does not read: ${line}`);
    const [, pid, ppid, mon, day, h, min, s, year, args = ""] = m;
    const start = Date.UTC(
      Number(year),
      MONTHS.indexOf(mon ?? "") / 3,
      Number(day),
      Number(h),
      Number(min),
      Number(s),
    );
    table.set(Number(pid), {
      ppid: Number(ppid),
      start,
      argv: args ? args.split(" ") : [],
    });
  }
  return { self, look: (pid) => table.get(pid) ?? null };
}

// This host's process table.
export function systemProcesses(): Processes {
  if (process.platform === "linux") return procfs();
  if (process.platform === "darwin") return psTable();
  throw new Error(`the router reads no process table on ${process.platform}`);
}

// What a Codex process says about the commands below it: they carry its
// own environment, a socket client's server's, or the router cannot tell.
export type Codex =
  | { kind: "own"; what: string }
  | { kind: "shared"; what: string }
  | { kind: "unknown"; what: string };

// Codex 0.163's options before a subcommand, and app-server's, by whether
// they take a value. --managed-daemon is the shared daemon's own flag; it
// is not in the help.
const TOP_VALUE = new Set([
  "-c",
  "--config",
  "--enable",
  "--disable",
  "--remote",
  "--remote-auth-token-env",
  "-m",
  "--model",
  "--local-provider",
  "-p",
  "--profile",
  "-s",
  "--sandbox",
  "-C",
  "--cd",
  "--add-dir",
  "-a",
  "--ask-for-approval",
]);
const TOP_FLAG = new Set([
  "--strict-config",
  "--oss",
  "--approve-for-me",
  "--dangerously-bypass-approvals-and-sandbox",
  "--dangerously-bypass-hook-trust",
  "--worktree",
  "--search",
  "--no-alt-screen",
  "--no-daemon",
]);
const SERVER_VALUE = new Set([
  "-c",
  "--config",
  "--enable",
  "--disable",
  "--code-mode-host",
  "--listen",
  "--ws-auth",
  "--ws-token-file",
  "--ws-token-sha256",
  "--ws-shared-secret-file",
  "--ws-issuer",
  "--ws-audience",
  "--ws-max-clock-skew-seconds",
]);
const SERVER_FLAG = new Set([
  "--strict-config",
  "--stdio",
  "--analytics-default-enabled",
  "--managed-daemon",
]);
// Short options that take a value may carry it attached: -ckey=value.
const shortValue = (arg: string, values: Set<string>): boolean =>
  /^-[A-Za-z]./.test(arg) && values.has(arg.slice(0, 2));

type Parsed =
  { options: Map<string, string[]>; rest: string[] } | { unknown: string };

// The options before the first word, as clap reads them; a word or option
// the router does not know leaves the shape unknown.
function options(
  args: string[],
  values: Set<string>,
  flags: Set<string>,
): Parsed {
  const found = new Map<string, string[]>();
  const add = (name: string, value: string) =>
    found.set(name, [...(found.get(name) ?? []), value]);
  for (let i = 0; i < args.length; i++) {
    const arg = args[i] ?? "";
    if (!arg.startsWith("-") || arg === "-")
      return { options: found, rest: args.slice(i) };
    const eq = arg.indexOf("=");
    const name = arg.startsWith("--") && eq > 0 ? arg.slice(0, eq) : arg;
    if (name !== arg && values.has(name)) add(name, arg.slice(eq + 1));
    else if (name === arg && flags.has(arg)) add(arg, "");
    else if (name === arg && values.has(arg)) {
      const value = args[++i];
      if (value === undefined) return { unknown: `${arg} without its value` };
      add(arg, value);
    } else if (shortValue(arg, values)) add(arg.slice(0, 2), arg.slice(2));
    else return { unknown: `the option ${arg}` };
  }
  return { options: found, rest: [] };
}

const basename = (path: string): string => path.split(/[/\\]/).at(-1) ?? "";
// A word as a message names it: a prompt may be long.
const word = (arg: string): string =>
  arg.length > 40 ? `${arg.slice(0, 40)}…` : arg;
const remote = (args: string[]): boolean =>
  args.some((a) => a === "--remote" || a.startsWith("--remote="));

// An app-server: on stdio it serves the one process that started it; over
// a socket, any client.
function server(args: string[]): Codex {
  const parsed = options(args, SERVER_VALUE, SERVER_FLAG);
  if ("unknown" in parsed)
    return { kind: "unknown", what: `codex app-server with ${parsed.unknown}` };
  const [sub] = parsed.rest;
  if (sub !== undefined)
    return { kind: "unknown", what: `codex app-server ${word(sub)}` };
  const opts = parsed.options;
  if (opts.has("--managed-daemon"))
    return {
      kind: "shared",
      what: "codex app-server --managed-daemon, the shared daemon",
    };
  const listen = (opts.get("--listen") ?? []).find((v) => v !== "stdio://");
  if (listen !== undefined)
    return { kind: "shared", what: `codex app-server --listen ${listen}` };
  const ws = [...opts.keys()].find((name) => name.startsWith("--ws-"));
  if (ws !== undefined)
    return { kind: "shared", what: `codex app-server ${ws}` };
  return { kind: "own", what: "codex app-server on stdio" };
}

// What one process's argv says, or null when it is not Codex.
export function codexOf(argv: string[]): Codex | null {
  const [zero, ...args] = argv;
  const name = basename(zero ?? "");
  if (name !== "codex" && name !== "codex.exe") return null;
  const parsed = options(args, TOP_VALUE, TOP_FLAG);
  if ("unknown" in parsed)
    return { kind: "unknown", what: `codex with ${parsed.unknown}` };
  const [sub, ...after] = parsed.rest;
  if (remote(args))
    return {
      kind: "unknown",
      what: "codex --remote, whose server is elsewhere",
    };
  if (sub === undefined) return { kind: "own", what: "an interactive codex" };
  if (sub === "resume" || sub === "fork")
    return { kind: "own", what: `codex ${sub}` };
  if (sub === "exec" || sub === "e") return { kind: "own", what: "codex exec" };
  if (sub === "app-server") return server(after);
  return { kind: "unknown", what: `codex ${word(sub)}` };
}

// What the caller's ancestry says: no Codex above it, only Codex that runs
// its own commands, or why its environment may not be its own.
export type Ancestry =
  | { kind: "plain" }
  | { kind: "own"; what: string }
  | { kind: "shared"; what: string; pid: number }
  | { kind: "unresolved"; what: string };

// More ancestors than any shell, terminal and agent stack has.
export const MAX_DEPTH = 64;

export function ancestry(table: () => Processes): Ancestry {
  let processes: Processes;
  let child: Proc | null;
  const unresolved = (what: string): Ancestry => ({ kind: "unresolved", what });
  try {
    processes = table();
    child = processes.look(processes.self);
  } catch (error: unknown) {
    return unresolved(
      `the process table could not be read (${error instanceof Error ? error.message : String(error)})`,
    );
  }
  if (!child) return unresolved("its own process is not in the process table");
  if (child.ppid === 1)
    return unresolved(
      "its parent is pid 1, so the process that ran it is gone",
    );
  let own: string | null = null;
  for (let depth = 0; child.ppid !== 0; depth++) {
    if (depth === MAX_DEPTH)
      return unresolved(`it has more than ${MAX_DEPTH} ancestors`);
    const pid = child.ppid;
    let parent: Proc | null;
    try {
      parent = processes.look(pid);
    } catch (error: unknown) {
      return unresolved(
        `pid ${pid} could not be read (${error instanceof Error ? error.message : String(error)})`,
      );
    }
    if (!parent)
      return unresolved(`its ancestor pid ${pid} exited during the check`);
    if (parent.start > child.start)
      return unresolved(
        `pid ${pid} started after its child, so the pid was reused`,
      );
    if (!parent.argv.length)
      return unresolved(`the command line of pid ${pid} could not be read`);
    const codex = codexOf(parent.argv);
    if (codex?.kind === "shared")
      return { kind: "shared", what: codex.what, pid };
    if (codex?.kind === "unknown")
      return unresolved(
        `pid ${pid} is ${codex.what}, a Codex the router does not know`,
      );
    own ??= codex?.what ?? null;
    child = parent;
  }
  return own ? { kind: "own", what: own } : { kind: "plain" };
}

const RESTART =
  "Nothing was sent. Run Codex in this terminal without the shared server, `codex --no-daemon resume <id>` with this conversation's id ($CODEX_THREAD_ID inside it), then run the command again.";

// The session the caller's environment names, null when it names none; or
// why the router will not act on it.
export function caller(
  env: Record<string, string | undefined>,
  table: () => Processes,
): { session: string | null } | { refused: string } {
  const agent = env.PASEO_AGENT_ID;
  const terminal = env.PASEO_TERMINAL_ID;
  if (agent && terminal)
    return {
      refused: `Both $PASEO_AGENT_ID and $PASEO_TERMINAL_ID are set, so the router cannot tell which session is calling. Nothing was sent.`,
    };
  const session = agent || (terminal ? `${TERMINAL}${terminal}` : null);
  if (!session) return { session: null };
  const found = ancestry(table);
  if (found.kind === "shared")
    return {
      refused: `This runs under a shared Codex server (pid ${found.pid}, ${found.what}), whose environment is the terminal's that started it, so ${session} may not be this session. ${RESTART}`,
    };
  if (found.kind === "unresolved")
    return {
      refused: `The router cannot tell whether this command's environment is its own: ${found.what}. ${RESTART}`,
    };
  return { session };
}
