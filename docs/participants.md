# Participants

A participant is an agent or a service with a stable id, one or more hosts,
and a responsibility text. This page covers writing that text and checking
it with `router eval`, and what changes when a participant's own session
sends work. The reasoning, with the measurements behind the text rules, is
in the spec: [Connecting a participant](../research/jev-router-spec.md#connecting-a-participant).

## The responsibility text

The text is all Jev sees, so it decides the routing. Write it as:

1. an ownership rule: what the participant does;
2. what it is not for, naming the neighbour a request might be confused
   with;
3. a few example requests, in every language requests arrive in. The
   spec records the measurement behind this: examples in a language move
   its probabilities, a note saying the language may occur does not.

The participant's owner keeps the text next to that agent's own `AGENTS.md`
and refreshes it when the role changes; the router config copies it. Names
that identify companies, clients or business areas stay out: the text goes
to an external API.

## Checking a change with `router eval`

Before a text, a grant or the threshold changes, judge a labeled set with
the candidate configuration:

```sh
router eval --config ~/.config/jev-router/candidate.json --set my-requests.jsonl
```

`secrets.env` is read from the candidate's directory, so keep candidates
beside the live file, or export `TYPESAFE_API_KEY`.

The set is JSON lines, one `{"text": ..., "expect": ..., "lang": ...}` per
line; blank lines and lines starting with `#` are skipped, and a duplicate
text is refused. `expect` is a participant id the requester may address, or
`none` for a request that should be handed back. The bundled
`router/eval/requests.jsonl` is the maintainer's own set, labeled for the
maintainer's deployment, so it is a shape to copy, not a set to run on
another roster. Phrase the
labeled requests differently from the examples in the text, and include
some that should go elsewhere or to `none`.

`eval` prints, for thresholds from 0.60 to 0.95 in steps of 0.05, how
many requests would be dispatched, how many of those wrongly, and how many
handed back, and exits 1 when any request got no usable judgment. Nothing enforces the rule, but the rule is:
a change goes live only with no wrong dispatch at the configured threshold
on the whole set, since a new text shifts every other participant's
probabilities too. `--model <id>` judges with another model; pin
`jev.model` to a dated version once the threshold is tuned to it.

Adding a participant, in order: write the text; add its labeled requests;
run `eval` on a candidate config that carries the text and the permission;
then make the candidate the live config. Until the permission is live
nobody can address the participant, and Jev never sees it.

## A participant as the sender

An agent's session may submit work too, with the same `submit`, `choose`
and `answer` commands, as far as `permissions` lets its participant address
others.

- On a host that does not run the router, the client acts as the session
  `$PASEO_AGENT_ID`, which Paseo sets in the agent's environment, or
  `terminal:$PASEO_TERMINAL_ID` for an agent CLI in a Paseo terminal.
- On the router host the CLI acts as a person (the first requester, or
  `--as` / `$ROUTER_AS`), since an agent there also submits on a person's
  behalf; a session names itself with `--as <its session id>`.

The router then tells the sender what a person would read on the board,
at the placement it sent from (`via`) and only when that session is idle,
like any delivery:

- the recipient's question, with the `answer` command that settles it;
- the choice, when Jev handed the request back, with the `choose` command;
- the final word, which needs no reply.

```sh
# In the notes agent's session:
router submit --to coder "The board's log panel clips its last line at 1280 wide."
# The notes agent's session hears back, for example:
# [router T41 question/D7/R2] coder asks about your request. Answer with:
#   router answer --as <session> --task T41 --delivery D7 --question R2 --text "<answer>" ...
```

Each notice is told once (the `key` in the task's `notices`, see
[board-model.md](board-model.md)), through the same adapter and with the
same record of attempting, accepted and unknown, so a restart or a dropped
call is retried under the same rules as a send. `router status T` lists them, and the
board's task detail shows them under "Notices to".

Limits:

- A notice whose adapter call was interrupted or whose host was unreachable
  is marked unknown and is not repeated when the participant's adapter does
  not deduplicate (`idempotent: false`), or when its session was replaced
  since; there is no operator form for it. On the router host the sender
  still finds the item with `router needs-you --as <participant>` and
  `router status`; the client on another host has no query command, so a
  person relays it.
- When two deliveries of one request ask under the same message id, an
  answer must name its delivery (`--delivery`); the notices do.
- This path was built on 2026-10-04 and has not yet been run live; the
  spec's [Verified live, and not](../research/jev-router-spec.md#verified-live-and-not)
  keeps that list.
