// The checkout this code runs from: its commit, which serve reports and a
// reply host compares with its own, so both sides run the same code; and
// its origin, which host setup clones.
import { execFileSync } from "node:child_process";
import { existsSync, readFileSync } from "node:fs";
import { dirname, join, resolve } from "node:path";

// What git says about the checkout at `dir`, or null outside one.
function git(args: string[], dir: string): string | null {
  try {
    return execFileSync("git", ["-C", dir, ...args], {
      encoding: "utf8",
      stdio: ["ignore", "pipe", "ignore"],
    }).trim();
  } catch {
    return null;
  }
}

// The commit HEAD names, read from git's files so a reply starts no git
// process: HEAD, and the loose ref it points at. Null when they do not say
// plainly (a worktree's .git file, a packed ref), and git is asked instead.
function headOf(dir: string): string | null {
  for (let at = resolve(dir); ; at = dirname(at)) {
    const dotGit = join(at, ".git");
    if (existsSync(dotGit))
      try {
        const head = readFileSync(join(dotGit, "HEAD"), "utf8").trim();
        const ref = /^ref: (refs\/\S+)$/.exec(head)?.[1];
        const commit = ref
          ? readFileSync(join(dotGit, ref), "utf8").trim()
          : head;
        return /^[0-9a-f]{40}$/.test(commit) ? commit : null;
      } catch {
        return null;
      }
    if (dirname(at) === at) return null;
  }
}

export const checkoutCommit = (
  dir: string = import.meta.dirname,
): string | null => headOf(dir) ?? git(["rev-parse", "HEAD"], dir);

export const checkoutOrigin = (
  dir: string = import.meta.dirname,
): string | null => git(["remote", "get-url", "origin"], dir);
