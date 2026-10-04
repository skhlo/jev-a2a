# Operating the router

What runs when, where the record lives, and what to look at when something
does not move. Keys named here are described in
[configuration.md](configuration.md).

## When the router looks

The router does nothing on a schedule of its own. It observes the sessions
and delivers what is eligible:

- when it handles something: a request, a reply, an answer, a choice, or
  `router run`;
- while anything waits only for a session to be seen idle (or for an
  unconfirmed send there to settle), every `serve.wake` seconds, 20 by
  default; `0` leaves `serve` to run on events alone;
- `serve` watches `journal.jsonl`, so a request made with the CLI on the
  router host, which writes the journal directly, arms that look too.

Anything else that waits (a hold, a hand-back, an open question, a replaced
session) waits on an event, and a quiet router arms nothing.

A session is sent to only when the router has just seen it idle, or closed
(a persisted session with no process; the prompt resumes it), with no
pending permission and the agent not archived. A turn a person starts
between the look and the send is the one race left; holding the session
(`router observe <participant@host> --hold`, or the lever on the board)
closes it, and `--release` opens it again.

## The record

`home` (default `~/.local/state/jev-router/`) holds:

- `journal.jsonl`: every event, appended. The CLI on the router host writes
  it directly; `serve` watches it. `router status` reads it.
- `telemetry.json`: one snapshot per served placement from the last run,
  written whole by rename after the run's observations and before its
  sends. It is not part of the record: an observation is journaled only
  when readiness or the session changes, while a snapshot changes every
  run. The board shows each snapshot with its age (the nav tick dates the
  file); `router status` prints one line per placement with the time,
  branch, diff and pull request. A missing or unreadable file is "no
  telemetry", logged once by `serve`, never a fault; a damaged entry drops
  its placement, named in the log; a damaged sheet field reads as not read.

With `telemetry.sheet` on (the default) a run costs, per host, one workspace
list, and per live session two more calls (the subagent list and the
timeline tail) on top of the one that reads readiness. A read that fails is
a `telemetry:` line in the run's report, which `serve` logs once while the
cause lasts, and a `null` field. `telemetry.sheet: false` keeps a run to the
one call per placement. Measured on three hosts over SSH, the sheet's cost
was not visible next to the SSH round trips.

## `router serve` as a service

`router/jev-router.service` runs `router serve` as a systemd user service;
the install steps are at the top of the file:

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
  configuration or the token is wrong). The unit stays down with the
  message in `systemctl --user status jev-router`.
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
- `/whoami`: the tailnet login Serve reports, the principals it maps to in
  `serve.identities`, and the `tailscale-*` headers seen. Use it to fill in
  `serve.identities`.
- `POST /actions`: the board's forms. Refused unless the request comes from
  the page itself (`Sec-Fetch-Site` or a matching `Origin`).

Routes match by suffix, so the board can be mounted under a path
(`tailscale serve --bg --set-path /router http://127.0.0.1:7678`), and its
forms use relative URLs.

## When nothing moves

- `router status <task>` shows what a task waits for: a recipient, a
  session not ready or held, a send behind another, an open question.
- `router needs-you` lists the decisions waiting on a person;
  `--as <participant>` lists what a participant sender is owed.
- `router run` makes one pass by hand and prints the run's report.
- `journalctl --user -u jev-router -f` follows `serve`; each `telemetry:`
  note appears once while its cause lasts.
- A placement missing from the board was not in `agents`, or its agent id
  is wrong (`missing` in its health line) or its host could not be reached
  (`unreachable`, with the reason as a tooltip).
