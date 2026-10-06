# Configuration

The router reads one JSON file, `~/.config/jev-router/config.json` unless
`--config <path>` or `$ROUTER_CONFIG` says otherwise, and a `secrets.env`
in the same directory as that file.
[`router/config.example.json`](../router/config.example.json) is a complete
one-host file; a test keeps it loading. The loader is `router/src/config.ts`
over the core's `validateConfig` in `router/src/core.ts`; what they refuse
is listed with each key. The spec's
[Configuration](research/jev-router-spec.md#configuration) section says
what is fixed on purpose and is not configuration.

## Keys

### `policy`

| Key            | Meaning                                                                                                                                                                    | Refused when          |
| -------------- | -------------------------------------------------------------------------------------------------------------------------------------------------------------------------- | --------------------- |
| `threshold`    | The probability Jev's choice must reach to be dispatched; below it the router hands the choice back. Pick it with `router eval`.                                           | Not in (0, 1]         |
| `deadline`     | How long a task may stay open, in **milliseconds**. The example uses 21600000 (six hours). At the deadline the task ends with its verdict and no further delivery is sent. | Not a positive number |
| `maxText`      | The longest request or answer text, in characters.                                                                                                                         | Not a positive number |
| `maxOpenTasks` | How many tasks may be open at once; a request past that is refused with "Too many open requests".                                                                          | Not a positive number |

### `principals`

Identities that are not participant sessions, each with its role:
`requester` (may submit, choose, answer, cancel) or `operator` (may resolve
a send the router cannot confirm; may not submit). Names are free; a
household may have several requesters. The CLI acts as the first principal
of the needed role unless `--as` or `$ROUTER_AS` names one. Refused: an
unknown role, or a name that collides with a participant id.

### `participants`

A list; at least one. Each has:

| Key              | Meaning                                                                                                                                                                                                                                   | Refused when              |
| ---------------- | ----------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------- | ------------------------- |
| `id`             | Stable and unique. Used in `permissions`, `agents` and on the command line.                                                                                                                                                               | Empty or repeated         |
| `name`           | A label.                                                                                                                                                                                                                                  |                           |
| `kind`           | `agent` or `service`.                                                                                                                                                                                                                     | Anything else             |
| `hosts`          | Host names; the participant has one placement per host. A host the router serves must also be in `hosts` below.                                                                                                                           | Empty, or a name repeated |
| `idempotent`     | **Required**, `true` or `false`: whether the participant's adapter deduplicates by the router's message key. Paseo agent sends are keyed, so `true`; a terminal takes no key, so a participant with a terminal placement must be `false`. | Missing or not a boolean  |
| `responsibility` | The text Jev reads, in full; see [participants.md](participants.md) for how to write it.                                                                                                                                                  | Empty                     |

### `permissions`

For each principal or participant, the list of participant ids it may
address. Absent means nobody. Jev only ever chooses among a sender's
permitted participants, and `router eval` judges the requester's. Refused:
an unknown principal or participant on either side.

### `hosts`

Machines named in `participants[].hosts`; at least one.

| Key            | Meaning                                                                                                                                                                                                                                                                                                                      | Default  |
| -------------- | ---------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------- | -------- |
| `paseo`        | The host's Paseo daemon: a websocket URL such as `ws://127.0.0.1:6767/ws`, or `ssh://[user@]host[:port]` to reach a daemon on `127.0.0.1:6767` of that machine through an SSH tunnel, as the Paseo CLI does. The port is SSH's; the connection runs with `BatchMode=yes`, so it needs key authentication that never prompts. | required |
| `replyCommand` | What a participant on this host runs to reply; it goes into every envelope.                                                                                                                                                                                                                                                  | `router` |

### `agents`

Placement key (`participant@host`) to the placement's session: a Paseo
agent id, or `terminal:<id>` for an agent CLI running in a Paseo terminal
(Claude Code unless [`terminals`](#terminals) names another).
The value is the placement's session identity: a placement without an
entry is not observed and not delivered to. `paseo agent ls -g --json`
prints each agent's `id` across directories, and `paseo terminal ls --all
--json` each terminal's (`--host ssh://<host>` for another machine; the
table form shows only the short id). Refused: a key that is not a
configured placement, a host not in `hosts`, an empty value, a terminal
named by anything but its full id, or a terminal for a participant that is
`idempotent: true`. When a terminal is sent to is in the contract's
adapters section ([jev-router-spec.md](research/jev-router-spec.md)).

### `terminals`

Placement key to the CLI its terminal runs, for a terminal placement that
does not run Claude Code: `codex`, for Codex started as `codex --no-daemon`
(the contract's adapters section says why). Optional; a terminal placement
not listed runs Claude Code. Refused: a key whose `agents` entry is not a
terminal, and a value other than `claude` or `codex`.

```json
"terminals": { "coder@laptop": "codex" }
```

### `serve`

| Key          | Meaning                                                                                                                                                                                 | Default          |
| ------------ | --------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------- | ---------------- |
| `listen`     | Where `router serve` accepts events from other hosts (`POST /events`, bearer the sending host's token; `GET /health` needs no token). Set a tailnet address when other hosts take part. | `127.0.0.1:7677` |
| `board`      | Where the board is served. **Must be loopback** (`127.0.0.1`, `localhost` or `[::1]`); the board trusts the login header Tailscale Serve sets, so nothing else may reach it.            | `127.0.0.1:7678` |
| `identities` | Tailnet login to the list of principals it acts as on the board. Each must be a configured principal. `GET /whoami` on the board shows the `tailscale-user-login` header Serve sends.   | `{}`             |
| `wake`       | Seconds between looks while work waits only for a session to be seen idle; `0` looks on events alone. 0 to 3600.                                                                        | `20`             |
| `poll`       | Seconds after the end of any run before `serve` runs again regardless, so the board's telemetry is at most this plus one run old; `0` polls nothing. 0 to 3600.                         | `0`              |

### `jev`

| Key         | Meaning                                                                      | Default                                |
| ----------- | ---------------------------------------------------------------------------- | -------------------------------------- |
| `model`     | The System One model. Pin a dated version once the threshold is tuned to it. | `jev-latest`                           |
| `url`       | The endpoint.                                                                | `https://api.typesafe.ai/v1/systemone` |
| `timeoutMs` | How long one judgment may take.                                              | `20000`                                |

The key itself is `TYPESAFE_API_KEY` in `secrets.env`. Without it the router
still serves `--to` requests; an unaddressed request waits with "Jev is not
configured".

### `telemetry`

| Key     | Meaning                                                                                                                                                            | Default |
| ------- | ------------------------------------------------------------------------------------------------------------------------------------------------------------------ | ------- |
| `sheet` | Whether each run reads the health sheet (checkout, subagents, activity) beyond readiness. Off, a run costs one Paseo call per placement. Refused unless a boolean. | `true`  |

### `usage`

Optional and off by default: without it `router serve` reads no account
and the board shows no usage. With it, `serve` reads this host's usage
accounts on its own cadence for the board's
[Usage section and pop-up](board.md#usage); what each account reads, and
with which login, is in [operating.md](operating.md#usage).

```json
"usage": { "every": 120 }
```

| Key        | Meaning                                                                                                                                | Default  |
| ---------- | -------------------------------------------------------------------------------------------------------------------------------------- | -------- |
| `every`    | Seconds after the end of one read before the next. Refused unless 30 to 3600.                                                          | `120`    |
| `accounts` | Which accounts to read, among `codex`, `claude`, `deepseek` and `openrouter`; shown in that order. Refused empty or with a name twice. | all four |

`router/config.example.json` leaves the section out on purpose: usage is
opt-in, and copying the quick start should not start reading a host's
accounts. Nor can `router/src/example-config.ts` hold it: that file is
typed as the core's `Config`, which has none of the router's own
sections (`serve`, `jev`, `telemetry`, `usage`).

### `home`

The record's directory: `journal.jsonl` and, beside it, `telemetry.json`.
Default `~/.local/state/jev-router`.

## Secrets

`secrets.env` holds `KEY=VALUE` lines; `router/secrets.env.example` names
them. The file is read at start from the directory of the configuration
file in use, so `router eval --config candidate.json` looks for
`secrets.env` beside `candidate.json`: keep candidates in
`~/.config/jev-router/`, or export the key. A value already in the
environment wins. Keep the file at mode 600; nothing secret belongs in the
JSON file.

| Key                   | Where                                                                                                                                                       |
| --------------------- | ----------------------------------------------------------------------------------------------------------------------------------------------------------- |
| `TYPESAFE_API_KEY`    | The router host, for Jev.                                                                                                                                   |
| `ROUTER_TOKEN_<HOST>` | The router host: a token for each host that sends events, named for the host upper-cased, other characters as `_` (`ROUTER_TOKEN_MINI`). Each is different. |
| `ROUTER_TOKEN`        | A host without a configuration: its own token, the router's `ROUTER_TOKEN_<HOST>` for it.                                                                   |
| `ROUTER_URL`          | Hosts that do not run the router: `serve.listen` as an `http://` URL.                                                                                       |

With [`usage`](#usage) on, the router host may also hold, all optional,
`OPENROUTER_MANAGEMENT_KEY`, `OPENROUTER_API_KEY` and `DEEPSEEK_API_KEY`;
what each reads, and where an account reads without one, is in
[operating.md](operating.md#usage).
