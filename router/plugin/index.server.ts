// The router's Paseo plugin, installed into the router host's daemon (see
// docs/operating.md). Its server half only: Paseo runs it in a subprocess
// beside the daemon.
import { nudgeOnTurnEnd, type Hooks } from "./server/nudge.ts";

export default function contribute(server: Hooks): () => void {
  nudgeOnTurnEnd(server);
  return () => undefined;
}
