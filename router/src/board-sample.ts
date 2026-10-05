// Writes board.sample.json: the board's view model built from the board
// fixture with its participant-sent task (`sampleJournal`), its telemetry
// and its usage at its fixed time, as the fixture's operator login sees
// it. The sample is part of the published contract and is changed only by
// this script; a board test fails when the committed file differs from what
// the script writes. After changing the model or the fixture, run
// `pnpm exec node src/board-sample.ts` in router/ and commit the result.
// `sampleModelAt` gives the same sample part way through its record, for
// the README's recording (`board-shots.ts`).
import { writeFileSync } from "node:fs";
import { join } from "node:path";
import {
  type BoardModel,
  boardModel,
  boardState,
  identify,
  messageTimes,
} from "./board.ts";
import {
  config,
  NOW,
  sampleJournal,
  telemetry,
  usage,
} from "./board-fixture.ts";

export const SAMPLE_PATH = join(import.meta.dirname, "board.sample.json");

export function sampleModel(): BoardModel {
  return sampleModelAt(sampleJournal.length);
}

// The sample as it stood after its first `end` entries, at the last one's
// time. The telemetry and the usage are snapshots taken near the sample's
// end, so each shows only once that time has reached it.
export function sampleModelAt(end: number): BoardModel {
  const entries = sampleJournal.slice(0, end);
  const now =
    end >= sampleJournal.length ? NOW : Date.parse(entries.at(-1)?.at ?? "");
  const actor = identify(
    { "tailscale-user-login": "me@example.com" },
    config.serve.identities,
  );
  return boardModel(
    boardState(config, entries, now),
    config,
    now,
    messageTimes(entries),
    actor,
    Date.parse(telemetry.at) <= now ? telemetry : null,
    usage.at === null || usage.at <= now ? usage : null,
  );
}

export function boardSample(): string {
  return `${JSON.stringify(sampleModel(), null, 2)}\n`;
}

if (import.meta.main) writeFileSync(SAMPLE_PATH, boardSample());
