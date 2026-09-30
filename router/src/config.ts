// A deployment's configuration file: the core's configuration plus what the
// shell on this host needs to reach its participants.
import { readFileSync } from "node:fs";
import { homedir } from "node:os";
import { join } from "node:path";
import { validateConfig } from "./core.ts";
import type { Config } from "./types.ts";

export type RouterConfig = Config & {
  // This machine's name as it appears in participants[].hosts.
  host: string;
  // Journal directory. Defaults to ~/.local/state/jev-router.
  home: string;
  paseo: { url: string };
  // Placement key ("participant@host") -> Paseo agent id, for placements on
  // this host. The agent id is the placement's session identity.
  agents: Record<string, string>;
};

export function loadConfig(path: string): RouterConfig {
  const raw: unknown = JSON.parse(readFileSync(path, "utf8"));
  const config = validateConfig(raw);
  const extra = raw as Record<string, unknown>;
  const fail = (message: string): never => {
    throw new Error(`Invalid router configuration (${path}): ${message}`);
  };
  if (typeof extra.host !== "string" || !extra.host)
    return fail("host names this machine");
  const paseo = extra.paseo;
  if (
    paseo === null ||
    typeof paseo !== "object" ||
    typeof (paseo as { url?: unknown }).url !== "string"
  )
    return fail("paseo.url is the daemon's websocket URL");
  const agents = extra.agents ?? {};
  if (agents === null || typeof agents !== "object" || Array.isArray(agents))
    return fail("agents maps placement keys to Paseo agent ids");
  const known = new Set(
    config.participants.flatMap((p) => p.hosts.map((h) => `${p.id}@${h}`)),
  );
  for (const [key, id] of Object.entries(agents as Record<string, unknown>)) {
    if (!known.has(key)) fail(`agents names unknown placement ${key}`);
    if (typeof id !== "string" || !id)
      fail(`agents.${key} must be an agent id`);
  }
  return {
    ...config,
    host: extra.host,
    home:
      typeof extra.home === "string" && extra.home
        ? extra.home
        : join(homedir(), ".local", "state", "jev-router"),
    paseo: { url: (paseo as { url: string }).url },
    agents: agents as Record<string, string>,
  };
}
