# Devices, dotfiles and one orchestrator

Open [jev-router-prototype.html](jev-router-prototype.html) directly in a browser.
It is one self-contained, throwaway HTML model: no installation, server,
credentials or network assets. Retained on `feat/router-architecture-prototype`.

## Question

Can a central communication layer coordinate a small number of agents and device
services across mba, mbp, mini and lab01, while dotfiles owns the harness and
environment configuration and one orchestrator owns the coding workflows?

The user supplied these device roles:

| Device | Role                         | Dotfiles scope                        |
| ------ | ---------------------------- | ------------------------------------- |
| mba    | Main daily driver            | Harness and environment configuration |
| mbp    | Always-on Linux box          | Harness and environment configuration |
| mini   | Knowledge work assistant box | Harness and environment configuration |
| lab01  | Incus micro VM host          | Not specified as a dotfiles target    |

All remote repositories share one GitHub identity. The model uses `skhlo` from the
host instructions. One orchestrator handles their coding work using configured
workflows. Paseo or herdr can expose the agents from any device; changing a view
does not create an agent or move its work.

## Proposed placement and ownership

- **Control plane on mbp:** one proposed process and SQLite journal. Owns the
  participant directory, bounded routing decisions, correlated messages, delivery
  records and results. Always-on mbp is a placement assumption, not a deployment.
- **One Orchestrator agent on mbp:** handles coding across repositories. Owns its
  configured workflow sequence and can request device services through the router.
- **One knowledge assistant on mini:** handles notes, research and synthesis.
- **Host and Incus services:** inspect configurations on mba/mbp/mini or carry out
  configured VM operations on lab01 without adding persistent reasoning agents.
- **Dotfiles:** supplies harness and environment profiles on the three working
  machines. Source changes use the orchestrator's workflow; inspecting applied
  configuration uses host services.
- **Paseo / herdr:** access surfaces. The viewing device, participant identity and
  execution host are distinct facts in the model.

The two persistent agents, their placement, repository examples (`dotfiles` and
`jev-a2a`), workflow step names and config revisions are prototype assumptions.
They are not live discovery results. “One orchestrator” is interpreted as one
across all repositories. No agent is added for each repository, device or view.

## What to explore

1. **Code from mba:** submit through Paseo, route to the orchestrator on mbp,
   close the view, advance its configured workflow, and read the same result
   through herdr on mini.
2. **Change dotfiles:** a brief description initially favors a configuration
   service. Fuller responsibilities identify a source change, so the second
   judgment chooses the orchestrator's dotfiles workflow. Execution is on mbp;
   affected profiles are mba, mbp and mini. The output is a reviewed change, not
   a deployment or an applied configuration revision.
3. **Check environments:** one explicitly addressed request produces three
   service deliveries with independent identities and replies. Mini reports
   simulated config drift. No Jev judgment or additional agent is needed.
4. **Knowledge work:** an Incus notes summary initially suggests the Incus
   service; fuller context selects the knowledge assistant on mini.
5. **Incus request:** the orchestrator requests a scratch VM through the router.
   An unreachable lab01 queues that request without changing its recipient.
   Once reachable, the service returns a result addressed to the orchestrator.
6. **Uncertain delivery:** restarting during a send preserves uncertainty and
   deduplicates a repeated request. Wrong-message and wrong-device replies are
   rejected. A matching late reply completes the request without another send.
7. **Unclear request:** abstain before involving any participant.

Free play also covers a busy orchestrator, independent knowledge work, queued
requests, definite delivery failure, stale observations, new inspections,
source-scoped message identity and switching views. Every control uses the same
portable reducer as the guided walkthroughs. The view is a separate script.

## Jev and ordinary code

The first scripted Choice returns one answer and a probability distribution.
Code derives a top-two shortlist and loads fuller participant responsibilities.
A second judgment uses that new evidence to select the recipient. Code then
resolves registered hosts and configured workflows. Known targets and replies
use zero judgments. Two judgments is a demo budget, not a service-wide limit.

This follows the progressive-context pattern in [TypeSafe's skill suggestion
example](https://docs.typesafe.ai/cookbooks/skill_suggestion) and the
[Choice contract](https://docs.typesafe.ai/primitives/choice). The probabilities
are fixtures, not measurements of routing quality. Workflow steps are owned by
the orchestrator; advancing them does not trigger further Jev judgments.

## Communication rules

One source and caller-supplied message ID identifies a request independently of
the current viewing device. Same identity and content returns the original
receipt. Changed text, repository, scope or recipient conflicts. The request
records its original view and retains it after switching devices.

Each delivery records a task, message, participant, device and session identity.
Replies must match all five. A multi-device request completes after all its
device results arrive; an individual reply cannot complete the other devices.
Transport acceptance is distinct from completion of the participant's work.

Code records attempts before dispatch. An unresolved send reserves that
participant on that device. Unknown outcomes are never automatically resent;
unsent queued work can proceed when availability returns. Other participants
can continue independently. The journal and modeled restart remain in memory.

## Limits and next experiment

Everything is simulated: Jev inference, workflow execution, GitHub repository
entries, dotfiles inspection, VM creation and transport replies. The model has no
live Paseo, herdr, Claude, Incus, GitHub or host integration. It does not establish
latency, throughput, inference quality, permissions, authentication, persistence
or real delivery guarantees. It proposes a communication contract above adapter
transports; it does not implement a network protocol. Availability of the
central service depends on mbp.

The Incus walkthrough is an independent service request from the orchestrator.
It does not model a complete coding run blocked on that VM, VM cleanup or an
end-to-end dotfiles rollout. Those are workflow responsibilities to explore
separately if needed.

The earlier Claude probe found an installed Claude Code 2.1.283 binary and
verified print mode, structured results and session listing. It sent no live
agent message and performed no Jev inference. A router-owned Claude turn is a
possible first transport experiment; adopting arbitrary existing sessions still
needs registration and verified reply correlation. The probe findings are
historical context, not a claim of a working integration.

## Verification

Browser verification passed seven guided walkthroughs and 23 additional free-play
checks through the visible controls. Desktop (1440 px) and mobile (390 px) passed
in light and dark themes, without page overflow, duplicate element IDs, browser
exceptions or external asset requests. Inline scripts parse and formatting passes.
A scratch copy with the device-correlation guard removed failed the same visible
wrong-device reply check as expected; the deliverable retains that guard.
Scratch browser checks are retained outside the repo; there is no production test
suite or added dependency.
