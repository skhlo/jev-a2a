// The caller's session, and whether its environment is its own: the Codex
// command lines the router recognises, the walk up a process table, and
// the Linux and macOS readers.
import test from "node:test";
import assert from "node:assert/strict";
import { spawn } from "node:child_process";
import { mkdirSync, writeFileSync } from "node:fs";
import { join } from "node:path";
import { scratch } from "./test-scratch.ts";
import {
  ancestry,
  caller,
  codexOf,
  MAX_DEPTH,
  procArgs,
  procfs,
  psTable,
  type Processes,
} from "../src/caller.ts";
import { LAUNCHED, MBA_DAEMON, plain, table, under } from "./processes.ts";

// Read from the hosts on 2026-10-19 (paths shortened): the shared daemon
// on the VPS (mba's is MBA_DAEMON), its updater, ChatGPT's own server on
// mba, and what Paseo starts per Codex agent.
const VPS_DAEMON =
  "/home/u/.codex/packages/app-server-daemon/releases/0.163.0-x86_64-unknown-linux-musl/bin/codex app-server --listen unix:// --analytics-default-enabled --managed-daemon";
const UPDATER =
  "/home/u/.codex/packages/app-server-daemon/releases/0.163.0-x86_64-unknown-linux-musl/bin/codex app-server daemon pid-update-loop";
const CHATGPT =
  "/Applications/ChatGPT.app/Contents/Resources/codex-cli/CodexCLI.app/Contents/MacOS/codex -c features.code_mode_host=true app-server --analytics-default-enabled -c plugins.codex-app-tools@openai-bundled.mcp_servers.codex_app.enabled=true -c plugins.code-review@openai-bundled.mcp_servers.code-review.enabled=true";
const PASEO_AGENT = "codex app-server --enable goals";

// A command line's kind: a string is split at spaces into its arguments.
const kind = (line: string | string[]) =>
  codexOf(typeof line === "string" ? line.split(" ") : line)?.kind ?? null;

test("a Codex that runs its own commands: interactive, with a prompt, images or -- and options on either side, resume and fork, exec, and app-server on stdio", () => {
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
    ...LAUNCHED,
    ["codex", "fix the bug", "-m", "o3"],
    ["codex", "-i", "a.png", "b.png", "fix"],
    ["codex", "-i", "a.png", "--", "fix"],
    ["codex", "--image=a.png", "fix"],
    ["codex", "-ia.png", "resume", "0199c0de"],
    ["codex", "--yolo", "-"],
    // Literal flags in a prompt, or after --, are the prompt's.
    ["codex", "fix --listen ws://h:1 --managed-daemon"],
    ["codex", "--", "--remote"],
    ["codex", "resume", "0199c0de", "use --remote"],
    ["codex", "resume", "0199c0de", "--", "--remote"],
    // A value, even one naming a subcommand.
    ["codex", "--remote-auth-token-env", "app-server"],
    // Not a subcommand in 0.163, so clap reads it as the prompt.
    "codex mcp-server",
  ])
    assert.equal(kind(line), "own", JSON.stringify(line));
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
    // A subcommand after the prompt, or after a value with a space, is
    // still one: both run on mba.
    "codex fix app-server --listen ws://127.0.0.1:47159",
    ["codex", "a prompt", "app-server", "--listen", "ws://127.0.0.1:47159"],
    ["codex", "-C", "/tmp/a b", "app-server", "--listen", "ws://127.0.0.1:1"],
    // -i's images end at the next option, an attached one at itself.
    "codex -i a.png --no-daemon app-server --listen ws://127.0.0.1:1",
    ["codex", "--image=a.png", "fix", "app-server", "--listen", "ws://h:1"],
  ])
    assert.equal(kind(line), "shared", JSON.stringify(line));
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
    "codex remote-control",
    "codex agents",
    "codex tcp-tunnel",
    "codex stdio-to-uds",
    "codex responses-api-proxy",
    // An attached image ends at itself.
    ["codex", "-ia.png", "exec-server"],
    "codex review",
    "codex fix review",
    "codex fix --remote ws://h:1",
    "codex exec --remote ws://h:1",
    "codex --frobnicate",
    "codex app-server --frobnicate",
    "codex -h",
    // Codex 0.163 would not run these: clap takes one prompt, a flag no
    // value, a value option its value, and no value beginning with -.
    "codex fix the bug",
    "codex fix -- more",
    "codex -- fix more",
    "codex --no-daemon=1",
    "codex -c",
    "codex -i",
    "codex -m -x",
    "codex app-server --listen",
  ])
    assert.equal(kind(line), "unknown", JSON.stringify(line));
  assert.equal(
    codexOf(["codex", "fix", "x".repeat(100)])?.what,
    `codex with ${"x".repeat(40)}… after its prompt`,
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
    kind: "unknown",
    what: "codex review",
    pid: 98,
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
    /^its ancestor pid 98 is not in the process table \(it exited during the check, or the table hides it\)$/,
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
    under("bash", "codex app-server proxy"),
    /^The router does not know the Codex above this command \(pid 98, codex app-server proxy\), .*under --no-daemon/,
  );
  // An ancestry it cannot read is no Codex's fault: no advice to resume one.
  refused(
    { PASEO_TERMINAL_ID: "T9" },
    unread,
    /^The router cannot tell whether this command's environment is its own: the process table could not be read \(not read\)\. Nothing was sent\. Run it again from the session's own shell/,
  );
  const unreadable = caller({ PASEO_AGENT_ID: "A1" }, unread);
  assert.doesNotMatch(
    "refused" in unreadable ? unreadable.refused : "",
    /resume|Codex/,
  );
});

// /proc/<pid>/stat as Linux writes it: the start time is field 22.
const stat = (pid: number, comm: string, ppid: number, start: number) =>
  `${pid} (${comm}) S ${ppid} ${"0 ".repeat(17)}${start} 0 0\n`;

// A /proc under root that processes are written into.
const fakeProc =
  (root: string) =>
  (pid: number, comm: string, ppid: number, start: number, argv: string[]) => {
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

test("Linux: /proc gives each process's parent, start and argv; a command name with spaces and parentheses reads", (t) => {
  const root = scratch(t, "caller-proc-");
  const proc = fakeProc(root);
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

test(
  "Linux: this process's own /proc reads, and so does its ancestry, whatever runs the tests",
  { skip: process.platform !== "linux" },
  () => {
    const self = procfs().look(process.pid);
    assert.ok(self && self.argv.length > 0 && self.ppid > 0);
    const found = ancestry(procfs);
    assert.doesNotMatch(
      "what" in found ? found.what : "",
      /could not be read|not in the process table/,
    );
  },
);

test(
  "macOS: this host's ps reads, and so does this process's ancestry, whatever runs the tests; a Codex's arguments come whole from the kernel",
  { skip: process.platform !== "darwin" },
  async () => {
    const self = psTable().look(process.pid);
    assert.ok(self && self.argv.length > 0 && self.ppid > 0);
    const found = ancestry(psTable);
    assert.doesNotMatch(
      "what" in found ? found.what : "",
      /could not be read|not in the process table/,
    );
    // A shell run as codex, waiting on its input.
    const args = ["-s", "a b", "app-server", "--", "c"];
    const child = spawn("/bin/sh", args, { argv0: "codex" });
    try {
      const argv = psTable().look(child.pid ?? 0)?.argv;
      assert.deepEqual(argv, ["codex", ...args]);
    } finally {
      child.stdin.end();
      await new Promise((resolve) => child.on("close", resolve));
    }
  },
);

test("macOS: KERN_PROCARGS2 holds argc, the executable's path, padding, the arguments and the environment; one cut short does not read", () => {
  const data = Buffer.concat([
    Buffer.from([3, 0, 0, 0]),
    Buffer.from("/bin/codex\0\0\0\0codex\0a b\0\0HOME=/u\0"),
  ]);
  assert.deepEqual(procArgs(data), ["codex", "a b", ""]);
  assert.throws(
    () =>
      procArgs(
        Buffer.concat([
          Buffer.from([2, 0, 0, 0]),
          Buffer.from("/bin/codex\0codex"),
        ]),
      ),
    /cut short/,
  );
  assert.throws(() => procArgs(Buffer.from([1, 0])), /cut short/);
});

// macOS as `ps` prints it under LC_ALL=C, the day padded with a space, the
// hour with a zero: pid, ppid, lstart and comm (argv[0], the last column);
// and each process's argv as the kernel gives it, a string split at
// spaces. The rows up to pid 51134 are as read on mba (paths shortened);
// the rest are made up for the cases below.
type MacRow = [
  pid: number,
  ppid: number,
  lstart: string,
  comm: string,
  argv: string | string[],
];
const MAC: MacRow[] = [
  [1, 0, "Fri Oct  2 23:03:31 2026", "/sbin/launchd", "/sbin/launchd"],
  [
    7554,
    1,
    "Sun Oct 18 09:38:44 2026",
    "/Applications/ChatGPT.app/Contents/MacOS/ChatGPT",
    "/Applications/ChatGPT.app/Contents/MacOS/ChatGPT",
  ],
  [
    7681,
    7554,
    "Sun Oct 18 09:38:46 2026",
    CHATGPT.split(" ")[0] ?? "",
    CHATGPT,
  ],
  [
    4000,
    1,
    "Mon Oct 12 08:00:09 2026",
    "/Applications/Paseo.app/Contents/Frameworks/Paseo Helper.app/Contents/MacOS/Paseo Helper",
    "/Applications/Paseo.app/Contents/Frameworks/Paseo Helper.app/Contents/MacOS/Paseo Helper",
  ],
  [46142, 4000, "Mon Oct 19 10:40:59 2026", "/bin/zsh", "/bin/zsh"],
  [
    51132,
    46142,
    "Mon Oct 19 10:42:17 2026",
    "/Users/u/.local/share/mise/installs/codex/0.163.0/bin/codex",
    "/Users/u/.local/share/mise/installs/codex/0.163.0/bin/codex",
  ],
  [
    51134,
    51132,
    "Mon Oct 19 10:42:18 2026",
    MBA_DAEMON.split(" ")[0] ?? "",
    MBA_DAEMON,
  ],
  [
    60000,
    51134,
    "Mon Oct 19 11:00:00 2026",
    "/bin/zsh",
    "/bin/zsh -c router reply",
  ],
  [
    60001,
    60000,
    "Mon Oct 19 11:00:00 2026",
    "/opt/node/bin/node",
    "node cli.ts reply",
  ],
  [60100, 7681, "Mon Oct 19 11:01:00 2026", "/bin/sh", "sh -c router reply"],
  [
    60101,
    60100,
    "Mon Oct 19 11:01:00 2026",
    "/opt/node/bin/node",
    "node cli.ts reply",
  ],
  // A shared daemon whose path holds a space.
  [
    70000,
    46142,
    "Mon Oct 19 12:00:00 2026",
    "/Users/u/Library/Application Support/Tools/bin/codex",
    [
      "/Users/u/Library/Application Support/Tools/bin/codex",
      "app-server",
      "--listen",
      "unix://",
      "--managed-daemon",
    ],
  ],
  [
    70001,
    70000,
    "Mon Oct 19 12:00:01 2026",
    "/opt/node/bin/node",
    "node cli.ts reply",
  ],
  // Arguments holding a space: a value before resume, and the two shared
  // servers whose argument boundaries ps's words hid on mba.
  [
    90000,
    46142,
    "Mon Oct 19 12:40:00 2026",
    "/Users/u/bin/codex",
    ["/Users/u/bin/codex", "-c", "model=a b", "resume", "0199c0de"],
  ],
  [
    90001,
    90000,
    "Mon Oct 19 12:40:01 2026",
    "/opt/node/bin/node",
    "node cli.ts reply",
  ],
  [
    91000,
    46142,
    "Tue Oct 20 02:55:00 2026",
    "/Users/u/bin/codex",
    [
      "/Users/u/bin/codex",
      "synthetic starting prompt",
      "app-server",
      "--listen",
      "ws://127.0.0.1:53383",
    ],
  ],
  [
    91001,
    91000,
    "Tue Oct 20 02:55:01 2026",
    "/opt/node/bin/node",
    "node cli.ts reply",
  ],
  [
    92000,
    46142,
    "Tue Oct 20 02:55:10 2026",
    "/Users/u/bin/codex",
    [
      "/Users/u/bin/codex",
      "-C",
      "/tmp/fixture/cwd with spaces",
      "app-server",
      "--listen",
      "ws://127.0.0.1:53391",
    ],
  ],
  [
    92001,
    92000,
    "Tue Oct 20 02:55:11 2026",
    "/opt/node/bin/node",
    "node cli.ts reply",
  ],
];
const pad = (n: number) => String(n).padStart(5);
const psRun = (rows: MacRow[]) =>
  rows
    .map(
      ([pid, ppid, lstart, comm]) =>
        `${pad(pid)} ${pad(ppid)} ${lstart}     ${comm}`,
    )
    .join("\n");
// The kernel's argv by pid, and the pids it was asked for.
const kernelOf =
  (rows: MacRow[], asked: number[] = []) =>
  (pid: number) => {
    asked.push(pid);
    const argv = rows.find((row) => row[0] === pid)?.[4];
    if (argv === undefined) throw new Error(`sysctl 1.49.${pid} failed`);
    return typeof argv === "string" ? argv.split(" ") : argv;
  };
// The table from ps runs, the last repeated, and the kernel's argv.
const mac =
  (self: number, rows = MAC, runs = [psRun(rows)], argvOf = kernelOf(rows)) =>
  () => {
    const left = [...runs];
    return psTable(
      () => (left.length > 1 ? left.shift() : left[0]) ?? "",
      argvOf,
      self,
    );
  };

test("macOS: one ps snapshot of parents and argv[0], a Codex's argv from the kernel; the executable's path may hold spaces", () => {
  const asked: number[] = [];
  const processes = mac(60101, MAC, [psRun(MAC)], kernelOf(MAC, asked))();
  assert.deepEqual(processes.look(51134), {
    ppid: 51132,
    start: null,
    argv: MBA_DAEMON.split(" "),
  });
  assert.deepEqual(processes.look(4000)?.argv, [
    "/Applications/Paseo.app/Contents/Frameworks/Paseo Helper.app/Contents/MacOS/Paseo Helper",
  ]);
  assert.deepEqual(processes.look(46142)?.argv, ["/bin/zsh"]);
  assert.deepEqual(processes.look(60100)?.argv, ["/bin/sh"]);
  assert.equal(processes.look(4242), null);
  assert.deepEqual(asked, [51134]);
  assert.equal(ancestry(mac(70001)).kind, "shared");
  assert.equal(ancestry(mac(90001)).kind, "own");
});

test("macOS: a Codex started with a prompt or a value with a space before app-server --listen is that shared server", () => {
  for (const [pid, port] of [
    [91000, 53383],
    [92000, 53391],
  ] as const)
    assert.deepEqual(ancestry(mac(pid + 1)), {
      kind: "shared",
      what: `codex app-server --listen ws://127.0.0.1:${port}`,
      pid,
    });
});

test("what codex-terminal starts is the session's own Codex, read from /proc and from macOS's kernel", (t) => {
  const root = scratch(t, "caller-launched-");
  const proc = fakeProc(root);
  proc(1, "systemd", 0, 1, ["/sbin/init"]);
  const rows: MacRow[] = MAC.slice(0, 1);
  const exe = "/Users/u/.local/share/mise/installs/codex/0.163.0/bin/codex";
  const launched = LAUNCHED.map((argv, n) => {
    const pid = 200 + 2 * n;
    proc(pid, "codex", 1, 10, argv);
    proc(pid + 1, "node", pid, 11, ["node", "cli.ts", "reply"]);
    const at = `Tue Oct 20 09:${String(n).padStart(2, "0")}:00 2026`;
    rows.push([pid, 1, at, exe, [exe, ...argv.slice(1)]]);
    rows.push([pid + 1, pid, at, "/opt/node/bin/node", "node cli.ts reply"]);
    return { self: pid + 1, line: JSON.stringify(argv) };
  });
  for (const { self, line } of launched) {
    assert.equal(ancestry(() => procfs(root, self)).kind, "own", line);
    assert.equal(ancestry(mac(self, rows)).kind, "own", line);
  }
});

test("macOS: the daemon's command is shared, ChatGPT's own server is not; a Codex gone once its argv is read is gone; one whose start or comm changed meanwhile, whose argv[0] from the kernel is not comm, or whose argv the kernel will not give, or a line ps should not print, is unresolved", () => {
  assert.deepEqual(ancestry(mac(60001)), {
    kind: "shared",
    what: "codex app-server --managed-daemon, the shared daemon",
    pid: 51134,
  });
  assert.deepEqual(ancestry(mac(60101)), {
    kind: "own",
    what: "codex app-server on stdio",
  });
  const changed = (row: MacRow) =>
    psRun(MAC.map((r) => (r[0] === row[0] ? row : r)));
  const daemon = MAC.find((row) => row[0] === 51134);
  assert.ok(daemon);
  const [pid, ppid, lstart, comm, argv] = daemon;
  const unread = (what: string) => ({
    kind: "unresolved",
    what: `pid 51134 could not be read (${what})`,
  });
  for (const again of [
    changed([pid, ppid, "Mon Oct 19 10:42:19 2026", comm, argv]),
    changed([pid, ppid, lstart, "/bin/codex", argv]),
  ])
    assert.deepEqual(
      ancestry(mac(60001, MAC, [psRun(MAC), again])),
      unread("the pid changed while its arguments were read"),
    );
  const gone = psRun(MAC.filter((row) => row[0] !== 51134));
  assert.deepEqual(ancestry(mac(60001, MAC, [psRun(MAC), gone])), {
    kind: "unresolved",
    what: "its ancestor pid 51134 is not in the process table (it exited during the check, or the table hides it)",
  });
  const renamed = MAC.map((row): MacRow =>
    row[0] === 51134 ? [pid, ppid, lstart, comm, ["codex", "app-server"]] : row,
  );
  assert.deepEqual(
    ancestry(mac(60001, renamed)),
    unread("its argv[0] from the kernel is not the one ps shows"),
  );
  const withheld = MAC.filter((row) => row[0] !== 51134);
  assert.deepEqual(
    ancestry(mac(60001, MAC, [psRun(MAC)], kernelOf(withheld))),
    unread("sysctl 1.49.51134 failed"),
  );
  assert.deepEqual(ancestry(mac(60001, MAC, [`${psRun(MAC)}\ngarbage`])), {
    kind: "unresolved",
    what: "the process table could not be read (ps printed a line it does not read: garbage)",
  });
});
