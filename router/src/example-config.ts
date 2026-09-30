// One example deployment for the Jev router. The router core carries no
// deployment of its own; the tests use this one.
// Change participants, hosts, principals and permissions freely: the core
// validates the shape, not the names.
import type { Config } from "./types.ts";

const config: Config = {
  policy: {
    threshold: 0.9, // provisional; tune on labeled routing examples
    deadline: 100, // model ticks in the prototype; a real deployment uses time
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
        "Coding across every repository, including changes to dotfiles source and harness settings, using its configured workflows. Not for inspecting what is applied on a device.",
    },
    {
      id: "knowledge",
      name: "Knowledge assistant",
      kind: "agent",
      hosts: ["mini"],
      idempotent: true,
      responsibility:
        "Notes, research and synthesis, including notes about Incus or any other technology. Not for live machine operations.",
    },
    {
      id: "environment",
      name: "Dotfiles service",
      kind: "service",
      hosts: ["mba", "mbp", "mini"],
      idempotent: true, // router-owned service; must deduplicate by message key
      responsibility:
        "Inspects the harness and environment configuration applied on mba, mbp and mini. Never changes dotfiles source.",
    },
    {
      id: "incus",
      name: "Incus service",
      kind: "service",
      hosts: ["lab01"],
      idempotent: true,
      responsibility:
        "Performs configured micro VM operations on lab01. Not for questions or notes about Incus.",
    },
  ],
  // Who may address whom. Absent means nobody.
  permissions: {
    you: ["orchestrator", "knowledge", "environment", "incus"],
    orchestrator: ["environment", "incus"],
  },
};

export default config;
