# Jev router

A small router for sending work between coding agents that run in
[Paseo](https://paseo.sh) sessions on several machines.

Agent-to-agent messaging is prompt sending. The router sends the same prompt a
person would type into an agent's session, and adds the two things that person
would otherwise carry in their head:

- **An envelope.** A task ID, the command the agent runs to reply, a key so
  nothing runs twice, and a check that the session is idle so nothing already
  running is interrupted.
- **A record.** One journal of what was sent to which session, what came back,
  and what is still waiting on someone.

When a request names no recipient, Jev (a TypeSafe System One model) reads each
participant's responsibility text and picks one. If no owner is clear or the
probability is under the threshold, the router hands the choice back to the
sender instead of guessing.

The router does not orchestrate, run workflows, or hold a session until a task
finishes. How the work gets done belongs to the agents.

This is a personal prototype, built for one person's machines. It is public as
a worked example, not as a product.

## How a request travels

```sh
router submit "Is this machine current with merged main of the dotfiles baseline?"
```

1. The router records the request as a task.
2. Jev chooses a participant among those the sender may address.
3. The router sends the prompt to that participant's session on each of its
   hosts, if the session is idle. A busy session gets it the next time the
   router looks and finds it idle: when it handles something (a request, a
   reply, an answer, or `router run`), and, while anything waits only for a
   session to come free, every `serve.wake` seconds (default 20); `serve`
   watches the journal, so a request made with the CLI on the router host
   counts too. An idle router runs nothing on a schedule.
4. The agent does the work and replies with the command from the envelope:
   `router reply --task T27 --in-reply-to <message> --kind completed --text "..."`.
5. `router status T27` shows the result: here, `2 of 2 completed`, one reply
   per host.

Use `--to <participant>` to skip Jev. With `--to`, `--hosts a,b` narrows a
participant that runs on several hosts.

## Commands

| Command                                                         | What it does                                                   |
| --------------------------------------------------------------- | -------------------------------------------------------------- |
| `router submit [--to P [--hosts a,b]] <text>`                   | Record a request and deliver it                                |
| `router status [<task>]`                                        | Show the record                                                |
| `router needs-you`                                              | List decisions waiting on a person                             |
| `router choose --task T --to P`                                 | Name the recipient when the router handed the choice back      |
| `router answer --task T --question Q [--delivery D] --text ...` | Answer a question an agent asked                               |
| `router reply --task T --in-reply-to M --kind ...`              | An agent's reply: `working`, `question`, `completed`, `failed` |
| `router run`                                                    | Observe the sessions and deliver what is eligible              |
| `router serve`                                                  | Accept events from other hosts over HTTP; serve the board      |
| `router eval`                                                   | Judge a labeled request set with the configured texts          |
| `router cancel <task>`                                          | Cancel a task                                                  |

`reply`, `answer` and `submit` also take `--text-file <path>` in place of
`--text`, for text that a shell cannot quote in one argument. `router` with
no arguments prints the full usage.

### A participant as the sender

An agent's session may submit work too, with the same `submit`, `choose` and
`answer` commands, as far as `permissions` lets its participant address
others. On another host the client acts as the session `$PASEO_AGENT_ID`;
on the router host the CLI acts as a person unless told `--as <session>`,
since an agent there also submits on a person's behalf. The
router then tells the sender what a person would read on the board, at the
placement it sent from and only when that session is idle, like any
delivery: the recipient's question, with the `answer` command that settles
it; the choice when Jev handed the request back, with the `choose` command;
and the final word, which needs no reply. Each is told once per key, through
the same adapter and with the same record of attempting, accepted and
unknown, so a restart or a dropped call is retried under the same rules as
a send. `router status T` lists them, and the board's task detail shows
them under "Notices to".

```sh
# As the design agent on mba:
router submit --to orchestrator "The board's log panel clips its last line at 1280 wide."
# The design agent's session hears back, for example:
# [router T41 question/D7/R2] orchestrator asks about your request. Answer with:
#   router answer --as <session> --task T41 --delivery D7 --question R2 --text "<answer>" ...
```

## The board

`router serve` also serves a page, the board, on `127.0.0.1:7678` by default
(`serve.board`). It reads the same record as the CLI. The page is the v0.10
console of the board design (`skhlo/designs`, tag `jev-a2a-v0.10`), drawn on
the server from the view model below, in three columns:

- **Agents**: a card per placement the router serves, saying what its
  session is doing (asks on a task, with the question; works on one,
  including after a question was answered, with the answer's time;
  delivered and not yet replied; a send still attempting, unknown or
  pending; held; ready; not ready) and when it last updated. Cards come in
  that order, asking first; a card with no open delivery collapses to its
  name and state. Each card closes with the session's health from the
  router's telemetry: a pending permission by name, or the status with the
  turn's age (running) or the last turn's end (idle), with `error`,
  `missing` and `unreachable` dotted and the reason as a tooltip, and a
  dotted "error" added when the session's attention is an error under
  another status; the snapshot's age; the lever. A context meter sits in
  the name row (the health row on an idle card) with the token counts and
  cost as its tooltip, and on a busy card provider/model, thinking and mode
  join the tags. Without a snapshot the row reads "no telemetry", and the
  nav tick, which otherwise dates the telemetry, says so too. The router's
  last twenty log lines fill the rest of the column, newest at the bottom.
- **Tasks**, in three groups. Needs you holds the tasks that wait on one of
  your principals, a finished task too when an operator must resolve its
  send; In flight holds the other open tasks, and Done the last finished
  ones. A row says what its task waits for: the open question, the recipient
  Jev was unsure of, the delivery it is queued behind or the session it is
  held on, a send not yet accepted, a delivery that has no reply yet, the
  answer it was just given, or who canceled it.
- **The selected task**: how its recipient was chosen and, for a task
  another agent sent, the placement it came from, its deadline with a
  countdown while it is open, the form that clears what waits on you, the
  exchange in time order, and its deliveries, the notices its sender was
  told, Jev's judgments and log.

Blue marks what needs you and nothing else: a question already answered, or
one that waits on another principal, is not blue. The selected task is in
the URL (`?task=T2`), so a reload or a shared link opens it; without one the
page opens the first task that needs you, else the newest open one, else the
newest finished one.

The board listens on loopback only, and a browser that opens it directly gets
a read-only page: every principal's waiting items, and no forms. Put it
behind Tailscale Serve to reach it from another device and to act: the board
takes the tailnet login Serve reports, and a login listed in
`serve.identities` acts as its principals. A requester answers, chooses a
recipient and cancels; an operator resolves a delivery the router cannot
confirm (the form offers only the outcomes the router accepts: a send the
session accepted can only be marked finished, and the form says so); any
identified login holds or releases a session (a hold says a person is
typing in the session, so the router does not send there). Each form posts
to the board's `actions` endpoint and comes back to the page with the
outcome.
Cancel shows on each of your open tasks; the router refuses one whose work
may have reached a participant, and the outcome says so.

The page reads and acts without a script. Its script adds:

- a refresh every ten seconds: the page fetches itself for the selected task
  and swaps the nav counts and the three columns. It keeps the selected
  task, the collapsed groups (in `localStorage`), typed drafts (in
  `sessionStorage`, by their form's `data-path`), the open peek and the
  filter, and it leaves alone a column you are typing in.
- the palettes: Flexoki, light or dark with the system, and One Dark. The
  choice is kept in `localStorage` and in a `router-theme` cookie, so the
  server paints it before the script runs.
- the keys the footer names: `j` and `k` move between task rows; space opens
  the peek, the row's open question with a reply box beside the row; `↵`
  opens the task, or in the peek sends the reply (`⇧↵` breaks the line); `→`
  opens the peeked task; `a` goes to the answer box; `c` cancels the
  selected task; `h` holds or releases the focused agent, or the selected
  task's; `/` filters the rows by text, id, recipient or state; `?` lists
  the keys; `esc` closes; `⌘↩` or `Ctrl ↩` sends the form you are typing
  in.

Each element the design binds keeps the `data-path` the design gives it, and
rows and groups keep `data-task` and `data-group`, so the page can be
compared with the design mechanically. `router/design/v0.10-paths.txt` lists
the design's paths, as `router/src/design-paths.ts` extracts them, and a test
fails when one is neither rendered for the board fixture nor named with a
reason in `router/design/v0.10-dropped.txt`. The test compares paths with
their indexes blanked (`open[].deliveries[].latest`), since the design's
sample is larger than the fixture.

The page differs from v0.10 on purpose where the design was wrong for live
data: counted nouns agree with their number, each clock carries its full
date as a tooltip, the needs-you count counts tasks the same way in the nav
and in the group, blue follows the viewer (the design colours every question
and its badge, whoever it waits on), a finished task's verdict names the
reason and who ended it, the forms post the router's own fields (resolving
takes evidence), a narrow screen gets one scrolling column, a session id of
any shape that is a UUID is shortened (the design shortens any id over
twelve characters), a delivery that waits (queued, held, on a session not
ready, behind an unconfirmed send, or on a replaced session) says what it
waits for where the design shows only the send's outcome, and the "from
<placement>" on an open row that another agent sent shows to every viewer,
since a person is never a participant (the design spares the sender its own
placement). What remains open: the design's health sheet, whose fields the
router does not collect yet (see the telemetry note below); a post does not
name its principal, so a login that holds two principals in one role acts as
the first one `serve.identities` lists, and the other's items show without a
form; a draft is keyed by its form's `data-path`, which shifts when an
earlier item goes, and such a draft stays in storage instead of filling the
moved form; and the script's behaviour has no test in CI.

### The board's view model

The page is one rendering of a view model, and the model is published so
that a design can bind its template to the router's own field names. The
board returns it as JSON to a client that asks for JSON: one whose Accept
header ranks `application/json` above `text/html`, or ranks them equal and
names JSON more exactly (`application/json, */*`). A browser gets the page.

```sh
curl -H 'Accept: application/json' http://127.0.0.1:7678/
```

`board.json` on the same address returns the same model. The JSON follows the
page's identity rules: through Tailscale Serve it names the viewer, and
without a known login it has no actor.

The contract is the `BoardModel` type in `router/src/board.ts`, the sample
in `router/src/board.sample.json`, and this section. The sample is the model
built from the board's test fixture (`router/src/board-fixture.ts`,
`sampleJournal`: the fixture plus one participant-sent task), so it holds no
live request text. After changing the model or the fixture, run
`pnpm exec node src/board-sample.ts` in `router/`; a test fails until the
committed sample matches.

- `version`: the contract and its major version, `jev-router-board/1`.
  Removing or renaming a field raises it; adding one does not.
- `at`: when the model was built. Every time in the model is an ISO string.
- `actor`: the viewer's `login`, and its `principals`, each a `principal`
  with its `role`. `null` when the request is not identified.
- `needsYou`: for each principal, its `role` and the `items` that wait on
  it. Each item has a `kind` and the `taskId` it belongs to:
  - `choose`: the task needs a recipient. `reason` is `no_owner`,
    `low_confidence`, `invalid_judgment` or `routing_unavailable`, and
    `suggestions` lists the participants in Jev's order.
  - `answer`: an agent asks the sender. `deliveryId`, `questionId` and the
    question's `text`.
  - `resolve`, for an operator: the router cannot confirm a send.
    `deliveryId`, the send's `messageId`, and `reason`: `task_ended`,
    `session_replaced` or `unknown_send`. The sample has none.
- `placements`: each placement the router serves, with its `key`
  (`participant@host`), `participant`, `host`, `session`, `ready` and
  `hold`, and `delivery`: the newest open delivery pinned to the current
  session, or `null`. A delivery carries its `id`, `taskId`, an `excerpt`
  of the task text, the `messageId` and `outcome` of its current send (the
  request, or the latest answer once one was sent; a delivery is pinned at
  the attempt, so the outcome may still be `attempting`), the `question`
  the session waits on with its `id`, `text` and `at` (`null` while no
  question is open: answered, or never asked), and the `latest` update's
  `kind` and `at`.
  - `agent`: what the router last saw of the session beyond its readiness,
    from the telemetry file (below), or `null` when the file has no entry
    for the placement: `seen` (when), `status` (Paseo's `idle`, `running`,
    `initializing`, `error` or `closed` (a persisted session whose process
    is not running; a send resumes it, so it counts as ready), or the
    router's `missing` when the
    daemon does not know the agent and `unreachable` when the host could
    not be reached, with the failure in `error`), `attention` (`finished`,
    `error` or `permission`) with `attentionAt` (when it was raised: for
    `finished`, when the last turn ended), `turnStartedAt` (the current
    turn's start)
    and `lastUserMessageAt`, `permissions` pending (each with `id`, `name`,
    `title` and `kind`; empty when none), `provider`, `model`, `thinking`
    and `mode`, `context` (`used` and `max` tokens, `max` above zero),
    `usage` (`input`, `cached` and `output` tokens, `costUsd`), the last
    `error`, the agent's `title` and `cwd`. Every field but `seen`,
    `status` and `permissions` is `null` when the daemon reported nothing
    for it (a token count the daemon left out of a reported usage is 0);
    `missing` and `unreachable` snapshots carry only `seen`, `status` and,
    for the latter, `error`.
- `open` and `finished`: tasks, newest first; `finished` keeps the last ten.
  Each has `id`, `status`, `a2a`, `source`, `messageId`, `recipient`,
  `chosenBy` (`address`, `judgment`, `sender` or `null`), `text`,
  `deadline`, and:
  - `routing`: while the router is finding a recipient, its `state`
    (`judging` or `needs_recipient`), `suggestions` and `reason`; otherwise
    `null`.
  - `judgments`: each with its `choice`, the full `probabilities` table
    (`null` when the judgment was not `valid`), the `model` version, whether
    it was `valid`, and the `threshold` it was held to.
  - `final`: `null` while the task is open; then its `status`, `reason`,
    `completed` of `of` deliveries, and `by`: the principal who canceled
    it (only the sender may cancel), or `null` when the router ended it.
  - `deliveries`: each with its `id`, `placement`, `session`, the current
    `send` (`kind`, `messageId`, `outcome`), every send in `sends` (with
    its `text`), the open `question` (`id`, `text`) or `null`, the agent's
    `updates` and the `latest` one (`messageId`, `inReplyTo`, `kind`,
    `text`), `end`: `null` while open, then its `reason` and, when
    recorded, `text`, `messageId` and `by` (the session that replied, or
    the operator who resolved it), and `waits`: why the send has not gone
    out, or `null` when nothing holds it back (it has gone, it ended, or
    it goes on the router's next run). `reason` is `session_replaced`,
    `in_flight` (another send to the placement, or a notice to its
    session, is unconfirmed), `held`,
    `not_ready` or `queued_behind`; for `queued_behind`, `behind` is the
    id of the delivery at the head of the placement's queue, the one that
    goes next, and otherwise `null`.
  - `via`: the placement a participant sender submitted from, where it is
    told about its request; `null` for a person's request.
  - `notices`: what that sender is owed or was told, each with its `key`
    (`question/<delivery>/<id>`, `choose/<n>` or `final`), `kind`, the
    `session` it went to (`null` before an attempt) and its `outcome`
    (`pending`, `attempting`, `accepted`, `unknown` or `withdrawn`). Empty
    for a person's request. The sample's T5, in `finished`, is one the
    orchestrator's session sent, with a withdrawn choice, an accepted
    question and a pending end.
  - `log`: the task's own log lines, as `router status <task>` shows them.
- `times`: when each message was recorded, by message ID.
- `log`: the router's last twenty log lines, each with its number `n`, its
  `actor` and its `text`.
- `telemetryAt`: when the placements' snapshots were taken, or `null`
  without telemetry.

Telemetry is not part of the record: an observation is journaled only when
readiness or the session changes, and a snapshot changes every run. After
each run's observations the shell writes `telemetry.json` beside the
journal, whole, by rename (`jev-router-telemetry/1`: `at` and one snapshot
per served placement, from the same Paseo call that reads readiness,
stamped with the run's clock). A write that fails is a line in the run's
report, and the run goes on to its sends. The board reads the file without
a lock and shows each snapshot with its age (the nav tick dates the file);
`router status` prints one line per placement with the time. A missing or unreadable file is no
telemetry, logged once by serve, never a fault; a damaged entry drops its
placement, named in the log. Not held yet: the subagent tree, the session's
last activity, turn and tool counts and the worktree, which need other
daemon calls per run.

## Participants and responsibility texts

A participant is an agent or a service with a stable ID, one or more hosts, and a
responsibility text: an ownership rule, what it is not for, and a few example
requests. The text is all Jev sees, so it decides the routing. Each
participant's owner keeps the text next to that agent's own `AGENTS.md`; the
router's config copies it.

Before a text or the threshold changes, `router eval` judges a labeled set of
requests (`router/eval/requests.jsonl`) and prints how many would be
dispatched, how many of those wrongly, and how many handed back. Nothing
enforces it, but the rule is: a change goes live only with no wrong dispatch
at the configured threshold.

## Setup

Needs Node 26 (it runs the TypeScript directly), pnpm, a Paseo daemon on each
host, and a TypeSafe API key.

On the host that runs the router:

```sh
cd router && pnpm install
printf '#!/bin/sh\nexec node --no-warnings %s/src/cli.ts "$@"\n' "$PWD" \
  > ~/.local/bin/router && chmod +x ~/.local/bin/router
```

`~/.local/bin` must exist and be on the PATH.

- **Config:** `~/.config/jev-router/config.json` holds the policy, principals,
  participants and permissions described in the
  [spec](research/jev-router-spec.md), plus `hosts` (each
  host's Paseo endpoint), `agents` (the Paseo agent ID for each
  `participant@host`), `serve` (`listen`, `board`, `identities`, and `wake`:
  seconds between looks while work waits for a busy session, `0` to look
  only on events) and `jev`.
- **Secrets:** copy `router/secrets.env.example` to
  `~/.config/jev-router/secrets.env`, mode 600. The router host needs
  `TYPESAFE_API_KEY`, and `ROUTER_TOKEN` for `router serve`: a secret you
  choose, which the other hosts' clients present.
- **Reachable address:** `serve.listen` defaults to `127.0.0.1:7677`. Set it
  to an address the other hosts can reach, such as the host's tailnet
  address, if participants on other hosts take part.
- **Record:** the journal lives in `~/.local/state/jev-router/`, or wherever
  `home` in the config points, with `telemetry.json` beside it.
- **Service:** `router/jev-router.service` runs `router serve` as a systemd
  user service; the install steps are at the top of that file. Its `PATH`
  line assumes Node comes from mise or `/usr/bin`; edit it otherwise.

On a host that does not run the router, install `router/client/router.mjs`
as `router` on the PATH. It carries `reply`, `submit`, `answer` and `choose`,
each acting as the session `$PASEO_AGENT_ID`. In the same secrets file give
it `ROUTER_URL`, the router host's `serve.listen` address as an `http://`
URL, and the same `ROUTER_TOKEN`.

## Repository layout

| Path                          | Contents                                                        |
| ----------------------------- | --------------------------------------------------------------- |
| `router/src/`                 | The router: a pure core (`core.ts`) and the shell around it     |
| `router/client/`              | The client for hosts that do not run the router                 |
| `router/eval/`                | The labeled request set                                         |
| `router/design/`              | The board design's data-paths, and the ones the page drops      |
| `research/jev-router-spec.md` | The design and the contract. Start here for the reasoning       |
| `research/`                   | The executable model the design was verified on, and background |

## Development

```sh
cd router
pnpm test        # unit tests; no calls to Jev or Paseo
pnpm typecheck
pnpm fmt:check
```

CI runs these plus `node --test router-core.test.js` in `research/`, and
fails if the run changed `package.json` or the lockfile.

## Limits

- Events from other hosts are authenticated by one shared token, so any host
  that holds it can reply, submit, answer or choose as any participant
  session the record knows (not as a person, and a replaced session may
  only reply or answer).
- A session is only sent to when the router has just seen it idle. A turn a
  person starts in between is the one race left; holding the session closes
  it.
- The board trusts the login header Tailscale Serve sets, so anything that
  can reach its loopback port can claim a login.
- A participant sender is told once per key. A notice whose adapter call
  was interrupted or whose host was unreachable is marked unknown and is
  not repeated when the participant's adapter does not deduplicate, or when
  its session was replaced since; there is no operator form for it. On the
  router host the sender still finds the item with
  `router needs-you --as <participant>` and `router status`; the client on
  another host has no query command, so a person relays it. Mark a Paseo
  participant `idempotent: true`, as its sends are keyed.
- When two deliveries of one request ask under the same message id, an
  answer must name its delivery (`--delivery`); the notices do.
- Not exercised live: a host that is down for a whole run, token rotation,
  and throughput. The spec keeps the full list.

## License

[MIT](LICENSE)
