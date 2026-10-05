// The writer's lock and repair, which the board's lock-free reader relies on.
import test from "node:test";
import assert from "node:assert/strict";
import { spawnSync } from "node:child_process";
import {
  appendFileSync,
  existsSync,
  mkdirSync,
  readFileSync,
  renameSync,
  statSync,
  truncateSync,
  writeFileSync,
} from "node:fs";
import { join } from "node:path";
import {
  openJournal,
  readJournal,
  readJournalSince,
  type JournalRead,
} from "./journal.ts";
import { scratch } from "./test-scratch.ts";

const line = (n: number): string =>
  `${JSON.stringify({ at: "t", event: { type: "tick", now: n } })}\n`;

test("the lock is exclusive while held and free once released", async (t) => {
  const home = scratch(t, "journal-");
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

test("a dead owner's lock is reclaimed; a lock being created is not", async (t) => {
  const home = scratch(t, "journal-");
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

test("release only removes a lock this process owns", async (t) => {
  const home = scratch(t, "journal-");
  const journal = await openJournal(home);
  writeFileSync(join(home, "journal.lock"), "999999");
  journal.release();
  assert.equal(readFileSync(join(home, "journal.lock"), "utf8"), "999999");
});

test("a torn final line is dropped by the writer and skipped by the reader", async (t) => {
  const home = scratch(t, "journal-");
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

test("a reader goes on from its mark: a missing journal, appends, a torn line, a truncation, a replacement of the same size and a rewrite", (t) => {
  const home = scratch(t, "journal-");
  const path = join(home, "journal.jsonl");
  const nows = (read: JournalRead): unknown[] =>
    read.entries.map((entry) => entry.event.now);
  // No journal: nothing, and no mark.
  const none = readJournalSince(home, null);
  assert.deepEqual(none, { entries: [], from: "start", mark: null });
  writeFileSync(path, `${line(1)}${line(2)}`);
  const first = readJournalSince(home, none.mark);
  assert.equal(first.from, "start");
  assert.deepEqual(nows(first), [1, 2]);
  // Unchanged: nothing new, and the same mark.
  const same = readJournalSince(home, first.mark);
  assert.deepEqual([same.from, nows(same)], ["mark", []]);
  assert.equal(same.mark, first.mark);
  // An append with a torn line after it: only the whole line is read, and
  // the torn one waits for its newline.
  appendFileSync(path, `${line(3)}${line(4).slice(0, 10)}`);
  const more = readJournalSince(home, first.mark);
  assert.deepEqual([more.from, nows(more)], ["mark", [3]]);
  appendFileSync(path, line(4).slice(10));
  const rest = readJournalSince(home, more.mark);
  assert.deepEqual([rest.from, nows(rest)], ["mark", [4]]);
  // Cut back, as repair cuts a torn line: read from the start.
  appendFileSync(path, line(5).slice(0, 10));
  const torn = readJournalSince(home, rest.mark);
  assert.deepEqual([torn.from, nows(torn)], ["mark", []]);
  truncateSync(path, statSync(path).size - 10);
  const cut = readJournalSince(home, torn.mark);
  assert.deepEqual([cut.from, nows(cut)], ["start", [1, 2, 3, 4]]);
  // Replaced by a file of the same size that ends with the same line
  // (another inode): from the start.
  const next = join(home, "next.jsonl");
  writeFileSync(next, `${line(6)}${line(7)}${line(8)}${line(4)}`);
  renameSync(next, path);
  assert.equal(statSync(path).size, cut.mark?.size);
  const replaced = readJournalSince(home, cut.mark);
  assert.deepEqual([replaced.from, nows(replaced)], ["start", [6, 7, 8, 4]]);
  // Rewritten in place and longer, no longer ending where the mark did
  // with its line: from the start.
  writeFileSync(path, `${line(1)}${line(2)}${line(3)}${line(5)}${line(6)}`);
  const rewritten = readJournalSince(home, replaced.mark);
  assert.deepEqual(
    [rewritten.from, nows(rewritten)],
    ["start", [1, 2, 3, 5, 6]],
  );
  assert.deepEqual(readJournal(home), rewritten.entries);
});

test("corrupt lines are refused, including a null event", (t) => {
  const home = scratch(t, "journal-");
  const path = join(home, "journal.jsonl");
  for (const bad of ['{"at":"t","event":null}', '{"at":1,"event":{}}', "[]"]) {
    writeFileSync(path, `${bad}\n`);
    assert.throws(() => readJournal(home), /Corrupt journal line/, bad);
  }
});
