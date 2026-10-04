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
  router host, which writes the journal directly, arms that look too.

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
  configuration is invalid, `ROUTER_TOKEN` is not set). The unit stays down
  with the message in `systemctl --user status jev-router`.
- `75`: the listen address was not up yet. `serve` waits up to 120 seconds
  for it (a tailnet address arrives after the service at boot), then exits
  75 and the unit restarts it.

One instance per host: a second finds the port taken and says so.

## Endpoints

On `serve.listen`:

- `POST /events` with `Authorization: Bearer $ROUTER_TOKEN`: what the client
  on another host sends (`reply`, `submit`, `answer`, `choose`).
- `GET /health`: `{"ok":true}`, no token.

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

Routes match by suffix, so the board can be mounted under a path
(`tailscale serve --bg --set-path /router http://127.0.0.1:7678`), and its
forms use relative URLs.

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
  agent id the daemon does not know shows `missing` in its health line;
  one whose host could not be reached shows `unreachable`, with the reason
  as a tooltip.
