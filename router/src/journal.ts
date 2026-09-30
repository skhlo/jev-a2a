// The record: an append-only JSON-lines file. State is never stored; it is
// always the fold of the journal. One writer at a time, guarded by a lock
// directory for the duration of a CLI run.
import {
  appendFileSync,
  mkdirSync,
  readFileSync,
  rmSync,
  writeFileSync,
} from "node:fs";
import { join } from "node:path";

export type Entry = { at: string; event: Record<string, unknown> };

export type Journal = {
  readonly path: string;
  entries(): Entry[];
  append(event: Record<string, unknown>): void;
  release(): void;
};

export function openJournal(home: string): Journal {
  mkdirSync(home, { recursive: true });
  const path = join(home, "journal.jsonl");
  const lock = join(home, "journal.lock");
  acquire(lock);
  return {
    path,
    entries() {
      let text = "";
      try {
        text = readFileSync(path, "utf8");
      } catch (error: unknown) {
        if (!isCode(error, "ENOENT")) throw error;
      }
      return text
        .split("\n")
        .filter((line) => line.trim())
        .map((line) => parseEntry(line));
    },
    append(event) {
      appendFileSync(
        path,
        `${JSON.stringify({ at: new Date().toISOString(), event })}\n`,
      );
    },
    release() {
      rmSync(lock, { recursive: true, force: true });
    },
  };
}

// The lock names its owner so a run that died mid-way does not block the next
// one; a live owner does.
function acquire(lock: string): void {
  for (let attempt = 0; attempt < 2; attempt++) {
    try {
      mkdirSync(lock);
      writeFileSync(join(lock, "pid"), String(process.pid));
      return;
    } catch (error: unknown) {
      if (!isCode(error, "EEXIST")) throw error;
      const owner = lockOwner(lock);
      if (owner !== null && alive(owner))
        throw new Error(
          `Another router run (pid ${owner}) holds ${lock}. Wait for it.`,
        );
      rmSync(lock, { recursive: true, force: true });
    }
  }
  throw new Error(`Could not take ${lock}.`);
}

function lockOwner(lock: string): number | null {
  try {
    const pid = Number(readFileSync(join(lock, "pid"), "utf8"));
    return Number.isInteger(pid) && pid > 0 ? pid : null;
  } catch {
    return null;
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
    typeof (value as { event?: unknown }).event !== "object"
  )
    throw new Error(`Corrupt journal line: ${line}`);
  return value as Entry;
}

const isCode = (error: unknown, code: string): boolean =>
  error instanceof Error && (error as NodeJS.ErrnoException).code === code;
