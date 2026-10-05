// Scratch directories for the tests, under the system's temporary one,
// removed when the test that made one ends, or, for one a whole file
// shares, when the file's tests have run. No test leaves one behind.
import { after, type TestContext } from "node:test";
import { mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";

const made = (prefix: string): string => mkdtempSync(join(tmpdir(), prefix));
const removing = (dir: string) => (): void =>
  rmSync(dir, { recursive: true, force: true });

// One test's directory.
export function scratch(t: TestContext, prefix: string): string {
  const dir = made(prefix);
  t.after(removing(dir));
  return dir;
}

// A directory every test in a file shares.
export function sharedScratch(prefix: string): string {
  const dir = made(prefix);
  after(removing(dir));
  return dir;
}
