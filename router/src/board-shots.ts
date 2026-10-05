// Writes the pictures of the board in the README and docs/board.md: the
// sample page as the
// fixture's operator sees it with T2 selected, the rail's Usage section
// under the agents; the same page with the usage pop-up open; with
// orchestrator@mbp's health sheet open; and a recording of the sample's
// record replayed one run at a time. The pages are rendered by the same
// function the server uses, from the same sample the contract publishes,
// so the pictures hold no live request text and only made-up usage, and
// change only when the page or the fixture does. Run in router/ after such
// a change:
//
//   pnpm exec node src/board-shots.ts
//
// It needs a Chromium on PATH (`chromium`, or $CHROMIUM) and ffmpeg
// (`ffmpeg`, or $FFMPEG), and writes design/screenshots/board.png,
// board-usage.png and board-sheet.png at 1440×1000, and board.gif.
import { spawnSync } from "node:child_process";
import { mkdirSync, mkdtempSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { sampleJournal } from "./board-fixture.ts";
import { renderBoard } from "./board-page.ts";
import { sampleModel, sampleModelAt } from "./board-sample.ts";

const SHOTS_DIR = join(import.meta.dirname, "..", "design", "screenshots");

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

export type Frame = { html: string; task: string | null; seconds: number };

// The recording: a frame of the board after each run of the sample's
// record (a `tick` starts one), with a task open: the newest when the run
// took a request, else the last one the run named, else the one open
// before. The last frame is the whole sample, held longer.
export function recording(): Frame[] {
  const ends = [
    ...sampleJournal.flatMap((entry, i) =>
      i > 0 && entry.event.type === "tick" ? [i] : [],
    ),
    sampleJournal.length,
  ];
  let task: string | null = null;
  return ends.map((end, i) => {
    const run = sampleJournal
      .slice(ends[i - 1] ?? 0, end)
      .map((entry) => entry.event);
    const model = sampleModelAt(end);
    const newest = [...model.open, ...model.finished]
      .map((t) => t.id)
      .sort((a, b) => Number(b.slice(1)) - Number(a.slice(1)))[0];
    const named = run.flatMap((event) =>
      typeof event.taskId === "string" ? [event.taskId] : [],
    );
    task = run.some((event) => event.type === "submit")
      ? (newest ?? task)
      : (named.at(-1) ?? task);
    const html = renderBoard(model, task ? { task } : {});
    return { html, task, seconds: end === sampleJournal.length ? 4 : 1.5 };
  });
}

// Runs a tool that writes `out`, and fails with what it said if it fails.
function run(tool: string, args: string[], out: string) {
  const ran = spawnSync(tool, args, { stdio: ["ignore", "ignore", "pipe"] });
  if (ran.status !== 0)
    throw new Error(
      `${tool} failed on ${out}: ${ran.stderr?.toString() ?? ran.error?.message}`,
    );
}

// Chromium's picture of a page, at the size the pictures share.
function draw(chromium: string, html: string, scratch: string, png: string) {
  const file = join(scratch, "page.html");
  writeFileSync(file, html);
  run(
    chromium,
    [
      "--headless=new",
      "--disable-gpu",
      "--no-sandbox",
      "--hide-scrollbars",
      "--window-size=1440,1000",
      // The page's reduced-motion rule draws the sheet and the pop-up in
      // place, without their slide and rise, which a picture taken in
      // virtual time would catch at their start; the budget lets the
      // script place the pop-up first.
      "--force-prefers-reduced-motion",
      "--virtual-time-budget=2000",
      `--screenshot=${png}`,
      `file://${file}`,
    ],
    png,
  );
}

if (import.meta.main) {
  const chromium = process.env.CHROMIUM ?? "chromium";
  const ffmpeg = process.env.FFMPEG ?? "ffmpeg";
  const scratch = mkdtempSync(join(tmpdir(), "board-shots-"));
  mkdirSync(SHOTS_DIR, { recursive: true });
  try {
    for (const [name, html] of Object.entries(shots())) {
      draw(chromium, html, scratch, join(SHOTS_DIR, `${name}.png`));
      console.log(`wrote design/screenshots/${name}.png`);
    }
    // ffmpeg's concat list holds each frame's time but drops the last
    // one's, which the GIF's final delay gives back, in centiseconds.
    const frames = recording();
    const list = frames.flatMap(({ html, seconds }, i) => {
      const png = join(scratch, `frame-${String(i).padStart(2, "0")}.png`);
      draw(chromium, html, scratch, png);
      return [`file '${png}'`, `duration ${seconds}`];
    });
    const finalDelay = Math.round((frames.at(-1)?.seconds ?? 0) * 100);
    writeFileSync(join(scratch, "frames.txt"), `${list.join("\n")}\n`);
    const gif = join(SHOTS_DIR, "board.gif");
    run(
      ffmpeg,
      [
        "-y",
        "-loglevel",
        "error",
        "-f",
        "concat",
        "-safe",
        "0",
        "-i",
        join(scratch, "frames.txt"),
        // One palette for the whole recording, and only the changed
        // rectangle of each frame stored, which keeps a mostly still page
        // small.
        "-vf",
        "split[a][b];[a]palettegen=stats_mode=diff[p];[b][p]paletteuse=dither=none:diff_mode=rectangle",
        "-final_delay",
        String(finalDelay),
        "-loop",
        "0",
        gif,
      ],
      gif,
    );
    console.log(`wrote design/screenshots/board.gif (${frames.length} frames)`);
  } finally {
    rmSync(scratch, { recursive: true });
  }
}
