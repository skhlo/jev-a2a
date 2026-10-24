# Router ideas, 2026-10-24

Five ideas, highest value first, drawn from the record (2026-09-30 to
2026-10-24) and from running the router on four hosts. What was still open
in the maintainer's local tickets 009-028 is carried over here, and those
tickets are closed ([below](#closed-tickets)).

T-numbers (T188) are task ids in the maintainer's record. Three-digit
numbers (025) name the closed tickets. #-numbers are this repository's pull
requests and issues.

## The record in numbers

At its last entry, 2026-10-24T01:45:56Z:

- About 6,950 journal entries and 198 tasks: 184 completed, 9 failed, 5
  canceled, none working.
- Send outcomes: 222 send results, 220 accepted and 2 unknown. 108
  notices, 100 accepted and 8 not sent.
- 18 tasks named no recipient, and Jev's choice was used for 10 of them.
- The record credits 104 tasks to the person. At least one of them, T189,
  came from an agent that omitted `--as` (#69).
- For completed tasks, from submit to completion: median 2 min, 90th
  percentile 33 min. To the first update: median 1.4 min, 90th percentile
  13 min.
- 3 of the 9 failures were early tests. 4 of the other 6 failed on the
  6-hour deadline (idea 3).

Delivery is sound. What fails is the work around it: the router's own
cost, sessions that are replaced, and tasks that wait without a word.

## 1. Make the router cheap to run

Its own resource use comes close to making it unusable. There are two
causes, both measured on 2026-10-24. Folding the record costs CPU and
holds the lock; reading usage costs memory.

### Folding the record

**Evidence:**

- `reduce` in the core deep-copies the whole state, every task and the
  whole log, for each event, and a rejected event copies it twice. Folding
  the record therefore costs time that grows with the square of its
  length.
  - Folding the first quarter, half and all of the record (6,963 entries)
    took 1.5 s, 5.5 s and 20.7 s of CPU. Each doubling costs about 3.7
    times as much.
  - 97% of the full fold is in `structuredClone`.
- Each router-host command that opens the record folds it from the start
  while it holds `journal.lock`: `status`, `needs-you`, `run`, `submit`,
  `answer`, `choose`, `cancel`, `resolve`, `observe` and a local `reply`.
  - The ones that record an event, and `run`, then deliver, observing
    placements over SSH, before they let go.
  - `roster` folds without the lock. `eval`, `usage` and `host` do not
    fold.
- The lock is not a queue. A waiting command tries again every 100 ms and
  gives up after 90 s, so back-to-back holders can starve it.
  - On 2026-10-24, behind repeated `router status` calls, dotfiles-host@mbp's
    reply to T193 failed on the lock.
  - It landed about 11 minutes after the other two hosts' replies, once
    it was sent again.
- From 2026-10-06 to 2026-10-24 the record grew by about 250 entries a
  day. At that rate it doubles by late November, and a fold then takes
  about 80 s.
- `serve` folds once at each start. On 2026-10-20, with about 5,700
  entries, it used about 15 s of CPU in its first 30 s. After that it
  folds only new lines, but each event still copies the whole state.

**Shape:**

- **Copy on write in the core.** An event copies only the task, placement
  or session it changes. The log is shared, or capped in the state. A
  rejected event makes a shallow copy that changes only `last` and the
  log. The core's tests, and the fold's refusal of a recorded event that
  is rejected, hold the meaning unchanged.
- **One process folds.** Router-host commands post to `serve` on
  loopback, as reply hosts already post over HTTP. Then only `serve`
  holds a fold, and `status` and `needs-you` read it without the lock.

**Done when:**

- Today's record folds in under a second, and twice the entries take
  about twice the time.
- No read on the router host takes the lock.

### Reading usage

**Evidence:**

- Each [`usage`](../configuration.md#usage) reading starts two
  `codex app-server` processes, one for the limits and one for the
  history, at about 370 MB each. The maintainer's config reads all four
  accounts, 120 s after each reading ends. `serve` itself holds about 350 MB.
- systemd's memory peak per run went from about 320 MB to about 900 MB on
  2026-10-05, the day usage landed (#36). Since then, long runs peak at
  about 0.9-1.4 GB, and runs of 30 s at about 0.75 GB.

**Shape:**

- **Today, in the config:** leave `codex` out of `usage.accounts`, or
  raise `usage.every` (up to 3600 s). Both exist already.
- **In code:** both readings through one app-server.

**Done when:** a day's memory peak, from systemd, is at most `serve` plus
one app-server (about 0.75 GB), and about 0.35 GB with Codex usage off.

### SSH connections

Each run opens a new SSH connection to each remote host (ticket 023). The
maintainer's [`serve.poll`](../operating.md#when-the-router-looks) is 30 s
(the default polls nothing), so that is up to about 2,880 runs a day, and
up to about 8,600 connections for three hosts. Whether SSH
multiplexing shares them was not checked. Measure it again after the two
fixes above. If it still costs, keep each host's connection across runs.

## 2. Follow a replaced session, and let the new one join

**Evidence:**

- 19 sessions were replaced from 2026-09-30 to 2026-10-19, 16 of them
  dotfiles placements.
- On 2026-10-20, by repoint, two dotfiles placements moved to new
  terminals, then the four dotfiles placements moved to Codex agents.
- 3 more were replaced on 2026-10-23 and 2026-10-24: a dotfiles-host
  placement, then dotfiles@mba twice. Each needed a repoint by hand.
- The new dotfiles@mba agent read the docs, said in its session that it
  could not bind itself, and stopped.

**Shape (ticket 025 step 2, decided 2026-10-19).** On each poll, `serve`
applies the rule that
[`router roster repoint` without a session](../configuration.md#agents)
applies today. What changes:

- **Opt-in** per participant, for dotfiles and dotfiles-host only.
- **No command.** It acts only once the bound session is gone, as repoint
  judges it. A closed agent is not gone, since
  [a send resumes it](../operating.md#when-the-router-looks), and neither
  is a terminal whose CLI exited.
- **No restart.** `serve` writes the config as repoint does, and keeps
  running where a repoint restarts it.
- **A tie** leaves the placement not ready, its candidates shown on the
  board.
- **Each bind** shows on the board and in `serve`'s log.
- **Check first** whether the plugin's `agent.closed` event (Paseo 0.11)
  is a better trigger than the next poll.
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

**Done when (025):**

- With no command run, after a daemon restart too:
  - a new Claude Code or Codex session in the folder is bound, as the
    right CLI, and a ping round-trips;
  - a switch between Claude Code and Codex sets or clears `terminals`;
  - with no candidate, nothing changes, and the board says what it found.
- A tie is shown, not guessed.
- A busy or idle session is never replaced.

## 3. No silent 6-hour failures

**Evidence.** Each of these failed on its deadline. For T126, T180 and
T188, the sender heard nothing until then.

| Task | What happened                                                                                                                                                                  |
| ---- | ------------------------------------------------------------------------------------------------------------------------------------------------------------------------------ |
| T77  | A moving task: it asked a question, which reached the sender, and sent two `working` updates, then completed after its deadline.                                               |
| T126 | Never delivered: its Codex terminal never read ready (ticket 026).                                                                                                             |
| T180 | Accepted, never answered: Codex's auto-review refused the replies (T184).                                                                                                      |
| T188 | Accepted, never answered. It needed a request from dotfiles-host@mbp. That request (T189) omitted `--as`, so it was recorded as the person's, and its answer went there (#69). |

On 2026-10-24, too, a reply failed on the lock (idea 1), and the agent
went idle without trying again.

**Shape:**

- **Not ready for too long.** When a delivery has waited 15 minutes (a
  [`policy`](../configuration.md#policy) key) on a placement that is not
  ready, missing or gone, the router tells the sender. It also adds a
  needs-you item: "waits on X: missing since …". Today
  [`router needs-you`](../operating.md#when-nothing-moves) lists only
  choices, answers and resolves.
- **Idle without a reply.** When a session accepted a delivery and went
  idle with no reply or update, the router reminds it once, in the
  session. If it is still silent, a needs-you item follows.
- **Moving tasks live on.** A `working` update pushes the deadline back,
  so a task like T77 does not fail. The limit on how far is still to
  decide.
- **The deadline notice says why.** It names which of these held.

**Done when:** a scratch delivery that waits on a missing placement
reaches the sender and needs-you within the policy's wait, and a task
that sends `working` updates outlives its first deadline.

## 4. Short replies, with details by reference

**Evidence:**

- T184: Codex's auto-review refused three detailed replies, two questions
  and a receipt, as sensitive data leaving the host. Only short replies
  passed, and T180 failed this way.
- Rollouts are much of the traffic: 70 of the 198 tasks went to
  dotfiles-host, the rollout participant.

**Shape:**

- **`router reply --attach <file>`.** The file stays on the replying
  host. The record holds its path, size and hash.
- **`router fetch <task>`,** run by the requester, asks `serve`, which
  pulls the file over the SSH it already uses and checks the hash.
- **The envelope** tells Codex to reply with a summary and attach the
  rest.
- **The trade-off.** The details still leave the replying host, only
  later and on the requester's demand. The transfer is then outside the
  replying agent's turn, so its auto-review no longer judges it. Whether
  that is wanted is the person's decision. T184 inferred two routes the
  auto-review would allow, and tried neither: a person's turn that names
  the payload and its destination, or an answer through Codex's
  `request_user_input`.
- **An alternative (ticket 024):** the plugin's `agent.create` hook could
  give each new agent an MCP reply tool, in place of `router reply` in
  bash. That avoids Codex's sandbox escalation, but only for agents
  created after the install, on hosts with the plugin.

**Done when:** the person has decided the trade-off, and a detailed
rollout receipt from a Codex session reaches the requester.

## 5. Warn before sending to a session near its context limit or a stale checkout

**Evidence.** On 2026-10-24 a ping (T193) showed two hosts' checkouts of
one participant's repository behind its main branch, and the telemetry
showed one of them dirty. Nothing warned at the sends to them.

**Shape:**

- The router's telemetry already holds each session's context use
  (`used`, `max`) and its checkout's branch, `dirty`, `ahead` and
  `behind`, which the board shows on
  [the sheet](../board.md#the-sheet).
- `behind` comes from Paseo and counts from the checkout's last fetch, so
  a checkout that has not fetched can read current. The telemetry fetches
  before it counts, or the warning leaves `behind` out.
- At a send, a context near its limit or a checkout that is dirty or
  behind adds a warning, to the envelope and to the task on the board.
- Optionally, a rollout task is held until its checkout is current.

**Done when:** a send to a session near its context limit, or to a dirty
or behind checkout, shows the warning in the envelope and on the board.

## Carried over from the tickets

Each item is still open. An item not seen live moves into the spec's
[Verified live, and not](jev-router-spec.md#verified-live-and-not) once it
runs.

- **009, a second judge:** waiting for another decision model. The first
  candidate had no public documentation.
  - It is compared with Jev on the labeled set with `router eval`, Korean
    especially, with the latency and cost of each judgment.
  - It runs behind the interface `judge(question) → JudgeResult`. A judge
    that returns one answer and a confidence must say how it was mapped
    onto probabilities.
  - In the config, `jev` becomes `judge: { provider, model, … }`, and the
    API key follows the provider.
  - The request text and the responsibility texts go to the provider, so
    the [rule on names](../participants.md#the-responsibility-text) holds
    for it as for Jev.
- **011, a hold set from the session:** not planned; the spec's
  [open decision](jev-router-spec.md#open-decisions) 3.
  - **Goal:** when the person starts steering a session, the router stops
    sending to it, with no trip to the CLI or the board.
  - **Signals to check:** a prompt in the session that the router did not
    send (the router tags its own); the session turning `running` with no
    router send; an event stream from Paseo, if one exists.
  - **Release** is the hard half, since "done steering" has no event. The
    options are a timer since the person's last prompt, the explicit
    `router observe --release` of today, or a question in the session.
    The ticket preferred the automatic hold with an explicit release.
  - **The board** shows an automatic hold as it shows a manual one, with
    who or what set it.
  - **Done when:** typing in a scratch session while a request is queued
    makes the next run report `held`, a release lets the request through,
    and the spec's open decision 3 is closed or narrowed to release only.
- **018, Pi in a Paseo terminal:** Codex is done (#40); Pi is not
  started.
  - **The ready rule** was probed on Pi 0.87.1. Pi is ready when:
    - its activity is not `working`;
    - the last two rows made only of `─` are two apart, with a blank row
      between them and at most four rows below the lower one;
    - the cursor is on the blank row at column 0, visible or not.
  - **Other facts from that probe:**
    - the title reads `π - <dir>` from start to exit;
    - the activity is `null` until the first turn, `working` 0.1-0.2 s
      after Enter and `idle` at the end, and Esc mid-turn sets `idle`
      with no reason;
    - a paste shows as `[paste #1 +26 lines]`, and Enter 300 ms later
      submits all of it;
    - the editor's top border reads `── ⠋ Working ───` for the whole
      turn;
    - the question dialog sets `idle` with `needs_input` and replaces the
      editor;
    - an exit or a kill leaves the last frame on screen, with the cursor
      on the shell's row;
    - Enter during a turn queues a steering message, by Pi's docs; not
      probed.
  - **Before building:** re-probe on the current Pi. The probe scripts
    and logs are not in this repository.
  - **Build:** Pi becomes a terminal CLI profile beside Codex's (#40):
    its condition, the ready rule, its board title and its reason in the
    run report.
    - Fixtures from real screens: fresh, with and without the hardware
      cursor; drafts; a paste; the Working border; the question dialog;
      exited; killed.
    - Each guard is proven by breaking it once: accepting the Working
      border; ignoring the cursor, which makes an exited frame ready;
      requiring a visible cursor, which makes mini never ready.
    - The contract gains a "Paseo terminal (Pi)" section, the
      configuration doc's value list gains `pi`, and the operating doc
      gains its report reason.
    - End to end with scratch Pi terminals on mbp and mini and a scratch
      record: accepted at idle; held while working, at a draft, at the
      question dialog and after an exit; a reply recorded as
      `terminal:<id>`.
  - **Not probed:** Pi without the custom status line, light themes,
    terminals narrower than 80 columns, and mini's Pi permission
    extensions.
  - **Pi's reply** needs no escalation: Pi has no sandbox.
  - **Open:** whether a receiving-side dedup extension is in scope, since
    an `unknown` send to a terminal
    [waits for `router resolve`](../operating.md#when-the-router-looks).
  - **Not seen live:** Codex's approval overlay on a host whose reviewer
    is a person.
  - **If Codex's escalation delay costs:** a Codex rules file that allows
    only `router reply` and `router answer`. A rule does not match a
    command with `$VAR`, `$(...)` or a redirect, and that an allow rule
    lifts the network block is not proven.
  - **An alternative:** herdr inside a Paseo terminal, which gives stable
    names and state. Still open there:
    - no message key, so a repeated prompt runs twice;
    - the reply identity, from the pane's `HERDR_PANE_ID`;
    - herdr is not on mini;
    - reaching another host's socket;
    - a name is cleared when the agent exits.
  - **Probe safety:** hash and copy the Codex and Pi configs before and
    after each run. Send a key only when the screen shows the state the
    key is meant for. Run Codex without `-m`: a retired model once brought
    up the migration notice, and answering it blind changed a host's
    default model.
- **019, a closed agent after a daemon restart:** a closed session
  [counts as ready](../operating.md#when-the-router-looks), but a cold one
  left closed until a request resumes it has not been seen live. Check it
  the next time a daemon restart leaves an agent placement closed. The
  ticket's other item is host-private and is not carried here.
- **022, more commands from a reply host:**
  - Later, in this order:
    - `status` and `needs-you`, scoped to the host's own sessions;
    - `cancel`.
  - Never: `observe`, `resolve`, `run`, `serve`, `eval` or `usage`.
  - Not yet checked on real use: `router roster add` and `remove` in
    place of a hand roster change.
- **023, a dropped host:**
  - Telemetry that stays fresh across one of mba's drops has not been
    seen yet.
  - Optional: `serve` exits within a few seconds of SIGTERM and logs what
    was still in flight.
- **024, the plugin's later steps:**
  - **An event source on every host:** the plugin wakes `serve` when a
    turn ends or a permission is resolved, with the host's token.
  - **Timeline rows:** first a client transformer that turns the router's
    prompt into a card and `router reply` into one line, which makes the
    prompt format a contract. Then a row pushed by the daemon for each
    task.
  - **Command Center items** "Open board" and "Submit to Jev".
  - **A composer pill,** only with the plugin on mba and mini.
  - **A header button with a count,** optionally.
  - **RPCs** `board.placement {agentId}`, for pills, and `usage.get`.
  - **The usage section** is skipped once Paseo 0.11's Usage screen is
    checked against it.
  - **The actor:** a handler gets no caller, so the backend
    [fixes the actor](../operating.md#the-paseo-plugin), and anyone whose
    app reaches mbp's daemon can act.
  - **Not tested:** whether panels, pills and Command Center items show
    when the app views another host. The board surface did.
  - **A community plugin** is a later direction, with Jev as its core,
    not an option.
  - **Paseo's channel** (`invokePluginRpc`) in place of
    [`POST /events`](../operating.md#endpoints) on the tailnet, the host
    tokens and the reply host's `ROUTER_URL`.
  - **Paseo's relay** in place of the SSH tunnels. Still open: where the
    pairing's credentials live on the router host, and that the relay is
    Paseo's service on the internet, where the tailnet is direct.
  - **The HTML board** stays until the plugin matches it.
  - **Dropped:** the agent panel.
  - The ticket's items in the design participant's repository are
    host-private and are not carried here.

## Closed tickets

The spec and the code cite some of these numbers. The numbers missing
from 009-028 were closed before this: 022 took in 010 and 013, and 019
took in 016.

| Ticket | Subject                                           | Outcome                                                              |
| ------ | ------------------------------------------------- | -------------------------------------------------------------------- |
| 009    | A second judge behind the same interface          | Waiting; carried over                                                |
| 011    | Holding a session from where the person is typing | Not planned; carried over                                            |
| 015    | Claude Code in a Paseo terminal                   | #39; closed before this                                              |
| 018    | Pi and Codex in a Paseo terminal                  | Codex in #40; Pi carried over                                        |
| 019    | Loose ends from the design participant            | One item carried over                                                |
| 022    | One router command on every host                  | #51-#56; later commands carried over                                 |
| 023    | A run hangs when a host drops off                 | #57; one check and an option carried over                            |
| 024    | The router as a Paseo plugin                      | #58-#62; later steps carried over, the design repository's items not |
| 025    | A placement follows its session                   | Step 1 in #67; step 2 is idea 2                                      |
| 026    | A terminal's visible screen, not scrollback       | #66                                                                  |
| 027    | Codex agents are told to escalate                 | #71                                                                  |
| 028    | Repoint recomputes `idempotent`                   | #71                                                                  |
