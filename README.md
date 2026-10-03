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
(`serve.board`). It reads the same record as the CLI and shows:

- what is waiting on you, with the action that clears it (choose a recipient,
  answer a question, cancel);
- each agent session the router serves, as the router last observed it:
  `ready`, `busy or away`, or `held` (a person holds a session with
  `router observe <participant@host> --hold` while typing in it, so the
  router does not send there);
- the tasks in progress and the last finished ones, each opening into the
  exchange with the agent.

The board listens on loopback only, and a browser that opens it directly gets
a read-only page. Put
it behind Tailscale Serve to reach it from another device and to act: the
board takes the tailnet login Serve reports, and a login listed in
`serve.identities` may act.

### The board's view model

The page is one rendering of a view model, and the model is published so
that a design can bind its template to the router's own field names. The
board returns it as JSON to a client that asks for JSON:

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
  it, each of `kind` `choose`, `answer` or `resolve`.
- `placements`: each placement the router serves, with its `key`
  (`participant@host`), `participant`, `host`, `session`, `ready` and
  `hold`, and `delivery`: the open delivery pinned to the current session
  (`id`, `taskId`, an `excerpt` of the task text, and the `latest` update's
  `kind` and `at`), or `null`.
- `open` and `finished`: tasks, newest first; `finished` keeps the last ten.
  Each has `id`, `status`, `a2a`, `source`, `messageId`, `recipient`,
  `chosenBy` (`address`, `judgment`, `sender` or `null`), `text`,
  `deadline`, `routing`, `judgments` (each with its full probability table,
  model version and threshold), `final` (`status`, `completed` of `of`,
  `reason`), `deliveries` with their sends, updates and open question, and
  `log`: the task's own log lines, as `router status <task>` shows them.
- `times`: when each message was recorded, by message ID.
- `log`: the router's last twenty log lines.

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
