// Writes the README's screenshots of the board: the sample page as the
// fixture's operator sees it with T2 selected, the rail's Usage section
// under the agents; the same page with the usage pop-up open; and with
// orchestrator@mbp's health sheet open. The page is rendered by the same
// function the server uses, from the same sample the contract publishes,
// so the pictures hold no live request text and only made-up usage, and
// change only when the page or the fixture does. Run in router/ after such
// a change:
//
//   pnpm exec node src/board-shots.ts
//
// It needs a Chromium on PATH (`chromium`, or $CHROMIUM) and writes
// design/screenshots/board.png, board-usage.png and board-sheet.png at
// 1440×1000.
import { spawnSync } from "node:child_process";
import { mkdirSync, mkdtempSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { renderBoard } from "./board-page.ts";
import { sampleModel } from "./board-sample.ts";

export const SHOTS_DIR = join(
  import.meta.dirname,
  "..",
  "design",
  "screenshots",
);

// A screenshot has no keyboard: the pop-up is drawn open as a page without
// a script opens it (?usage), and the sheet, which the script opens, is
// written already shown.
export function shots(): Record<string, string> {
  const model = sampleModel();
  const page = renderBoard(model, { task: "T2" });
  return {
    board: page,
    "board-usage": renderBoard(model, { task: "T2", usage: true }),
    "board-sheet": page.replace(
      'data-key="orchestrator@mbp" hidden>',
      'data-key="orchestrator@mbp">',
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
          // Lets the sheet's slide and the pop-up's rise finish before the
          // picture is taken.
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
