// One example deployment for the Jev router. The router core carries no
// deployment of its own; the tests use this one.
// Change participants, hosts, principals and permissions freely: the core
// validates the shape, not the names. Each responsibility text ends with
// example requests in the languages its users write; they are what Jev
// matches against, so a live text carries real ones, written by the agent's
// owner next to its AGENTS.md. Spec: "Connecting a participant".
import type { Config } from "./types.ts";

const config: Config = {
  policy: {
    threshold: 0.9, // a deployment picks this with `router eval` on its own labeled set
    deadline: 100, // the tests count in ticks; a live router reads milliseconds (config.example.json)
    maxText: 4000,
    maxOpenTasks: 20,
  },
  // Authenticated identities that are not participant sessions.
  principals: {
    you: "requester", // every view (Paseo, herdr, any device) authenticates as the user
    operator: "operator", // may reconcile uncertain deliveries; may not submit work
  },
  participants: [
    {
      id: "orchestrator",
      name: "Orchestrator",
      kind: "agent",
      hosts: ["mbp"],
      idempotent: true, // Paseo SDK send with a router message ID
      responsibility:
        "Coding across every repository, including changes to dotfiles source and harness settings, using its configured workflows. Not for inspecting what is applied on a device. Examples: 'Fix the failing TypeScript build in the router repo', '라우터 저장소에 테스트 케이스 추가해줘', 'Add a pre-commit hook to the dotfiles'.",
    },
    {
      id: "knowledge",
      name: "Knowledge assistant",
      kind: "agent",
      hosts: ["mini"],
      idempotent: true,
      responsibility:
        "Notes, research and synthesis, including notes about Incus or any other technology. Not for live machine operations. 예시: '볼트에 있는 노트 구조 설명해줘', '이 주제로 노트 초안 작성해줘', 'What are the stages of the review pipeline?'.",
    },
    {
      id: "environment",
      name: "Dotfiles service",
      kind: "service",
      hosts: ["mba", "mbp", "mini"],
      idempotent: true, // router-owned service; must deduplicate by message key
      responsibility:
        "Inspects the harness and environment configuration applied on mba, mbp and mini. Never changes dotfiles source. Examples: 'Which shell config is active on mini?', 'mbp에 적용된 git 설정 보여줘'.",
    },
    {
      id: "incus",
      name: "Incus service",
      kind: "service",
      hosts: ["lab01"],
      idempotent: true,
      responsibility:
        "Performs configured micro VM operations on lab01. Not for questions or notes about Incus. Examples: 'Start the ci-runner VM', 'lab01의 VM 목록 보여줘'.",
    },
  ],
  // Who may address whom. Absent means nobody.
  permissions: {
    you: ["orchestrator", "knowledge", "environment", "incus"],
    orchestrator: ["environment", "incus"],
  },
};

export default config;
