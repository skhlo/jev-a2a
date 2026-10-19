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
import { terminalSession } from "./config.ts";

// One process as a table reads it: its parent, when it started (in the
// table's own unit, compared only within one table; null where the table
// is one snapshot, in which a pid cannot have been reused), and its argv,
// which macOS's table gives whole only for Codex: for another process,
// argv[0] alone.
export type Proc = { ppid: number; start: number | null; argv: string[] };

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

// macOS's `ps` of every process: pid, ppid, lstart and comm, as it prints
// them under the C locale.
const ps = (): string =>
  execFileSync("ps", ["-A", "-ww", "-o", "pid=,ppid=,lstart=,comm="], {
    encoding: "utf8",
    env: { ...process.env, LC_ALL: "C" },
  });
const LSTART = String.raw`\w{3} \w{3} +\d{1,2} \d\d:\d\d:\d\d \d{4}`;
const LINE = new RegExp(String.raw`^\s*(\d+)\s+(\d+)\s+(${LSTART})\s+(.*)$`);

const basename = (path: string): string => path.split("/").at(-1) ?? "";

// One ps run's rows by pid: ppid, lstart and comm.
function rowsByPid(text: string): Map<number, string[]> {
  const found = new Map<number, string[]>();
  for (const line of text.split("\n")) {
    if (!line.trim()) continue;
    const m = LINE.exec(line);
    if (!m) throw new Error(`ps printed a line it does not read: ${line}`);
    found.set(Number(m[1]), m.slice(2));
  }
  return found;
}

// A process's argv as sysctl's KERN_PROCARGS2 gives it: argc, the
// executable's path, padding, then the arguments, each ending in a NUL
// (the environment follows).
export function procArgs(data: Buffer): string[] {
  const argc = data.length >= 4 ? data.readInt32LE(0) : -1;
  let at = data.indexOf(0, 4);
  if (argc < 0 || at < 0) throw new Error("its arguments read cut short");
  while (data[at] === 0) at++;
  const argv: string[] = [];
  for (let k = 0; k < argc; k++) {
    const end = data.indexOf(0, at);
    if (end < 0) throw new Error("its arguments read cut short");
    argv.push(data.toString("utf8", at, end));
    at = end + 1;
  }
  return argv;
}

// sysctl(3), through node:ffi, which Node 26.1 added as experimental (the
// router runs with --no-warnings, so it says nothing): at most size bytes
// of the value at a name.
let sysctlCall: ReturnType<typeof loadSysctl> | undefined;
function loadSysctl() {
  // Undefined, though typed as always there, where Node lacks it.
  const ffi = process.getBuiltinModule("node:ffi");
  if (!ffi)
    throw new Error("this Node has no node:ffi to read a Codex's arguments");
  return ffi.dlopen(null, {
    sysctl: {
      arguments: ["pointer", "u32", "pointer", "pointer", "pointer", "u64"],
      return: "i32",
    },
  }).functions.sysctl;
}
function sysctl(name: number[], size: number): Buffer {
  sysctlCall ??= loadSysctl();
  const out = Buffer.alloc(size);
  const length = new BigUint64Array([BigInt(size)]);
  if (sysctlCall(new Int32Array(name), name.length, out, length, null, 0n))
    throw new Error(`sysctl ${name.join(".")} failed`);
  return out.subarray(0, Number(length[0]));
}
const CTL_KERN = 1;
const KERN_ARGMAX = 8;
const KERN_PROCARGS2 = 49;

// A process's exact argv from macOS's kernel, which gives it for the
// user's own processes.
const exactArgv = (pid: number): string[] =>
  procArgs(
    sysctl(
      [CTL_KERN, KERN_PROCARGS2, pid],
      sysctl([CTL_KERN, KERN_ARGMAX], 4).readInt32LE(0),
    ),
  );

// macOS: one `ps` snapshot of parents, start times and argv[0] (comm,
// printed whole as the last column), which holds no reused pid. ps joins
// the other arguments with spaces, losing where one ends, so a Codex's,
// which decide what it runs, are read from the kernel instead, and the
// snapshot taken again: a Codex gone by then is gone, and one whose start
// or comm changed in between, or whose argv[0] from the kernel is not
// comm, cannot be read (nor so one whose argv[0] holds non-ASCII bytes,
// which ps escapes).
export function psTable(
  run: () => string = ps,
  argvOf: (pid: number) => string[] = exactArgv,
  self = process.pid,
): Processes {
  const rows = rowsByPid(run());
  const look = (pid: number): Proc | null => {
    const row = rows.get(pid);
    if (!row) return null;
    const [ppid = "", start, exe = ""] = row;
    const proc = { ppid: Number(ppid), start: null, argv: exe ? [exe] : [] };
    if (basename(exe) !== "codex") return proc;
    const argv = argvOf(pid);
    const again = rowsByPid(run()).get(pid);
    if (!again) return null;
    if (again[1] !== start || again[2] !== exe)
      throw new Error("the pid changed while its arguments were read");
    if (argv[0] !== exe)
      throw new Error("its argv[0] from the kernel is not the one ps shows");
    return { ...proc, argv };
  };
  return { self, look };
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

// Codex 0.163's command line as clap reads it (codex-rs/cli/src/main.rs,
// tui/src/cli.rs and utils/cli/src): options anywhere; the first argument
// that no option takes names a subcommand, or else is the prompt, after
// which a subcommand may still follow; after --, the one argument left is
// the prompt.
//
// Codex's options by whether they take a value, before a subcommand and
// app-server's; no value begins with -, and -i takes every argument up to
// the next option. --managed-daemon is the shared daemon's own flag; it is
// not in the help.
const TOP_VALUE = new Set([
  "-c",
  "--config",
  "--enable",
  "--disable",
  "--remote",
  "--remote-auth-token-env",
  "-i",
  "--image",
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
  "--not-so-yolo",
  "--dangerously-bypass-approvals-and-sandbox",
  "--yolo",
  "--dangerously-bypass-hook-trust",
  "--worktree",
  "--search",
  "--no-alt-screen",
  "--no-daemon",
]);
const IMAGES = new Set(["-i", "--image"]);
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
// Codex's subcommands and their aliases, the hidden ones too; app, which only
// macOS and Windows have, serves no client and reads as a prompt.
const SUBCOMMANDS = new Set([
  "agents",
  "tcp-tunnel",
  "exec",
  "e",
  "review",
  "login",
  "logout",
  "mcp",
  "plugin",
  "app-server",
  "remote-control",
  "completion",
  "update",
  "doctor",
  "sandbox",
  "debug",
  "execpolicy",
  "apply",
  "a",
  "resume",
  "queue",
  "archive",
  "delete",
  "migrate-rollouts",
  "unarchive",
  "fork",
  "cloud",
  "cloud-tasks",
  "responses-api-proxy",
  "stdio-to-uds",
  "exec-server",
  "features",
  "help",
]);

const isOption = (arg: string): boolean => arg.startsWith("-") && arg !== "-";
// Short options that take a value may carry it attached: -ckey=value.
const shortValue = (arg: string, values: Set<string>): boolean =>
  /^-[A-Za-z]./.test(arg) && values.has(arg.slice(0, 2));

// One option as clap reads it: its name, its (first) value or null for a
// flag, and where the next argument starts; or why it does not read.
type Step =
  { name: string; value: string | null; next: number } | { unknown: string };

function option(
  args: string[],
  i: number,
  values: Set<string>,
  flags: Set<string>,
): Step {
  const arg = args[i] ?? "";
  const eq = arg.indexOf("=");
  const name = arg.startsWith("--") && eq > 0 ? arg.slice(0, eq) : arg;
  if (name !== arg && values.has(name))
    return { name, value: arg.slice(eq + 1), next: i + 1 };
  if (flags.has(arg)) return { name: arg, value: null, next: i + 1 };
  if (values.has(arg)) {
    const value = args[i + 1];
    if (value === undefined || isOption(value))
      return { unknown: `${arg} without its value` };
    let next = i + 2;
    if (IMAGES.has(arg))
      while (next < args.length && !isOption(args[next] ?? "")) next++;
    return { name: arg, value, next };
  }
  if (shortValue(arg, values))
    return { name: arg.slice(0, 2), value: arg.slice(2), next: i + 1 };
  return { unknown: `the option ${arg}` };
}

// A word as a message names it: a prompt may be long.
const clipped = (arg: string): string =>
  arg.length > 40 ? `${arg.slice(0, 40)}…` : arg;
const unknown = (what: string): Codex => ({ kind: "unknown", what });
const INTERACTIVE: Codex = { kind: "own", what: "an interactive codex" };
const REMOTE = unknown("codex --remote, whose server is elsewhere");

// An app-server: on stdio it serves the one process that started it; over
// a socket, any client.
function appServer(args: string[]): Codex {
  const opts = new Map<string, string[]>();
  for (let i = 0; i < args.length;) {
    const arg = args[i] ?? "";
    if (!isOption(arg)) return unknown(`codex app-server ${clipped(arg)}`);
    const step = option(args, i, SERVER_VALUE, SERVER_FLAG);
    if ("unknown" in step)
      return unknown(`codex app-server with ${step.unknown}`);
    opts.set(step.name, [...(opts.get(step.name) ?? []), step.value ?? ""]);
    i = step.next;
  }
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

// Whether a subcommand's arguments ask for a remote server, as resume's
// and fork's may. clap takes no value that begins with -, so such an
// argument is the option.
const remote = (args: string[]): boolean => {
  const end = args.indexOf("--");
  return (end < 0 ? args : args.slice(0, end)).some(
    (a) => a === "--remote" || a.startsWith("--remote="),
  );
};

// The subcommands that run their own commands, as an interactive codex.
const OWN_SUBCOMMANDS = new Map([
  ["resume", "codex resume"],
  ["fork", "codex fork"],
  ["exec", "codex exec"],
  ["e", "codex exec"],
]);

// What a subcommand runs.
function subcommand(sub: string, args: string[]): Codex {
  const own = OWN_SUBCOMMANDS.get(sub);
  if (own !== undefined)
    return remote(args) ? REMOTE : { kind: "own", what: own };
  if (sub === "app-server") return appServer(args);
  return unknown(`codex ${sub}`);
}

// What one process's argv says, as clap reads it, or null when it is not
// Codex.
export function codexOf(argv: string[]): Codex | null {
  const [zero, ...args] = argv;
  if (basename(zero ?? "") !== "codex") return null;
  const extra = (arg: string) =>
    unknown(`codex with ${clipped(arg)} after its prompt`);
  let remoted = false;
  let prompted = false;
  for (let i = 0; i < args.length;) {
    const arg = args[i] ?? "";
    if (arg === "--") {
      // The prompt, if none came yet, and then nothing more.
      const after = args[i + (prompted ? 1 : 2)];
      if (after === undefined) break;
      return extra(after);
    }
    if (isOption(arg)) {
      const step = option(args, i, TOP_VALUE, TOP_FLAG);
      if ("unknown" in step) return unknown(`codex with ${step.unknown}`);
      remoted ||= step.name === "--remote";
      i = step.next;
    } else if (SUBCOMMANDS.has(arg)) {
      return remoted ? REMOTE : subcommand(arg, args.slice(i + 1));
    } else if (prompted) {
      return extra(arg);
    } else {
      prompted = true;
      i++;
    }
  }
  return remoted ? REMOTE : INTERACTIVE;
}

// What the caller's ancestry says: no Codex above it, only Codex that runs
// its own commands, or why its environment may not be its own: a shared
// server, a Codex the router does not know, or an ancestry it cannot read.
export type Ancestry =
  | { kind: "plain" }
  | { kind: "own"; what: string }
  | { kind: "shared"; what: string; pid: number }
  | { kind: "unknown"; what: string; pid: number }
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
      return unresolved(
        `its ancestor pid ${pid} is not in the process table (it exited during the check, or the table hides it)`,
      );
    if (
      parent.start !== null &&
      child.start !== null &&
      parent.start > child.start
    )
      return unresolved(
        `pid ${pid} started after its child, so the pid was reused`,
      );
    if (!parent.argv.length)
      return unresolved(`the command line of pid ${pid} could not be read`);
    const codex = codexOf(parent.argv);
    if (codex && codex.kind !== "own") return { ...codex, pid };
    own ??= codex?.what ?? null;
    child = parent;
  }
  return own ? { kind: "own", what: own } : { kind: "plain" };
}

const NOT_SENT = "Nothing was sent.";
const CODEX_HELP =
  'Resume this conversation without the shared server, in the same terminal and while no turn runs: `codex --no-daemon resume <id>` with its id ($CODEX_THREAD_ID inside it), never --last (docs/operating.md, "A Codex session on the shared server").';
const UNKNOWN_HELP =
  'Run the session\'s Codex interactively, or with resume, fork or exec, under --no-daemon (docs/participants.md, "Whose environment").';
const SHELL_HELP =
  'Run it again from the session\'s own shell (docs/participants.md, "Whose environment").';

// The session the caller's environment names, null when it names none; or
// why the router will not act on it.
export type Caller = { session: string | null } | { refused: string };

export function caller(
  env: Record<string, string | undefined>,
  table: () => Processes,
): Caller {
  const agent = env.PASEO_AGENT_ID;
  const terminal = env.PASEO_TERMINAL_ID;
  if (agent && terminal)
    return {
      refused: `Both $PASEO_AGENT_ID and $PASEO_TERMINAL_ID are set, so the router cannot tell which session is calling. ${NOT_SENT}`,
    };
  const session = agent || (terminal ? terminalSession(terminal) : null);
  if (!session) return { session: null };
  const found = ancestry(table);
  if (found.kind === "shared")
    return {
      refused: `This runs under a shared Codex server (pid ${found.pid}, ${found.what}), whose environment is the terminal's that started it, so ${session} may not be this session. ${NOT_SENT} ${CODEX_HELP}`,
    };
  if (found.kind === "unknown")
    return {
      refused: `The router does not know the Codex above this command (pid ${found.pid}, ${found.what}), so it cannot tell whether this command's environment is its own. ${NOT_SENT} ${UNKNOWN_HELP}`,
    };
  if (found.kind === "unresolved")
    return {
      refused: `The router cannot tell whether this command's environment is its own: ${found.what}. ${NOT_SENT} ${SHELL_HELP}`,
    };
  return { session };
}
