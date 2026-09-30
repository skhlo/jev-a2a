# Jev router: contract

Status: proposed, verified as an executable model on 2026-09-29 and 2026-09-30.
Not implemented against live Paseo, herdr or TypeSafe. This document is the
authoritative design of the router as a general tool. The
[original design](jev-router-design.html) is historical; where the two differ,
this one records the decision and the reason.

| Artifact                    | Role                                                                                                          |
| --------------------------- | ------------------------------------------------------------------------------------------------------------- |
| `router-core.js`            | Pure reducer implementing this contract. No I/O, no built-in deployment.                                      |
| `router-example-config.js`  | One example deployment. The page and tests load it; nothing in the core depends on it.                        |
| `router-core.test.js`       | Scenario tests, an independent invariant oracle, random sequences. `node --test research/router-core.test.js` |
| `jev-router-prototype.html` | Interactive view over the core with the example deployment. Open directly in a browser.                       |

## What the router is

A small always-on process with one journal that carries requests between
**principals** and **participants** and brings each reply back to its sender.
Jev decides who owns an unaddressed request; code handles everything else.
The router is not a topology: participants, their hosts, who may address whom,
and the policy numbers are configuration, and a deployment can change them
without touching the router.

Terms:

- **Principal:** an authenticated identity. Either a configured non-participant
  (`requester`, who may submit, choose, answer and cancel; or `operator`, who
  may reconcile uncertain deliveries and may not submit) or a participant acting
  through one of its sessions.
- **Participant:** an agent or a service with a stable id, a responsibility
  description that Jev reads in full, one or more hosts, and an `idempotent`
  flag saying whether its adapter deduplicates by the router's message key.
- **Placement:** a participant on one host, with one current **session**. The
  router pins each delivery to the session it sent to.
- **View:** any surface through which a person submits and reads. Views
  authenticate as a requester and never prompt a router-owned session directly,
  because that races the router.

The core is a functional core: the shell authenticates callers, calls Jev and
adapters, and feeds their results back as events. `commands(state)` tells the
shell what to do next (`judge` or `deliver`). The core never performs I/O.
`initial(config)` validates the configuration and refuses an invalid one.

## Configuring a deployment

| Key            | Decides                                                                                                                                                                                   |
| -------------- | ----------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------- |
| `policy`       | `threshold` for dispatching on a judgment, `maxJudgments` per request, `deadline`, `maxText`, `maxOpenTasks`.                                                                             |
| `principals`   | Non-participant identities and their role: `requester` or `operator`. Names are free; a household may have several requesters.                                                            |
| `participants` | `id`, `name`, `kind` (`agent` or `service`), `hosts`, `idempotent`, `responsibility`. The responsibility text is what Jev sees, so write it as an ownership rule with what it is not for. |
| `permissions`  | For each principal or participant, which participants it may address. Absent means nobody. Jev only ever chooses among a sender's permitted participants.                                 |

What is not configuration, by design: message identity, the delivery state
machine, the eligibility rule, reply correlation, and what each event may do.
Those are the contract below.

## Decisions made while merging

Structure was the priority: each rule below exists because a scenario fails
without it.

| Topic          | Decision                                                                                                                                                                                                                                                  | Why                                                                                                                                                                                                                                |
| -------------- | --------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------- | ---------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------- |
| Jev            | One Choice with full responsibilities plus `none`; dispatch only if the chosen option's probability is at least the threshold (0.9, provisional). Otherwise the sender chooses.                                                                           | TypeSafe's staged "progressive context" is for large rosters (182 skills); its Choice docs advise giving the full list rather than a shortlist. Four participants fit in one call. The prototype's two-stage shortlist is removed. |
| Busy recipient | Queue in the router, per placement, in arrival order. Send only when a fresh observation says the session is idle, and never while another of the router's sends to it is unconfirmed. An accepted send marks the session busy until a newer observation. | A Paseo send to a running agent cancels its turn, and Paseo has no inbox. Holding the session until the task finishes is unnecessary: once the turn has started and ended, the next task cannot interrupt anything.                |
| Concurrency    | Open tasks do not block new ones. A participant decides how much it runs at once: an agent can hand a task to background subagents, end its turn, take the next task, and reply to each when done.                                                        | Serial versus parallel is the participant harness's decision, not transport policy. Correlation by task and message ID keeps interleaved replies apart.                                                                            |
| Fan-out        | One recipient per request. An explicitly addressed request may name several hosts of that recipient; each host gets its own delivery. Never fan out on ambiguity.                                                                                         | Keeps the original "never send to multiple suggestions" rule while allowing one service to be asked on several machines at once.                                                                                                   |
| Authorization  | The sender principal is the authenticated caller, never a field. Permissions decide who may address whom. Only the delivery's pinned session can reply.                                                                                                   | Replaces the unauthenticated `source` field in the earlier prototype.                                                                                                                                                              |
| Questions      | One outstanding question per delivery; the sender's answer is queued to the same pinned session.                                                                                                                                                          | Agents need clarification; without it the recipient could not ask within the task.                                                                                                                                                 |
| Uncertainty    | `unknown` is retried only through an adapter that deduplicates by the router's message key, only on the same pinned session, only when idle and before the deadline. Otherwise a matching reply or an operator `resolve` closes it.                       | With Paseo SDK receipts a same-key retry either confirms an earlier send or makes the first one; it cannot run twice. A receipt stuck `pending` after a daemon crash stays unknown on every retry, so the operator path remains.   |
| Deadline       | The task fails at its deadline; never-sent deliveries expire; an unconfirmed send keeps holding its session until it ends or is resolved, and is not retried.                                                                                             | A retry after the deadline could start work nobody is waiting for; freeing the session could let the next send interrupt a turn that did start.                                                                                    |
| Cancel         | Only while nothing may have reached the participant: never attempted, or every attempt definitely `not_sent`.                                                                                                                                             | Nothing can stop a turn the router has already handed over.                                                                                                                                                                        |
| Removed        | Repository and device-scope fields on requests; view state; workflow stages in router state.                                                                                                                                                              | They belonged to the orchestrator or the view, not the router.                                                                                                                                                                     |

## Contract

Events (`reduce(state, event) → state`, with `state.last` = `{ ok, code?, message }`):

| Event                                                                | Who                                          | Effect                                                                                                                                                                       |
| -------------------------------------------------------------------- | -------------------------------------------- | ---------------------------------------------------------------------------------------------------------------------------------------------------------------------------- |
| `submit { by, messageId, text, to?, hosts?, via? }`                  | a requester or a current participant session | Records a task under `source/messageId`. Same key and content returns the same receipt; different content is a `conflict`. `to` skips Jev.                                   |
| `judged { taskId, choice, probabilities, model }` / `judgeFailed`    | shell, after Jev                             | Selects the recipient or asks the sender (`no_owner`, `low_confidence`, `invalid_judgment`, `routing_unavailable`).                                                          |
| `choose { by, taskId, to }`                                          | original sender                              | Resolves a pending recipient choice once.                                                                                                                                    |
| `attempt { deliveryId }`                                             | shell                                        | Commits `attempting`, pins the session and marks it busy **before** the adapter call. Rejected unless eligible.                                                              |
| `adapterResult { deliveryId, messageId, outcome }`                   | shell                                        | `accepted`, `unknown`, or `not_sent`. `not_sent` re-queues; `unknown` is retried with the same key only for a deduplicating adapter. Applies only to an attempt in progress. |
| `update { by, taskId, messageId, inReplyTo, kind, text }`            | pinned session                               | `working`, `question`, `completed`, `failed`. Proves receipt. Replies to earlier messages are kept as history only.                                                          |
| `answer { by, taskId, messageId, questionId, text }`                 | original sender                              | Consumes the open question and queues the answer to the same session.                                                                                                        |
| `cancel { by, taskId }`                                              | original sender                              | Only while nothing may have reached the participant.                                                                                                                         |
| `resolve { by: operator, deliveryId, messageId, outcome, evidence }` | operator                                     | Closes an open pinned delivery as `finished` or `not_sent`. Never resends.                                                                                                   |
| `observe { placement, ready?, session? }`                            | shell's presence refresh                     | Readiness and session replacement.                                                                                                                                           |
| `restart` / `tick { now }`                                           | router                                       | Interrupted attempts become `unknown`; deadlines fire.                                                                                                                       |

A delivery is **eligible** when its task is open; its current message is
pending, or unknown with a deduplicating adapter; its placement is ready; it is
unpinned or pinned to the placement's current session; no other send to the
placement is unconfirmed (`attempting` or `unknown`); and, if unpinned, no older
unpinned delivery waits for the same placement.

### Status and A2A v1.0 mapping

| Router status                  | Meaning                                           | A2A task state                                 |
| ------------------------------ | ------------------------------------------------- | ---------------------------------------------- |
| routing                        | Waiting for Jev                                   | `TASK_STATE_SUBMITTED`                         |
| queued / delivering            | Waiting for a ready session / attempt in progress | `TASK_STATE_SUBMITTED`                         |
| working                        | A participant has the message                     | `TASK_STATE_WORKING`                           |
| uncertain                      | A send may or may not have arrived                | `TASK_STATE_WORKING` (detail in metadata)      |
| needs_recipient / needs_answer | The sender must choose or answer                  | `TASK_STATE_INPUT_REQUIRED`                    |
| completed / failed / canceled  | Terminal                                          | `TASK_STATE_COMPLETED` / `FAILED` / `CANCELED` |

A2A v1.0 has no "unknown" state, so uncertainty travels in extension
metadata. Router fields (recipient, judgment, delivery outcomes) go under an
extension URI in `metadata`, declared in the Agent Card; extensions may not add
top-level fields. A2A leaves duplicate `messageId` handling undefined, so the
receipt rule above is the router's own documented behavior. Messages to terminal
tasks are rejected (`UnsupportedOperationError`); late participant results are
kept as evidence without reopening the task.

## Invariants

Checked by the oracle in `router-core.test.js` after every event of every test,
including 400 random sequences of 90 events each, half with a non-deduplicating
participant. A coverage guard requires every status, every accepted event type,
and both kinds of resend, so the run cannot pass vacuously:

1. One task per `source/messageId`; receipts never change.
2. At most one unconfirmed send per placement.
3. A message is attempted again only right after a definite `not_sent`, or right after `unknown` when its adapter deduplicates.
4. A new attempt happens only through an `attempt` event for an eligible delivery, and leaves the placement not ready.
5. Addressed requests use zero judgments; judged recipients passed the threshold with valid output; recipients are always permitted for the sender.
6. `completed` means every delivery returned `completed` from its pinned session.
7. Terminal states, recipients, closed deliveries and send histories never change.
8. A pinned session changes only after a definite `not_sent`.
9. A rejected event changes nothing but the log.
10. Canceled tasks never had a possibly-delivered attempt; terminal tasks have no sendable work.

Mutation check: all 16 deliberately broken guards fail the suite (in-flight gate,
retry without deduplication, send leaving the session ready, readiness, restart
replay, reply session, threshold, FIFO, stale reply, ack overwrite, permissions,
double answer, deadline, cancel, retry after deadline, replaced session). An
earlier run showed that removing the rollback in `reduce` is equivalent today,
because every handler validates before mutating; the rollback stays so that
property does not depend on handler order.

## Adapter requirements (verified against installed tools)

Evidence: Paseo 0.9.2 and herdr 0.8.2 help, schema and packaged source, read-only.

**Paseo: use the SDK.** The adapter calls `@getpaseo/client`
`sendAgentMessage(agentId, text, { messageId })`, never the CLI. The CLI
generates a random message ID per call, so it cannot retry safely. Verified in
the packaged 0.9.2 source:

- The daemon keeps a receipt per `(agentId, messageId)` on disk under
  `$PASEO_HOME/agent-requests`, written atomically: `pending` before the send,
  `completed` after the run starts. No expiry was found.
- A repeat with the same key and payload: `completed` → no-op success; no
  receipt → sends now; `pending` → `agent_request_outcome_unknown`; different
  payload → `agent_request_key_conflict`. The payload fingerprint covers the
  prompt and `activeTurnBehavior`, so a retry must send identical text.
- Use a globally unique key per send, for example `deliveryId/messageId`.
- Sending to a running agent **cancels the active turn and clears pending
  permissions** (default `activeTurnBehavior: "interrupt"`; the other option,
  `steer`, injects into the turn). There is no inbox and no reject-if-busy mode.

Therefore:

- `ready` requires a fresh `idle` status and no pending permissions, observed
  after the router's last send to that session. Agent status is
  `initializing | idle | running | error | closed`; pending permissions come
  from inspect or wait results.
- The router must be the only sender to its sessions; the idle check and the
  send race. Humans submit through the router from their views.
- Outcome mapping: success → `accepted`; agent-resolution failure → `not_sent`;
  `agent_request_outcome_unknown`, timeout, disconnect or a run-start failure →
  `unknown`. A key conflict is a router bug.
- A receipt left `pending` by a daemon crash, or by a run that never reported
  starting, answers `unknown` forever. The operator path covers it.
- Participants that work in parallel must keep delegated work alive after their
  turn ends and reply per task through the router.

This applies to the router's adapter. It is separate from the host rule that
agents operating Paseo interactively use the CLI rather than Paseo MCP.

**herdr.** `agent prompt` refuses a `blocked` agent before sending
(`agent_blocked`), but pastes into a `working` agent. Success means text reached
the PTY, not that the agent took it; there is no receipt, turn ID or
idempotency, so a herdr participant is configured `idempotent: false`: its
`unknown` sends are never repeated. `ready` requires `idle` or `done` and
`interactive_ready`; every herdr timeout is `unknown`; `state_change_seq` can
distinguish a stall from a start.

Neither tool correlates replies. The explicit `update` call carrying task and
message IDs remains the only reply path.

## Jev request

One call per unaddressed request: `POST https://api.typesafe.ai/v1/systemone`,
bearer auth held by the router. `judgmentQuestion()` builds it: request text in
`state` (it is untrusted input), routing rubric in `instructions`, one criterion
per permitted participant plus `none`. The response gives `choice`,
`probabilities` (sum 1) and `confidence`. The core defines confidence as the
chosen option's probability, which TypeSafe explicitly allows. Record the
response `model` (for example `jev-1.13.0`) and pin that version once thresholds
are tuned, since `jev-latest` moves. Limits: 255 options, 64k tokens per request.

A Choice picks relatively and can confidently select a near miss. If labeled
examples show that, add a relevance question (a Noul) to the same call rather
than a second call. Not added now: no evidence yet. TypeSafe handles non-English
input "not equally well", so tune the threshold on requests in the languages
actually used.

## Router-wide additions still to model

- **A "needs you" view.** The statuses exist (`needs_recipient`, `needs_answer`,
  uncertain deliveries awaiting an operator), but nothing collects them into one
  list per requester. That list is what a person's own device should show.
- **Partial results for multi-host service requests.** Today a request to a
  service on several hosts fails as a whole at the deadline if one host never
  became ready. A deployment with a machine that sleeps wants "checked on two of
  three hosts; the third was unavailable" as a result.

## Open decisions

1. Threshold and deadline values: provisional 0.9 and 100 model ticks until
   labeled routing examples and real task durations exist.
2. Authentication mechanism for views and participant sessions, including remote
   devices reaching the router host.
3. Router-owned service adapters are assumed to deduplicate by message key like
   Paseo. If one cannot, mark it `idempotent: false`.

## Not verified

Everything live: Jev routing accuracy and latency, adapter acknowledgments,
receiver enrollment, remote return paths, persistence and crash behavior of a
real journal, throughput. The model proves the contract is consistent and that
its guards hold; it does not prove the adapters behave as their help and source
suggest. The next experiment is the original design's first slice: one addressed
request and reply through a real Paseo session with a durable journal.

## Example deployment

`router-example-config.js` models the setup this design was drawn from. It is
one instance of the contract, not part of it; a deployment is expected to
change it.

| Machine | Role in the example                                                                                                                                                                                                      |
| ------- | ------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------ |
| mba     | The person's portable window and decision inbox. Runs views only, plus a dotfiles-inspection placement. No participant positions, since a laptop sleeps and travels.                                                     |
| mbp     | Always-on Linux host: the router and its journal, the coding orchestrator, and the person's own hands-on agent sessions. Sessions the person drives are never registered participants, so the router cannot prompt them. |
| mini    | Knowledge-work host: the vault and its agents. The example still models one "knowledge assistant"; the vault's own `AGENTS.md` defines the real positions, and its responsibility text should come from there.           |
| lab01   | Incus host with a VM service; no reasoning agent.                                                                                                                                                                        |

Principals: `you` (every view, any device) as requester and `operator`.
Permissions: `you` may address all four participants; the orchestrator may ask
the two services; nobody else may address anyone. Coding handoffs between the
person's own sessions and the orchestrator go through the git remote.

Position design (which persistent agents exist, their skills, tools, memory,
definition of done and output destination) is a deployment question. It is
recorded separately from this contract when decided.
