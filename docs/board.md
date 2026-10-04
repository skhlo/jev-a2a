# The board

`router serve` serves the board on `serve.board` (`127.0.0.1:7678` by
default). It reads the same record as the CLI and is drawn on the server
from the [view model](board-model.md), in three columns. The pictures are
the sample board (`router/src/board.sample.json`, no live request text), the
second with one agent's sheet open.

![The board: agents, tasks and the selected task's detail](../router/design/screenshots/board.png)

![The health sheet of one agent over the tasks column](../router/design/screenshots/board-sheet.png)

## Agents

A card per placement the router serves, saying what its session is doing
(asks on a task, with the question; works on one, including after a
question was answered, with the answer's time; delivered and not yet
replied; a send still attempting, unknown or pending; held; ready; not
ready) and when it last updated. Cards come in that order, asking first; a
card with no open delivery collapses to its name and state.

Each card closes with the session's health from the router's telemetry: a
pending permission by name, or the status with the turn's age (running) or
the last turn's end (idle), with `error`, `missing` and `unreachable`
dotted and the reason as a tooltip, and a dotted "error" added when the
session's attention is an error under another status; the snapshot's age;
the lever that holds or releases the session. A context meter sits in the
name row (the health row on an idle card) with the token counts and cost as
its tooltip; on a busy card provider/model, thinking and mode join the tags;
while subagents run, the status line counts them. Without a snapshot the
row reads "no telemetry"; without a telemetry file at all the nav tick,
which otherwise dates the telemetry, says so too. The router's last twenty
log lines fill the rest of the column, newest at the bottom.

## The sheet

A card's name, or `s` on the focused card, opens the placement's health
over the tasks column, the detail left whole. Its head repeats the card's
dot, name, meter, status line with the seen age and levers, then the tags
with the host and session. Three sections follow:

- **Checkout**, a key-value grid: project; workspace with its kind;
  directory; branch with the remote, "dirty" and "ahead n · behind n" when
  either is non-zero; the diff as `+a −d` or "no diff"; the pull request as
  "#n title" linked to its URL (when it is a web address) with its state
  word (draft, merged, else the state) and "conflicts" when Paseo reports
  `CONFLICTING`, then checks (failing, pending, passing, no checks, or
  unknown) and the review word; the workspace status with `active <age>`.
- **Subagents**: the non-zero counts, then the running ones as a tree one
  level deep (a child under its parent; a child whose parent is not running
  sits at the top); "none running" with counts alone, "none" with neither.
- **Activity**: the last eight timeline entries oldest first, each with its
  clock (hh:mm:ss), kind word, tool and status, and text, the last one
  marked current when it is a running tool; the heading counts the turns
  among them.

A field the router did not read says "not read"; subagents and activity add
"session not live" when the session is not idle or running. Every
placement's sheet is in the page, hidden; `esc` or its close button closes
it, a refresh keeps it open by key, and a lever pressed in it brings it back
with the page.

## Tasks and the selected task

Tasks come in three groups. **Needs you** holds the tasks that wait on one
of your principals, a finished task too when an operator must resolve its
send; **In flight** holds the other open tasks, and **Done** the last
finished ones. A row says what its task waits for: the open question, the
recipient Jev was unsure of, the delivery it is queued behind or the session
it is held on, a send not yet accepted, a delivery that has no reply yet,
the answer it was just given, or who canceled it.

The selected task shows how its recipient was chosen and, for a task
another agent sent, the placement it came from; its deadline with a
countdown while it is open; the form that clears what waits on you; the
exchange in time order; and its deliveries, the notices its sender was
told, Jev's judgments and log.

Blue marks what needs you and nothing else: a question already answered, or
one that waits on another principal, is not blue. The selected task is in
the URL (`?task=T2`), so a reload or a shared link opens it; without one the
page opens the first task that needs you, else the newest open one, else
the newest finished one.

## Identity and actions

The board listens on loopback only, and a browser that opens it directly
gets a read-only page: every principal's waiting items, and no forms. Put
it behind Tailscale Serve to reach it from another device and to act: the
board takes the tailnet login Serve reports, and a login listed in
`serve.identities` acts as its principals (`/whoami` shows the login).

- A requester answers, chooses a recipient and cancels. Cancel shows on
  each of your open tasks; the router refuses one whose work may have
  reached a participant, and the outcome says so.
- An operator resolves a delivery the router cannot confirm. The form
  offers only the outcomes the router accepts: a send the session accepted
  can only be marked finished, and the form says so.
- Any identified login holds or releases a session. A hold says a person is
  typing in the session, so the router does not send there.

Each form posts to the board's `actions` endpoint and comes back to the page
with the outcome. `serve.board` must stay on loopback; the README's Limits
say why.

## The script

The page reads and acts without a script. Its script adds:

- a refresh every ten seconds while the tab is visible: the page fetches
  itself for the selected task and swaps the nav counts and tick, the three
  columns and the sheets. It keeps the selected task, the collapsed groups
  (in `localStorage`), typed drafts (in `sessionStorage`, by their form's
  `data-path`), the open peek, the open sheet (its element, scroll and all)
  and the filter, and it leaves alone a column you are typing in or a sheet
  holding the focus;
- the palettes: Flexoki, light or dark with the system, and One Dark. The
  choice is kept in `localStorage` and in a `router-theme` cookie, so the
  server paints it before the script runs;
- the keys. `?` lists them on the page; in short, `j`/`k` move between task
  rows, space opens the peek (the row's open question with a reply box),
  `↵` opens the task or sends the peek's reply, `s` opens the sheet, `h`
  holds or releases, `a` goes to the answer box, `c` cancels, `/` filters,
  `esc` closes, and `⌘↩` or `Ctrl ↩` sends the form you are typing in.

## Open items

- A post does not name its principal, so a login that holds two principals
  in one role acts as the first one `serve.identities` lists, and the
  other's items show without a form.
- A draft is keyed by its form's `data-path`, which shifts when an earlier
  item goes, and such a draft stays in storage instead of filling the moved
  form.
- The script's behaviour has no test in CI.

How the page is held to its design, and where it departs from it on
purpose, is in [`router/design/README.md`](../router/design/README.md).
