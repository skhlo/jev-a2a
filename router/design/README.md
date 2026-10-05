# The board and its design

The board page is the v0.13 console of a design kept in a separate,
private repository (`skhlo/designs`, tag `jev-a2a-v0.13`, commit
`4a0b0ab`). These notes record how the page is held to that design and
where it departs from it on purpose. They matter to whoever changes the
page or the design; a user of the board needs only
[`docs/board.md`](../../docs/board.md).

## Files

- `v0.13-paths.txt`: every `data-path` the design's fourteen pages bind,
  distinct and sorted, as `src/design-paths.ts` extracts them.
- `v0.13-dropped.txt`: the paths the page does not render, each with its
  reason. For v0.13 it lists none: the page renders every path for the
  board fixture and its usage states.
- `screenshots/board.png`, `screenshots/board-usage.png`,
  `screenshots/board-sheet.png`: the sample board with the rail's Usage
  section, the same page with the usage pop-up open, and with
  orchestrator@mbp's sheet open. Drawn from `src/board.sample.json`, so
  they hold no live request text and only made-up usage.
  `pnpm exec node src/board-shots.ts` in `router/` redraws them with a
  Chromium on `PATH`.

## The conformance test

Each element the design binds keeps the `data-path` the design gives it,
and rows and groups keep `data-task` and `data-group`, so the page can be
compared with the design mechanically. A test in `src/board-page.test.ts`
fails when a path in `v0.13-paths.txt` is neither rendered for the board
fixture nor named with a reason in `v0.13-dropped.txt`. It compares paths
with their indexes blanked (`open[].deliveries[].latest`), since the
design's sample is larger than the fixture. The header of
`src/design-paths.ts` says how to list the paths again from the design's
pages.

## Where the page differs from the design, on purpose

Each of these is a place where the design was wrong for live data, or
where the page must work without its script:

- counted nouns agree with their number;
- each clock carries its full date as a tooltip: the nav tick's tooltip
  dates the build and the telemetry to the second (the design gives the
  clocks alone, and a telemetry file can be a day old), the usage
  pop-up's freshness line dates its read, and the countdown or the verdict
  carries the deadline's date;
- the needs-you count counts tasks the same way in the nav and in the
  group;
- blue follows the viewer: the design colours every question and its
  badge, whoever it waits on;
- a finished task's verdict names the reason and who ended it, in the row
  and in the head after the count;
- the forms post the router's own fields (resolving takes evidence);
- a session id of any shape that is a UUID is shortened (the design
  shortens any id over twelve characters; it does apply that rule to a
  send's message id, and so does the page);
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
- the open router log is kept across refreshes on this device, like the
  collapsed groups, and without a script, which `r` needs, the log shows
  all its lines;
- a rail row is a link to the page with the pop-up drawn open (`?usage`)
  and the pop-up's close button a link back, where the design has buttons,
  so the pop-up opens and closes without a script (while it is open a row
  is a link back too); the script toggles it in place and drops `?usage`
  from the address. `usage/`, the old tab's
  address, redirects to the board with `?usage`;
- an account's details and a day table's older days are drawn open, so a
  page without a script shows them; the script shuts each one this device
  has not kept open (the design draws them shut, and its "all n days"
  removes itself rather than staying for the next refresh);
- a balance leads with one row per reported balance, in every currency the
  provider sends (the design's sample has one);
- the help's `u` row says "or click an account under the agents" only when
  the rail has rows: with API accounts alone there is no Usage section,
  and `u` still opens the pop-up. Without usage there is no `u`, no section
  and no pop-up;
- `esc` closes the help, then the usage, then the peek, then the sheet (the
  design's order leaves out the peek, which `esc` has always closed); in
  the pop-up `←` closes the focused account's details, or the pop-up when
  they are shut, and with the help open `←` closes the help first. `↑` `↓`
  move between the rows only from a row, a card or nothing in particular,
  so a focused button, a link in the sheet or a scrolling table keeps them,
  and `⇧` with an arrow or `↵` is the browser's;
- a link to a task (a row's id, a card's task, the peek's Open task, an
  Answer lever) opens the task in place, where the design's links
  navigate; the link alone still works. How an open keeps the history, and
  what it does when its fetch fails or hangs, is in
  [docs/board.md](../../docs/board.md#the-script);
- a task row's second line wraps rather than squeeze the text after the
  status below 8em, and the route (the sender, the recipients, a late
  warning) moves under it whole: the design's line squeezed that text to
  nothing from 901px to about 930px when a row named "no recipient", and to
  a few characters for a row with two recipients. A recipient too long for
  the line ends in an ellipsis, whole in its title, where the design's
  scrolled the task list sideways;
- a sheet's value row and an activity row wrap their parts, and a part
  wider than the row ends in an ellipsis, whole in its title: from 901px
  to about 1060px the design cut a long branch row mid-word and squeezed
  the remote and an activity's text to nothing;
- from 901px to 1180px the sheet is at least 320px wide and spills over
  the detail column, as it is an overlay: below about 1024px the tasks
  column is narrower than the sheet's head, which hid the close button and
  scrolled the sheet sideways;
- the narrow card (the status on its own line under the name) holds from
  1279px down, not 1180px, and the facts tables' heads may wrap: from
  1181px to 1279px the wide card overflowed the rail by up to 25px,
  cutting off its levers, and the six-column table the detail by up to
  10px;
- the screenshots are taken with reduced motion, so the sheet's slide and
  the pop-up's rise do not catch them half drawn.

## The script in a browser

The unit tests read the page's script as text. `src/board-check.ts` runs
it: it serves the sample on a loopback port as the fixture's operator,
drives a headless Chromium over the DevTools protocol, and checks:

- opening a task in place with refreshes racing its fetch, and the timed
  refreshes going on once it has landed;
- an open whose fetch fails (to another task, to the same task with a
  hash, and after Back to an entry with a hash) or hangs;
- Back and Forward after an open;
- the focus coming back from the usage pop-up after a refresh replaced
  its opener;
- the arrow and `esc` basics.

It is not part of `pnpm test`, and CI, which has no browser, does not run
it. Run it in `router/` after changing the script:

```sh
pnpm exec node src/board-check.ts
```

It needs `chromium` on `PATH` (or `$CHROMIUM`) and prints a line per
check. It exits 1 when a check fails, 2 when it cannot run, and 130 or 143
on `SIGINT` or `SIGTERM`. Whatever it writes, the browser's profile and
temporary files included, is in one directory under `$TMPDIR`, removed
when it ends.

## The design's own departures from its brief

The design PR (skhlo/designs, tag `jev-a2a-v0.13`) took three, and the page
follows each:

- the facts tables (Deliveries, Notices to a sender, and Jev) become
  records at 1180px and less, not 900px, as the six-column table spilled
  out of the detail column at 1024px;
- a delivery's send cell is three slots, `send.kind`, `send.messageId`
  (through `short()`) and `send.outcome`, which replace the `send` path of
  an open or finished delivery;
- `board-usage-states` is drawn at 1440×1160, as the pop-up with Codex's
  history open is about 990px tall.

## Page-side items of v0.13

The brief named three for the page rather than the design, done in this
port: the Usage tab's page (`src/usage-page.ts`) is gone, its readers,
store, `router usage`, configuration section and the model's `usage`
field kept; a task opens in place; and the server keeps the record's fold
between requests and folds onto it only the lines appended since (the
journal changes at least every `serve.poll`), so a request no longer
replays the whole record. The wake and the events endpoint read the same
kept record.

The generic parts the Usage tab added stay in `src/board-page.ts`, named
for what they are: `chip`, `meter` with its pace tick (which also draws the
cards' context meter and the rail's windows), `pairs`, `table` and
`disclosure`, with `pace` and `band`.

`pr.mergeable` is read as Paseo's word (`CONFLICTING` shows "conflicts"):
a deviation in v0.11, the design's own rule since v0.12.
