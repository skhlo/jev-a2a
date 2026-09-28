# Personal router architecture prototype

Open [jev-router-prototype.html](jev-router-prototype.html) directly in a browser.
It is one self-contained file with no dependencies, external assets, server, or
credentials. It is throwaway exploration, retained on
`feat/router-architecture-prototype`.

## Question and scope

Can a self-hosted single-user router own a request from acceptance through reply,
while code composes bounded Jev decisions and delivery adapters remain replaceable?

The user chose an interactive HTML model. The agreed shape is any caller or event
to an independent router, then an adapter and recipient. The router owns the
directory, decisions, delivery bookkeeping, and replies. Claude is the first
endpoint; the sender must not have to be a Claude session.

The model exposes state after every action, seven guided walkthroughs, and free
play. Its reducer is independent of the view. Scripted judgments use short
descriptions first, then full responsibility notes; known targets skip judgments.
Code derives the top-two shortlist from the first Choice's option probabilities.
Each request has at most two judgments in this experiment. That is a prototype
budget, not a permanent restriction on the service.

## What the model demonstrates

- A caller can disconnect after acceptance and read the stored result later.
- Other callers and scheduled events can still submit while that observer is disconnected.
- Added evidence can change the selected owner between two judgments.
- Abstention and a busy owner can stop delivery without selecting a substitute.
- A second adapter uses the same request, delivery, and reply lifecycle.
- A modeled restart preserves delivery uncertainty and never automatically resends.
- Duplicate identity and content return the same receipt; changed content conflicts.
  The editable caller-supplied message ID and repeat controls use the same submit transition.
- Replies match task, message, and endpoint session before completing work.
- Another endpoint can continue while an earlier delivery remains uncertain.

## What remains unproven

All Jev judgments, transport outcomes, and replies are fixtures. The journal lives
in browser memory. “Restart router” is a state transition, not a process or disk
test. The model does not establish inference quality, latency, cost, native
delivery guarantees, authentication, or real persistence.

The proposed first deployment remains one process and one SQLite file. Plain code
owns the sequence. The next implementation experiment should use a router-owned
Claude turn and correlate its structured result with a chosen session ID. Adopting
an existing terminal needs a separate registration and reply experiment.

## Probe evidence

Two GPT-5.6 Sol probes at high effort examined architecture and Claude integration.
The local probe found an installed Claude Code 2.1.283 binary and verified its help
and supported external session-listing command. No live agent was messaged and no
Jev inference ran. The default launcher tried to install a missing version, so
the probe used the installed absolute binary without changing the installation.

Primary references: [programmatic Claude](https://code.claude.com/docs/en/headless),
[session discovery](https://code.claude.com/docs/en/agent-view),
[cross-session messaging](https://code.claude.com/docs/en/cross-session-messaging),
and [TypeSafe's progressive-context example](https://docs.typesafe.ai/cookbooks/skill_suggestion).

## Verification

Browser verification passed all seven walkthroughs and fourteen additional free-play
checks through the visible controls. Desktop (1440 px) and mobile (390 px) layouts
passed in light and dark themes, without page overflow, browser errors, or
external asset requests. A scratch copy with reply correlation intentionally
broken failed the wrong-reply check as expected. The prototype does not add a
production test suite.
