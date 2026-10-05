# The board's view model

The page is one rendering of a view model, and the model is published so
that a design can bind its template to the router's own field names.

## Getting it

The board returns the model as JSON to a client that asks for JSON: one
whose `Accept` header ranks `application/json` above `text/html`, or ranks
them equal and names JSON more exactly (`application/json, */*`). A browser
gets the page. `board.json` on the same address returns the model
regardless.

```sh
curl -H 'Accept: application/json' http://127.0.0.1:7678/
```

The JSON follows the page's identity rules: through Tailscale Serve it
names the viewer, and without a known login it has no actor.

## The contract

Three things make the contract, `jev-router-board/1`:

- the `BoardModel` type in `router/src/board.ts`, with `AgentSnapshot` and
  the sheet types (`Checkout`, `Subagents`, `Activity`) in
  `router/src/telemetry.ts` and `UsageView` with its parts in
  `router/src/usage.ts`; the names and shapes live there;
- the sample in `router/src/board.sample.json`: the model built from the
  board's test fixture (`router/src/board-fixture.ts`, `sampleJournal`: the
  fixture plus the minute after it, with a participant-sent task), so it
  holds no live request text and its usage is made up. After changing the
  model or the fixture, run
  `pnpm exec node src/board-sample.ts` in `router/`; a test fails until the
  committed sample matches;
- this page, for what a type cannot say: what `null` means where, how
  lists are ordered and capped, and the version rule.

Removing or renaming a field raises the major version in `version`; adding
one does not. Every time in the model is an ISO string, as the journal
records it.

## What the types cannot say

- `actor` is `null` when the request is not identified. `needsYou` lists,
  per principal, the items that wait on it: `choose` (with `reason`:
  `no_owner`, `low_confidence`, `invalid_judgment` or `routing_unavailable`,
  and `suggestions` in Jev's order), `answer` (the open question) and, for
  an operator, `resolve` (a send the router cannot confirm: `task_ended`,
  `session_replaced` or `unknown_send`). The sample has no `resolve` item.
- `placements` are the placements the router serves, keyed
  `participant@host`. `delivery` is the newest open delivery pinned to the
  current session, or `null`. Its `messageId` and `outcome` are those of
  the current send: the request, or the latest answer once one was sent.
  A delivery is pinned at the attempt, so the outcome may still be
  `attempting`; its `question` is `null` while none is open (answered, or
  never asked).
- `placements[].agent` is `null` when the telemetry file has no entry for
  the placement. `status` is Paseo's (`idle`, `running`, `initializing`,
  `error`, `closed`), or the router's `missing` (the daemon does not know
  the agent) and `unreachable` (the host could not be reached, failure in
  `error`). A `closed` session is a persisted one whose process is not
  running; a send resumes it, so it counts as ready unless the agent is
  archived. Every field but `seen`, `status` and `permissions` is `null`
  when the daemon reported nothing for it; a token count left out of a
  reported usage is `0`; `missing` and `unreachable` snapshots carry only
  `seen`, `status` and, for the latter, `error`. `attentionAt` for
  `finished` is when the last turn ended.
- The sheet fields `checkout`, `subagents` and `activity` are each `null`
  when the router did not read them (`telemetry.sheet` off, the session not
  live, or that read failed) and empty when it read nothing. `checkout` is
  the session's workspace from Paseo's list, joined by project key and
  workspace name, else by directory; `null` too when the list has no
  workspace for the agent. `pr.mergeable` is Paseo's word (`UNKNOWN`,
  `MERGEABLE`, `CONFLICTING`) or `null`, not a boolean. `subagents.counts`
  covers the session's whole history; `subagents.running` is the open ones,
  oldest first, at most twenty, with `title` the harness's type,
  `description` the brief's first line and `parent` another subagent's id
  or `null`. `activity.items` is the last eight timeline entries that are
  the session's own (the harness's calls to itself, such as a background
  command's completion notice, are left out, so fewer than eight can come
  back), oldest first, `text` cut to its first line and 160 characters,
  `tool` and `status` set for a tool call; `activity.turns` counts the
  user messages among those items, not the whole timeline; the whole timeline's counts
  and the subagents' own timelines are not held. `subagents` and
  `activity` are read only for a session seen `idle` or `running`: in
  Paseo 0.10 a timeline fetch resumes a closed session, and observing must
  not.
- `open` and `finished` are newest first; `finished` keeps the last ten.
  `routing` is `null` once a recipient is found or the task has ended. `judgments[].probabilities`
  is `null` when the judgment was not `valid`. `final` is `null` while the
  task is open; `final.by` is the principal who canceled it (only the
  sender may) or `null` when the router ended it.
- `deliveries[].waits` is why the send has not gone out, or `null` when
  nothing holds it back (it has gone, it ended, or it goes on the next
  run): `session_replaced`, `in_flight` (another send to the placement, or
  a notice to its session, is unconfirmed), `held`, `not_ready` or
  `queued_behind`, with `behind` the id of the delivery at the head of the
  placement's queue for the last and `null` otherwise. `end` is `null`
  while open; then its `reason` and, when recorded, `text`, `messageId`
  and `by`: the session that replied, or the operator who resolved it. The
  current `send` is the request, or the latest answer once one was sent.
- `via` is the placement a participant sender submitted from, `null` for a
  person's request. `notices` are what that sender is owed or was told, by
  `key` (`question/<delivery>/<id>`, `choose/<n>` or `final`), with
  `session` `null` before an attempt and `outcome` one of `pending`,
  `attempting`, `accepted`, `unknown` or `withdrawn`; empty for a person's
  request. The sample's T5, in `finished`, is one the orchestrator's
  session sent, with a withdrawn choice, an accepted question and a pending
  end.
- `log` is the router's last twenty lines; each task's `log` is its own, as
  `router status <task>` shows them. `times` maps message ids to when they
  were recorded. `telemetryAt` is `null` without telemetry.
- `usage` is `null` when the configuration has no `usage` section; the
  rail's Usage section and the usage pop-up are drawn from it alone. `at`
  is when the store's last refresh ended, `null` before the first; `every`
  is the seconds between refreshes. `accounts` are the configured ones in
  a fixed order (Codex, Claude, DeepSeek, OpenRouter), `kind`
  `subscription` or `api`, `url` the provider's own usage page.
- An account's `status` is `loading` before its first refresh ends,
  `ready`, `stale` (a reading kept after a failed refresh, older than ten
  minutes, timed more than a minute ahead, or past a window's reset) or
  `unavailable` (never read, or a reading of history alone). `reading` is
  `null` when the account was never read, and is otherwise the last one
  that succeeded, with its own `observedAt`; `checkedAt` is when the last
  refresh of the account ended, whatever its outcome. `error` is `null`
  after a refresh that succeeded, else the router's own sentence for the
  failure: provider error text and credentials never enter the model.
- `reading.allowance` says whether the reading holds a current allowance;
  `unavailable` means history alone, and its `windows` are then empty. A
  window's `usedPercent` is as reported (0 is a reading, not a default);
  `minutes`, its length, and `resetsAt` are `null` when the provider did
  not send them, and a window without both has no pace. A value the
  provider did not send is left out of `metrics`, never sent as `0`; a
  metric's `value` is a number, or words for one that is not a number
  (`"No management key"`, a plan name), and `unit` is a currency code
  (`USD`, `CNY`), a counted noun or `null`. The labels the view places by
  name (`Account balance`, `Balance`, `Key remaining`, `Key limit`,
  `Key allowance`, and the word "window" that ends a window's label) are
  `LABEL` and `WINDOW_SUFFIX` in `router/src/usage.ts`.
- `reading.details` is history behind the account, each with its own
  `observedAt` and `status` (stale after ten minutes, or when the account's
  last refresh failed), `throughDate` the last day it reports and `null`
  without one, and `tables` whose rows carry `null` for a value not
  reported. A column's `format` says what its cells are: `number`, `USD`,
  `date` (a calendar day), `name` (a model or provider as the provider
  wrote it) or `null` for words. A day with no data is an absent row, not
  a zero row. A sum over a value not reported, or one too large to count
  safely, is `null` in a row and left out of `metrics`, rather than
  undercounted.
