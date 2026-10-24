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

A Codex agent's prompt that gives it a router command tells it to request
escalated permissions for it, as a Codex terminal's does. In Paseo's
Default Permissions and Auto-review modes, Codex runs its commands in a
sandbox that cannot reach the router; a Full Access agent is told too.

A terminal placement, Claude Code or Codex in a Paseo terminal, is sent to
only at the CLI's empty prompt, as the contract's adapters section
([jev-router-spec.md](research/jev-router-spec.md)) defines it, by one
paste and Enter. Codex must run as `codex --no-daemon`, and each prompt
tells it to request escalated permissions for the router command; the
contract says why. Under the shared server its router commands are
refused ([participants.md](participants.md#whose-environment)). A send it
cannot confirm is unknown and waits for `router resolve`, since a
terminal takes no message key. A line a person starts typing between the
look and the paste is the race here, and the hold closes it the same way.
The board shows no provider, model, context, subagents or activity tail
for a terminal, which reports none of them.

### A Codex session on the shared server

Bare `codex` runs on the shared server, so the router refuses its
commands. To move the session to `--no-daemon` without losing the
conversation, at a point where no delivery is open and no turn runs:

1. Read its conversation id, `$CODEX_THREAD_ID` as a command it runs
   prints it, and check that a rollout under `~/.codex/sessions` carries
   that id in its name. Not `resume --last`: with several sessions it may
   pick another.
2. Quit it, and in the same terminal run `codex --no-daemon resume <id>`.
   The terminal, and so the placement, stay the same. If Codex reports the
   conversation is loaded elsewhere, stop; do not force it.
3. Check from the resumed session that `$PASEO_TERMINAL_ID` is the
   placement's terminal and `$CODEX_THREAD_ID` the id read in step 1, then
   send it a request and see its reply recorded: the core takes a reply
   only from the session the delivery is pinned to.

The shared server and its other clients keep running.

## The record

`home` (default `~/.local/state/jev-router/`) holds:

- `journal.jsonl`: every event that changed the record, appended. The CLI
  on the router host writes it directly; `serve` watches it.
  `router status` and `router needs-you` read it without the lock, so
  they never wait for a run; an attempt in progress shows as delivering.
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

`router/plugin/` is a Paseo plugin. Installed into the router host's
daemon, it posts `/nudge` to `serve.board` each time a placement's
session ends a turn there. A delivery or notice waiting for that session
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

In the app, the plugin adds Jev to the sidebar: an Agents row, the
board's tasks in Needs you, In flight and Done, and the selected task
with its record. A task's row reads its title, then who sent it to
whom and its status, then what it waits on or last said. A group's
heading collapses or opens it; the app remembers which until it
restarts. The Agents row counts the agents
ready and held and marks each by host; it opens the Agents page, with
each agent's state, Hold or Release, and its open tasks. Your answer,
choose and resolve items are forms in a task, an open delivery has Hold
or Release, and New task and Cancel task open a dialog. The surface
asks for the summary every 5 seconds while it is shown, and fetches a
task again only when it changed.

The plugin reads the configuration at the default path, or at the
daemon's `$ROUTER_CONFIG`; a `--config` or `ROUTER_CONFIG` given only to
`serve` does not reach it.

It needs `pluginsEnabled` on that daemon (Settings → Plugins). The
daemon and the app on each device must be Paseo 0.10.2 or newer
(`router/plugin/paseo-plugin.json`); an older app, such as a phone that
has not updated, lists the plugin as failed in Settings → Plugins and
shows no Jev. Paseo bundles the plugin's dependencies (the plugin SDK
and zod) from its `node_modules`; the app provides React, React Native
and React Query, whose copies there serve the typecheck. Install it
once from the checkout `serve` runs; after updating the checkout,
install its dependencies again and reload it:

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
  board's new `rev`, and the task it changed. A request or an answer keeps
  a `messageId` the app gives, so a retry after a timeout is recognised
  as a repeat. A refusal is `{"message":…}`.

`/nudge` and `/api/` answer only a process on this host: a request with a
`Forwarded`, `X-Forwarded-*` or `Tailscale-*` header (Tailscale Serve
adds them) is refused, and so is one a browser marks as cross-site, or
one whose `Host` is not a loopback address.

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
  (`router roster repoint <placement>` finds its new session in its
  folder);
  one whose host could not be reached shows `unreachable`, with the reason
  as a tooltip, and the next run tries again: a host that drops off the
  network costs that run, not the ones after it.
- A terminal placement's line in the run report says why it is not ready:
  `working`, `at its prompt with text in it or a dialog open`, or `Claude
Code is not running in the terminal` when the title is not Claude Code's
  (start it again in that terminal). For Codex: `working`, which includes
  its automatic reviewer weighing an approval, or `not at an empty Codex
composer: a draft, a dialog, or Codex not running`.
