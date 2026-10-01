# Jev router: design

Status: verified as an executable model on 2026-09-29 and 2026-09-30, then
built in TypeScript under `router/` and run live across two Paseo hosts and
TypeSafe's Jev the same day. This is the authoritative
design; the [original design](jev-router-design.html) is historical. herdr is
not connected.

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

1. It sends only to a session it has just seen idle, so it does not interrupt
   a turn it can see. A turn a person starts between that observation and the
   send is the one race left, and the hold is what closes it.
2. A person can **hold** a placement: while held, the router does not send to
   it even when idle. Holding is how a person says "I am typing here". A hold
   belongs to the person, so it outlives a restarted session. How a hold is
   raised from where the person is typing is still open (decision 3).
3. When a participant reports progress after asking a question, the question
   counts as settled, and an answer the router had queued but not yet sent is
   withdrawn. Answering in the session is the normal path; answering through
   the router is for the sender who is not sitting in front of it.

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

| Key            | Decides                                                                                                                                                                                                                                                                                                                                                                                                 |
| -------------- | ------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------- |
| `policy`       | `threshold` in (0, 1] for dispatching on a judgment; `deadline`, `maxText` and `maxOpenTasks`, all positive. Validation refuses anything else, plus unknown participant kinds, duplicate or empty hosts, and permissions that name unknown ids.                                                                                                                                                         |
| `principals`   | Non-participant identities and their role: `requester` or `operator`. Names are free; a household may have several requesters.                                                                                                                                                                                                                                                                          |
| `participants` | `id`, `name`, `kind` (`agent` or `service`), `hosts`, `idempotent`, `responsibility`. The responsibility text is what Jev sees, so write it as an ownership rule with what it is not for, followed by a few example requests in every language requests arrive in (measured: three Korean examples raised Korean probabilities by 0.17 on average; a note saying "requests may be Korean" did nothing). |
| `permissions`  | For each principal or participant, which participants it may address. Absent means nobody. Jev only ever chooses among a sender's permitted participants.                                                                                                                                                                                                                                               |

### Connecting a participant

The same steps each time an agent joins the roster; the vault was the first
(decided 2026-09-30, generalized 2026-10-01):

1. The participant's owner writes the responsibility text, next to the
   agent's own `AGENTS.md`, from its role section and its glossary: an
   ownership rule, what it is not for, then a few example requests in the
   languages its users write. Names that identify companies, clients or
   business areas stay out; the text goes to an external API. The owner
   refreshes it when `AGENTS.md` changes. The router config copies it.
2. Add labeled requests for the participant to `router/eval/requests.jsonl`,
   phrased differently from the examples in the text, with some that should
   go elsewhere or to `none`.
3. Run `router eval --config` on a candidate config that carries the new
   text and the grant, since eval judges the participants the requester may
   address: no wrong dispatch at the configured threshold on the whole set,
   since a new text shifts every other participant's probabilities too.
4. Then make the candidate the live config. Until the grant is live nobody
   can address the participant, and Jev never sees it.

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
| `submit { by, messageId, text, to?, hosts?, via? }`                  | a requester or a current participant session | Records a task under `source/messageId`. Same key and content returns the same receipt; different content is a `conflict`. `to` skips Jev; without it, a sender permitted to address nobody is refused.                                                                         |
| `judged { taskId, choice, probabilities, model }` / `judgeFailed`    | shell, after Jev                             | One judgment per request. Selects the recipient, or asks the sender (`no_owner`, `low_confidence`, `invalid_judgment`, `routing_unavailable`) with the permitted participants ranked in Jev's order as suggestions.                                                             |
| `choose { by, taskId, to }`                                          | original sender                              | Resolves a pending recipient choice once.                                                                                                                                                                                                                                       |
| `attempt { deliveryId }`                                             | shell                                        | Commits `attempting`, pins the session and marks it busy **before** the adapter call. Rejected unless eligible.                                                                                                                                                                 |
| `adapterResult { deliveryId, messageId, outcome }`                   | shell                                        | `accepted`, `unknown`, or `not_sent`. `not_sent` re-queues; the request may move to another session only if no earlier attempt on this one could have arrived. `unknown` is retried with the same key only for a deduplicating adapter. Applies only to an attempt in progress. |
| `update { by, taskId, messageId, inReplyTo, kind, text }`            | pinned session                               | `working`, `question`, `completed`, `failed`. Proves receipt. `working` after a question settles the question. A reply to the message before an unsent queued answer withdraws that answer. Other replies to earlier messages are kept as history only.                         |
| `answer { by, taskId, messageId, questionId, text }`                 | original sender                              | Consumes the open question and queues the answer to the same session. Rejected once the question was settled in the session.                                                                                                                                                    |
| `cancel { by, taskId }`                                              | original sender                              | Only while nothing may have reached the participant.                                                                                                                                                                                                                            |
| `resolve { by: operator, deliveryId, messageId, outcome, evidence }` | operator                                     | Closes an open pinned delivery as `finished` or `not_sent`. Never resends.                                                                                                                                                                                                      |
| `observe { placement, ready?, hold?, session? }`                     | shell's presence refresh; a person's hold    | Readiness, hold and session replacement. A new session is not ready until an observation says so; a hold stays until released.                                                                                                                                                  |
| `restart` / `tick { now }`                                           | router                                       | Interrupted attempts become `unknown`; deadlines fire.                                                                                                                                                                                                                          |
| `configured { config }`                                              | router                                       | The configuration in force from here on; invalid ones are refused. Recorded first and on every change, so replay uses the rules of the time.                                                                                                                                    |

Queries: `commands(state)` is the shell's work list; `needsYou(state,
principal)` is a person's. A requester's list holds its own open tasks that
wait for a recipient (`choose`, with Jev's ranked suggestions) or an answer
the router can still deliver (`answer`, one per delivery on a live session).
An operator's list holds pinned deliveries the router can no longer move by
itself (`resolve`): an unknown send with no deduplicating retry, a pin to a
replaced session, or a send left unconfirmed after its task ended. The oracle
restates both lists from this paragraph, compares them after every event, and
checks that every item's event succeeds.

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
| Jev: one Choice over the sender's permitted participants plus `none`, full responsibility text; dispatch only if the chosen probability meets the threshold (0.75; decision 1).                     | TypeSafe's Choice docs advise the full list over a shortlist for small rosters; staged context is for hundreds of options. Addressed requests use zero judgments.                             |
| The sender is the authenticated caller, never a field. Only the pinned session can reply, and only to a message sent on that delivery.                                                              | Anything else lets a stray or replayed message steer a task.                                                                                                                                  |
| One outstanding question per delivery.                                                                                                                                                              | Keeps "what needs me" a single item per task.                                                                                                                                                 |
| `unknown` is retried only through a deduplicating adapter, on the same session, when idle, before the deadline. Otherwise a matching reply or an operator `resolve` closes it.                      | With Paseo receipts a same-key retry confirms or makes the first send; it cannot run twice. A receipt stuck `pending` after a daemon crash stays unknown forever, so the operator path stays. |
| The deadline ends the task with its verdict and expires never-sent deliveries; an unconfirmed send keeps holding its session until it ends or is resolved.                                          | A retry after the deadline could start work nobody waits for; freeing the session could let the next send interrupt a turn that did start.                                                    |
| Cancel only while nothing may have reached the participant.                                                                                                                                         | Nothing can stop a turn already handed over. Steering it is done in the session.                                                                                                              |
| A task's verdict counts the deliveries that returned `completed` when it ended: all → `completed`, some → `partial`, none → `failed`. `final` records `completed` of `of`.                          | A request to a service on three hosts where one sleeps should end as "two answers, one unavailable", with the answers in the record, not as a failure.                                        |
| A late final result after the deadline is kept as evidence; the verdict does not change.                                                                                                            | The record must not lose work, and a terminal state must not flip.                                                                                                                            |

### Status and A2A v1.0 mapping

| Router status                  | Meaning                                           | A2A task state                              |
| ------------------------------ | ------------------------------------------------- | ------------------------------------------- |
| routing                        | Waiting for Jev                                   | `TASK_STATE_SUBMITTED`                      |
| queued / delivering            | Waiting for a ready session / attempt in progress | `TASK_STATE_SUBMITTED`                      |
| working                        | A participant has the message                     | `TASK_STATE_WORKING`                        |
| uncertain                      | A send may or may not have arrived                | `TASK_STATE_WORKING` (detail in metadata)   |
| needs_recipient / needs_answer | The sender must choose or answer                  | `TASK_STATE_INPUT_REQUIRED`                 |
| completed / partial            | Every host answered / some did                    | `TASK_STATE_COMPLETED` (detail in metadata) |
| failed / canceled              | No host completed / withdrawn before delivery     | `TASK_STATE_FAILED` / `TASK_STATE_CANCELED` |

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
participant. The oracle derives eligibility, in-flight, status, judgment
validity, the verdict and the needs-you lists itself rather than calling the
core. That catches a core rule that drifts from the spec, not an oracle that
restates the core's mistake: the review of this redo found the verdict oracle
had copied the core's formula and passed a timed-out task with no deliveries
as `completed`, so the verdict check is now stated by cases. A coverage guard
requires every status, every accepted event type, both kinds of resend, every
rejection code and blocking reason, a held pinned send, a withdrawn answer and
every kind of "needs you" item to occur, so the run cannot pass vacuously.

1. One task per `source/messageId`; receipts never change.
2. At most one unconfirmed send per placement.
3. A message is attempted again only right after a definite `not_sent`, or right after `unknown` when its adapter deduplicates.
4. A new attempt happens only through an `attempt` event for a delivery the oracle finds eligible, and leaves the placement not ready. `commands()` offers exactly the eligible deliveries.
5. Addressed requests use zero judgments; judged recipients passed the threshold with valid output; recipients are always permitted for the sender.
6. `completed` means every delivery returned `completed` from its pinned session; `partial` and `failed` count exactly the deliveries that had, late results excluded.
7. Terminal states, recipients, closed deliveries and send histories never change.
8. A delivery that may have reached a session stays pinned to it; the pin is released only when every attempt on it was definitely `not_sent`.
9. A rejected event changes nothing but the log.
10. Canceled tasks never had a possibly-delivered attempt; terminal tasks have no sendable work.

Mutation checks are run by hand while a rule is added and are not kept in the
repository, so the record here is a description, not a count. Guards broken
one at a time and caught by the suite: the in-flight gate, readiness, hold
(including for pinned sends), FIFO, retry rules (deduplication, deadline,
replaced session), restart replay, the unpin-after-retry bug found in review,
reply session and message correlation, the settled-question rule and answer
withdrawal, the verdict by cases, the needs-you lists, threshold boundary,
probability sum, operator rules, cancel, deadline, permissions, double
answers, time direction and configuration validation. Most eligibility, verdict
and needs-you mutants are caught by the random run alone. Removing the
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

`router eval` asks the same question for each line of a labeled set
(`router/eval/requests.jsonl`: text, expected recipient, language) with the
texts of the configuration it is given, and prints each verdict and, per
threshold, how many requests would be dispatched, how many of those wrongly,
and how many handed back. A confident `none` is a hand-back, not a dispatch.
A request Jev gave no usable answer for is reported and fails the run.
Nothing is recorded; the set is the evidence a text or a threshold changes on.

## Open decisions

1. Threshold and model: decided 2026-10-01 at 0.75 on `jev-1.13.0`, from
   `router eval` on 40 labeled requests (Korean-heavy, 13 of them written to
   be mis-routed) against the vault's own responsibility text: 36 correct,
   22 dispatched at 0.60 and 20 at 0.75 with no wrong dispatch, the worst
   wrong participant choice at 0.51. Rule: the most dispatches with zero
   wrong ones, at the top of a plateau and with a margin of about 0.2 over
   the worst wrong choice seen. Re-run when the roster or a text changes,
   and before moving the pin.
2. Authentication of participant replies: a local reply is trusted on
   `PASEO_AGENT_ID`; a reply over HTTP is trusted on the shared
   `ROUTER_TOKEN`, so any holder of the token can reply as any participant.
   Board actions are authenticated by Tailscale identity and
   are not affected.
3. Raising a hold from where the person is typing: today a hold is set by
   hand, from the CLI or the board. Detecting that the person has taken
   over a session is not built.
4. Router-owned service adapters are assumed to deduplicate by message key
   like Paseo. If one cannot, mark it `idempotent: false`.

## Record and configuration

The journal carries the configuration in force: the router records a
`configured` event on a fresh journal and whenever the core part of the
configuration (policy, participants, principals, permissions) changes. A
replay judges each event by the rules that applied when it happened, so a
deployment can raise the threshold or add a participant without making its
own record unreadable. Each task keeps the participants its sender could
address when it asked, each judgment the threshold it was held to, and each
delivery whether its participant deduplicated at the time. Placements are
only ever added: a removed participant's open deliveries stay readable. A
record older than its first `configured` line was written under that first
configuration, so the replay starts from it, not from today's (found
2026-10-01, when lowering the threshold made a September hand-back into a
dispatch and the choice that followed it unreadable).

## Verified live, and not

Verified on 2026-09-30: the envelope round trip
through Paseo on the same and on a second host; the idle gate; crash
recovery with the same key and one prompt in the agent's transcript;
questions and answers pinned to a session; Jev dispatch, abstention and
low-confidence hand-back with latency of 250 to 300 ms; the board and its
actions over the tailnet. Not exercised live: a host that is down for a
whole run, token rotation, a participant on another host submitting work,
`resolve` from the board, throughput.

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
  moves 검토 완료 → 확정/폐기. A view shows items in those two states next to
  the router's "needs you" list; the router itself knows nothing of them. The
  rule lives in the vault's own `AGENTS.md`.
- `router serve` runs as a systemd user service on the router host
  (`router/jev-router.service`, decided 2026-10-01): restarts on failure,
  logs to journald, starts at boot under linger. It binds the tailnet
  address, which at boot arrives after the service; `serve` waits for it
  instead of failing. One instance per host: the second finds the port taken
  and says so. Deliveries still happen only on events and runs; the service
  adds no schedule.
- The vault participant's responsibility text is authored next to the vault's
  `AGENTS.md`, from its role section and the `CONTEXT.md` glossary, with
  example requests in Korean, and is refreshed when those change. The router
  config copies it; the vault owns it. Folder names
  that identify companies or business areas stay out of it, since the text
  goes to an external API.
