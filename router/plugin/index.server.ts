// The router's Paseo plugin, installed into the router host's daemon (see
// docs/operating.md). Its server half: Paseo runs it in a subprocess
// beside the daemon. It wakes serve when a placement's turn ends, and
// answers the app's board RPCs from serve's board API.
import { serveBoard, type Handles } from "./server/board.ts";
import { nudgeOnTurnEnd, type Hooks } from "./server/nudge.ts";

export default function contribute(server: Hooks & Handles): () => void {
  nudgeOnTurnEnd(server);
  serveBoard(server);
  return () => undefined;
}
