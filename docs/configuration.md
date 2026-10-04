# Configuration

The router reads one JSON file, `~/.config/jev-router/config.json` unless
`--config <path>` or `$ROUTER_CONFIG` says otherwise, and a `secrets.env`
beside it. [`router/config.example.json`](../router/config.example.json) is
a complete file for two hosts; a test keeps it valid. The loader is
`router/src/config.ts` over the core's `validateConfig` in
`router/src/core.ts`; what they refuse is listed with each key below. The
reasoning behind the policy keys is in the
[spec](../research/jev-router-spec.md#configuration).

## Keys

### `policy`

| Key            | Meaning                                                                                                                          | Refused when          |
| -------------- | -------------------------------------------------------------------------------------------------------------------------------- | --------------------- |
| `threshold`    | The probability Jev's choice must reach to be dispatched; below it the router hands the choice back. Pick it with `router eval`. | Not in (0, 1]         |
| `deadline`     | How long a task may stay open, in **milliseconds**. The example uses 21600000 (six hours). Nothing is sent after the deadline.   | Not a positive number |
| `maxText`      | The longest request, reply or answer text, in characters.                                                                        | Not a positive number |
| `maxOpenTasks` | How many tasks may be open at once; a request past that is refused with "Too many open requests".                                | Not a positive number |

### `principals`

Identities that are not participant sessions, each with its role:
`requester` (may submit, choose, answer, cancel) or `operator` (may resolve
a send the router cannot confirm; may not submit). Names are free; a
household may have several requesters. The CLI acts as the first principal
of the needed role unless `--as` or `$ROUTER_AS` names one. Refused: an
unknown role, or a name that collides with a participant id.

### `participants`

A list; at least one. Each has:

| Key              | Meaning                                                                                                                                        |
| ---------------- | ---------------------------------------------------------------------------------------------------------------------------------------------- |
| `id`             | Stable, unique, non-empty. Used in `permissions`, `agents` and on the command line.                                                            |
| `name`           | For display.                                                                                                                                   |
| `kind`           | `agent` or `service`.                                                                                                                          |
| `hosts`          | Distinct names from `hosts`; the participant has one placement per host.                                                                       |
| `idempotent`     | **Required**, `true` or `false`: whether the participant's adapter deduplicates by the router's message key. Paseo sends are keyed, so `true`. |
| `responsibility` | The text Jev reads, in full; see [participants.md](participants.md) for how to write it.                                                       |

### `permissions`

For each principal or participant, the list of participant ids it may
address. Absent means nobody. Jev only ever chooses among a sender's
permitted participants, and `router eval` judges the requester's. Refused:
an unknown principal or participant on either side.

### `hosts`

Machines named in `participants[].hosts`; at least one.

| Key            | Meaning                                                                                                                                                              | Default  |
| -------------- | -------------------------------------------------------------------------------------------------------------------------------------------------------------------- | -------- |
| `paseo`        | The host's Paseo daemon: a websocket URL such as `ws://127.0.0.1:6767/ws`, or `ssh://[user@]host[:port]` to tunnel to a loopback-bound daemon as the Paseo CLI does. | required |
| `replyCommand` | What a participant on this host runs to reply; it goes into every envelope.                                                                                          | `router` |

### `agents`

Placement key (`participant@host`) to Paseo agent id. The agent id is the
placement's session identity: a placement without an entry is not observed
and not delivered to. `paseo agent ls --json` prints each agent's `id`
(`--host ssh://<host>` for another machine; the table form shows only the
short id). Refused: a key that is not a configured placement, or a host not
in `hosts`.

### `serve`

| Key          | Meaning                                                                                                                                                                       | Default          |
| ------------ | ----------------------------------------------------------------------------------------------------------------------------------------------------------------------------- | ---------------- |
| `listen`     | Where `router serve` accepts events from other hosts (`POST /events`, bearer `ROUTER_TOKEN`; `GET /health` needs no token). Set a tailnet address when other hosts take part. | `127.0.0.1:7677` |
| `board`      | Where the board is served. **Must be loopback** (`127.0.0.1`, `localhost` or `[::1]`), because the board trusts the login header Tailscale Serve sets.                        | `127.0.0.1:7678` |
| `identities` | Tailnet login to the list of configured principals it acts as on the board. `GET /whoami` on the board shows the login Serve reports.                                         | `{}`             |
| `wake`       | Seconds between looks while work waits only for a session to be seen idle; `0` looks on events alone. 0 to 3600.                                                              | `20`             |

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

| Key     | Meaning                                                                                                                                  | Default |
| ------- | ---------------------------------------------------------------------------------------------------------------------------------------- | ------- |
| `sheet` | Whether each run reads the health sheet (checkout, subagents, activity) beyond readiness. Off, a run costs one Paseo call per placement. | `true`  |

### `home`

The record's directory: `journal.jsonl` and, beside it, `telemetry.json`.
Default `~/.local/state/jev-router`.

## Secrets

`secrets.env` holds `KEY=VALUE` lines; `router/secrets.env.example` names
them. The file is read at start and a value already in the environment
wins. Keep it at mode 600; nothing secret belongs in the JSON file.

| Key                | Where                                                                 |
| ------------------ | --------------------------------------------------------------------- |
| `TYPESAFE_API_KEY` | The router host, for Jev.                                             |
| `ROUTER_TOKEN`     | The router host and every host with a client.                         |
| `ROUTER_URL`       | Hosts that do not run the router: `serve.listen` as an `http://` URL. |

## Not configuration, by design

Message identity, the delivery state machine, the eligibility rule, reply
correlation, and what each event may do are fixed; the
[spec](../research/jev-router-spec.md#configuration) says why.
