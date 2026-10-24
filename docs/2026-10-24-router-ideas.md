# Router ideas, 2026-10-24

Five ideas, highest value first, drawn from the record (2026-09-30 to
2026-10-24) and from running the router on four hosts. The ideas and
what was still open in the maintainer's local tickets 009-028 are both
here; those tickets are closed ([below](#closed-tickets)).

## The record in numbers

- 6,931 journal entries and 198 tasks: 183 completed, 9 failed, 5
  canceled, 1 working.
- 222 send results: 220 accepted, 2 unknown. 107 notices: 99 accepted,
  8 not sent.
- Jev chose the recipient for 18 of the 198 tasks. Every other task
  named its recipient; most traffic is agent to agent.
- Time to the last reply: median 2 min, 90th percentile 34 min. Time to
  the first update: median 1.4 min, 90th percentile 13 min.
- 3 of the 9 failures were early tests. 4 of the other 6 ended on the
  6-hour deadline (idea 3).

Delivery is sound. What fails is the work around it: the cost of reading
the record, sessions that are replaced, and tasks that wait without a
word.

## 1. Make the record cheap to read

The router's own resource use comes close to making it unusable.

**What happens (measured 2026-10-24):**

- `reduce` in the core deep-copies the whole state, every task and the
  whole log, for each event. Folding the record therefore costs time
  that grows with the square of its length.
  - Folding today's 6,931 entries takes 20 s of CPU, 97% of it in
    `structuredClone`.
  - On 2026-10-06, 2,470 entries took 2.6 s (ticket 024's probe). The
    record grew 2.8 times since, and the time 7.7 times, which is 2.8
    squared.
- Every router-host command except `serve` folds the whole record from
  the start, while it holds `journal.lock`. That includes `status`,
  `submit`, `roster repoint` and a local `reply`. Each therefore costs
  at least 20 s, and a command that waits behind two others runs out of
  the 90 s lock wait. That is how dotfiles-host@mbp's reply to T193
  failed on 2026-10-24, behind repeated `router status` calls.
- At today's rate, about 290 entries a day, the record doubles by
  mid-November. A fold then takes about 80 s, and any command that waits
  behind one fails on the lock.
- `serve` folds once at each start: about 15 s of CPU in its first 30 s,
  in the service log of every restart. After that it folds only new
  lines, but each event still copies the whole state.
- **Memory:**
  - `serve` holds about 350 MB resident.
  - systemd reports peaks of 0.75 GB within 30 s of each restart, and
    0.88 to 1.4 GB over longer runs (27 runs since 2026-10-18). On
    2026-10-01 a run peaked at 129 MB.
  - A fold on its own peaks at 222 MB, so the rest is not explained yet.
- Each run opens a new ssh connection to each remote host (ticket 023).
  With the 30 s poll, that is about 8,600 ssh handshakes a day for three
  hosts.

**Shape:**

- **Copy on write in the core.** An event copies only the task,
  placement or session it changes. The log is shared, or capped in the
  state. A rejected event returns the previous state, which no one
  mutates. The core's tests and the replay check hold the meaning
  unchanged.
- **One process folds.** Router-host commands post to `serve` on
  loopback, as reply hosts already post over HTTP. Then only `serve`
  holds a fold. `status` and `needs-you` read that fold and take no
  lock.
- **Then measure memory again.** If ssh still costs, keep each host's
  connection across runs.

**Done when:**

- Today's record folds in under a second.
- Folding twice the entries takes about twice the time.
- No read on the router host holds the lock.
- `serve`'s daily memory peak has been measured again.

## 2. Follow a replaced session, and let the new one join

**Evidence:**

- 16 sessions were replaced from 2026-09-30 to 2026-10-19, 13 of them
  dotfiles placements.
- 3 more were replaced on 2026-10-23 and 2026-10-24: dotfiles-host@vps,
  then dotfiles@mba twice. Each needed a repoint by hand.
- dotfiles@mba read missing until it was repointed.
  - T188 asked dotfiles-host@mbp to send a request to it. That request
    could not be delivered, and T188 failed on its deadline.
  - The new mba agent read the docs, concluded it could not bind itself,
    and stopped.

**Shape (ticket 025 step 2, decided 2026-10-19):**

- **Opt-in** per participant; dotfiles and dotfiles-host first.
- **Trigger:** the bound session is gone, meaning its terminal is
  missing or its agent is archived or missing. A busy, idle or closed
  session does not trigger it, nor does a terminal whose CLI exited.
- **Each poll** applies the rule that `router roster repoint` without a
  session applies today (step 1, #67):
  - one candidate is bound;
  - the config is written with one backup;
  - `serve` keeps running, where a repoint restarts it today.
- **Decided rules:**
  - A closed agent is not a candidate, and a bound closed agent is not
    gone: a send resumes it.
  - Only Claude Code and Codex may become the participant.
  - A tie leaves the placement not ready, its candidates shown on the
    board.
  - A spent session is never bound again.
  - Open deliveries stay with the old session.
- **Each bind** shows on the board and in `serve`'s log.
- **Check first** whether the plugin's `agent.closed` event (Paseo
  0.11) is a better trigger than the next poll.
- **New: `router join <participant>`.** The new session runs it from its
  own host. It applies the same rule with the caller as the only
  candidate. The host's token proves the host, and the caller's folder
  must be the placement's recorded folder. This settles a tie the poll
  cannot.
- **Not covered (from 025):**
  - a side session in the same folder, which makes a tie;
  - a terminal whose shell moved elsewhere;
  - a terminal that runs `ssh` to a CLI on another host;
  - a CLI switch inside the same terminal;
  - an old agent left unarchived, which keeps the work.

## 3. No silent 6-hour failures

**Evidence.** In each of these four failures, the sender heard nothing
until the deadline:

| Task | What happened                                                                              |
| ---- | ------------------------------------------------------------------------------------------ |
| T77  | Completed, but after its deadline. It had asked a question and sent two `working` updates. |
| T126 | Never delivered: its Codex terminal never read ready (ticket 026).                         |
| T180 | Accepted, never answered: Codex's auto-review refused the replies (T184).                  |
| T188 | Accepted, never answered: it waited on a request to a missing placement (idea 2).          |

On 2026-10-24, too, a reply failed on the lock and the agent went idle
without trying again.

**Shape:**

- **Not ready for too long.** When a delivery has waited 15 minutes
  (a policy key) on a placement that is not ready, missing or gone, the
  router tells the sender. It also adds a needs-you item: "waits on X:
  missing since …". Today needs-you covers only choose, answer and
  resolve.
- **Idle without a reply.** When a session accepted a delivery and went
  idle with no reply or update, the router reminds it once, in the
  session. If it is still silent, a needs-you item follows.
- **Moving tasks live on.** A `working` update pushes the deadline back,
  so a task that is moving does not fail. The limit on how far is still
  to decide.
- **The deadline notice says why.** It names which of these held.

## 4. Short replies, with details by reference

**Evidence:**

- T184: Codex's auto-review refused three detailed rollout receipts as
  sensitive data leaving the host. Only short replies passed, and T180
  failed this way.
- Rollouts are much of the traffic: 68 of the 198 tasks went to
  dotfiles-host.

**Shape:**

- **`router reply --attach <file>`.** The file stays on the replying
  host. The record holds its path, size and hash.
- **`router fetch <task>`,** run by the requester, pulls the file over
  the ssh the router already uses and checks the hash. The requester
  starts the transfer, so the replying agent's auto-review never sees it
  leave.
- **The envelope** tells Codex to reply with a summary and attach the
  rest.
- **An alternative (ticket 024):** the plugin's `agent.create` hook could
  give each new agent an MCP reply tool, in place of `router reply` in
  bash. That avoids Codex's sandbox escalation, but only for agents
  created after the install, on hosts with the plugin.

## 5. Warn before sending to a placement in poor shape

**Evidence.** On 2026-10-24, three things went unnoticed until a ping
(T193) asked for them:

- dotfiles-host@mbp was at 86% of its context.
- The dotfiles checkouts on mini and vps were 7 commits behind main.
- vps's checkout had uncommitted changes.

**Shape:**

- The router's telemetry already holds each session's context use
  (`used`, `max`) and its checkout's branch, `dirty`, `ahead` and
  `behind`.
- At a send, a context near full or a checkout that is dirty or behind
  adds a warning, to the envelope and to the task on the board.
- Optionally, a rollout task is held until its checkout is current.

## Carried over from the tickets

Each item is still open; the ticket it came from is named.

- **009, a second judge:** waiting for another decision model.
  - The comparison runs on the labeled set with `router eval`, Korean
    especially.
  - It runs behind the interface `judge(question) → JudgeResult`.
  - A judge that returns one answer and a confidence must say how it was
    mapped onto probabilities.
- **011, a hold set from the session:** not planned; the spec's open
  decision 3.
- **018, Pi in a Paseo terminal:** Codex is done (#40); Pi is not
  started.
  - **The ready rule** was probed on Pi 0.87.1. Pi is ready when:
    - its activity is not `working`;
    - the last two rows made only of `─` are two apart, with a blank row
      between them and at most four rows below the lower one;
    - the cursor is on the blank row at column 0, visible or not.
  - **Before building:** re-probe on the current Pi.
  - **If Codex's escalation delay costs:** a Codex rules file that
    allows only `router reply` and `router answer`.
  - **An alternative:** herdr inside a Paseo terminal, which gives
    stable names and state. It still has no message key.
- **019, a closed agent after a daemon restart:** since #27, a closed
  session counts as ready, but a cold one left closed until a request
  resumes it has not been seen live. Check it the next time a daemon
  restart leaves an agent placement closed.
- **022, more commands from a reply host:**
  - Later, in this order:
    - `status` and `needs-you`, scoped to the host's own sessions;
    - `cancel`.
  - Never: `observe`, `resolve`, `run`, `serve`, `eval` or `usage`.
- **023, a dropped host:** acceptance 3, telemetry that stays fresh
  across one of mba's drops, has not been seen yet.
- **024, the plugin's later steps:**
  - **An event source on every host:** the plugin wakes `serve` when a
    turn ends, with the host's token, and adds timeline rows.
  - **Paseo's channel** (`invokePluginRpc`) in place of the events door
    and the host tokens.
  - **Paseo's relay** in place of the ssh tunnels. Still open: where the
    pairing's credentials live on the router host, and the relay runs on
    the internet.
  - **The HTML board** stays until the plugin matches it.
- **025, step 2:** idea 2.
- **GitHub issue #69** is open: on the router host, a session that omits
  `--as` is recorded as a person.

## Closed tickets

The spec cites some of these numbers.

| Ticket | Subject                                     | Outcome                                             |
| ------ | ------------------------------------------- | --------------------------------------------------- |
| 009    | A second judge behind the same interface    | Waiting; carried over                               |
| 011    | Holding a session from where the person is  | Not planned; carried over                           |
| 018    | Pi and Codex in a Paseo terminal            | Codex in #40; Pi carried over                       |
| 019    | Loose ends from the design participant      | One item carried over                               |
| 022    | One router command on every host            | Done in #51-#56                                     |
| 023    | A run hangs when a host drops off           | Fixed in #57; acceptance 3 carried over             |
| 024    | The router as a Paseo plugin                | #58-#62; the later steps carried over               |
| 025    | A placement follows its session             | Step 1 in #67; step 2 is idea 2                     |
| 026    | A terminal's visible screen, not scrollback | Done in #66                                         |
| 027    | Codex agents are told to escalate           | Done in #71                                         |
| 028    | Repoint recomputes `idempotent`             | Done in #71; dotfiles and dotfiles-host read `true` |
