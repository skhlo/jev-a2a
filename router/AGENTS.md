# AGENTS.md

This file gives coding agents project-specific context. Keep it short and
update it when workflows change.

## Project Overview

- Primary app or package: `jev-router` (this folder), a router that sends
  work between coding agents in Paseo sessions on several machines and
  keeps one record of it. The contract is
  `../docs/research/jev-router-spec.md`.
- Main entry points: `src/cli.ts` (the `router` command on every host,
  `router serve` included); the scripts in `src/` run by hand with node,
  each under `import.meta.main`.
- Important directories: `src/` the router; `test/` its tests; `eval/`
  the labeled request set; `design/` the board design's paths and the
  README's pictures; `../docs/` the reference pages.

## Architecture Notes

- Module boundaries: `src/core.ts` is a pure, deterministic model of the
  contract and performs no I/O. `src/shell.ts` and the adapters around it
  (`paseo.ts`, `jev.ts`, `journal.ts`, `server.ts`) perform the core's
  commands and feed results back as events.
- `src/cli.ts` picks the host: with a configuration it loads
  `src/router-host.ts`, the process around `src/commands.ts` (the commands
  on the record, which the tests run in-process); without one,
  `src/reply-host.ts` sends `reply`, `submit`, `answer` and `choose` to
  `serve`, and `check` asks it whether the two work together. Both build
  events with `src/request.ts`. The reply host's path loads no package, so
  it runs from a checkout without `pnpm install`;
  `test/reply-host.test.ts` runs it once from a copy of `src/`.
  `router host setup` (`src/host-setup.ts`) installs that checkout on a
  host over ssh; `test/host-setup.test.ts` runs its script here, with a
  scratch `HOME`, cloning a scratch repository.
- `router roster` (`src/roster.ts`) changes the configuration file the way
  it was changed by hand: checked, kept as a dated copy, swapped in, and
  `serve` restarted and watched.
- Generated or vendored code: `src/board.sample.json` and
  `design/screenshots/`, each written by a script in `src/` (the README's
  development section says when to run them); `pnpm-lock.yaml`, by pnpm.
- Sensitive areas: the repository is public. Keep secrets, logins, private
  paths and live request texts out of commits.

## Commands

The README's development section says what each does.

- Install: `pnpm install`
- Build: none; Node runs the TypeScript directly.
- Test: `pnpm test`
- Typecheck or lint: `pnpm typecheck`, `pnpm fmt:check`, `pnpm fallow`
- Advice only: `pnpm fallow:health`

## Fallow

- Run fallow through pnpm in this folder (`pnpm exec fallow …`); its
  configuration is `.fallowrc.jsonc`.
- Before committing, run `pnpm fallow`: it is the check CI runs. Complexity
  (`fallow health`, and the complexity part of `fallow audit`) is advice
  here: read its findings, and do not add `fallow-ignore` comments to
  silence them.
- `pnpm fallow:health` clears and refills `.coverage/` with the tests' V8
  coverage, then reads it with `fallow health --coverage .coverage`; a bare
  `fallow health` estimates CRAP scores instead.
- Use `fallow dead-code --format json --quiet`,
  `fallow dupes --format json --quiet`, and
  `fallow health --coverage .coverage --format json --quiet` (after
  `pnpm fallow:health`; rerun it after an edit) for targeted checks.
- Use `fallow list --entry-points --format json --quiet` to inspect
  project shape.

<!-- generated:task-matrix:start -->

| When the agent is about to...                                     | Run                                                                                                                                                     |
| ----------------------------------------------------------------- | ------------------------------------------------------------------------------------------------------------------------------------------------------- |
| delete an "unused" export or file                                 | `fallow dead-code --trace <file>:<export>`                                                                                                              |
| prove a TypeScript symbol's exact consumers before refactoring    | `fallow dead-code --type-aware --symbol-impact <file>:<export-or-class.method>`                                                                         |
| find how one module reaches another                               | `fallow trace --path <from> <to>` (Reports `reachable: false` instead of failing when no import path exists; type-only hops are reported, not skipped.) |
| delete an "unused" dependency                                     | `fallow dead-code --trace-dependency <name>`                                                                                                            |
| commit or open a PR                                               | `fallow audit --base <ref>`                                                                                                                             |
| read a diff before approving it                                   | `fallow review --base <ref> --brief` (orientation, never gates: deterministic and always exit 0, unlike the audit row)                                  |
| prioritize refactoring                                            | `fallow health --hotspots --targets`                                                                                                                    |
| ask who owns code                                                 | `fallow health --ownership`                                                                                                                             |
| check untested-but-reachable code                                 | `fallow health --coverage-gaps`                                                                                                                         |
| consolidate duplication                                           | `fallow dupes --trace dup:<fingerprint>`                                                                                                                |
| find feature flags                                                | `fallow flags`                                                                                                                                          |
| check which architecture rules apply to a file before changing it | `fallow guard <files>`                                                                                                                                  |
| surface security candidates                                       | `fallow security`                                                                                                                                       |
| understand a finding                                              | `fallow explain <issue-type>`                                                                                                                           |
| scope a monorepo                                                  | `--workspace <glob> / --changed-workspaces <ref>` (global flags, prefix any command)                                                                    |

<!-- generated:task-matrix:end -->

## Agent Rules

- Do not edit: the generated files above by hand; regenerate them with
  their owner.
- Preferred style: what the surrounding code does; Prettier formats
  everything (`pnpm fmt`).
