// --text and --text-file. The reply host's tests (remote.test.ts) run the
// rule as the process a participant runs.
import test from "node:test";
import assert from "node:assert/strict";
import { writeFileSync } from "node:fs";
import { join } from "node:path";
import { sharedScratch } from "./test-scratch.ts";
import { textOption } from "../src/text.ts";

const dir = sharedScratch("text-");
const file = join(dir, "reply.md");
const body =
  'Merged: skhlo/designs@abc\n\n- `jsx/card.jsx`\n- "quoted" $(not run)';
writeFileSync(file, `${body}\n`);

test("textOption: --text, --text-file, neither, both, unreadable", () => {
  assert.equal(textOption("hi", undefined), "hi");
  assert.equal(textOption(undefined, undefined), "");
  assert.equal(textOption(undefined, file), body);
  assert.throws(() => textOption("hi", file), /not both/);
  assert.throws(
    () => textOption(undefined, join(dir, "missing")),
    /--text-file: .*ENOENT/,
  );
});
