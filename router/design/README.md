# The board and its design

The board page is the v0.11 console of a design kept in a separate,
private repository (`skhlo/designs`, tag `jev-a2a-v0.11`). These notes
record how the page is held to that design and where it departs from it on
purpose. They matter to whoever changes the page or the design; a user of
the board needs only [`docs/board.md`](../../docs/board.md).

## Files

- `v0.11-paths.txt`: every `data-path` the design's eight pages bind,
  distinct and sorted, as `src/design-paths.ts` extracts them.
- `v0.11-dropped.txt`: the paths the page does not render, each with its
  reason.
- `screenshots/board.png`, `screenshots/board-sheet.png`: the sample board,
  the second with orchestrator@mbp's sheet open. Drawn from
  `src/board.sample.json`, so they hold no live request text.
  `pnpm exec node src/board-shots.ts` in `router/` redraws them with a
  Chromium on `PATH`.

## The conformance test

Each element the design binds keeps the `data-path` the design gives it,
and rows and groups keep `data-task` and `data-group`, so the page can be
compared with the design mechanically. A test in `src/board-page.test.ts`
fails when a path in `v0.11-paths.txt` is neither rendered for the board
fixture nor named with a reason in `v0.11-dropped.txt`. It compares paths
with their indexes blanked (`open[].deliveries[].latest`), since the
design's sample is larger than the fixture. The header of
`src/design-paths.ts` says how to list the paths again from the design's
pages.

## Where the page differs from v0.11, on purpose

Each of these is a place where the design was wrong for live data:

- counted nouns agree with their number;
- each clock carries its full date as a tooltip;
- the needs-you count counts tasks the same way in the nav and in the
  group;
- blue follows the viewer: the design colours every question and its
  badge, whoever it waits on;
- a finished task's verdict names the reason and who ended it;
- the forms post the router's own fields (resolving takes evidence);
- a narrow screen gets one scrolling column, and its sheet takes the whole
  screen;
- a session id of any shape that is a UUID is shortened (the design
  shortens any id over twelve characters);
- a delivery that waits (queued, held, on a session not ready, behind an
  unconfirmed send, or on a replaced session) says what it waits for, where
  the design shows only the send's outcome;
- the "from <placement>" on an open row that another agent sent shows to
  every viewer, since a person is never a participant (the design spares
  the sender its own placement);
- every placement's sheet is rendered, hidden, so the script opens one
  without a round trip (the design renders the open one);
- `pr.mergeable` is read as Paseo's word (`CONFLICTING` shows "conflicts");
  the design's sample used a boolean;
- the Flexoki dark pin (`data-scheme`) is not carried, as the theme switch
  covers it.
