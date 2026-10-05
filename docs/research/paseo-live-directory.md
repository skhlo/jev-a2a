# Paseo live peer directory research

Investigated 2026-09-27. Scope: the smallest way to obtain `host -> project -> workspace -> agent/terminal` for a routing helper. This is research only; no integration, dependency, daemon, or service changes were made.

## Finding

Paseo already supplies per-host records and live directory synchronization, and its installed app exposes public plugin APIs for enumerating configured hosts. A small app plugin could aggregate an exact live directory using those existing APIs. A new discovery daemon is not a prerequisite.

For the current CLI-only workflow, the smallest routing prototype can aggregate a flat shortlist across explicitly configured hosts. The installed CLI strips some relationship IDs, so an exact hierarchy requires a small CLI projection addition or a decision to adopt the app/SDK path. This distinction matters: four CLI listings alone do not reliably reconstruct the full tree.

The installed Linux CLI reports 0.9.2. Upstream's release page currently identifies v0.9.2, released 2026-09-24, as the latest stable release. v0.9.0 already added public plugin host discovery through `useHosts()` and `getPaseoClient(serverId)`. Merely upgrading is therefore not an established fix. Other host daemon and app versions still need verification. [0.9.2 release](https://github.com/getpaseo/paseo/releases/tag/v0.9.2), [0.9.0 release](https://github.com/getpaseo/paseo/releases/tag/v0.9.0)

## Three separate inventories

1. **App host registry:** the configured connections in a particular Paseo client. These include offline hosts. This is where an app can enumerate connected/configured hosts.
2. **One daemon's directory:** its registered projects, workspaces, agents, and workspace terminals. Each host remains responsible for its own records.
3. **Arbitrary processes and devices:** unrelated shells, agent CLIs launched outside Paseo, and devices without a configured Paseo connection. The inspected directory interfaces do not promise to enumerate these.

Paseo is a client/server system: apps connect to one or more daemons, each daemon manages its own agents, and Desktop bundles and manages a daemon. A daemon is not automatically the central directory for all machines. [Architecture](https://github.com/getpaseo/paseo/blob/main/docs/architecture.md), [Getting started](https://paseo.sh/docs)

## Existing public functionality

| Need | Existing capability | Boundary |
| --- | --- | --- |
| Enumerate configured app hosts | Plugin `useHosts()` | Runs inside the app, not a standalone CLI command |
| Query another app-connected host | Plugin `getPaseoClient(serverId)` | Borrows that host's authenticated app connection |
| Snapshot one host | CLI project, workspace, agent, terminal JSON lists | Caller supplies `--host` |
| Follow project changes | SDK `projects.subscribe()` with an initial `projects.list()` | Per host |
| Follow workspace/agent changes | SDK `list({ subscribe: {} })` | Per-host snapshots and updates |
| Inventory terminals | CLI `terminal ls --all --json` / SDK `terminals.list()` | Public SDK reference documents snapshot reads, no directory subscription |

Plugin host summaries contain `serverId`, `label`, and current connection status (`idle`, `connecting`, `online`, `offline`, `error`). They expose no connection URLs or credentials. The borrowed API requires an online host, opens no new socket, and does not require the plugin on the target daemon. Connection replacement requires reacquiring the API and rebuilding observations. Plugin unloading releases its borrowed APIs. This is a public extension surface, but a client plugin is not an always-running monitor when the app is closed. [Plugin reference: host discovery](https://paseo.sh/docs/plugins/reference#discover-hosts-and-target-another-host)

The supported standalone TypeScript package is `@getpaseo/client`. It accepts a daemon WebSocket URL including `/ws`, supports authentication and reconnect options, and provides projects, workspaces, agents, and terminals. Workspaces expose their project IDs; agents expose workspace IDs. Terminal entries contain `id`, `workspaceId`, `cwd`, and `name`. An agent `send()` resolves on daemon acceptance, while terminal input does not acknowledge command execution. [SDK overview](https://paseo.sh/docs/sdk), [SDK API reference](https://paseo.sh/docs/sdk/reference)

Directory subscriptions deliver snapshots before live updates, obtain new snapshots after reconnect, and can be released independently on capable daemons. Older daemons have shared subscription/filter behavior. Project observation uses a separate subscribe call; buffer updates while fetching its initial snapshot. These are directory state subscriptions, not a need to stream every agent's conversation. [SDK events](https://paseo.sh/docs/sdk/events)

Internally, directory synchronization has independent monotonic sequences for projects, workspaces, and agents, a shared daemon generation, and bounded tombstones. Invalid or expired cursors receive full snapshots. The app owns caches and reconciliation for each host; connection alone does not automatically demand directory data. Those internals explain freshness but should not be imported as a stable external API. Public SDK root exports are the supported integration surface; low-level drivers live under explicitly internal paths. [Architecture: directory synchronization and client package](https://github.com/getpaseo/paseo/blob/main/docs/architecture.md)

Hub is a different service for dispatching automation. Its documented public endpoints operate on organizational automation projects, trigger configuration, manual runs, and daemon enrollment. They do not document a complete inventory of manually started local sessions or terminals. Hub owns agents it dispatched, leaving manually started agents untouched. Enrolling Hub is unnecessary for this directory. [Hub public API](https://paseo.sh/docs/hub/api), [Daemons in Hub](https://paseo.sh/docs/hub/daemons)

## Minimum path under the current CLI-only instruction

The session's instructions require the Paseo CLI for discovery and control and prohibit Paseo MCP. Therefore the default implementation recommendation is a small CLI wrapper, not an assumed switch to SDK operations.

Start from an explicit host endpoint registry. For each host, execute these read-only commands:

```sh
paseo --host <endpoint> project ls --json
paseo --host <endpoint> workspace ls --json
paseo --host <endpoint> ls --global --json
paseo --host <endpoint> terminal ls --all --json
```

`--global` means agents across workspaces on the selected daemon; it does not mean every host. CLI `--host` selects a single endpoint. Remote targets can use direct connections, SSH, or relay pairing offers where supported. SSH connects to an already-running remote daemon; it does not install or start one. [CLI reference](https://paseo.sh/docs/cli), [Connectivity](https://paseo.sh/docs/connectivity)

Recommended progression:

1. **One-shot routing shortlist:** query configured hosts concurrently, key peers by host/channel/full ID, and retain titles, status, provider, and working directory. This is enough to route among explicitly described/pinned peers without promising an exact hierarchy.
2. **Continuously refreshed shortlist:** reuse the collector in a loop, publish a replacement JSON file atomically, and let the sending helper read it. This is polling with a known age, not instantaneous state. No system service installation is needed to prove it.
3. **Exact CLI hierarchy:** add preservation of workspace/project relationship IDs and absolute paths to Paseo CLI JSON projections, or a raw snapshot command. The underlying daemon already carries the IDs; no replacement directory model is needed.

If the user chooses an app-native integration instead, the smallest exact directory uses a client plugin's `useHosts()` and `getPaseoClient(serverId)`, fetches projects/workspaces/agents per online host, and joins their exact IDs. Public directory observations can keep the merged view current; terminals need periodic list refreshes. This differs from the current CLI-only instruction and depends on the app/plugin remaining active. A standalone SDK monitor would additionally need explicit endpoints/authentication and its own process lifecycle.

This recommendation is an engineering inference from the verified interfaces. It is not a claim that Paseo ships this standalone merged JSON directory today.

## Normalized directory requirements

For an exact directory, use IDs qualified by host identity; paths and display names are labels rather than join keys. Preserve projects without workspaces. Do not merge two workspaces because they share a directory. Represent agents and terminals as different endpoint kinds. Do not fabricate workspace/project relationships when the current CLI omits them.

Each host snapshot should record connection/reachability, collection start/end, last successful refresh, and separate collection errors. An unreachable host must not produce an empty fresh directory. Retain prior records as stale and exclude them from automatic sending until revalidated. Several list requests are separate observations, so tolerate a record being created or removed between them and report unmatched placement rather than inventing relationships.

An agent directory gives Paseo-registered session identity and status. A terminal ID identifies a shell endpoint; its name and working directory alone do not establish that Pi or Codex is currently accepting input. Terminal-based peers still need explicit registration/pinning and the existing skill's idle/delivery checks. Jev should see routing descriptions and eligible peers, not derive peer identity from terminal text.

## Remaining verification

- Establish the MBA's actual daemon endpoint and version and which client owns the authoritative configured-host list.
- Exercise installed commands against a reachable configured daemon; JSON projections were inspected in the package but no live record responses were obtained.
- Decide whether the required freshness justifies a persistent collector, and choose its owning host.
- Confirm the desired inventory means Paseo-managed sessions, explicitly pinned terminal agents, or all OS processes; the last requires separate registration/instrumentation.
- If automatic app-host enumeration is needed outside the app, prefer a supported export/CLI addition over coupling to private app storage. Public plugin host summaries intentionally do not export endpoint URLs.

## Evidence limits

No conclusion about the MBA's daemon availability follows from the default Linux daemon being stopped. Current public documentation and upstream `main` were inspected; identical version strings do not prove every remote app/daemon or packaged bundle implements every current-main detail.

## Installed 0.9.2 evidence

Two parallel investigators read packaged code under `~/.local/opt/Paseo/resources/app.asar` and CLI help. They did not read private registry contents, install packages, start daemons, query remote hosts, or send messages.

| Observation | Packaged source |
| --- | --- |
| `project ls --json` returns `projectId`, `name`, `kind`, `path` | `node_modules/@getpaseo/cli/dist/commands/project/shared.js:10` |
| `workspace ls --json` returns `workspaceId`, project display name, name, isolation, cwd; drops `projectId` | `node_modules/@getpaseo/cli/dist/commands/workspace/shared.js:11` |
| Agent list returns full `id` plus short ID, name, provider, thinking, status, shortened cwd, relative created time; drops `workspaceId` and project descriptor | `node_modules/@getpaseo/cli/dist/commands/agent/ls.js:68` |
| Agent inspect JSON also drops `workspaceId` and project descriptor | `node_modules/@getpaseo/cli/dist/commands/agent/inspect.js:82` |
| Terminal all-list forwards entries including `workspaceId` | `node_modules/@getpaseo/cli/dist/commands/terminal/ls.js:7` |
| Raw daemon agent projection already contains `workspaceId` | `node_modules/@getpaseo/server/dist/server/server/agent/agent-projections.js:60` |
| Installed daemon includes directory sync and advertises `directorySync: true` | `node_modules/@getpaseo/server/dist/server/server/directory-sync/index.js:4`; `websocket-server.js:1162` |

The renderer runtime supplies `useHosts()` and `getPaseoClient(serverId)` at `index-175a084f06a62a82744c7d8bac90f342.js:15325`. The host API adapter is at `:15280`; per-host directory sync is at `:15235`. Thus public host discovery and per-host synchronization are present in the installed app, not merely a new upstream proposal.

The host registry key is `@paseo:daemon-registry` in renderer storage (`:15111`); its persisted schema (`:15163`) includes host IDs/labels and connection alternatives. Connection data can contain passwords. Do not scrape/export the raw registry. Its existence does not establish which host entries are saved in the MBA's app. The public plugin summary deliberately excludes endpoints and credentials.

The app-managed daemon and CLI both default to `~/.paseo` unless their launch environment or explicit selectors override it. Desktop lifecycle ownership does not imply a separate home. A read-only default CLI status check reported `stopped` and `connectedDaemon: not_probed`; this only describes that selected local home.

The installed command surface has no host-list command or documented CLI bridge to the app registry. `workspace ls` pages through its results; agent `--global` expands workspace scope on one host and `--all` includes archived agents. A raw terminal listing cannot establish which agent program is running inside a terminal.
