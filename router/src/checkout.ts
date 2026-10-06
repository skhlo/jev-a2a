// The checkout this code runs from: its commit, which serve reports and a
// reply host compares with its own, so both sides run the same code; and
// its origin, which host setup clones.
import { execFileSync } from "node:child_process";

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

export const checkoutCommit = (
  dir: string = import.meta.dirname,
): string | null => git(["rev-parse", "HEAD"], dir);

export const checkoutOrigin = (
  dir: string = import.meta.dirname,
): string | null => git(["remote", "get-url", "origin"], dir);
