// Writes the README's screenshots of the board: the sample page as the
// fixture's operator sees it with T2 selected, the same page with
// orchestrator@mbp's health sheet open, and the Usage view with Codex's
// token activity open. The page is rendered by the same
// function the server uses, from the same sample the contract publishes,
// so the pictures hold no live request text and change only when the
// page or the fixture does. Run in router/ after such a change:
//
//   pnpm exec node src/board-shots.ts
//
// It needs a Chromium on PATH (`chromium`, or $CHROMIUM) and writes
// design/screenshots/board.png, board-sheet.png and usage.png at 1440×1000.
import { spawnSync } from "node:child_process";
import { mkdirSync, mkdtempSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { renderBoard } from "./board-page.ts";
import { sampleModel } from "./board-sample.ts";
import { renderUsage } from "./usage-page.ts";

export const SHOTS_DIR = join(
  import.meta.dirname,
  "..",
  "design",
  "screenshots",
);

// The sheet is opened by the script in a browser; a screenshot has no
// keyboard, so the page is written with that sheet already shown, and the
// Usage view with one disclosure open.
export function shots(): Record<string, string> {
  const model = sampleModel();
  const { usage } = model;
  if (!usage) throw new Error("The sample has no usage.");
  const page = renderBoard(model, { task: "T2" });
  return {
    board: page,
    "board-sheet": page.replace(
      'data-key="orchestrator@mbp" hidden>',
      'data-key="orchestrator@mbp">',
    ),
    usage: renderUsage({ ...model, usage }).replace(
      '<details class="disclosure" data-key="codex/Token activity"',
      '<details class="disclosure" open data-key="codex/Token activity"',
    ),
  };
}

if (import.meta.main) {
  const chromium = process.env.CHROMIUM ?? "chromium";
  const scratch = mkdtempSync(join(tmpdir(), "board-shots-"));
  mkdirSync(SHOTS_DIR, { recursive: true });
  try {
    for (const [name, html] of Object.entries(shots())) {
      const file = join(scratch, `${name}.html`);
      writeFileSync(file, html);
      const run = spawnSync(
        chromium,
        [
          "--headless=new",
          "--disable-gpu",
          "--no-sandbox",
          "--hide-scrollbars",
          "--window-size=1440,1000",
          // Lets the sheet's slide finish before the picture is taken.
          "--virtual-time-budget=2000",
          `--screenshot=${join(SHOTS_DIR, `${name}.png`)}`,
          `file://${file}`,
        ],
        { stdio: ["ignore", "ignore", "pipe"] },
      );
      if (run.status !== 0)
        throw new Error(
          `${chromium} failed on ${name}: ${run.stderr?.toString() ?? run.error?.message}`,
        );
      console.log(`wrote design/screenshots/${name}.png`);
    }
  } finally {
    rmSync(scratch, { recursive: true });
  }
}
