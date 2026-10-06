# Operating the router

What runs when, where the record lives, and what to look at when something
does not move. Keys named here are described in
[configuration.md](configuration.md).

## When the router looks

By default the router does nothing on a schedule of its own. It observes
the sessions and delivers what is eligible:

- when it handles something: a request, a reply, an answer, a choice, or
  `router run`;
- while anything waits only for a session to be seen idle (or for an
  unconfirmed send there to settle), every `serve.wake` seconds, 20 by
  default; `0` leaves `serve` to run on events alone;
- `serve` watches `journal.jsonl`, so a request made with the CLI on the
  router host, which writes the journal directly, arms that look too;
- with the router's Paseo plugin installed (below), when a placement's
  session ends a turn on the router host's daemon, at once if anything
  waits for a session, instead of at the next look.

Anything else that waits (a hold, a hand-back, an open question, a replaced
session) waits on an event, and a quiet router arms nothing.

`serve.poll` changes that: set to a number of seconds, `serve` runs again
that long after the end of any run, whatever started it, so while `serve`
is up the board's telemetry (session status, permissions, the sheet) is at
most that plus one run old. A poll run is an ordinary run: it observes,
ends tasks whose deadline has passed, and delivers what is eligible, at
the cost of the Paseo calls described under the telemetry file below. It
appends nothing to the journal unless something changed: a run records
its clock only when it ended a task or a recorded event follows it, and an
observation only when readiness, the session or the hold changed. The
tasks column needs the poll only for deadlines: a request, a reply or an
answer is an event and runs at once, while a task past its deadline is
ended by the next run's clock. `0`, the default, polls nothing.

A session is sent to only when the router has just seen it idle, or closed
(a persisted session with no process; the prompt resumes it) and not
archived, and in either case with no pending permission. A turn a person
starts between the look and the send is the one race left; holding the
session (`router observe <participant@host> --hold`, or the lever on the
board) closes it, and `--release` opens it again.

A terminal placement, Claude Code or Codex in a Paseo terminal, is sent to
only at the CLI's empty prompt, as the contract's adapters section
([jev-router-spec.md](research/jev-router-spec.md)) defines it, by one
paste and Enter. Codex must run as `codex --no-daemon`, and each prompt
tells it to request escalated permissions for the router command; the
contract says why. A send it cannot confirm is unknown and waits for
`router resolve`, since a terminal takes no message key. A line a person
starts typing between the look and the paste is the race here, and the hold
closes it the same way. The board shows no provider, model, context,
subagents or activity tail for a terminal, which reports none of them.

## The record

`home` (default `~/.local/state/jev-router/`) holds:

- `journal.jsonl`: every event that changed the record, appended. The CLI
  on the router host writes it directly; `serve` watches it.
  `router status` reads it.
- `telemetry.json`: one snapshot per served placement from the last run,
  written whole by rename after the run's observations and before its
  sends. It is not part of the record: an observation is journaled only
  when readiness, the session or the hold changes, while a snapshot
  changes every run. The board shows each snapshot (the nav tick's
  tooltip dates the file); `router status` prints one line per placement
  with the time,
  branch, diff and pull request. A missing file is "no telemetry" and
  never a fault; an unreadable one is logged once by `serve`; a damaged
  entry drops its placement, named in the log; a damaged sheet field reads
  as not read.

With `telemetry.sheet` on (the default) a run costs, per host, one workspace
list, and per live session two more calls (the subagent list and the
timeline tail) on top of the one that reads readiness. A read that fails is
a `telemetry:` line in the run's report, which `serve` logs once while the
cause lasts, and a `null` field. `telemetry.sheet: false` keeps a run to the
one call per placement.

## Usage

With a [`usage`](configuration.md#usage) section, `serve` also reads this
host's usage accounts for the board's [Usage](board.md#usage) view: when
it starts, then [`usage.every`](configuration.md#usage) seconds after each
read ends, one read at a time and apart from the runs. Each read asks every
configured account at once, so one slow or failed account never holds back
another; a request has 12 seconds and 1 MB, and refuses redirects. The
store is in memory: nothing is written, and a restart starts from "not
read yet".

What each account reads, with this host's own logins:

- Codex: `codex app-server --listen stdio://`, run from a temporary
  directory with the router's secrets left out of its environment (the
  fixed names and every name `secrets.env` sets), for the current limits
  and the account's daily token history. It needs
  `codex` on `PATH` (the service's `PATH` includes mise's shims) and a
  signed-in Codex; the router never reads Codex's own credentials.
- Claude: the OAuth token in `~/.claude/.credentials.json` (or under
  `$CLAUDE_CONFIG_DIR`) and nowhere else, so its expiry always applies;
  never `CLAUDE_CODE_OAUTH_TOKEN`. The router does not refresh the token: an
  expired login reads "Claude login expired; open Claude Code.", and
  opening Claude Code renews it.
- DeepSeek: `DEEPSEEK_API_KEY`, else the `deepseek` API-key entry in Pi's
  `~/.pi/agent/auth.json`.
- OpenRouter: `OPENROUTER_API_KEY` (or Pi's auth.json) for the key's
  allowance and spend, and `OPENROUTER_MANAGEMENT_KEY` for the account
  balance and the spending by model and provider. Either alone is enough
  to read something.

A key in auth.json that names a command (`!…`) is not run. Neither keys
nor a provider's error text reach the page, the model or the log: a failed
account shows the router's own sentence and keeps its last reading. A
credential the provider refuses (HTTP 401 or 403) reads as the next step:
"open Claude Code and run /login" for Claude, "check the provider API key"
for an API key, and the management key for OpenRouter's balance and
spending.

`router usage` reads every configured account once (all four without a
`usage` section) and prints the result as the board model carries it,
without opening the journal. It prints private account data to the
terminal; use it to check the readers on a host.

## `router serve` as a service

`router/jev-router.service` runs `router serve` as a systemd user service.
From the repository root:

```sh
cp router/jev-router.service ~/.config/systemd/user/
systemctl --user daemon-reload
systemctl --user enable --now jev-router
loginctl enable-linger            # start at boot, before any login
```

Its `PATH` line assumes Node comes from mise or `/usr/bin`; edit it
otherwise. Logs: `journalctl --user -u jev-router`. After a code change:
`systemctl --user restart jev-router`.

Exit codes:

- `2`: a reason a restart cannot change (the port is taken, the
  configuration is invalid, two hosts have the same token). The unit stays
  down with the message in `systemctl --user status jev-router`.
- `75`: the listen address was not up yet. `serve` waits up to 120 seconds
  for it (a tailnet address arrives after the service at boot), then exits
  75 and the unit restarts it.

One instance per host: a second finds the port taken and says so.

## The Paseo plugin

`router/plugin/` is a Paseo plugin, with no UI yet. Installed into the
router host's daemon, it posts `/nudge` to `serve.board` each time a
placement's session ends a turn there. A delivery or notice waiting for that session
then goes out at once instead of up to `serve.wake` seconds later. The
looks stay, since Paseo's hooks are best effort, and they still find:

- sessions on other hosts;
- terminal placements, which are not Paseo agents and have no turns to
  hook.

It also answers the board's RPCs for the Paseo app: `board.summary`,
`board.task`, and the actions `task.answer`, `task.choose`,
`task.resolve`, `task.cancel`, `task.hold`, `task.release` and
`task.submit`, declared in `router/plugin/shared/rpc.ts`. Each forwards
to serve's API on `serve.board` (below), so the app sees what the board
page sees, and acts as the CLI on the router host does without `--as`:
as the first principal of each role.

The plugin reads the configuration at the default path, or at the
daemon's `$ROUTER_CONFIG`; a `--config` or `ROUTER_CONFIG` given only to
`serve` does not reach it.

It needs `pluginsEnabled` on that daemon (Settings → Plugins). Paseo
bundles the plugin's dependencies (the plugin SDK and zod) from its
`node_modules`. Install it once from the checkout `serve` runs; after
updating the checkout, install its dependencies again and reload it:

```sh
pnpm --dir router/plugin install --frozen-lockfile   # from the repository root
paseo plugin install "$PWD/router/plugin"
paseo plugin reload router
paseo plugin logs router    # a failed nudge is logged once
```

## Endpoints

On `serve.listen`:

- `POST /events` with `Authorization: Bearer <the host's token>`: what
  `router` on another host sends (`reply`, `submit`, `answer`, `choose`).
  A token acts only for sessions on its own host; an event as a session on
  another host is refused with `wrong_host`. `serve` names the hosts that
  have a token when it starts; with none, it refuses every event.
- `GET /check` with a host's token: `{"ok":true,"host":"<host>"}`, what
  `router check` on that host asks.
- `GET /health`: `{"ok":true}`, no token.

Every answer on this address carries `commit`, the commit `serve` runs, so
a reply host can tell when its checkout differs.

On `serve.board` (loopback; expose it through Tailscale Serve):

- `/`: the page, or the view model as JSON for a client whose `Accept`
  ranks `application/json` above `text/html`; `/board.json` is the model
  regardless. See [board-model.md](board-model.md).
- `/`: with `?usage`, the page with the usage pop-up drawn open, which is
  how a page without a script opens it.
- `/usage/`: the old Usage tab's address, kept for its links: a redirect
  to the board with the pop-up open (`../?usage`), or to the bare board
  (`../`) without a `usage` section.
- `/whoami`: the `tailscale-*` headers seen, with the `login` and
  `principals` they map to once the login is in `serve.identities` (`null`
  and empty before). Read `tailscale-user-login` from it to fill in
  `serve.identities`.
- `POST /actions`: the board's forms. A request with no identity gets 403;
  one a browser marks as cross-site (`Sec-Fetch-Site`, or an `Origin` that
  does not match the host) is refused.
- `POST /nudge`: what the Paseo plugin sends when a turn ends. `202` with
  `run queued` when something waits for a session, or `nothing waits`. It
  changes nothing in the record, so it needs no identity.
- `GET /api/summary`, `GET /api/task?id=<task>` and `POST /api/action`
  (JSON): the Paseo plugin's API (`router/src/board-api.ts`). The summary
  heads each task with its own `rev`; with `?sinceRev=<rev>`, an unchanged
  board answers `{"unchanged":true,"rev":"<rev>"}`. An action acts as the
  first principal of each role and answers the router's `outcome`, the
  board's new `rev`, and the task it changed.

`/nudge` and `/api/` answer only a process on this host: a request that
came through Tailscale Serve, from another device, is refused, and so is
one a browser marks as cross-site, or one whose `Host` is not a loopback
address.

Routes match by suffix, so the board can be mounted under a path
(`tailscale serve --bg --set-path /router http://127.0.0.1:7678`), and its
links, forms and redirects use relative URLs.

## When nothing moves

- `router status <task>` shows the task's deliveries, their sends and
  replies, an open question, and a recipient still to be chosen.
- `router run` makes one pass by hand and prints the run's report, which
  says why each waiting delivery waits: not ready, held, queued behind
  another. The board's task row says the same.
- `router needs-you` lists the decisions waiting on a person;
  `--as <participant>` lists what a participant sender is owed.
- `journalctl --user -u jev-router -f` follows `serve`; each `telemetry:`
  note appears once while its cause lasts.
- A placement absent from the board has no entry in `agents`. One whose
  agent id the daemon does not know shows `missing` in its health line
  (`router roster repoint` points it at its new session);
  one whose host could not be reached shows `unreachable`, with the reason
  as a tooltip, and the next run tries again: a host that drops off the
  network costs that run, not the ones after it.
- A terminal placement's line in the run report says why it is not ready:
  `working`, `at its prompt with text in it or a dialog open`, or `Claude
Code is not running in the terminal` when the title is not Claude Code's
  (start it again in that terminal). For Codex: `working`, which includes
  its automatic reviewer weighing an approval, or `not at an empty Codex
composer: a draft, a dialog, or Codex not running`.
