// `router roster` on a scratch configuration, record and labeled set:
// what each command refuses without touching any of them, how it rewrites
// the configuration, and that it waits for serve's first run to bind a new
// session.
import test from "node:test";
import assert from "node:assert/strict";
import {
  appendFileSync,
  chmodSync,
  existsSync,
  lstatSync,
  mkdirSync,
  readdirSync,
  readFileSync,
  rmSync,
  statSync,
  symlinkSync,
  writeFileSync,
} from "node:fs";
import { execFileSync } from "node:child_process";
import { join } from "node:path";
import { scratch } from "./test-scratch.ts";
import {
  add,
  readOver,
  refresh,
  remove,
  repoint,
  type RosterDeps,
} from "../src/roster.ts";
import { loadConfig } from "../src/config.ts";
import type { FolderSession } from "../src/paseo.ts";
import { recordReader } from "../src/server.ts";
import { coreConfig } from "../src/shell.ts";
import { UsageError } from "../src/request.ts";
import { config as fixture, journal } from "../src/board-fixture.ts";

const TERMINAL = "terminal:0b6a4c2e-7f1d-4e3a-9c5b-2d8e1f0a3b4c";

type File = Record<string, unknown> & {
  agents: Record<string, string>;
  terminals?: Record<string, string>;
  participants: (Record<string, unknown> & {
    id: string;
    idempotent: boolean;
  })[];
  permissions: Record<string, string[]>;
};

// Labeled requests whose first word is in the text of the participant
// that owns them (the fixture's, and design's below).
const SET = [
  "# A test set.",
  '{"text": "VM: start the ci-runner", "expect": "incus", "lang": "en"}',
  '{"text": "Notes: draft a note on Incus", "expect": "knowledge", "lang": "en"}',
  '{"text": "weather: will it rain", "expect": "none", "lang": "en"}',
];
const DESIGN =
  '{"text": "logo: draw a new logo", "expect": "design", "lang": "en"}';

// The fixture's configuration as a file, with its record and a labeled
// set beside it, and roster's dependencies around them. Jev picks the
// participant whose text has the request's first word. serve's restart
// stands for its first run: it records the configuration, then binds what
// it names, as observations.
function setup(
  t: test.TestContext,
  edit = (file: File): File => file,
  set = SET,
) {
  const dir = scratch(t, "roster-");
  const configPath = join(dir, "config.json");
  const file = edit(
    JSON.parse(JSON.stringify({ ...fixture, home: dir })) as File,
  );
  writeFileSync(configPath, `${JSON.stringify(file, null, 2)}\n`);
  // Group-writable, which the usual umask would strip from a new file.
  chmodSync(configPath, 0o664);
  const journalPath = join(dir, "journal.jsonl");
  // Opened as serve opens a record: with the configuration it runs.
  const opened = {
    at: journal[0]?.at,
    event: { type: "configured", config: coreConfig(fixture) },
  };
  writeFileSync(
    journalPath,
    [opened, ...journal].map((entry) => `${JSON.stringify(entry)}\n`).join(""),
  );
  const setPath = join(dir, "requests.jsonl");
  writeFileSync(setPath, `${set.join("\n")}\n`);
  // Responsibility files by host:path, as their main has them, and the
  // requests Jev gives no answer for.
  const files = new Map<string, string>();
  const unanswered = new Set<string>();
  const read = recordReader({ ...fixture, home: dir });
  const log: string[] = [];
  const counts = { restarts: 0 };
  // The sessions each host's Paseo lists, with their folders. One not
  // listed works in /srv/work, unless the daemon does not know it.
  const world: (FolderSession & { host: string; folder: string })[] = [
    {
      host: "mini",
      folder: "/srv/work",
      kind: "terminal",
      session: TERMINAL,
      title: "✳ Notes",
      cli: "claude",
    },
  ];
  let binds = true;
  const binding = (on: boolean): void => {
    binds = on;
  };
  const deps: RosterDeps = {
    configPath,
    record: () => read().state,
    // The daemon also finds K2 by the prefix "K".
    resolve: (_host, session) =>
      Promise.resolve(
        session === "unknown" ? null : session === "K" ? "K2" : session,
      ),
    folderOf: (host, session) =>
      Promise.resolve(
        world.find((s) => s.host === host && s.session === session)?.folder ??
          (session === "unknown" ? null : "/srv/work"),
      ),
    sessionsIn: (host, folder) =>
      Promise.resolve(
        world
          .filter((s) => s.host === host && s.folder === folder)
          .map(({ host: _host, folder: _folder, ...s }) => s),
      ),
    read: (host, path) => {
      const text = files.get(`${host}:${path}`);
      return text === undefined
        ? Promise.reject(new Error("No such file"))
        : Promise.resolve({ at: "1a2b3c4 2026-10-05", text });
    },
    judge: (question) => {
      if (unanswered.has(question.state.request))
        return Promise.resolve({ ok: false, reason: "timeout", ms: 0 });
      const options = Object.keys(question.criteria);
      const word = question.state.request.split(":")[0] ?? "";
      const choice =
        options.find((id) => question.criteria[id]?.includes(word)) ?? "none";
      const rest = 0.06 / (options.length - 1);
      return Promise.resolve({
        ok: true,
        choice,
        probabilities: Object.fromEntries(
          options.map((id) => [id, id === choice ? 0.94 : rest]),
        ),
        confidence: null,
        model: "fake",
        usage: null,
        ms: 0,
      });
    },
    requester: () => "you",
    setPath,
    restart: () => {
      counts.restarts++;
      // A first run that failed records nothing.
      if (!binds) return Promise.resolve();
      appendFileSync(
        journalPath,
        `${JSON.stringify({
          at: "2026-10-06T13:05:02.000Z",
          event: {
            type: "configured",
            config: coreConfig(loadConfig(configPath)),
          },
        })}\n`,
      );
      const now = (JSON.parse(readFileSync(configPath, "utf8")) as File).agents;
      for (const [placement, session] of Object.entries(now))
        if (read().state.placements[placement]?.session !== session)
          appendFileSync(
            journalPath,
            `${JSON.stringify({
              at: "2026-10-06T13:05:02.000Z",
              event: { type: "observe", placement, session, ready: true },
            })}\n`,
          );
      return Promise.resolve();
    },
    sleep: () => Promise.resolve(),
    now: () => new Date("2026-10-06T13:05:01.234Z"),
    log: (line) => log.push(line),
  };
  const fileNow = () => JSON.parse(readFileSync(configPath, "utf8")) as File;
  return {
    dir,
    configPath,
    setPath,
    files,
    unanswered,
    deps,
    log,
    counts,
    fileNow,
    binding,
    world,
  };
}

test("roster repoint: refuses, touching neither the configuration nor serve, what it cannot point at", async (t) => {
  const { dir, configPath, deps, counts, world } = setup(t);
  const before = readFileSync(configPath, "utf8");
  const refused = (
    placement: string,
    session: string,
    message: RegExp,
    given = deps,
  ) =>
    assert.rejects(
      repoint(placement, session, given),
      (error) => error instanceof UsageError && message.test(error.message),
      `${placement} ${session}`,
    );
  await refused("nobody@mini", "K9", /^nobody@mini is not a placement/);
  await refused("constructor", "K9", /^constructor is not a placement/);
  // The core takes no session it has seen: another placement's, or this
  // one's before.
  await refused(
    "knowledge@mini",
    "A1",
    /record knows A1 already, as orchestrator@mbp's/,
  );
  await refused("knowledge@mini", "unknown", /^Paseo on mini does not know/);
  await refused(
    "knowledge@mini",
    "K",
    /^Paseo on mini knows K as K2; name it by that id\.$/,
  );
  await refused("knowledge@mini", "K9", /^Cannot reach Paseo on mini: down/, {
    ...deps,
    resolve: () => Promise.reject(new Error("down")),
  });
  // What the configuration refuses, named as the file it would replace: a
  // terminal named by a short id (that a daemon would know it so).
  world.push({
    host: "mini",
    folder: "/srv/work",
    kind: "terminal",
    session: "terminal:0b6a4c2e",
    title: "✳ Notes",
    cli: "claude",
  });
  await refused(
    "knowledge@mini",
    "terminal:0b6a4c2e",
    new RegExp(`^Invalid router configuration \\(${configPath}\\): .*full id`),
  );
  assert.equal(readFileSync(configPath, "utf8"), before);
  assert.deepEqual(readdirSync(dir).sort(), [
    "config.json",
    "journal.jsonl",
    "requests.jsonl",
  ]);
  assert.equal(counts.restarts, 0);
});

test("roster repoint: refuses a session another placement is configured with, seen by the record or not", async (t) => {
  const { configPath, deps, counts } = setup(t, (file) => ({
    ...file,
    agents: { ...file.agents, "environment@mini": "E9" },
  }));
  await assert.rejects(
    repoint("knowledge@mini", "E9", deps),
    /^UsageError: environment@mini is at E9 already\.$/,
  );
  // A file that names A1 twice already: repoint does not restart serve
  // into a binding the core refuses.
  const file = JSON.parse(readFileSync(configPath, "utf8")) as File;
  file.agents["knowledge@mini"] = "A1";
  writeFileSync(configPath, JSON.stringify(file));
  await assert.rejects(
    repoint("knowledge@mini", "A1", deps),
    /record knows A1 already, as orchestrator@mbp's/,
  );
  assert.equal(counts.restarts, 0);
});

test("roster repoint: an agent placement moved to a terminal, its participant no longer idempotent, the old file kept", async (t) => {
  const { configPath, deps, log, counts, fileNow } = setup(t);
  const before = readFileSync(configPath, "utf8");
  assert.equal(await repoint("knowledge@mini", TERMINAL, deps), 0);
  const after = fileNow();
  assert.equal(after.agents["knowledge@mini"], TERMINAL);
  assert.equal(after.agents["orchestrator@mbp"], "A1");
  assert.deepEqual(
    after.participants.map((p) => [p.id, p.idempotent]),
    [
      ["orchestrator", true],
      ["knowledge", false],
      ["environment", true],
      ["incus", true],
    ],
  );
  // Indent and mode kept; the old file beside it, as it was.
  assert.match(readFileSync(configPath, "utf8"), /^\{\n {2}"policy"/);
  assert.equal(statSync(configPath).mode & 0o777, 0o664);
  assert.equal(
    readFileSync(`${configPath}.bak-20261006T130501Z`, "utf8"),
    before,
  );
  assert.equal(counts.restarts, 1);
  assert.deepEqual(log, [
    "knowledge@mini works in /srv/work.",
    "knowledge is idempotent: false now, for a terminal.",
    `knowledge@mini: K1 -> ${TERMINAL}; the old configuration is ${configPath}.bak-20261006T130501Z.`,
    "1 open delivery went to the old session K1; router needs-you lists what they need.",
    `knowledge@mini: serve binds ${TERMINAL}, ready.`,
  ]);
  // Asked again: bound already, nothing to do.
  log.length = 0;
  assert.equal(await repoint("knowledge@mini", TERMINAL, deps), 0);
  assert.deepEqual(log, [`knowledge@mini is at ${TERMINAL} already.`]);
  assert.equal(counts.restarts, 1);
  // The old session is the record's now: the placement does not go back.
  await assert.rejects(
    repoint("knowledge@mini", "K1", deps),
    /record knows K1 already, as knowledge@mini's/,
  );
});

test("roster repoint: through a symlink, the file it names is replaced, its tabs kept", async (t) => {
  const { dir, configPath, deps, fileNow } = setup(t);
  const real = join(dir, "real.json");
  writeFileSync(real, `${JSON.stringify(fileNow(), null, "\t")}\n`);
  rmSync(configPath);
  symlinkSync(real, configPath);
  assert.equal(await repoint("knowledge@mini", "K2", deps), 0);
  assert.ok(lstatSync(configPath).isSymbolicLink());
  assert.match(readFileSync(real, "utf8"), /^\{\n\t"policy"/);
  assert.equal(fileNow().agents["knowledge@mini"], "K2");
  assert.ok(existsSync(`${real}.bak-20261006T130501Z`));
});

test("roster repoint: a terminal placement moved to an agent drops its terminal's CLI", async (t) => {
  const { deps, log, fileNow } = setup(t, (file) => ({
    ...file,
    agents: { ...file.agents, "knowledge@mini": TERMINAL },
    terminals: { "knowledge@mini": "codex" },
    participants: file.participants.map((p) =>
      p.id === "knowledge" ? { ...p, idempotent: false } : p,
    ),
  }));
  assert.equal(await repoint("knowledge@mini", "K2", deps), 0);
  const after = fileNow();
  assert.equal(after.agents["knowledge@mini"], "K2");
  assert.deepEqual(after.terminals, {});
  // Once not idempotent, a participant is made so again only by a person.
  assert.equal(
    after.participants.find((p) => p.id === "knowledge")?.idempotent,
    false,
  );
  assert.equal(log[1], "terminals.knowledge@mini removed: K2 is an agent.");
});

test("roster repoint: a restart that bound nothing is repaired by asking again; until then it fails", async (t) => {
  const { dir, deps, log, counts, fileNow, binding } = setup(t);
  binding(false);
  assert.equal(await repoint("knowledge@mini", "K2", deps), 1);
  assert.equal(fileNow().agents["knowledge@mini"], "K2");
  assert.equal(
    log.at(-1),
    "knowledge@mini: serve has not bound K2 in 90 seconds; its first run may still be going. router status shows when it does; if it never does, see serve's log and run this again.",
  );
  // The configuration names K2 already: asked again, serve restarts and
  // binds it, and the file is not written twice.
  binding(true);
  log.length = 0;
  assert.equal(await repoint("knowledge@mini", "K2", deps), 0);
  assert.equal(counts.restarts, 2);
  assert.deepEqual(log, [
    "1 open delivery went to the old session K1; router needs-you lists what they need.",
    "knowledge@mini: serve binds K2, ready.",
  ]);
  assert.equal(
    readdirSync(dir).filter((name) => name.includes(".bak-")).length,
    1,
  );
});

// More terminals, and a folder's sessions as a host's Paseo lists them.
const T2 = "terminal:1c7b5d3f-8a2e-4f4b-ad6c-3e9f2a1b4c5d";
const T3 = "terminal:2d8c6e4a-9b3f-4a5c-be7d-4fa03b2c5d6e";
const T4 = "terminal:3e9d7f5b-ac4a-4b6d-8f8e-50b14c3d6e7f";
type Listed = FolderSession & { host: string; folder: string };
const inNotes = (s: FolderSession): Listed => ({
  ...s,
  host: "mini",
  folder: "/srv/notes",
});
const terminal = (
  session: string,
  cli: "claude" | "codex" | null,
  title: string,
  unsure?: string,
): Listed =>
  inNotes({
    kind: "terminal",
    session,
    title,
    cli,
    ...(unsure ? { unsure } : {}),
  });
const agent = (
  session: string,
  provider: string,
  status: string,
  title: string,
  archived = false,
): Listed =>
  inNotes({ kind: "agent", session, title, provider, status, archived });

test("roster repoint without a session: the one new session in the folder, its CLI from what it shows, the folder kept for the next", async (t) => {
  const { deps, log, fileNow, world, counts } = setup(t);
  world.length = 0;
  world.push(
    agent("K1", "codex", "closed", "Notes", true),
    terminal(T2, "codex", "zsh"),
    terminal(T3, null, "~/notes"),
    agent("P1", "pi", "idle", "Vault admin"),
    { ...terminal(TERMINAL, "claude", "✳ Other"), folder: "/srv/other" },
  );
  assert.equal(await repoint("knowledge@mini", null, deps), 0);
  assert.equal(fileNow().agents["knowledge@mini"], T2);
  assert.deepEqual(fileNow().terminals, { "knowledge@mini": "codex" });
  assert.deepEqual(fileNow().folders, { "knowledge@mini": "/srv/notes" });
  assert.deepEqual(log.slice(0, 4), [
    `knowledge@mini: ${T2} (terminal, Codex, "zsh") is the one new session in /srv/notes.`,
    "knowledge@mini works in /srv/notes.",
    "knowledge is idempotent: false now, for a terminal.",
    "terminals.knowledge@mini: codex, as its screen shows.",
  ]);
  // Codex's terminal closed, Claude Code in a new one: found by the folder
  // kept, though the daemon no longer knows the current session.
  world.splice(1, 1, terminal(T4, "claude", "✳ Notes"));
  log.length = 0;
  assert.equal(await repoint("knowledge@mini", null, deps), 0);
  assert.equal(fileNow().agents["knowledge@mini"], T4);
  assert.deepEqual(fileNow().terminals, {});
  assert.deepEqual(log.slice(0, 2), [
    `knowledge@mini: ${T4} (terminal, Claude Code, "✳ Notes") is the one new session in /srv/notes.`,
    `terminals.knowledge@mini removed: Claude Code runs in ${T4}.`,
  ]);
  assert.equal(counts.restarts, 2);
});

test("roster repoint without a session: none or several that can take it, or one beside an unsure terminal, change nothing and list the folder; a seen session never comes back", async (t) => {
  const { configPath, deps, log, fileNow, world, counts } = setup(t);
  const listed = (...sessions: Listed[]) =>
    world.splice(0, world.length, ...sessions);
  // The current session, archived: gone.
  const gone = agent("K1", "claude", "idle", "Notes", true);
  const shell = terminal(T3, null, "~/notes");
  const claude = terminal(T2, "claude", "✳ Notes");
  const review = agent("K3", "codex", "idle", "Review");
  listed(
    gone,
    shell,
    agent("X1", "claude", "closed", "Old", true),
    agent("P1", "pi", "idle", "Vault admin"),
    agent("K4", "claude", "closed", "Left"),
  );
  const before = readFileSync(configPath, "utf8");
  assert.equal(await repoint("knowledge@mini", null, deps), 1);
  assert.deepEqual(log, [
    "knowledge@mini: no session in /srv/notes can take it, so nothing changed. Name one: router roster repoint knowledge@mini <session>.",
    `  ${T3} (terminal, "~/notes"): shows neither Claude Code's title nor Codex's empty composer`,
    '  P1 (pi agent, idle, "Vault admin"): a pi agent; only Claude Code and Codex take placements',
    '  K4 (claude agent, closed, "Left"): closed; only a live agent is found, so name it',
    "  and 2 archived agents",
  ]);
  listed(gone, shell, claude, review);
  log.length = 0;
  assert.equal(await repoint("knowledge@mini", null, deps), 1);
  assert.equal(
    log[0],
    "knowledge@mini: 2 sessions in /srv/notes can take it, so nothing changed. Name one: router roster repoint knowledge@mini <session>.",
  );
  // A Codex turn, or a screen not read, may be one more candidate.
  for (const why of [
    "a turn is running on its screen",
    "its screen was not read: no screen of the terminal within 5 s",
  ]) {
    listed(gone, claude, terminal(T4, null, "zsh", why));
    log.length = 0;
    assert.equal(await repoint("knowledge@mini", null, deps), 1);
    assert.deepEqual(log.slice(0, 3), [
      "knowledge@mini: 1 session in /srv/notes can take it, and 1 terminal is unsure, so nothing changed. Name one: router roster repoint knowledge@mini <session>.",
      `  ${T2} (terminal, Claude Code, "✳ Notes")`,
      `  ${T4} (terminal, "zsh"): ${why}`,
    ]);
  }
  assert.equal(readFileSync(configPath, "utf8"), before);
  assert.equal(counts.restarts, 0);
  // Named, one binds, and its folder is kept.
  listed(gone, claude, review);
  assert.equal(await repoint("knowledge@mini", "K3", deps), 0);
  assert.equal(fileNow().agents["knowledge@mini"], "K3");
  assert.deepEqual(fileNow().folders, { "knowledge@mini": "/srv/notes" });
  // K3 gone and K1 out of the archive: the record has seen K1.
  listed(agent("K1", "claude", "idle", "Notes"));
  log.length = 0;
  assert.equal(await repoint("knowledge@mini", null, deps), 1);
  assert.equal(
    log[1],
    '  K1 (claude agent, idle, "Notes"): seen before, as knowledge@mini\'s',
  );
});

test("roster repoint without a session: while the current session is still there, nothing changes, whatever is beside it", async (t) => {
  const { configPath, deps, log, world, counts } = setup(t);
  const before = readFileSync(configPath, "utf8");
  for (const status of ["closed", "idle"]) {
    world.splice(
      0,
      world.length,
      agent("K1", "claude", status, "Notes"),
      terminal(T2, "codex", "review"),
    );
    log.length = 0;
    assert.equal(await repoint("knowledge@mini", null, deps), 1);
    assert.deepEqual(log, [
      `knowledge@mini: its session K1 (claude agent, ${status}, "Notes") is still there, so nothing changed. Close its terminal or archive its agent first, or name the new session: router roster repoint knowledge@mini <session>.`,
    ]);
  }
  assert.equal(readFileSync(configPath, "utf8"), before);
  assert.equal(counts.restarts, 0);
  // A terminal whose CLI has exited is still there too.
  world.splice(0, world.length, terminal(TERMINAL, "claude", "✳ Notes"));
  assert.equal(await repoint("knowledge@mini", TERMINAL, deps), 0);
  world.splice(
    0,
    world.length,
    terminal(TERMINAL, null, "~/notes"),
    terminal(T2, "codex", "review"),
  );
  log.length = 0;
  assert.equal(await repoint("knowledge@mini", null, deps), 1);
  assert.match(
    log[0] ?? "",
    /^knowledge@mini: its session terminal:\S+ \(terminal, "~\/notes"\) is still there, so nothing changed\./,
  );
});

test("roster repoint: no folder to look in, an unreachable host and a terminal showing neither CLI are refused before anything is written", async (t) => {
  const { configPath, deps, fileNow, world, counts } = setup(t);
  world.length = 0;
  const before = readFileSync(configPath, "utf8");
  await assert.rejects(
    repoint("knowledge@mini", null, {
      ...deps,
      folderOf: () => Promise.resolve(null),
    }),
    /^UsageError: No folder is recorded for knowledge@mini, and Paseo on mini no longer knows K1; name the session: router roster repoint knowledge@mini <session>\.$/,
  );
  await assert.rejects(
    repoint("knowledge@mini", null, {
      ...deps,
      sessionsIn: () => Promise.reject(new Error("down")),
    }),
    /^UsageError: Cannot reach Paseo on mini: down$/,
  );
  world.push(
    { ...terminal(T3, null, "~"), folder: "/srv/work" },
    {
      ...terminal(
        T2,
        null,
        "~",
        "its screen was not read: no screen of the terminal within 5 s",
      ),
      folder: "/srv/work",
    },
  );
  await assert.rejects(
    repoint("knowledge@mini", T3, deps),
    /^UsageError: terminal:\S+ shows neither Claude Code's title nor Codex's empty composer; start the CLI in it \(Codex as codex --no-daemon\), leave it at its empty prompt and run this again\.$/,
  );
  await assert.rejects(
    repoint("knowledge@mini", T2, deps),
    /^UsageError: terminal:\S+: its screen was not read: no screen of the terminal within 5 s; run this again when it is at its empty prompt\.$/,
  );
  assert.equal(readFileSync(configPath, "utf8"), before);
  assert.equal(counts.restarts, 0);
  // Named, a Codex terminal is recorded as Codex.
  world.push({ ...terminal(T4, "codex", "zsh"), folder: "/srv/work" });
  assert.equal(await repoint("knowledge@mini", T4, deps), 0);
  assert.deepEqual(fileNow().terminals, { "knowledge@mini": "codex" });
  assert.deepEqual(fileNow().folders, { "knowledge@mini": "/srv/work" });
});

test("roster repoint: naming the bound session records its folder when none is, once, without a restart", async (t) => {
  const { dir, deps, log, counts, fileNow } = setup(t);
  // A host not reached, or a session its Paseo no longer knows: nothing
  // recorded, and still done.
  for (const folderOf of [
    () => Promise.reject(new Error("down")),
    () => Promise.resolve(null),
  ])
    assert.equal(
      await repoint("knowledge@mini", "K1", { ...deps, folderOf }),
      0,
    );
  assert.deepEqual(log, [
    "knowledge@mini is at K1 already.",
    "knowledge@mini's folder is not recorded: cannot reach Paseo on mini: down.",
    "knowledge@mini is at K1 already.",
    "knowledge@mini's folder is not recorded: Paseo on mini does not know K1.",
  ]);
  assert.deepEqual(fileNow().folders, {});
  log.length = 0;
  assert.equal(await repoint("knowledge@mini", "K1", deps), 0);
  assert.deepEqual(fileNow().folders, { "knowledge@mini": "/srv/work" });
  assert.deepEqual(log, [
    "knowledge@mini is at K1 already.",
    `knowledge@mini works in /srv/work, recorded; the old configuration is ${dir}/config.json.bak-20261006T130501Z.`,
  ]);
  log.length = 0;
  assert.equal(await repoint("knowledge@mini", "K1", deps), 0);
  assert.deepEqual(log, ["knowledge@mini is at K1 already."]);
  assert.equal(counts.restarts, 0);
});

test("roster repoint without a session: after a restart that bound nothing, asked again it restarts serve into the configured session", async (t) => {
  const { dir, deps, log, counts, fileNow, binding, world } = setup(t);
  world.length = 0;
  world.push(
    agent("K1", "claude", "idle", "Notes", true),
    terminal(T2, "claude", "✳ Notes"),
  );
  binding(false);
  assert.equal(await repoint("knowledge@mini", null, deps), 1);
  assert.equal(fileNow().agents["knowledge@mini"], T2);
  binding(true);
  log.length = 0;
  assert.equal(await repoint("knowledge@mini", null, deps), 0);
  assert.equal(
    log[0],
    `knowledge@mini is configured at ${T2}; serve has not bound it yet.`,
  );
  assert.equal(log.at(-1), `knowledge@mini: serve binds ${T2}, ready.`);
  assert.equal(counts.restarts, 2);
  assert.equal(
    readdirSync(dir).filter((name) => name.includes(".bak-")).length,
    1,
  );
});

// design's text, in a file with a section for each participant it names.
const OWNERS =
  "# Owners\n\n## design\n<!-- Copied into the router; keep it short. -->\nOwns the logo and the board's look.\n\n# Others\n\n## other\nweather reports.\n";
const SOURCE = "mini:~/work/responsibility.md";
const TEXT = `design's text: 35 characters from ${SOURCE}, main at 1a2b3c4 2026-10-05.`;

test("roster add: refuses, touching nothing, what it cannot add", async (t) => {
  const { dir, configPath, setPath, files, unanswered, deps, log, counts } =
    setup(t, undefined, [...SET, DESIGN]);
  files.set(SOURCE, OWNERS);
  files.set("mini:/weather.md", "Owns the logo, and the weather.");
  files.set("mini:/empty.md", "## design\n<!-- to write -->\n## other\nx\n");
  files.set("mini:/cased.md", "## Design\nOwns the logo.\n");
  files.set("mini:/open.md", "<!-- a note\nOwns the logo.\n");
  const before = [
    readFileSync(configPath, "utf8"),
    readFileSync(setPath, "utf8"),
  ];
  const refused = (
    from: string,
    placements: string[],
    message: RegExp,
    given = deps,
    id = "design",
  ) =>
    assert.rejects(
      add(id, from, placements, given),
      (error) => error instanceof UsageError && message.test(error.message),
      `${id} ${from} ${placements.join(" ")}`,
    );
  await refused(
    SOURCE,
    ["mini=D1"],
    /^knowledge is in the roster already/,
    deps,
    "knowledge",
  );
  await refused(SOURCE, ["mini"], /^mini is not <host>=<session>/);
  await refused(SOURCE, ["mini=D1", "mini=D2"], /^mini is named twice/);
  await refused(SOURCE, ["lab01=D1"], /^lab01 is not in hosts/);
  await refused(SOURCE, ["mini=A1"], /record knows A1 already/);
  await refused(SOURCE, ["mini=unknown"], /^Paseo on mini does not know/);
  await refused("mini", ["mini=D1"], /^mini is not <host>:<path>/);
  await refused("lab01:/x.md", ["mini=D1"], /^lab01 is not in hosts/);
  await refused(
    "mini:/nope.md",
    ["mini=D1"],
    /^Cannot read \/nope\.md on mini: No such file/,
  );
  // The text: none in its section, sections but none its own, a comment
  // that never ends.
  await refused(
    "mini:/empty.md",
    ["mini=D1"],
    /^mini:\/empty\.md has no text for design/,
  );
  await refused(
    "mini:/cased.md",
    ["mini=D1"],
    /^mini:\/cased\.md has sections, and none is ## design/,
  );
  await refused(
    "mini:/open.md",
    ["mini=D1"],
    /^mini:\/open\.md has a <!-- that never ends/,
  );
  // The eval: no request expects design; a text that takes the weather
  // from none; a request Jev does not answer.
  writeFileSync(join(dir, "plain.jsonl"), `${SET.join("\n")}\n`);
  await refused(
    SOURCE,
    ["mini=D1"],
    /^No request in .*plain\.jsonl expects design/,
    {
      ...deps,
      setPath: join(dir, "plain.jsonl"),
    },
  );
  log.length = 0;
  await refused(
    "mini:/weather.md",
    ["mini=D1"],
    /^The eval refuses it: 1 of 4 requests/,
  );
  assert.match(
    log.at(-1) ?? "",
    /^NO {2}en none {9}design 0\.94 {8}weather: will it rain$/,
  );
  unanswered.add("VM: start the ci-runner");
  log.length = 0;
  await refused(SOURCE, ["mini=D1"], /^The eval refuses it: 1 of 4 requests/);
  assert.match(
    log.at(-1) ?? "",
    /no answer \(timeout\) +VM: start the ci-runner$/,
  );
  assert.deepEqual(
    [readFileSync(configPath, "utf8"), readFileSync(setPath, "utf8")],
    before,
  );
  assert.ok(!readdirSync(dir).some((name) => name.includes(".bak-")));
  assert.equal(counts.restarts, 0);
});

test("roster add: a participant from its section of a responsibility file, granted all to all, bound on each host", async (t) => {
  const { files, deps, log, counts, fileNow } = setup(t, undefined, [
    ...SET,
    DESIGN,
  ]);
  files.set(SOURCE, OWNERS);
  assert.equal(
    await add("design", SOURCE, ["mini=D1", `mbp=${TERMINAL}`], deps),
    0,
  );
  const after = fileNow();
  assert.deepEqual(after.participants.at(-1), {
    id: "design",
    kind: "agent",
    hosts: ["mini", "mbp"],
    // A terminal takes no message key.
    idempotent: false,
    responsibility: "Owns the logo and the board's look.",
    responsibilityFrom: SOURCE,
  });
  assert.deepEqual(after.permissions, {
    you: ["orchestrator", "knowledge", "environment", "incus", "design"],
    orchestrator: ["environment", "incus", "design"],
    design: ["orchestrator", "knowledge", "environment", "incus"],
  });
  assert.equal(after.agents["design@mini"], "D1");
  assert.equal(after.agents["design@mbp"], TERMINAL);
  assert.equal(counts.restarts, 1);
  assert.deepEqual(log, [
    TEXT,
    "Judging 4 labeled requests with the new texts.",
    "Eval: none of 4 requests sent wrong at 0.9.",
    `design added on mini, mbp; the old configuration is ${deps.configPath}.bak-20261006T130501Z.`,
    "design@mini: serve binds D1, ready.",
    `design@mbp: serve binds ${TERMINAL}, ready.`,
  ]);
});

test("roster remove: the participant, its grants and placements go; its labeled requests expect none, the rest as written", async (t) => {
  const { setPath, deps, log, counts, fileNow } = setup(t, (file) => ({
    ...file,
    folders: { "knowledge@mini": "/srv/notes", "orchestrator@mbp": "/srv" },
  }));
  await assert.rejects(
    remove("nobody", deps),
    /^UsageError: nobody is not in the roster/,
  );
  assert.equal(await remove("knowledge", deps), 0);
  const after = fileNow();
  assert.deepEqual(
    after.participants.map((p) => p.id),
    ["orchestrator", "environment", "incus"],
  );
  assert.deepEqual(after.permissions, {
    you: ["orchestrator", "environment", "incus"],
    orchestrator: ["environment", "incus"],
  });
  assert.equal(after.agents["knowledge@mini"], undefined);
  assert.deepEqual(after.folders, { "orchestrator@mbp": "/srv" });
  assert.equal(
    readFileSync(setPath, "utf8"),
    `${SET.map((line) => line.replace('"expect": "knowledge"', '"expect": "none"')).join("\n")}\n`,
  );
  assert.equal(counts.restarts, 1);
  assert.deepEqual(log, [
    "Judging 3 labeled requests with the new texts.",
    "Eval: none of 3 requests sent wrong at 0.9.",
    `Relabeled 1 request for knowledge to expect none in ${setPath}; commit that.`,
    `knowledge removed; the old configuration is ${deps.configPath}.bak-20261006T130501Z.`,
    "knowledge has 1 open delivery in the record; router status shows it.",
    "serve runs without knowledge.",
  ]);
});

test("roster remove: refused when another participant would take its requests; fails when serve's first run records nothing", async (t) => {
  // environment's text takes the notes once knowledge, before it, is gone.
  const { configPath, setPath, deps, counts, binding } = setup(t, (file) => ({
    ...file,
    participants: file.participants.map((p) =>
      p.id === "environment"
        ? { ...p, responsibility: `${String(p.responsibility)} Notes too.` }
        : p,
    ),
  }));
  const before = [
    readFileSync(configPath, "utf8"),
    readFileSync(setPath, "utf8"),
  ];
  await assert.rejects(
    remove("knowledge", deps),
    /^UsageError: The eval refuses it: 1 of 3 requests/,
  );
  assert.deepEqual(
    [readFileSync(configPath, "utf8"), readFileSync(setPath, "utf8")],
    before,
  );
  binding(false);
  assert.equal(await remove("incus", deps), 1);
  assert.equal(counts.restarts, 1);
});

test("roster refresh: a new text judged and served; a new source only written down; unchanged, nothing happens", async (t) => {
  const { configPath, files, deps, log, counts, fileNow } = setup(t);
  await assert.rejects(
    refresh("knowledge", undefined, deps),
    /^UsageError: knowledge's text has no source yet/,
  );
  // A text that takes the weather from none is refused, and nothing changes.
  files.set("mini:/weather.md", "Notes, and the weather.\n");
  const before = readFileSync(configPath, "utf8");
  await assert.rejects(
    refresh("knowledge", "mini:/weather.md", deps),
    /^UsageError: The eval refuses it/,
  );
  assert.equal(readFileSync(configPath, "utf8"), before);
  // A file with no sections is all knowledge's.
  files.set("mini:/vault/responsibility.md", "Notes and research.\n");
  log.length = 0;
  assert.equal(
    await refresh("knowledge", "mini:/vault/responsibility.md", deps),
    0,
  );
  const entry = () => fileNow().participants.find((p) => p.id === "knowledge");
  assert.equal(entry()?.responsibility, "Notes and research.");
  assert.equal(entry()?.responsibilityFrom, "mini:/vault/responsibility.md");
  assert.equal(counts.restarts, 1);
  assert.equal(log.at(-1), "serve runs with knowledge's new text.");
  // The same text from elsewhere: written down, not judged, no restart.
  files.set("mini:/copy.md", "Notes and research.\n");
  log.length = 0;
  assert.equal(await refresh("knowledge", "mini:/copy.md", deps), 0);
  assert.equal(entry()?.responsibilityFrom, "mini:/copy.md");
  assert.equal(counts.restarts, 1);
  assert.ok(!log.some((line) => line.startsWith("Judging")));
  // Asked again: nothing to do.
  log.length = 0;
  assert.equal(await refresh("knowledge", undefined, deps), 0);
  assert.equal(
    log.at(-1),
    "knowledge's text is as mini:/copy.md has it already.",
  );
  assert.equal(counts.restarts, 1);
});

test("roster's read: a responsibility file as committed on its repository's main, not as edited since; only over ssh or here", async (t) => {
  const dir = scratch(t, "roster-read-");
  const git = (...args: string[]) =>
    execFileSync(
      "git",
      ["-c", "user.name=t", "-c", "user.email=t@example.com", ...args],
      { cwd: dir, stdio: "pipe" },
    );
  // A repository with no origin, as mini's vault is.
  git("init", "-q", "-b", "main", "work");
  const file = join(dir, "work", "docs", "responsibility.md");
  mkdirSync(join(dir, "work", "docs"));
  writeFileSync(file, "## design\nOwns the logo.\n");
  git("-C", "work", "add", ".");
  git("-C", "work", "commit", "-q", "-m", "text");
  // An edit on a branch, and one not committed, are not read.
  git("-C", "work", "switch", "-q", "-c", "draft");
  writeFileSync(file, "## design\nOn a branch.\n");
  git("-C", "work", "commit", "-q", "-am", "draft");
  writeFileSync(file, "## design\nNot committed.\n");
  // The router host's own Paseo is not over ssh: read here.
  const read = await readOver("ws://127.0.0.1:6767/ws", file);
  assert.equal(read.text, "## design\nOwns the logo.\n");
  assert.match(read.at, /^[0-9a-f]{7,} \d{4}-\d{2}-\d{2}$/);
  await assert.rejects(
    readOver("ws://127.0.0.1:6767/ws", join(dir, "work", "docs", "gone.md")),
    /gone\.md/,
  );
  // Another machine's Paseo, reached without ssh: its files are not here.
  await assert.rejects(
    readOver("ws://mini.example.ts.net:6767/ws", file),
    /^Error: ws:\/\/mini\.example\.ts\.net:6767\/ws is neither ssh nor this machine\./,
  );
});
