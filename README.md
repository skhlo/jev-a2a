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
   router handles something and finds it idle (a request, a reply, an answer,
   or `router run`); nothing runs on a schedule.
4. The agent does the work and replies with the command from the envelope:
   `router reply --task T27 --in-reply-to <message> --kind completed --text "..."`.
5. `router status T27` shows the result: here, `2 of 2 completed`, one reply
   per host.

Use `--to <participant>` to skip Jev. With `--to`, `--hosts a,b` narrows a
participant that runs on several hosts.

## Commands

| Command                                            | What it does                                                   |
| -------------------------------------------------- | -------------------------------------------------------------- |
| `router submit [--to P [--hosts a,b]] <text>`      | Record a request and deliver it                                |
| `router status [<task>]`                           | Show the record                                                |
| `router needs-you`                                 | List decisions waiting on a person                             |
| `router choose --task T --to P`                    | Name the recipient when the router handed the choice back      |
| `router answer --task T --question Q --text ...`   | Answer a question an agent asked                               |
| `router reply --task T --in-reply-to M --kind ...` | An agent's reply: `working`, `question`, `completed`, `failed` |
| `router run`                                       | Observe the sessions and deliver what is eligible              |
| `router serve`                                     | Accept replies from other hosts over HTTP; serve the board     |
| `router eval`                                      | Judge a labeled request set with the configured texts          |
| `router cancel <task>`                             | Cancel a task                                                  |

`reply` and `answer` also take `--text-file <path>` in place of `--text`, for
text that a shell cannot quote in one argument. `router` with no arguments
prints the full usage.

## The board

`router serve` also serves a page, the board, on `127.0.0.1:7678` by default
(`serve.board`). It reads the same record as the CLI. The page is the v0.6
console of the board design (`skhlo/designs`, tag `jev-a2a-v0.6`), drawn on
the server from the view model below, in three columns:

- **Agents**: a card per placement the router serves, saying what its
  session is doing (asks on a task, works on one, ready, held, not ready) and
  when it last updated, over the router's last log lines.
- **Tasks**, in three groups. Needs you holds the tasks that wait on one of
  your principals, a finished task too when an operator must resolve its
  send; In flight holds the other open tasks, and Done the last finished
  ones. A row says what its task waits for: the open question, the recipient
  Jev was unsure of, the delivery it is queued behind or the session it is
  held on, or who canceled it.
- **The selected task**: how its recipient was chosen, its deadline with a
  countdown while it is open, the exchange in time order, the form that
  clears what waits on you, and its deliveries, Jev's judgments and log.

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
confirm, and holds or releases a session (a person holds a session while
typing in it, so the router does not send there). Each form posts to the
board's `actions` endpoint and comes back to the page with the outcome.
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
compared with the design mechanically. `router/design/v0.6-paths.txt` lists
the design's paths, as `router/src/design-paths.ts` extracts them, and a test
fails when one is neither rendered for the board fixture nor named with a
reason in `router/design/v0.6-dropped.txt`.

The page differs from v0.6 on purpose where the design was wrong for live
data: counted nouns agree with their number, each clock carries its full
date as a tooltip, the needs-you count counts tasks the same way in the nav
and in the group, blue follows the viewer (the design colours every question
and its badge, whoever it waits on), a finished task shows its verdict
instead of a countdown, the forms post the router's own fields (resolving
takes evidence), a narrow screen gets one scrolling column, the detail
title shows a request's first line (the full text is its tooltip and is in
the transcript), a session id that is a UUID shows its first eight
characters with the full id as its tooltip, and the Needs you header is blue
only while something waits on the viewer. What remains
open: the design's session telemetry and health sheet, which the record does
not hold (see below); the hold lever shows for operators, as the design has
it, although the router accepts a hold from any known login; a post does not
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
built from the board's test fixture (`router/src/board-fixture.ts`), so it
holds no live request text. After changing the model or the fixture, run
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
  session (`id`, `taskId`, an `excerpt` of the task text, and the `latest`
  update's `kind` and `at`), or `null`.
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
    `in_flight` (another send to the placement is unconfirmed), `held`,
    `not_ready` or `queued_behind`; for `queued_behind`, `behind` is the
    id of the delivery at the head of the placement's queue, the one that
    goes next, and otherwise `null`.
  - `log`: the task's own log lines, as `router status <task>` shows them.
- `times`: when each message was recorded, by message ID.
- `log`: the router's last twenty log lines, each with its number `n`, its
  `actor` and its `text`.

The record does not hold adapter status, the number of permission requests
pending in a session, or session telemetry (context use, turns, tool calls,
cost, process, worktree, subagents, activity), so the model does not carry
them. These are the gaps a later telemetry round fills.

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
  `participant@host`), `serve` and `jev`.
- **Secrets:** copy `router/secrets.env.example` to
  `~/.config/jev-router/secrets.env`, mode 600. The router host needs
  `TYPESAFE_API_KEY`, and `ROUTER_TOKEN` for `router serve`: a secret you
  choose, which reply hosts present.
- **Reachable address:** `serve.listen` defaults to `127.0.0.1:7677`. Set it
  to an address the other hosts can reach, such as the host's tailnet
  address, if agents on other hosts reply.
- **Record:** the journal lives in `~/.local/state/jev-router/`, or wherever
  `home` in the config points.
- **Service:** `router/jev-router.service` runs `router serve` as a systemd
  user service; the install steps are at the top of that file. Its `PATH`
  line assumes Node comes from mise or `/usr/bin`; edit it otherwise.

On a host that only replies, install `router/client/router.mjs` as `router` on
the PATH. In the same secrets file give it `ROUTER_URL`, the router host's
`serve.listen` address as an `http://` URL, and the same `ROUTER_TOKEN`.

## Repository layout

| Path                          | Contents                                                        |
| ----------------------------- | --------------------------------------------------------------- |
| `router/src/`                 | The router: a pure core (`core.ts`) and the shell around it     |
| `router/client/`              | The reply client for hosts that do not run the router           |
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

- Replies from other hosts are authenticated by one shared token, so any host
  that holds it can reply as any participant.
- A session is only sent to when the router has just seen it idle. A turn a
  person starts in between is the one race left; holding the session closes
  it.
- The board trusts the login header Tailscale Serve sets, so anything that
  can reach its loopback port can claim a login.
- A participant on another host cannot submit work: the reply client only
  replies.
- Not exercised live: a host that is down for a whole run, token rotation,
  and throughput. The spec keeps the full list.

## License

[MIT](LICENSE)
