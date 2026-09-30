// The writer's lock and repair, which the board's lock-free reader relies on.
import test from "node:test";
import assert from "node:assert/strict";
import { spawnSync } from "node:child_process";
import {
  existsSync,
  mkdirSync,
  mkdtempSync,
  readFileSync,
  writeFileSync,
} from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { openJournal, readJournal } from "./journal.ts";

const fresh = (): string => mkdtempSync(join(tmpdir(), "journal-"));
const line = (n: number): string =>
  `${JSON.stringify({ at: "t", event: { type: "tick", now: n } })}\n`;

test("the lock is exclusive while held and free once released", async () => {
  const home = fresh();
  const first = await openJournal(home);
  assert.equal(
    readFileSync(join(home, "journal.lock"), "utf8"),
    String(process.pid),
  );
  await assert.rejects(
    openJournal(home, { waitMs: 250, pollMs: 20 }),
    /has held .*journal\.lock for 0\.25s/,
  );
  first.release();
  assert.ok(!existsSync(join(home, "journal.lock")));
  const second = await openJournal(home);
  second.release();
});

test("a dead owner's lock is reclaimed; a lock being created is not", async () => {
  const home = fresh();
  const lock = join(home, "journal.lock");
  const dead = spawnSync(process.execPath, ["-e", "process.exit(0)"]);
  assert.equal(dead.status, 0);
  writeFileSync(lock, String(dead.pid));
  const journal = await openJournal(home, { waitMs: 500, pollMs: 20 });
  assert.equal(readFileSync(lock, "utf8"), String(process.pid));
  journal.release();
  // A pidless lock file younger than the grace period is someone mid-create.
  writeFileSync(lock, "");
  await assert.rejects(
    openJournal(home, { waitMs: 300, pollMs: 20 }),
    /Another router run/,
  );
  assert.ok(existsSync(lock), "not reclaimed inside the grace period");
  // The same file, older than the grace period, is stale.
  let clock = Date.now();
  const stale = await openJournal(home, {
    waitMs: 300,
    pollMs: 20,
    now: () => (clock += 3_000),
  });
  stale.release();
  // A lock directory from the earlier scheme is removed.
  mkdirSync(lock);
  writeFileSync(join(lock, "pid"), String(dead.pid));
  const upgraded = await openJournal(home, { waitMs: 300, pollMs: 20 });
  upgraded.release();
});

test("release only removes a lock this process owns", async () => {
  const home = fresh();
  const journal = await openJournal(home);
  writeFileSync(join(home, "journal.lock"), "999999");
  journal.release();
  assert.equal(readFileSync(join(home, "journal.lock"), "utf8"), "999999");
});

test("a torn final line is dropped by the writer and skipped by the reader", async () => {
  const home = fresh();
  const path = join(home, "journal.jsonl");
  writeFileSync(path, `${line(1)}${line(2)}${line(3).slice(0, 12)}`);
  assert.equal(readJournal(home).length, 2);
  const journal = await openJournal(home);
  assert.equal(readFileSync(path, "utf8"), `${line(1)}${line(2)}`);
  assert.equal(journal.entries().length, 2);
  journal.append({ type: "tick", now: 4 });
  assert.equal(journal.entries().length, 3);
  assert.equal(journal.entries()[2]?.event.now, 4);
  journal.release();
  // Multi-byte text is truncated at the right byte.
  const korean = `${JSON.stringify({ at: "t", event: { type: "note", text: "한글" } })}\n`;
  writeFileSync(path, `${korean}${korean.slice(0, 20)}`);
  const again = await openJournal(home);
  assert.equal(readFileSync(path, "utf8"), korean);
  again.release();
});

test("corrupt lines are refused, including a null event", () => {
  const home = fresh();
  const path = join(home, "journal.jsonl");
  for (const bad of ['{"at":"t","event":null}', '{"at":1,"event":{}}', "[]"]) {
    writeFileSync(path, `${bad}\n`);
    assert.throws(() => readJournal(home), /Corrupt journal line/, bad);
  }
});
