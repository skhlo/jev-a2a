// Process tables for the tests: rows by pid, the caller at pid 100.
import type { Processes } from "../src/caller.ts";

type Row = [ppid: number, start: number, argv: string];

export const table =
  (rows: Record<number, Row>, self = 100) =>
  (): Processes => ({
    self,
    look: (pid) => {
      const row = rows[pid];
      return row
        ? { ppid: row[0], start: row[1], argv: row[2] ? row[2].split(" ") : [] }
        : null;
    },
  });

// The caller (pid 100) under each command line in turn, nearest first; the
// last is a child of init.
export const under = (...lines: string[]) => {
  const rows: Record<number, Row> = { 1: [0, 0, "/sbin/init"] };
  const all = ["node router/src/cli.ts", ...lines];
  all.forEach((line, i) => {
    rows[100 - i] = [i === all.length - 1 ? 1 : 99 - i, 1000 - i, line];
  });
  return table(rows);
};

// The shared daemon's command line as mba runs it (path shortened).
export const MBA_DAEMON =
  "/Users/u/.codex/packages/app-server-daemon/releases/0.163.0-aarch64-apple-darwin/bin/codex app-server --listen unix:// --analytics-default-enabled --managed-daemon";

// A caller with no Codex above it: a shell in a Paseo terminal.
export const plain = under("bash -c router", "zsh", "Paseo.bin");
