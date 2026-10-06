// The checkout's commit: from git's files when they say it plainly, which
// costs a reply no git process, and from git when they do not.
import test from "node:test";
import assert from "node:assert/strict";
import { execFileSync } from "node:child_process";
import { existsSync, mkdirSync, writeFileSync } from "node:fs";
import { join } from "node:path";
import { scratch } from "./test-scratch.ts";
import { checkoutCommit } from "../src/checkout.ts";

test("checkout: a branch's loose ref and a detached HEAD are read without git; a packed ref asks git", (t) => {
  const dir = scratch(t, "checkout-");
  const git = (...args: string[]): string =>
    execFileSync(
      "git",
      [
        "-C",
        dir,
        "-c",
        "user.name=t",
        "-c",
        "user.email=t@example.com",
        ...args,
      ],
      { encoding: "utf8" },
    ).trim();
  assert.equal(checkoutCommit(dir), null);
  git("init", "-q", "-b", "main");
  mkdirSync(join(dir, "router"));
  writeFileSync(join(dir, "router", "f"), "x\n");
  git("add", "-A");
  git("commit", "-q", "-m", "one");
  const one = git("rev-parse", "HEAD");
  // Without git on PATH: what the files say is all there is.
  const withoutGit = (): string | null => {
    const path = process.env.PATH;
    process.env.PATH = "";
    try {
      return checkoutCommit(join(dir, "router"));
    } finally {
      process.env.PATH = path;
    }
  };
  assert.equal(withoutGit(), one);
  git("checkout", "-q", "--detach", one);
  assert.equal(withoutGit(), one);
  git("checkout", "-q", "main");
  git("pack-refs", "--all");
  assert.ok(!existsSync(join(dir, ".git", "refs", "heads", "main")));
  assert.equal(withoutGit(), null);
  assert.equal(checkoutCommit(join(dir, "router")), one);
});
