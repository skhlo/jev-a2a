# Jev router

A small router that sends work between coding agents running in
[Paseo](https://paseo.sh) sessions on several machines, and keeps one record
of what was asked, who took it, and what came back.

> [!NOTE]
> A personal prototype, built for one person's machines and published as a
> worked example. It is not a product: no releases, no support, and the
> contracts can change between commits.

![The board: agents, open tasks, and the selected task's exchange](router/design/screenshots/board.png)

```sh
router submit "Is this machine current with merged main of the dotfiles baseline?"
```

Agent-to-agent messaging is prompt sending. The router sends the same prompt
a person would type into an agent's session, and adds the two things that
person would otherwise carry in their head:

- **An envelope.** A task ID, the command the agent runs to reply, a key so
  nothing runs twice, and a check that the session is idle so nothing
  already running is interrupted.
- **A record.** One journal of what was sent to which session, what came
  back, and what is still waiting on someone.

When a request names no recipient, Jev (a
[TypeSafe](https://typesafe.ai) System One model) reads each participant's
responsibility text and picks one. If no owner is clear, the router hands
the choice back to the sender instead of guessing.

The router does not orchestrate, run workflows, or hold a session until a
task finishes. How the work gets done belongs to the agents. Typing into a
session you are already looking at needs none of this.

## How a request travels

1. The router records the request as a task.
2. Jev chooses a participant among those the sender may address, or `--to`
   names one.
3. The router sends the prompt to that participant's session on each of its
   hosts, when the session is idle. A busy session gets it the next time the
   router looks and finds it idle ([when it looks](docs/operating.md#when-the-router-looks)).
4. The agent does the work and replies with the command from the envelope:
   `router reply --task T27 --in-reply-to <message> --kind completed --text "..."`.
5. `router status T27` shows the result: here, `1 of 1 completed`, with the
   reply.

Five words carry the rest of this file. A **participant** is an agent or a
service with a stable id, one or more hosts and a **responsibility text**,
which is all Jev reads. A **placement** is a participant on one host
(`coder@laptop`), with one current Paseo session. A **principal** is who
acts: a person as a requester, who submits, or as an operator, who settles
what the router cannot; or a participant, through its session. A
**delivery** is one request on its way to one placement. The [spec](research/jev-router-spec.md#vocabulary) defines them
in full.

## Quick start

You need, on the host that runs the router: Node 26 (it runs the TypeScript
directly), pnpm, and a Paseo daemon with at least one agent. A TypeSafe API
key is needed only for requests that name no recipient. Other machines need
a Paseo daemon reachable over SSH and, for their agents to reply, Node.
The hosts here reach each other over Tailscale; acting on the board from
another device depends on Tailscale Serve.

```sh
git clone https://github.com/skhlo/jev-a2a && cd jev-a2a/router
pnpm install
printf '#!/bin/sh\nexec node --no-warnings %s/src/cli.ts "$@"\n' "$PWD" \
  > ~/.local/bin/router && chmod +x ~/.local/bin/router   # ~/.local/bin on PATH

mkdir -p ~/.config/jev-router
cp config.example.json ~/.config/jev-router/config.json
cp secrets.env.example ~/.config/jev-router/secrets.env && chmod 600 ~/.config/jev-router/secrets.env
```

Edit the config: name your hosts under `hosts` (a websocket URL for the
local daemon, `ssh://<host>` for another machine), your agents under
`participants` with a responsibility text each, and under `agents` the Paseo
agent id of each `participant@host` (`paseo agent ls --json` prints it; add
`--host ssh://<host>` for another machine). Every key is explained in
[docs/configuration.md](docs/configuration.md); note that `policy.deadline`
is in milliseconds. Put `TYPESAFE_API_KEY` in `secrets.env` if you have one,
and choose a `ROUTER_TOKEN`.

Then send something to a named participant and read the record:

```sh
router submit --to coder "Reply with the word pong."
router status            # T1 ... → coder · Reply with the word pong.
router status T1         # the delivery, the session it went to, and the reply when it comes
```

The agent's session receives the prompt with its envelope and answers with
`router reply ...`; once it has, `router status T1` shows `1 of 1
completed` and the reply text. If the session was busy, the task waits and
`router run` makes another pass by hand.

For replies from agents on other machines, and for the board, run the
daemon:

```sh
router serve             # events on 127.0.0.1:7677, board on http://127.0.0.1:7678
```

Set `serve.listen` to the host's tailnet address when other hosts take
part, and on each of those hosts install `router/client/router.mjs` as
`router` on the PATH with `ROUTER_URL` and the same `ROUTER_TOKEN` in its
`secrets.env`; it needs only Node. To keep `serve` running, install it as a
user service ([docs/operating.md](docs/operating.md#router-serve-as-a-service)).

## Commands

| Command                                          | What it does                                                    |
| ------------------------------------------------ | --------------------------------------------------------------- |
| `router submit [--to P [--hosts a,b]] <text>`    | Record a request and deliver it; without `--to`, Jev picks      |
| `router status [<task>]`                         | The record: every task, or one task with its deliveries and log |
| `router needs-you`                               | Decisions waiting on you                                        |
| `router choose --task T --to P`                  | Name the recipient when the router handed the choice back       |
| `router answer --task T --question Q --text ...` | Answer a question an agent asked                                |
| `router cancel <task>`                           | Cancel a task whose work has not reached anyone yet             |
| `router run`                                     | Observe the sessions and deliver what is eligible, once         |
| `router serve`                                   | Accept events from other hosts; serve the board; keep looking   |

Agents use `router reply`. `router observe <placement> --hold` keeps the
router from sending to a session a person is typing in; `router resolve`
lets an operator settle a send the router could not confirm; `router eval`
judges a labeled request set. `router --help` lists every flag, including
`--as` (which principal acts), `--text-file` for text a shell cannot quote,
and `--config`.

An agent's own session may submit, choose and answer too, within
`permissions`, and is told the answers at the placement it sent from:
[docs/participants.md](docs/participants.md#a-participant-as-the-sender).

## The board

`router serve` serves a page on loopback (`serve.board`, `127.0.0.1:7678`)
from the same record: a card per placement with what its session is doing
and its health (branch, diff, pull request, running subagents, the last
tool calls), the tasks that need you, in flight and done, and the selected
task's exchange. Click a card's name, or press `s`, for the health sheet.

![The health sheet of one agent over the tasks column](router/design/screenshots/board-sheet.png)

Opened directly, the page is read-only. Put it behind Tailscale Serve
(`tailscale serve --bg --set-path /router http://127.0.0.1:7678`) to reach
it from another device and to act: the board takes the login Serve reports,
`/whoami` shows it, and a login listed in `serve.identities` answers,
chooses, cancels, resolves and holds as its principals. The page works
without JavaScript; with it, it refreshes every ten seconds and `?` lists
the keys. The same address serves the view model as JSON (`board.json`),
the contract `jev-router-board/1`.

More: [docs/board.md](docs/board.md) (what every part shows),
[docs/board-model.md](docs/board-model.md) (the JSON).

## Routing quality

Jev sees only the responsibility texts, so they decide the routing. Each
participant's owner writes its text next to that agent's own `AGENTS.md`:
an ownership rule, what it is not for, and a few example requests in every
language requests arrive in; the router config copies it.

Before a text, a grant or the threshold changes, judge a labeled set with
the candidate config:

```sh
router eval --config candidate.json --set my-requests.jsonl
```

It prints, per threshold, how many requests would be dispatched, how many
of those wrongly, and how many handed back. The rule: a change goes live
only with no wrong dispatch at the configured threshold. The bundled set in
`router/eval/` names this repository's own participants; write your own in
the same shape ([docs/participants.md](docs/participants.md)). Pin
`jev.model` once the threshold is tuned.

## Limits

- Events from other hosts are authenticated by one shared token, so any
  host that holds it can reply, submit, answer or choose as any participant
  session the record knows (not as a person).
- A session is sent to only when the router has just seen it idle, with no
  pending permission, or closed (the prompt resumes it). A turn a person
  starts in between is the one race left; holding the session closes it.
- The board trusts the login header Tailscale Serve sets, so anything that
  can reach its loopback port can claim a login.
- A participant that sends work is told once per key; a notice lost to an
  interrupted call is not repeated for a non-idempotent participant
  ([docs/participants.md](docs/participants.md#a-participant-as-the-sender)).
- What has and has not been exercised live is listed in the spec:
  [Verified live, and not](research/jev-router-spec.md#verified-live-and-not).

## Documentation

- [research/jev-router-spec.md](research/jev-router-spec.md): the design
  and the contract. Start here for the reasoning.
- [docs/configuration.md](docs/configuration.md): every config key, its
  default and what is refused.
- [docs/operating.md](docs/operating.md): when the router looks, the
  record, the service, the endpoints, what to check when nothing moves.
- [docs/participants.md](docs/participants.md): responsibility texts,
  `router eval`, agents as senders.
- [docs/board.md](docs/board.md) and [docs/board-model.md](docs/board-model.md):
  the board and its JSON.
- [router/design/README.md](router/design/README.md): how the page is held
  to its design.

## Repository layout and development

| Path                         | Contents                                                              |
| ---------------------------- | --------------------------------------------------------------------- |
| `router/src/`                | The router: a pure core (`core.ts`) and the shell around it           |
| `router/config.example.json` | A complete configuration for two hosts; a test keeps it valid         |
| `router/client/`             | The client for hosts that do not run the router                       |
| `router/eval/`               | The labeled request set                                               |
| `router/design/`             | The board design's data-paths, the page's deviations, the screenshots |
| `router/jev-router.service`  | The systemd user unit for `router serve`                              |
| `docs/`                      | Reference pages                                                       |
| `research/`                  | The spec, the executable model it was verified on, and background     |

```sh
cd router
pnpm test        # unit tests; no calls to Jev or Paseo
pnpm typecheck
pnpm fmt:check
```

CI runs these plus `node --test router-core.test.js` in `research/`, and
fails if the run changed `package.json` or the lockfile. After changing the
view model or the board fixture, `pnpm exec node src/board-sample.ts`
regenerates the sample and `pnpm exec node src/board-shots.ts` the
screenshots.

## License

[MIT](LICENSE)
