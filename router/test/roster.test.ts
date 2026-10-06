// `router roster repoint` on a scratch configuration and record: what it
// refuses without touching either, how it rewrites the configuration, and
// that it waits for serve's first run to bind the new session.
import test from "node:test";
import assert from "node:assert/strict";
import {
  appendFileSync,
  readdirSync,
  readFileSync,
  statSync,
  writeFileSync,
} from "node:fs";
import { join } from "node:path";
import { scratch } from "./test-scratch.ts";
import { repoint, type RosterDeps } from "../src/roster.ts";
import { recordReader } from "../src/server.ts";
import { UsageError } from "../src/request.ts";
import { config as fixture, journal } from "../src/board-fixture.ts";

const TERMINAL = "terminal:0b6a4c2e-7f1d-4e3a-9c5b-2d8e1f0a3b4c";

type File = Record<string, unknown> & {
  agents: Record<string, string>;
  terminals?: Record<string, string>;
  participants: { id: string; idempotent: boolean }[];
};

// The fixture's configuration as a file, with its record beside it, and
// repoint's dependencies around them. serve's restart stands for its first
// run: it binds what the configuration now names, as an observation.
function setup(t: test.TestContext, edit = (file: File): File => file) {
  const dir = scratch(t, "roster-");
  const configPath = join(dir, "config.json");
  const file = edit(
    JSON.parse(JSON.stringify({ ...fixture, home: dir })) as File,
  );
  writeFileSync(configPath, `${JSON.stringify(file, null, 2)}\n`, {
    mode: 0o640,
  });
  const journalPath = join(dir, "journal.jsonl");
  writeFileSync(
    journalPath,
    journal.map((entry) => `${JSON.stringify(entry)}\n`).join(""),
  );
  const read = recordReader({ ...fixture, home: dir });
  const log: string[] = [];
  const counts = { restarts: 0 };
  let binds = true;
  const binding = (on: boolean): void => {
    binds = on;
  };
  const deps: RosterDeps = {
    configPath,
    record: () => read().state,
    known: (_host, session) => Promise.resolve(session !== "unknown"),
    restart: () => {
      counts.restarts++;
      const now = (JSON.parse(readFileSync(configPath, "utf8")) as File).agents;
      for (const [placement, session] of Object.entries(now))
        if (binds && read().state.placements[placement]?.session !== session)
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
    deps,
    log,
    counts,
    fileNow,
    binding,
  };
}

test("roster repoint: refuses, touching neither the configuration nor serve, what it cannot point at", async (t) => {
  const { dir, configPath, deps, counts } = setup(t);
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
  await refused("knowledge@mini", "K9", /^Cannot reach Paseo on mini: down/, {
    ...deps,
    known: () => Promise.reject(new Error("down")),
  });
  // What the configuration refuses: a terminal named by a short id.
  await refused("knowledge@mini", "terminal:0b6a4c2e", /full id/);
  assert.equal(readFileSync(configPath, "utf8"), before);
  assert.deepEqual(readdirSync(dir).sort(), ["config.json", "journal.jsonl"]);
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
  assert.equal(statSync(configPath).mode & 0o777, 0o640);
  assert.equal(
    readFileSync(`${configPath}.bak-20261006T130501Z`, "utf8"),
    before,
  );
  assert.equal(counts.restarts, 1);
  assert.deepEqual(log, [
    "knowledge is idempotent: false now, for a terminal.",
    `knowledge@mini: K1 -> ${TERMINAL}; the old configuration is ${configPath}.bak-20261006T130501Z.`,
    "1 open deliveries went to the old session K1; router needs-you lists what they need.",
    `knowledge@mini: serve binds ${TERMINAL}, ready.`,
  ]);
  // Asked again: bound already, nothing to do.
  log.length = 0;
  assert.equal(await repoint("knowledge@mini", TERMINAL, deps), 0);
  assert.deepEqual(log, [`knowledge@mini is at ${TERMINAL} already.`]);
  assert.equal(counts.restarts, 1);
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
  assert.equal(log[0], "terminals.knowledge@mini removed: K2 is an agent.");
});

test("roster repoint: a restart that bound nothing is repaired by asking again; until then it fails", async (t) => {
  const { dir, deps, log, counts, fileNow, binding } = setup(t);
  binding(false);
  assert.equal(await repoint("knowledge@mini", "K2", deps), 1);
  assert.equal(fileNow().agents["knowledge@mini"], "K2");
  assert.equal(
    log.at(-1),
    "knowledge@mini: serve has not bound K2 after 30 seconds; see router status and serve's log.",
  );
  // The configuration names K2 already: asked again, serve restarts and
  // binds it, and the file is not written twice.
  binding(true);
  log.length = 0;
  assert.equal(await repoint("knowledge@mini", "K2", deps), 0);
  assert.equal(counts.restarts, 2);
  assert.deepEqual(log, [
    "1 open deliveries went to the old session K1; router needs-you lists what they need.",
    "knowledge@mini: serve binds K2, ready.",
  ]);
  assert.equal(
    readdirSync(dir).filter((name) => name.includes(".bak-")).length,
    1,
  );
});
