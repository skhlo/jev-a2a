// Writes board.sample.json: the board's view model built from the board
// fixture with its participant-sent task (`sampleJournal`) at its fixed
// time, as the fixture's operator login sees it. The sample is part of the
// published contract and is changed only by this script; a board test fails
// when the committed file differs from what the script writes. After
// changing the model or the fixture, run `pnpm exec node src/board-sample.ts`
// in router/ and commit the result.
import { writeFileSync } from "node:fs";
import { join } from "node:path";
import {
  type BoardModel,
  boardModel,
  boardState,
  identify,
  messageTimes,
} from "./board.ts";
import { config, NOW, sampleJournal } from "./board-fixture.ts";

export const SAMPLE_PATH = join(import.meta.dirname, "board.sample.json");

export function sampleModel(): BoardModel {
  const actor = identify(
    { "tailscale-user-login": "me@example.com" },
    config.serve.identities,
  );
  return boardModel(
    boardState(config, sampleJournal, NOW),
    config,
    NOW,
    messageTimes(sampleJournal),
    actor,
  );
}

export function boardSample(): string {
  return `${JSON.stringify(sampleModel(), null, 2)}\n`;
}

if (import.meta.main) writeFileSync(SAMPLE_PATH, boardSample());
