// Paseo adapter over @getpaseo/client. Never the CLI (random message id per
// call) and never Paseo MCP. Facts this relies on, verified in the 0.9.2
// source: the daemon keeps a receipt per (agentId, messageId); a repeat with
// the same key and text is a no-op after a completed send, and answers
// agent_request_outcome_unknown while a receipt is still pending; a send to a
// running agent interrupts its turn, so the router sends only to idle agents.
import { createPaseoClient } from "@getpaseo/client";
import type { AdapterOutcome } from "./types.ts";

export type Observation = {
  // The agent exists; ready when idle with no permission waiting.
  ready: boolean;
  status: string;
  pendingPermissions: number;
};

export type Adapter = {
  // null: the daemon does not know this agent.
  observe(agentId: string): Promise<Observation | null>;
  send(agentId: string, key: string, text: string): Promise<AdapterOutcome>;
  close(): Promise<void>;
};

export async function createPaseoAdapter(url: string): Promise<Adapter> {
  const client = createPaseoClient({ url });
  await client.connect();
  return {
    async observe(agentId) {
      const result = await client.agents.ref(agentId).refresh();
      if (!result) return null;
      const { status, pendingPermissions } = result.agent;
      return {
        ready: status === "idle" && pendingPermissions.length === 0,
        status,
        pendingPermissions: pendingPermissions.length,
      };
    },
    async send(agentId, key, text) {
      try {
        await client.agents.ref(agentId).send(text, { messageId: key });
        return "accepted";
      } catch (error: unknown) {
        const message = error instanceof Error ? error.message : String(error);
        if (message.includes("agent_request_key_conflict"))
          throw new Error(
            `Router bug: ${key} was already sent to ${agentId} with different text.`,
          );
        // Only a refusal before any send is a definite not_sent. Anything
        // else may have reached the agent.
        if (/^Agent not found: |^Agent identifier /.test(message))
          return "not_sent";
        return "unknown";
      }
    },
    close: () => client.close(),
  };
}
