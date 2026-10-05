// The record: an append-only JSON-lines file. State is never stored; it is
// always the fold of the journal. One writer at a time, guarded by a lock
// file for the duration of a run.
import {
  appendFileSync,
  closeSync,
  fstatSync,
  mkdirSync,
  openSync,
  readFileSync,
  readSync,
  rmSync,
  statSync,
  truncateSync,
  writeSync,
} from "node:fs";
import { join } from "node:path";
import { setTimeout as sleep } from "node:timers/promises";

export type Entry = { at: string; event: Record<string, unknown> };

export type Journal = {
  readonly path: string;
  append(event: Record<string, unknown>): void;
  release(): void;
};

export type LockOptions = {
  // How long to wait for a live owner. A run that asks Jev and tunnels to a
  // host can hold the lock for the better part of a minute.
  waitMs?: number;
  pollMs?: number;
  now?: () => number;
};

export const LOCK_WAIT_MS = 90_000;
const LOCK_POLL_MS = 100;
// A lock file younger than this with no readable pid is one being created.
const LOCK_GRACE_MS = 2_000;

export async function openJournal(
  home: string,
  options: LockOptions = {},
): Promise<Journal> {
  mkdirSync(home, { recursive: true });
  const path = join(home, "journal.jsonl");
  const lock = join(home, "journal.lock");
  await acquire(lock, options);
  repair(path);
  return {
    path,
    append(event) {
      appendFileSync(
        path,
        `${JSON.stringify({ at: new Date().toISOString(), event })}\n`,
      );
    },
    release() {
      // Only the owner removes the lock; a contender that reclaimed it must
      // not lose its own lock to our release.
      if (lockOwner(lock) === process.pid) rmSync(lock, { force: true });
    },
  };
}

// A reader's view of the journal: no lock, no appends. The writer appends
// one whole line per call, so a final line without its newline is a write in
// progress and is left for the next read.
export function readJournal(home: string): Entry[] {
  return readJournalSince(home, null).entries;
}

// Where a read left the journal: the file (its inode), its size and
// modification time then, the bytes read (up to the end of the last whole
// line), and that line, which must still end there for a later read to go
// on from it.
export type JournalMark = Readonly<{
  ino: number;
  size: number;
  mtimeMs: number;
  offset: number;
  last: string;
}>;

// What a read found: the whole lines after `mark` (`from` "mark"), or, when
// the journal is not the one the mark was taken on, every line (`from`
// "start"); and the mark to pass next time, null while there is no
// journal. The writer only appends, but `repair` truncates a torn last line
// and a journal can be replaced, so a file that shrank, has another inode or
// no longer holds the mark's line where it ended is read from the start.
export type JournalRead = {
  entries: Entry[];
  from: "start" | "mark";
  mark: JournalMark | null;
};

export function readJournalSince(
  home: string,
  mark: JournalMark | null,
): JournalRead {
  let fd: number;
  try {
    fd = openSync(join(home, "journal.jsonl"), "r");
  } catch (error: unknown) {
    if (!isCode(error, "ENOENT")) throw error;
    return { entries: [], from: "start", mark: null };
  }
  try {
    const stat = fstatSync(fd);
    const read = (length: number, position: number): Buffer => {
      const buffer = Buffer.alloc(length);
      let done = 0;
      while (done < length) {
        const n = readSync(fd, buffer, done, length - done, position + done);
        if (n === 0) break;
        done += n;
      }
      return buffer.subarray(0, done);
    };
    const same =
      mark !== null && stat.ino === mark.ino && stat.size >= mark.size;
    if (same && stat.size === mark.size && stat.mtimeMs === mark.mtimeMs)
      return { entries: [], from: "mark", mark };
    const ended = Buffer.from(`${mark?.last ?? ""}\n`);
    const goOn =
      same &&
      (mark.offset === 0 ||
        (mark.offset >= ended.length &&
          read(ended.length, mark.offset - ended.length).equals(ended)));
    const start = goOn ? mark.offset : 0;
    const bytes = read(stat.size - start, start);
    // Whole lines only, cut at a newline byte, so no character is split.
    const whole = bytes.subarray(0, bytes.lastIndexOf(0x0a) + 1);
    const lines = whole.toString("utf8").split("\n");
    lines.pop();
    return {
      entries: lines
        .filter((line) => line.trim())
        .map((line) => parseEntry(line)),
      from: goOn ? "mark" : "start",
      mark: {
        ino: stat.ino,
        size: stat.size,
        mtimeMs: stat.mtimeMs,
        offset: start + whole.length,
        last: lines.at(-1) ?? (goOn ? mark.last : ""),
      },
    };
  } finally {
    closeSync(fd);
  }
}

// A final line without its newline is a write that died mid-way. It was
// never acknowledged, so the writer drops it rather than append after it.
function repair(path: string): void {
  let text: string;
  try {
    text = readFileSync(path, "utf8");
  } catch (error: unknown) {
    if (isCode(error, "ENOENT")) return;
    throw error;
  }
  if (!text || text.endsWith("\n")) return;
  truncateSync(
    path,
    Buffer.byteLength(text.slice(0, text.lastIndexOf("\n") + 1)),
  );
}

// The lock is a file created exclusively, holding its owner's pid. A run
// that died mid-way does not block the next one; a live owner is waited for.
async function acquire(lock: string, options: LockOptions): Promise<void> {
  const now = options.now ?? Date.now;
  const waitMs = options.waitMs ?? LOCK_WAIT_MS;
  const pollMs = options.pollMs ?? LOCK_POLL_MS;
  const deadline = now() + waitMs;
  for (;;) {
    let fd: number | null = null;
    try {
      fd = openSync(lock, "wx");
      writeSync(fd, String(process.pid));
      return;
    } catch (error: unknown) {
      if (!isCode(error, "EEXIST")) throw error;
    } finally {
      if (fd !== null) closeSync(fd);
    }
    if (isDirectory(lock)) {
      // A lock from before the lock was a file.
      rmSync(lock, { recursive: true, force: true });
      continue;
    }
    const owner = lockOwner(lock);
    if (owner === null && ageMs(lock, now) > LOCK_GRACE_MS)
      rmSync(lock, { force: true });
    else if (owner !== null && !alive(owner)) rmSync(lock, { force: true });
    else if (now() >= deadline)
      throw new Error(
        `Another router run (pid ${owner ?? "unknown"}) has held ${lock} for ${waitMs / 1000}s.`,
      );
    await sleep(pollMs);
  }
}

function lockOwner(lock: string): number | null {
  try {
    const pid = Number(readFileSync(lock, "utf8"));
    return Number.isInteger(pid) && pid > 0 ? pid : null;
  } catch {
    return null;
  }
}

function isDirectory(path: string): boolean {
  try {
    return statSync(path).isDirectory();
  } catch {
    return false;
  }
}

function ageMs(path: string, now: () => number): number {
  try {
    return now() - statSync(path).mtimeMs;
  } catch {
    return Infinity;
  }
}

function alive(pid: number): boolean {
  try {
    process.kill(pid, 0);
    return true;
  } catch (error: unknown) {
    return !isCode(error, "ESRCH");
  }
}

function parseEntry(line: string): Entry {
  const value: unknown = JSON.parse(line);
  if (
    value === null ||
    typeof value !== "object" ||
    typeof (value as { at?: unknown }).at !== "string" ||
    (value as { event?: unknown }).event === null ||
    typeof (value as { event?: unknown }).event !== "object"
  )
    throw new Error(`Corrupt journal line: ${line}`);
  return value as Entry;
}

const isCode = (error: unknown, code: string): boolean =>
  error instanceof Error && (error as NodeJS.ErrnoException).code === code;
