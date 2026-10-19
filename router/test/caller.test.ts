// The caller's session, and whether its environment is its own: the Codex
// command lines the router recognises, the walk up a process table, and
// the Linux and macOS readers.
import test from "node:test";
import assert from "node:assert/strict";
import { mkdirSync, writeFileSync } from "node:fs";
import { join } from "node:path";
import { scratch } from "./test-scratch.ts";
import {
  ancestry,
  caller,
  codexOf,
  MAX_DEPTH,
  procfs,
  psTable,
  type Processes,
} from "../src/caller.ts";
import { plain, table, under } from "./processes.ts";

// Read from the hosts on 2026-10-19 (paths shortened): the shared daemon
// on mba and on the VPS, its updater, ChatGPT's own server on mba, and
// what Paseo starts per Codex agent.
const MBA_DAEMON =
  "/Users/u/.codex/packages/app-server-daemon/releases/0.163.0-aarch64-apple-darwin/bin/codex app-server --listen unix:// --analytics-default-enabled --managed-daemon";
const VPS_DAEMON =
  "/home/u/.codex/packages/app-server-daemon/releases/0.163.0-x86_64-unknown-linux-musl/bin/codex app-server --listen unix:// --analytics-default-enabled --managed-daemon";
const UPDATER =
  "/home/u/.codex/packages/app-server-daemon/releases/0.163.0-x86_64-unknown-linux-musl/bin/codex app-server daemon pid-update-loop";
const CHATGPT =
  "/Applications/ChatGPT.app/Contents/Resources/codex-cli/CodexCLI.app/Contents/MacOS/codex -c features.code_mode_host=true app-server --analytics-default-enabled -c plugins.codex-app-tools@openai-bundled.mcp_servers.codex_app.enabled=true -c plugins.code-review@openai-bundled.mcp_servers.code-review.enabled=true";
const PASEO_AGENT = "codex app-server --enable goals";

const kind = (line: string) => codexOf(line.split(" "))?.kind ?? null;

test("a Codex that runs its own commands: interactive, resume and fork with options before them, exec, and app-server on stdio", () => {
  for (const line of [
    "codex",
    "/home/u/.local/share/mise/installs/codex/0.163.0/bin/codex --no-daemon --no-alt-screen",
    "codex resume 0199c0de-0000-7000-8000-000000000001",
    "codex --no-daemon resume 0199c0de-0000-7000-8000-000000000001",
    "codex --no-daemon --no-alt-screen resume --last",
    "codex -c model=o3 resume 0199c0de",
    "codex --config=model=o3 fork 0199c0de",
    "codex -cmodel=o3 -m gpt-6 --no-daemon fork --last",
    "codex -C /tmp --add-dir /var -s workspace-write -a on-request",
    "codex exec --json fix",
    "codex e fix",
    "codex -c x=y exec resume --last",
    "codex app-server",
    PASEO_AGENT,
    CHATGPT,
    "codex app-server --listen stdio://",
    "codex app-server --listen=stdio://",
    "codex app-server --stdio",
    "C:\\Codex\\codex.exe app-server",
  ])
    assert.equal(kind(line), "own", line);
});

test("a server for socket clients is shared: the daemon on mba and the VPS, --listen on a socket, websocket options", () => {
  for (const line of [
    MBA_DAEMON,
    VPS_DAEMON,
    "codex app-server --listen ws://127.0.0.1:47159",
    "codex app-server --listen=unix:///tmp/s.sock",
    "codex app-server --listen stdio:// --listen unix://",
    "codex -c x=y app-server --managed-daemon",
    "codex app-server --ws-auth token",
  ])
    assert.equal(kind(line), "shared", line);
  assert.match(
    codexOf(MBA_DAEMON.split(" "))?.what ?? "",
    /--managed-daemon, the shared daemon/,
  );
});

test("a Codex shape the router does not know is unknown, never an interactive codex", () => {
  for (const line of [
    "codex --remote ws://host:1",
    "codex --remote=unix://",
    "codex resume --remote unix:// 0199c0de",
    "codex fork --remote=ws://h:1 --last",
    "codex app-server proxy",
    UPDATER,
    "codex exec-server",
    "codex mcp-server",
    "codex review",
    "codex fix the bug",
    "codex --frobnicate",
    "codex --no-daemon=1",
    "codex -c",
    "codex -i shot.png",
    "codex -- fix",
    "codex -h",
    "codex app-server --listen",
    "codex app-server --frobnicate",
  ])
    assert.equal(kind(line), "unknown", line);
  assert.equal(
    codexOf(["codex", "x".repeat(100)])?.what,
    `codex ${"x".repeat(40)}…`,
  );
});

test("a process that is not Codex is none: a wrapper, a sandbox helper, Paseo, a launcher", () => {
  for (const line of [
    "node /usr/lib/node_modules/@openai/codex/bin/codex.js",
    "codex-linux-sandbox --sandbox-policy x",
    "/home/u/.local/opt/Paseo/Paseo.bin --type=utility",
    "codex-terminal resume 0199c0de",
    "zsh",
  ])
    assert.equal(kind(line), null, line);
});

test("the ancestry: plain without Codex, own under a Codex that runs its commands, shared under a socket server at any height", () => {
  assert.deepEqual(ancestry(plain), { kind: "plain" });
  assert.deepEqual(
    ancestry(under("bash -c router", "codex --no-daemon", "zsh", "Paseo.bin")),
    { kind: "own", what: "an interactive codex" },
  );
  assert.deepEqual(
    ancestry(under("bash -c router", PASEO_AGENT, "Paseo.bin")),
    { kind: "own", what: "codex app-server on stdio" },
  );
  // The daemon is the child of the codex that started it.
  assert.deepEqual(
    ancestry(under("bash -c router", MBA_DAEMON, "codex", "zsh")),
    {
      kind: "shared",
      what: "codex app-server --managed-daemon, the shared daemon",
      pid: 98,
    },
  );
  // A codex exec run by the shared server inherits its environment.
  assert.equal(
    ancestry(under("bash", "codex exec fix", "bash", VPS_DAEMON)).kind,
    "shared",
  );
  assert.deepEqual(ancestry(under("bash", "codex review", "zsh")), {
    kind: "unresolved",
    what: "pid 98 is codex review, a Codex the router does not know",
  });
});

test("an ancestry the router cannot read is unresolved: no table, a missing caller, an orphan, an ancestor gone, a reused pid, too deep, no argv", () => {
  const unresolved = (processes: () => Processes, what: RegExp) => {
    const found = ancestry(processes);
    assert.equal(found.kind, "unresolved");
    assert.match("what" in found ? found.what : "", what);
  };
  unresolved(() => {
    throw new Error("EACCES");
  }, /^the process table could not be read \(EACCES\)$/);
  unresolved(table({}), /its own process is not in the process table/);
  unresolved(table({ 100: [1, 5, "node cli.ts"] }), /parent is pid 1/);
  unresolved(
    table({ 100: [99, 5, "node"], 99: [98, 4, "bash"] }),
    /^its ancestor pid 98 exited during the check$/,
  );
  unresolved(
    table({ 100: [99, 5, "node"], 99: [1, 9, "bash"], 1: [0, 0, "init"] }),
    /^pid 99 started after its child, so the pid was reused$/,
  );
  unresolved(
    under(...Array.from({ length: MAX_DEPTH }, () => "bash")),
    /more than 64 ancestors/,
  );
  assert.equal(
    ancestry(under(...Array.from({ length: MAX_DEPTH - 1 }, () => "bash")))
      .kind,
    "plain",
  );
  unresolved(
    table({ 100: [99, 5, "node"], 99: [1, 4, ""], 1: [0, 0, "init"] }),
    /^the command line of pid 99 could not be read$/,
  );
  const failing = (): Processes => ({
    self: 100,
    look: (pid) => {
      if (pid === 100) return { ppid: 99, start: 5, argv: ["node"] };
      throw new Error("EIO");
    },
  });
  unresolved(failing, /^pid 99 could not be read \(EIO\)$/);
});

test("the caller: its session from the environment, refused when two are named or the environment may not be its own", () => {
  const unread = () => {
    throw new Error("not read");
  };
  // No session named: no table is read, and each command says so itself.
  assert.deepEqual(caller({}, unread), { session: null });
  assert.deepEqual(caller({ PASEO_TERMINAL_ID: "" }, unread), {
    session: null,
  });
  assert.deepEqual(caller({ PASEO_AGENT_ID: "A1" }, plain), {
    session: "A1",
  });
  assert.deepEqual(caller({ PASEO_TERMINAL_ID: "T9" }, plain), {
    session: "terminal:T9",
  });
  const refused = (
    env: Record<string, string>,
    processes: () => Processes,
    message: RegExp,
  ) => {
    const found = caller(env, processes);
    assert.ok("refused" in found, JSON.stringify(found));
    assert.match(found.refused, message);
    assert.match(found.refused, /Nothing was sent\./);
  };
  refused(
    { PASEO_AGENT_ID: "A1", PASEO_TERMINAL_ID: "T9" },
    plain,
    /^Both \$PASEO_AGENT_ID and \$PASEO_TERMINAL_ID are set/,
  );
  refused(
    { PASEO_TERMINAL_ID: "T9" },
    under("bash", VPS_DAEMON),
    /^This runs under a shared Codex server \(pid 98, codex app-server --managed-daemon, the shared daemon\), whose environment is the terminal's that started it, so terminal:T9 may not be this session\. .*codex --no-daemon resume <id>/,
  );
  refused(
    { PASEO_TERMINAL_ID: "T9" },
    unread,
    /^The router cannot tell whether this command's environment is its own: the process table could not be read \(not read\)\./,
  );
});

// /proc/<pid>/stat as Linux writes it: the start time is field 22.
const stat = (pid: number, comm: string, ppid: number, start: number) =>
  `${pid} (${comm}) S ${ppid} ${"0 ".repeat(17)}${start} 0 0\n`;

test("Linux: /proc gives each process's parent, start and argv; a command name with spaces and parentheses reads", (t) => {
  const root = scratch(t, "caller-proc-");
  const proc = (
    pid: number,
    comm: string,
    ppid: number,
    start: number,
    argv: string[],
  ) => {
    mkdirSync(join(root, String(pid)));
    writeFileSync(
      join(root, String(pid), "stat"),
      stat(pid, comm, ppid, start),
    );
    writeFileSync(
      join(root, String(pid), "cmdline"),
      argv.map((a) => `${a}\0`).join(""),
    );
  };
  proc(100, "node", 99, 50, ["node", "cli.ts", "reply"]);
  proc(99, "bash", 98, 40, ["bash", "-c", "router reply"]);
  proc(98, "codex (x) y", 97, 30, VPS_DAEMON.split(" "));
  proc(97, "systemd", 1, 2, ["/usr/lib/systemd/systemd", "--user"]);
  proc(1, "systemd", 0, 1, ["/sbin/init"]);
  const processes = procfs(root, 100);
  assert.deepEqual(processes.look(98), {
    ppid: 97,
    start: 30,
    argv: VPS_DAEMON.split(" "),
  });
  assert.equal(processes.look(4242), null);
  assert.equal(ancestry(() => procfs(root, 100)).kind, "shared");
  writeFileSync(join(root, "98", "stat"), "98 (codex) S\n");
  assert.deepEqual(
    ancestry(() => procfs(root, 100)),
    {
      kind: "unresolved",
      what: `pid 98 could not be read (${root}/98/stat does not read as proc(5) says)`,
    },
  );
});

test("Linux: this process's own /proc reads, and its ancestry holds no shared Codex", () => {
  if (process.platform !== "linux") return;
  const self = procfs().look(process.pid);
  assert.ok(self && self.argv.length > 0 && self.ppid > 0);
  assert.notEqual(ancestry(procfs).kind, "shared");
});

// `ps -A -ww -o pid=,ppid=,lstart=,args=` as macOS prints it under LC_ALL=C
// (read on mba): the day padded with a space, the hour with a zero.
const PS = `    1     0 Fri Oct  2 23:03:31 2026     /sbin/launchd
 7554     1 Sun Oct 18 09:38:44 2026     /Applications/ChatGPT.app/Contents/MacOS/ChatGPT
 7681  7554 Sun Oct 18 09:38:46 2026     ${CHATGPT}
46142  4000 Mon Oct 19 10:40:00 2026     -zsh
 4000     1 Mon Oct 12 08:00:09 2026     /Applications/Paseo.app/Contents/Frameworks/Paseo Helper.app/Contents/MacOS/Paseo Helper
51132 46142 Mon Oct 19 10:42:17 2026     /Users/u/.local/share/mise/installs/codex/0.163.0/bin/codex
51134 51132 Mon Oct 19 10:42:18 2026     ${MBA_DAEMON}
60000 51134 Mon Oct 19 11:00:00 2026     /bin/zsh -c router reply
60001 60000 Mon Oct 19 11:00:00 2026     node cli.ts reply
60100  7681 Mon Oct 19 11:01:00 2026     /bin/zsh -c router reply
60101 60100 Mon Oct 19 11:01:00 2026     node cli.ts reply
`;

test("macOS: one ps snapshot; the daemon's command is shared, ChatGPT's own server is not", () => {
  const processes = psTable(() => PS, 60001);
  assert.deepEqual(processes.look(51134)?.argv, MBA_DAEMON.split(" "));
  assert.equal(processes.look(46142)?.start, Date.UTC(2026, 9, 19, 10, 40, 0));
  assert.equal(processes.look(7554)?.start, Date.UTC(2026, 9, 18, 9, 38, 44));
  assert.deepEqual(
    ancestry(() => psTable(() => PS, 60001)),
    {
      kind: "shared",
      what: "codex app-server --managed-daemon, the shared daemon",
      pid: 51134,
    },
  );
  assert.deepEqual(
    ancestry(() => psTable(() => PS, 60101)),
    {
      kind: "own",
      what: "codex app-server on stdio",
    },
  );
  assert.deepEqual(
    ancestry(() => psTable(() => `${PS}garbage\n`, 60001)),
    {
      kind: "unresolved",
      what: "the process table could not be read (ps printed a line it does not read: garbage)",
    },
  );
});
