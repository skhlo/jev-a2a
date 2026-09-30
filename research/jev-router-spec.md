# Jev router: design

Status: proposed, verified as an executable model on 2026-09-29 and 2026-09-30.
Not implemented against live Paseo, herdr or TypeSafe. This is the authoritative
design; the [original design](jev-router-design.html) is historical.

| Artifact                    | Role                                                                                                          |
| --------------------------- | ------------------------------------------------------------------------------------------------------------- |
| `router-core.js`            | Pure reducer implementing the contract below. No I/O, no built-in deployment.                                 |
| `router-example-config.js`  | One example deployment. The page and tests load it; nothing in the core depends on it.                        |
| `router-core.test.js`       | Scenario tests, an independent invariant oracle, random sequences. `node --test research/router-core.test.js` |
| `jev-router-prototype.html` | Interactive view over the core with the example deployment. Open directly in a browser.                       |

## The idea

Agent-to-agent messaging is prompt sending. The router sends the same prompt a
person would type into an agent's session, and adds two things the person would
otherwise carry in their head:

- **An envelope:** a task ID, the route the reply takes back, a deduplication
  key so nothing runs twice, and a check that the session is idle so nothing
  already running is interrupted.
- **A record:** one journal of what was sent to which session, what came back,
  and what is still waiting on someone.

Everything else about how work gets done belongs to the participants. The
router does not orchestrate, does not run workflows, does not hold a session
until a task finishes, and does not carry a topology: who exists, where they
run, who may address whom and the policy numbers are configuration, and a
deployment can change them without touching the router.

## One habit

**Start it through the router, steer it in the session.**

A registered participant's session stays open in Paseo or herdr, and the person
works in it natively while a task runs: reads, redirects, answers a question in
the conversation. None of that goes through the router. The router only needs
three things to stay true while someone is in a session:

1. It never sends to a session that is not idle, so it cannot interrupt a turn,
   whoever started it.
2. A person can **hold** a placement: while held, the router does not send to
   it even when idle. Holding is how a person says "I am typing here".
3. When a participant reports progress after asking a question, the question
   counts as settled. Answering in the session is the normal path; answering
   through the router is for the sender who is not sitting in front of it.

The pinned session in the journal doubles as the deep link: from a task, open
the session it went to.

## Where the router earns its place

- **Unaddressed requests.** "Do X" without naming who: Jev reads every
  participant's responsibility and picks one, or hands the choice back.
- **Sends nobody is watching.** Agent to agent, agent to service, across hosts,
  from a laptop that will be asleep when the answer comes. The envelope makes
  these safe to fire and forget.
- **Hand off and return.** The record answers "what did I start, where is it,
  what needs me" from any device, and keeps the reply even if the session is
  gone.

Typing directly into a session you are already looking at needs none of this,
and the design does not try to route it.

## Vocabulary

- **Principal:** an authenticated identity. A configured non-participant
  (`requester`: may submit, choose, answer, cancel; `operator`: may reconcile
  stuck deliveries, may not submit) or a participant acting through one of its
  sessions.
- **Participant:** an agent or a service with a stable id, a responsibility
  text that Jev reads in full, one or more hosts, and an `idempotent` flag
  saying whether its adapter deduplicates by the router's message key.
- **Placement:** a participant on one host, with one current **session**, a
  `ready` flag (observed idle since the router's last send) and a `hold` flag
  (a person has it). Each delivery is pinned to the session it was sent to.
- **View:** any surface through which a person submits and reads the record.
  A view authenticates as a requester.

The core is a functional core: the shell authenticates callers, calls Jev and
adapters, and feeds their results back as events. `commands(state)` tells the
shell what to do next (`judge` or `deliver`); the core performs no I/O.
`initial(config)` validates the configuration and refuses an invalid one.

## Configuration

| Key            | Decides                                                                                                                                                                                                                                         |
| -------------- | ----------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------- |
| `policy`       | `threshold` in (0, 1] for dispatching on a judgment; `deadline`, `maxText` and `maxOpenTasks`, all positive. Validation refuses anything else, plus unknown participant kinds, duplicate or empty hosts, and permissions that name unknown ids. |
| `principals`   | Non-participant identities and their role: `requester` or `operator`. Names are free; a household may have several requesters.                                                                                                                  |
| `participants` | `id`, `name`, `kind` (`agent` or `service`), `hosts`, `idempotent`, `responsibility`. The responsibility text is what Jev sees, so write it as an ownership rule with what it is not for.                                                       |
| `permissions`  | For each principal or participant, which participants it may address. Absent means nobody. Jev only ever chooses among a sender's permitted participants.                                                                                       |

Not configuration, by design: message identity, the delivery state machine,
the eligibility rule, reply correlation, and what each event may do.

Also not the router's: which persistent positions exist, their skills, memory,
definition of done and output destination. Those are a deployment's design and
are recorded with it. A participant learns about a repository or a vault from
that repository's own files and from the position's own memory, not from a
router field. A router-kept history of past tasks per scope was considered and
is parked until a case needs it.

## Contract

Events (`reduce(state, event) → state`, with `state.last` = `{ ok, code?, message }`):

| Event                                                                | Who                                          | Effect                                                                                                                                                                                                                                                                          |
| -------------------------------------------------------------------- | -------------------------------------------- | ------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------- |
| `submit { by, messageId, text, to?, hosts?, via? }`                  | a requester or a current participant session | Records a task under `source/messageId`. Same key and content returns the same receipt; different content is a `conflict`. `to` skips Jev.                                                                                                                                      |
| `judged { taskId, choice, probabilities, model }` / `judgeFailed`    | shell, after Jev                             | One judgment per request. Selects the recipient, or asks the sender (`no_owner`, `low_confidence`, `invalid_judgment`, `routing_unavailable`) with the permitted participants ranked in Jev's order as suggestions.                                                             |
| `choose { by, taskId, to }`                                          | original sender                              | Resolves a pending recipient choice once.                                                                                                                                                                                                                                       |
| `attempt { deliveryId }`                                             | shell                                        | Commits `attempting`, pins the session and marks it busy **before** the adapter call. Rejected unless eligible.                                                                                                                                                                 |
| `adapterResult { deliveryId, messageId, outcome }`                   | shell                                        | `accepted`, `unknown`, or `not_sent`. `not_sent` re-queues; the request may move to another session only if no earlier attempt on this one could have arrived. `unknown` is retried with the same key only for a deduplicating adapter. Applies only to an attempt in progress. |
| `update { by, taskId, messageId, inReplyTo, kind, text }`            | pinned session                               | `working`, `question`, `completed`, `failed`. Proves receipt. `working` after a question settles the question. Replies to earlier messages are kept as history only.                                                                                                            |
| `answer { by, taskId, messageId, questionId, text }`                 | original sender                              | Consumes the open question and queues the answer to the same session. Rejected once the question was settled in the session.                                                                                                                                                    |
| `cancel { by, taskId }`                                              | original sender                              | Only while nothing may have reached the participant.                                                                                                                                                                                                                            |
| `resolve { by: operator, deliveryId, messageId, outcome, evidence }` | operator                                     | Closes an open pinned delivery as `finished` or `not_sent`. Never resends.                                                                                                                                                                                                      |
| `observe { placement, ready?, hold?, session? }`                     | shell's presence refresh; a person's hold    | Readiness, hold and session replacement. A new session is neither ready nor held until an observation says so.                                                                                                                                                                  |
| `restart` / `tick { now }`                                           | router                                       | Interrupted attempts become `unknown`; deadlines fire.                                                                                                                                                                                                                          |

Queries: `commands(state)` is the shell's work list; `needsYou(state,
principal)` is a person's. A requester's list holds its own open tasks that
wait for a recipient (`choose`, with Jev's ranked suggestions) or an answer
(`answer`, one per delivery). An operator's list holds pinned deliveries the
router can no longer move by itself (`resolve`): an unknown send with no
deduplicating retry, a pin to a replaced session, or a send still holding a
session after its task ended. The oracle checks that each list names exactly
the decisions that principal can act on right now, and that every item's event
succeeds.

A delivery is **eligible** when its task is open; its current message is
pending, or unknown with a deduplicating adapter; it is unpinned or pinned to
the placement's current session; no other send to the placement is unconfirmed
(`attempting` or `unknown`); the placement is not held and is ready; and, if
unpinned, no older unpinned delivery waits for the same placement.

### Rules and why

| Rule                                                                                                                                                                                                | Why                                                                                                                                                                                           |
| --------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------- | --------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------- |
| Send only to an idle, unheld session; never while another router send to it is unconfirmed. An attempt marks the session busy until a newer observation; a replaced session is busy until observed. | A Paseo send to a running agent cancels its turn, and Paseo has no inbox. A stale "idle" would let the next send interrupt a turn.                                                            |
| Open tasks do not block new ones. The participant decides serial or parallel.                                                                                                                       | An agent can hand work to subagents, end its turn, take the next task and reply per task. Correlation by task and message ID keeps interleaved replies apart.                                 |
| One recipient per request; an addressed request may name several hosts of that recipient, one delivery each. Never fan out on ambiguity.                                                            | Lets one service be asked on several machines while keeping "never send to multiple suggestions".                                                                                             |
| Jev: one Choice over the sender's permitted participants plus `none`, full responsibility text; dispatch only if the chosen probability meets the threshold (0.9, provisional).                     | TypeSafe's Choice docs advise the full list over a shortlist for small rosters; staged context is for hundreds of options. Addressed requests use zero judgments.                             |
| The sender is the authenticated caller, never a field. Only the pinned session can reply, and only to a message sent on that delivery.                                                              | Anything else lets a stray or replayed message steer a task.                                                                                                                                  |
| One outstanding question per delivery.                                                                                                                                                              | Keeps "what needs me" a single item per task.                                                                                                                                                 |
| `unknown` is retried only through a deduplicating adapter, on the same session, when idle, before the deadline. Otherwise a matching reply or an operator `resolve` closes it.                      | With Paseo receipts a same-key retry confirms or makes the first send; it cannot run twice. A receipt stuck `pending` after a daemon crash stays unknown forever, so the operator path stays. |
| The deadline fails the task and expires never-sent deliveries; an unconfirmed send keeps holding its session until it ends or is resolved.                                                          | A retry after the deadline could start work nobody waits for; freeing the session could let the next send interrupt a turn that did start.                                                    |
| Cancel only while nothing may have reached the participant.                                                                                                                                         | Nothing can stop a turn already handed over. Steering it is done in the session.                                                                                                              |
| A late final result after the deadline is kept as evidence; the task stays failed.                                                                                                                  | The record must not lose work, and a terminal state must not flip.                                                                                                                            |

### Status and A2A v1.0 mapping

| Router status                  | Meaning                                           | A2A task state                                 |
| ------------------------------ | ------------------------------------------------- | ---------------------------------------------- |
| routing                        | Waiting for Jev                                   | `TASK_STATE_SUBMITTED`                         |
| queued / delivering            | Waiting for a ready session / attempt in progress | `TASK_STATE_SUBMITTED`                         |
| working                        | A participant has the message                     | `TASK_STATE_WORKING`                           |
| uncertain                      | A send may or may not have arrived                | `TASK_STATE_WORKING` (detail in metadata)      |
| needs_recipient / needs_answer | The sender must choose or answer                  | `TASK_STATE_INPUT_REQUIRED`                    |
| completed / failed / canceled  | Terminal                                          | `TASK_STATE_COMPLETED` / `FAILED` / `CANCELED` |

A2A v1.0 has no "unknown" state, so uncertainty travels in extension metadata.
Router fields (recipient, judgment, delivery outcomes) go under an extension
URI in `metadata`, declared in the Agent Card; extensions may not add top-level
fields. A2A leaves duplicate `messageId` handling undefined, so the receipt
rule is the router's own documented behavior. Messages to terminal tasks are
rejected (`UnsupportedOperationError`); late results are kept without reopening
the task.

## Invariants

Checked by the oracle in `router-core.test.js` after every event of every test,
including 400 random sequences of 90 events each, half with a non-deduplicating
participant. The oracle derives eligibility, in-flight, status and judgment
validity itself rather than calling the core, so a wrong rule cannot approve
its own behavior. A coverage guard requires every status, every accepted event
type, both kinds of resend, and every rejection code and blocking reason
(including `held`) and every kind of "needs you" item to occur, so the run
cannot pass vacuously.

1. One task per `source/messageId`; receipts never change.
2. At most one unconfirmed send per placement.
3. A message is attempted again only right after a definite `not_sent`, or right after `unknown` when its adapter deduplicates.
4. A new attempt happens only through an `attempt` event for a delivery the oracle finds eligible, and leaves the placement not ready. `commands()` offers exactly the eligible deliveries.
5. Addressed requests use zero judgments; judged recipients passed the threshold with valid output; recipients are always permitted for the sender.
6. `completed` means every delivery returned `completed` from its pinned session.
7. Terminal states, recipients, closed deliveries and send histories never change.
8. A delivery that may have reached a session stays pinned to it; the pin is released only when every attempt on it was definitely `not_sent`.
9. A rejected event changes nothing but the log.
10. Canceled tasks never had a possibly-delivered attempt; terminal tasks have no sendable work.

Mutation checks: 38 deliberately broken guards each fail the suite, covering
the in-flight gate, readiness, hold, the needs-you list, FIFO, retry rules (deduplication,
deadline, replaced session), restart replay, the unpin-after-retry bug found in
review, reply session and message correlation, the settled-question rule,
threshold boundary, probability sum, operator rules, cancel, deadline,
permissions, double answers, time direction, and configuration validation.
Eight eligibility mutants are caught by the random run alone. Removing the
rollback in `reduce` is equivalent today, because every handler validates
before mutating; the rollback stays so that property does not depend on
handler order.

## Adapters (verified against installed tools)

Evidence: Paseo 0.9.2 and herdr 0.8.2 help, schema and packaged source, read-only.

**Paseo: use the SDK.** The adapter calls `@getpaseo/client`
`sendAgentMessage(agentId, text, { messageId })`, never the CLI, which
generates a random message ID per call and so cannot retry safely. Verified in
the packaged 0.9.2 source:

- The daemon keeps a receipt per `(agentId, messageId)` on disk under
  `$PASEO_HOME/agent-requests`, written atomically: `pending` before the send,
  `completed` after the run starts. No expiry was found.
- A repeat with the same key and payload: `completed` → no-op success; no
  receipt → sends now; `pending` → `agent_request_outcome_unknown`; different
  payload → `agent_request_key_conflict`. The fingerprint covers the prompt and
  `activeTurnBehavior`, so a retry must send identical text.
- Use a globally unique key per send, for example `deliveryId/messageId`.
- Sending to a running agent **cancels the active turn and clears pending
  permissions** (default `activeTurnBehavior: "interrupt"`; `steer` injects
  into the turn). There is no inbox and no reject-if-busy mode.

Therefore:

- `ready` requires a fresh `idle` status and no pending permissions, observed
  after the router's last send to that session. Agent status is
  `initializing | idle | running | error | closed`; pending permissions come
  from inspect or wait results.
- The router is the only **automatic** sender to a registered session. A person
  in the session is not a race the router can see, which is what the hold is
  for. How a hold is raised from a view or from Paseo's own UI is not designed
  yet.
- Outcome mapping: success → `accepted`; agent-resolution failure → `not_sent`;
  `agent_request_outcome_unknown`, timeout, disconnect or a run-start failure →
  `unknown`. A key conflict is a router bug.
- A receipt left `pending` by a daemon crash, or by a run that never reported
  starting, answers `unknown` forever. The operator path covers it.
- The pinned Paseo agent ID is the deep link from a task to its session.

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
message IDs is the only reply path. The envelope the participant receives must
therefore tell it the task ID, the message ID and how to reply, in the prompt
text itself.

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

## Still to model

- **Partial results for multi-host service requests.** A request to a service
  on several hosts fails as a whole at the deadline if one host never became
  ready. A deployment with a machine that sleeps wants "checked two of three;
  the third was unavailable".

## Open decisions

1. Threshold and deadline values: provisional 0.9 and 100 model ticks until
   labeled routing examples and real task durations exist.
2. Authentication for views and participant sessions, including remote devices
   reaching the router host.
3. How a person raises and releases a hold from where they are typing.
4. Router-owned service adapters are assumed to deduplicate by message key like
   Paseo. If one cannot, mark it `idempotent: false`.

## Not verified

Everything live: Jev routing accuracy and latency, adapter acknowledgments,
receiver enrollment, remote return paths, persistence and crash behavior of a
real journal, throughput. The model proves the contract is consistent and that
its guards hold; it does not prove the adapters behave as their help and source
suggest. The next experiment is one addressed request and reply through a real
Paseo session with a durable journal. This model is JavaScript because it is
throwaway; a real router is written in TypeScript against the same contract.

## Example deployment

`router-example-config.js` models the setup this design was drawn from. It is
one instance of the contract, not part of it.

| Machine | Role in the example                                                                                                                                                                             |
| ------- | ----------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------- |
| mba     | The portable window into every other device, and the "needs you" list. Runs views plus a dotfiles-inspection placement; no reasoning agent, since a laptop sleeps and travels.                  |
| mbp     | Always-on Linux host: the router and its journal, and the coding orchestrator. Its session stays open in Paseo, so tasks start through the router and are steered there.                        |
| mini    | Knowledge-work host: the vault and its agents. The example models one "knowledge assistant"; the vault's own `AGENTS.md` defines the real positions, and the responsibility text comes from it. |
| lab01   | Incus host with a VM service; no reasoning agent.                                                                                                                                               |

Principals: `you` (every view, any device) as requester, and `operator`.
Permissions: `you` may address all four participants; the orchestrator may ask
the two services; nobody else may address anyone. Coding handoffs between the
person's own sessions and the orchestrator go through the git remote.

Deployment decisions taken on 2026-09-30, outside the contract:

- Review lenses such as a "CIO" are skill packs used inside the vault agent's
  session, not positions. A lens becomes a position only if it needs its own
  memory and address.
- Vault tooling that lands in a repository (skills, scripts, templates) is the
  coding orchestrator's work. The vault meta agent keeps vault structure and
  asks the orchestrator through the router, which adds
  `knowledge: ["orchestrator"]` to permissions when that repository is set up.
- Vault status moves forward by agents up to 전문 검토 대기; only the person
  moves 검토 완료 → 확정/폐기. Items in those two states are the vault's
  contribution to the "needs you" list. The rule lives in the vault's own
  `AGENTS.md`.
