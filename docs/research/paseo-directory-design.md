# Minimal SDK directory for the Jev router

Design explored 2026-09-27 by three sub-agents. This pass uses the Paseo SDK as requested. Jev's speed is accepted from the user's testing; a comparison benchmark is outside this design.

## Recommendation

Keep the directory in memory inside the ongoing router helper. The router creates one authorized Paseo SDK client per configured host, refreshes peer records in the background, gives Jev a compact snapshot, and delivers the original message through the selected host's client.

Start with one directory module exporting `snapshotPeers()`. It borrows clients rather than owning another connection manager. The router owns connections, the refresh loop, the current snapshot, and shutdown. There is no need for a separate directory process, database, disk cache, or HTTP interface to prove this design.

This is an engineering recommendation, not a feature already shipped by Paseo. Paseo supplies the per-host records. Its public `PaseoApi` interface is implemented by both standalone `PaseoClient` instances and app-borrowed clients. [SDK source](https://github.com/getpaseo/paseo/blob/main/packages/client/src/index.ts), [SDK reference](https://paseo.sh/docs/sdk/reference)

```text
Paseo clients for configured hosts
             |
     background snapshot refresh
             |
     in-memory routing directory
             |
incoming text -> one Jev choice -> selected host client sends original text
```

## Designs compared

1. **Standalone directory manager:** `startDirectory()` owns connections, refreshes, and shutdown; callers use `snapshot()` and `close()`. It hides lifecycle work but overlaps with the router's own client lifecycle. Useful if the directory will eventually serve multiple callers.
2. **App-native directory hook:** `useHosts()` discovers configured hosts and `getPaseoClient(serverId)` borrows their authenticated connections. A mounted router surface owns the directory. This minimizes host setup, but depends on that surface and the app remaining active. Exporting the directory to an external helper would not export the borrowed transport connections. [Plugin host discovery](https://paseo.sh/docs/plugins/reference#discover-hosts-and-target-another-host)
3. **Borrowed-client snapshot module:** `snapshotPeers(hosts, terminalPeers)` normalizes complete host snapshots. The existing router keeps the result and schedules refreshes. This has the smallest interface and can be used with either standalone or app clients. Recommended for the first implementation.

The third design concentrates pagination, joins, and partial-failure handling in one module without adding a second lifecycle owner. Keep the app-native option if automatic app host discovery becomes the deciding requirement.

## Proposed interface

This is a design sketch, not an implemented or type-checked integration. `PaseoApi` is a verified SDK export; the directory types and function below are proposed.

```ts
import type { PaseoApi } from "@getpaseo/client";

type Host = {
  id: string;
  label: string;
  api: PaseoApi | null;
};

type TerminalPeer = {
  hostId: string;
  id: string;
  description: string;
};

type Peer = {
  key: string; // Encoded tuple [hostId, channel, id].
  host: { id: string; label: string };
  project: { id: string; label: string } | null;
  workspace: { id: string; label: string } | null;
  channel: "agent" | "terminal";
  id: string;
  name: string;
  cwd: string;
  status: string | null;
  description: string;
  observedAt: number;
};

type DirectorySnapshot = {
  peers: readonly Peer[];
  hosts: readonly {
    id: string;
    observedAt: number | null;
    error: string | null;
    terminalError: string | null;
  }[];
};

declare function snapshotPeers(
  hosts: readonly Host[],
  terminalPeers?: readonly TerminalPeer[],
): Promise<DirectorySnapshot>;
```

Agent title, project, workspace, and host provide the first routing description. Explicit responsibilities can be overlaid when titles do not distinguish peers. Keep IDs host-qualified and terminal registrations session-scoped; the directory must not invent a role from terminal contents.

## Smallest collection implementation

Per host, read **agents and workspaces**, following every page. A separate project request is unnecessary for routing: workspace records already carry the exact project ID and display name. Fetch terminal inventory only when that host has explicitly registered terminal peers. Inventorying empty projects can be added separately if required. [Protocol schemas](https://github.com/getpaseo/paseo/blob/main/packages/protocol/src/messages.ts)

Verified SDK operation names and request shapes:

```ts
// allPages is a proposed private helper, not a Paseo method.
const [workspaces, agents] = await Promise.all([
  allPages(page => api.workspaces.list({ page })),
  allPages(page => api.agents.list({
    filter: { includeArchived: false },
    page,
  })),
]);

// Only needed for explicitly registered terminal peers.
const terminals = await api.terminals.list();
```

`page` accepts `{ limit: 200, cursor?: string }`. Agent and workspace responses contain `entries` and `pageInfo`, including `nextCursor` and `hasMore`. Omit the agent `scope` option to cover the selected daemon rather than restrict results to its active workspace. Reject inconsistent or repeating cursors rather than publishing a truncated list as complete. [SDK reference](https://paseo.sh/docs/sdk/reference), [Protocol schemas](https://github.com/getpaseo/paseo/blob/main/packages/protocol/src/messages.ts)

The module's implementation would:

1. Collect hosts concurrently and catch failures independently.
2. Fetch complete agent/workspace lists for each host.
3. Map workspaces by `workspace.id`.
4. Join `agent.workspaceId` or `terminal.workspaceId` to that map.
5. Read `workspace.projectId`, `projectDisplayName`, `name`, and `workspaceDirectory` for exact ancestry and labels.
6. Normalize agent entries from their `agent` field, apply any explicit descriptions, and include only registered terminal peers.
7. Return a replacement snapshot and host diagnostics.

The agent listing's accompanying project descriptor uses `projectKey`; it is not a substitute for `workspace.projectId`. Missing parents stay unresolved. Never infer exact joins from matching paths or display names. [Protocol schemas](https://github.com/getpaseo/paseo/blob/main/packages/protocol/src/messages.ts)

## Refresh and availability

The first implementation uses a sequential background refresh loop. Each pass resolves current host clients, collects records, and replaces the in-memory snapshot. The message path reads memory rather than waiting for inventory requests. Refresh cadence and maximum accepted snapshot age are explicit configuration, not SDK guarantees.

Polling gives a known delay. Paseo also supports agent/workspace observations through `list({ subscribe: {} })`, with snapshots followed by updates and reconnect recovery. Those can replace polling behind the same module if stricter freshness is needed. They add observation release, update reconciliation, and reconnect ordering. Terminals still need snapshot refreshes; no terminal directory subscription is documented in the public interface. [SDK events](https://paseo.sh/docs/sdk/events)

Required behavior:

- A failing or unavailable host contributes diagnostics and no current routing candidates. Previous records may remain visible as stale diagnostics, but cannot silently remain eligible.
- If a snapshot exceeds the configured age limit, the router stops using its peers for automatic dispatch until refreshed.
- Terminal collection errors do not disable successful agent routing on that host.
- Separate lists are not a transactional snapshot. Preserve unresolved placement and retry on the next pass rather than fabricate relationships.
- Encode peer keys from `[hostId, channel, id]`; identical IDs on two hosts remain distinct.
- Terminal inventory establishes an endpoint, not that an agent is ready for input. The terminal-send path still verifies the pinned peer and readiness.
- After Jev selects a peer, resolve it against the current eligible directory and current host connection before sending. A choice made from an older snapshot does not authorize delivery to a removed or unavailable peer.

## Host setup and credentials

Standalone SDK clients need explicitly configured host connections. They do not automatically inherit the app's registry. Reuse authorized connection configuration already available to the router host; do not copy provider credentials or export private app storage. Neither credentials nor SDK client objects belong in the data supplied to Jev. [SDK overview](https://paseo.sh/docs/sdk)

The app-native alternative avoids endpoint/authentication setup by borrowing current app connections. However, public host summaries expose identifiers, labels, and connection status rather than connection URLs, and borrowed clients are not serializable. A JSON export alone therefore cannot provide a standalone helper with a usable delivery connection. No supported generic app-to-terminal-helper bridge was found in this investigation. [Plugin host discovery](https://paseo.sh/docs/plugins/reference#discover-hosts-and-target-another-host)

## Implementation scope and verification

The first code pass needs one snapshot module, one private paginator, and the router's refresh loop. Use the same host-client map for delivery. Begin with addressable Paseo agents; include explicitly registered terminal peers only when their delivery path is required.

Meaningful checks for that implementation are full pagination, exact workspace/project joins, duplicate IDs across hosts, removal on refresh, one failed host alongside a healthy host, stale snapshot exclusion, and terminal failures that leave agent routing intact. Exercise the final collector against authorized live hosts before claiming a working cross-host directory.

This pass produced a design only. No dependencies were added, host connections opened, peers contacted, or services started. The MBA endpoint and live SDK responses remain unverified. The earlier installed-source investigation is recorded in [paseo-live-directory.md](paseo-live-directory.md).
