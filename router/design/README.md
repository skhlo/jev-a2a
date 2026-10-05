# The board and its design

The board page is the v0.12 console of a design kept in a separate,
private repository (`skhlo/designs`, tag `jev-a2a-v0.12`, commit
`81ba68e`). These notes record how the page is held to that design and
where it departs from it on purpose. They matter to whoever changes the
page or the design; a user of the board needs only
[`docs/board.md`](../../docs/board.md).

## Files

- `v0.12-paths.txt`: every `data-path` the design's nine pages bind,
  distinct and sorted, as `src/design-paths.ts` extracts them.
- `v0.12-dropped.txt`: the paths the page does not render, each with its
  reason. For v0.12 it lists none: the page renders every path for the
  board fixture.
- `screenshots/board.png`, `screenshots/board-sheet.png`,
  `screenshots/usage.png`: the sample board, the second with
  orchestrator@mbp's sheet open, the third the Usage view with Codex's
  token activity open. Drawn from `src/board.sample.json`, so they hold
  no live request text and only made-up usage.
  `pnpm exec node src/board-shots.ts` in `router/` redraws them with a
  Chromium on `PATH`.

## The conformance test

Each element the design binds keeps the `data-path` the design gives it,
and rows and groups keep `data-task` and `data-group`, so the page can be
compared with the design mechanically. A test in `src/board-page.test.ts`
fails when a path in `v0.12-paths.txt` is neither rendered for the board
fixture nor named with a reason in `v0.12-dropped.txt`. It compares paths
with their indexes blanked (`open[].deliveries[].latest`), since the
design's sample is larger than the fixture. The header of
`src/design-paths.ts` says how to list the paths again from the design's
pages.

## Where the page differs from v0.12, on purpose

Each of these is a place where the design was wrong for live data:

- counted nouns agree with their number;
- each clock carries its full date as a tooltip: the nav tick's tooltip
  dates the build and the telemetry to the second (the design gives the
  clocks alone, and a telemetry file can be a day old), and the countdown
  or the verdict carries the deadline's date;
- the needs-you count counts tasks the same way in the nav and in the
  group;
- blue follows the viewer: the design colours every question and its
  badge, whoever it waits on;
- a finished task's verdict names the reason and who ended it, in the row
  and in the head after the count;
- the forms post the router's own fields (resolving takes evidence);
- a narrow screen gets one scrolling column, and its sheet takes the whole
  screen;
- a session id of any shape that is a UUID is shortened (the design
  shortens any id over twelve characters);
- a delivery that waits (queued, held, on a session not ready, behind an
  unconfirmed send, or on a replaced session) says what it waits for, where
  the design shows only the send's outcome;
- the `from <placement>` on an open row that another agent sent shows to
  every viewer, since a person is never a participant (the design spares
  the sender its own placement);
- every placement's sheet is rendered, hidden, so the script opens one
  without a round trip (the design renders the open one);
- the Flexoki dark pin (`data-scheme`) is not carried, as the theme switch
  covers it;
- "no reply" counts only a send the session accepted (one pending or
  attempting is a wait, which the card and the row already name), and it
  counts an answered question too: once the answer is the current send and
  nothing has come back since, the card already says "no reply yet" (the
  design's `stale` and `stale_task` count a send unreplied while the
  delivery has no update at all, whatever its outcome);
- the help's `⌘↩` row names `Ctrl ↩` too, which the script has always
  taken;
- the footer's `l` and `?` take a click, so a screen without a keyboard
  reaches the router log and the help with its theme switch (the v0.11 nav
  had the switch; the design's are keys alone), and the open log is kept
  across refreshes like the collapsed groups;
- without a script, which `l` needs, the router log shows all its lines.

## The design's own departures from its brief

The design PR (skhlo/designs, tag `jev-a2a-v0.12`) took three, and the page
follows each: busy has its own rank, between the work and the held cards;
a held placement whose session runs stays held; the tick's tooltip gives
the clocks to the second (the page adds their dates, above).

## Page-side items of v0.12

The design PR named three items for the page rather than the design. All
three were done on main before this port (PR #34): a refresh leaves alone
a panel or sheet holding a text selection; harness-internal tool rows are
left out of the activity tail; the router writes no log line for a clock
that ended nothing.

`pr.mergeable` is read as Paseo's word (`CONFLICTING` shows "conflicts"):
a deviation in v0.11, the design's own rule in v0.12.

## The Usage view, before a design

The Usage view (`src/usage-page.ts`) has no design yet: it is a first cut
from the design agent's first look (router T60), to be refined in v0.13.
It uses the board's tokens, themes, head, type and density, and what it
adds is built as generic parts, named for what they are so a later view
can reuse them: builders beside `chip` and `frame` in `src/board-page.ts`
(the meter with its pace tick, which also draws the board's context
meter, the pairs, the table, the disclosure, `pace` and `band`) and their
CSS (the bento pair, the head chip in a band, the ledger with its entries:
lead, name, figure, wide meter, note, when, rest). The tabs are one list
(`VIEWS`), and a panel the script swaps on refresh carries `data-part`.
Its slots carry `data-path`s into the model's `usage`, with `pace()` and
`max()` added to the formats; no conformance list holds them until the
design binds them.
