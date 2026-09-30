// Paseo adapter over @getpaseo/client. Never the CLI (random message id per
// call) and never Paseo MCP. Facts this relies on, verified in the 0.9.2
// source: the daemon keeps a receipt per (agentId, messageId); a repeat with
// the same key and text is a no-op after a completed send, and answers
// agent_request_outcome_unknown while a receipt is still pending; a send to a
// running agent interrupts its turn, so the router sends only to idle agents.
import { spawn, type ChildProcess } from "node:child_process";
import { createServer, type Server, type Socket } from "node:net";
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

// endpoint: a websocket URL, or ssh://[user@]host[:port] for a daemon bound to
// loopback on another machine.
export async function createPaseoAdapter(endpoint: string): Promise<Adapter> {
  const tunnel = endpoint.startsWith("ssh://")
    ? await openSshTunnel(endpoint)
    : null;
  const client = createPaseoClient({
    url: tunnel ? `ws://127.0.0.1:${tunnel.port}/ws` : endpoint,
  });
  try {
    await client.connect();
  } catch (error) {
    tunnel?.close();
    throw tunnel?.failure()
      ? new Error(`SSH to ${endpoint} failed: ${tunnel.failure()}`)
      : error;
  }
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
    async close() {
      try {
        await client.close();
      } finally {
        tunnel?.close();
      }
    },
  };
}

type Tunnel = { port: number; close(): void; failure(): string | null };

// The Paseo CLI's tunnel, in miniature: a local listener that, on its first
// connection, spawns `ssh -W 127.0.0.1:<daemonPort> <host>` and pipes the
// socket through it. One connection per tunnel, which is all one run needs.
function openSshTunnel(endpoint: string): Promise<Tunnel> {
  const url = new URL(endpoint);
  if (
    url.password ||
    url.search ||
    url.hash ||
    (url.pathname && url.pathname !== "/")
  )
    throw new Error(
      `Unsupported ssh endpoint ${endpoint}: use ssh://[user@]host[:port]`,
    );
  const host = url.username
    ? `${decodeURIComponent(url.username)}@${url.hostname}`
    : url.hostname;
  const args = [
    "-T",
    "-o",
    "BatchMode=yes",
    "-o",
    "ConnectTimeout=10",
    "-o",
    "ClearAllForwardings=yes",
    "-o",
    "ExitOnForwardFailure=yes",
    ...(url.port ? ["-p", url.port] : []),
    "-W",
    "127.0.0.1:6767",
    host,
  ];
  let server: Server | null = null;
  let socket: Socket | null = null;
  let child: ChildProcess | null = null;
  let stderr = "";
  let failure: string | null = null;
  const close = (): void => {
    server?.close();
    server = null;
    socket?.destroy();
    socket = null;
    if (child && !child.killed) child.kill();
    child = null;
  };
  return new Promise((resolve, reject) => {
    server = createServer((accepted) => {
      socket = accepted;
      server?.close();
      server = null;
      const ssh = spawn("ssh", args, { stdio: ["pipe", "pipe", "pipe"] });
      child = ssh;
      ssh.stderr.on("data", (chunk: Buffer) => {
        stderr = `${stderr}${chunk.toString()}`.slice(-2000);
      });
      ssh.on("error", (error) => {
        failure = error.message;
        accepted.destroy(error);
      });
      ssh.on("exit", (code, signal) => {
        if (code !== 0 || signal)
          failure = stderr.trim() || `ssh exited with ${signal ?? code}`;
        accepted.destroy(failure ? new Error(failure) : undefined);
      });
      accepted.on("error", () => undefined);
      accepted.on("close", () => {
        if (child && !child.killed) child.kill();
      });
      accepted.pipe(ssh.stdin);
      ssh.stdout.pipe(accepted);
    });
    server.once("error", (error) => {
      close();
      reject(error);
    });
    server.listen(0, "127.0.0.1", () => {
      const address = server?.address();
      if (!address || typeof address === "string") {
        close();
        reject(new Error("Could not allocate a tunnel port"));
        return;
      }
      resolve({ port: address.port, close, failure: () => failure });
    });
  });
}
