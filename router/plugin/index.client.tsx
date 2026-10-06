// The router plugin's app half: the Jev board as a surface, opened from a
// sidebar item. Paseo draws the surface's header; client/board.tsx draws
// the rest from the plugin's RPCs (shared/rpc.ts).
import type { PluginCleanup } from "@getpaseo/plugin";
import type { PluginClientContext } from "@getpaseo/plugin/client";
import { Board } from "./client/board.tsx";

export default function contribute(client: PluginClientContext): PluginCleanup {
  const surface = client.addSurface("board", Board);
  const item = client.addSidebarItem({
    id: "jev",
    title: "Jev",
    icon: "Route",
    surface: "board",
  });
  return async () => {
    await item();
    await surface();
  };
}
