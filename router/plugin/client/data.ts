// The surface's data, through the plugin's RPCs. Plugin RPC is request and
// response only, so the summary polls every 5 s while the surface is shown,
// sending the rev it holds; the selected task refetches when its head's rev
// changes; an action's result replaces the task it changed. The app's
// QueryClient holds it all, under keys of this plugin and host.
import { useRpc } from "@getpaseo/plugin/client";
import { useToast } from "@getpaseo/plugin/client/react-native";
import { useMutation, useQuery, useQueryClient } from "@tanstack/react-query";
import { useState } from "react";
import { boardSummary, boardTask } from "../shared/rpc.ts";
import type { Acted, FullTask, Summary } from "../shared/rpc.ts";

const NS = "jev-router";
const POLL_MS = 5_000;

const summaryKey = (host: string) => [NS, host, "summary"];
const taskKey = (host: string, id: string, rev: string | null) => [
  NS,
  host,
  "task",
  id,
  rev,
];

// The summary, with how far serve's clock is ahead of this device's: ages
// and countdowns run on serve's clock, as its "no reply" texts do.
type Polled = Summary & { skew: number };

export function useSummary(host: string) {
  const call = useRpc(boardSummary);
  const client = useQueryClient();
  return useQuery({
    queryKey: summaryKey(host),
    queryFn: async (): Promise<Polled> => {
      const last = client.getQueryData<Polled>(summaryKey(host));
      const got = await call(last ? { sinceRev: last.rev } : {});
      if (!("unchanged" in got))
        return { ...got, skew: Date.parse(got.at) - Date.now() };
      if (last) return last;
      throw new Error("Serve answered unchanged to a first poll.");
    },
    refetchInterval: POLL_MS,
  });
}

// `rev` is the task's head rev, so a changed task is fetched again; null
// for a task the board no longer lists, fetched once.
export function useTask(host: string, id: string, rev: string | null) {
  const call = useRpc(boardTask);
  return useQuery({
    queryKey: taskKey(host, id, rev),
    queryFn: () => call({ id }),
    // A rev's task never changes, so what an action returns or an earlier
    // fetch got stands until the rev moves.
    staleTime: Infinity,
    // Keep showing the task while its new rev loads, but never another one.
    placeholderData: (prev: FullTask | null | undefined) =>
      prev?.task.id === id ? prev : undefined,
  });
}

// A message id for one submit or answer, sent again on a retry, so the
// router takes a repeat as the same message (shared/rpc.ts). `next` mints a
// new one when the message changes, so an edited retry is a new message
// rather than a conflict with one serve may have recorded, and once the
// form is done.
export function useMessageId(): [string, () => void] {
  const [id, setId] = useState(mint);
  return [id, () => setId(mint())];
}
const mint = (): string =>
  `app-${Date.now().toString(36)}-${Math.random().toString(36).slice(2, 10)}`;

// One action through its RPC. Once serve accepts it, the task it changed
// goes into the cache under its new rev, the summary is asked again and
// the router's message shows as a toast; a refusal shows its reason.
export function useAct<Input>(
  host: string,
  run: (input: Input) => Promise<Acted>,
  done?: (result: Acted) => void,
) {
  const client = useQueryClient();
  const toast = useToast();
  return useMutation({
    mutationFn: run,
    onSuccess: (result) => {
      if (result.task)
        client.setQueryData(
          taskKey(host, result.task.task.id, result.task.rev),
          result.task,
        );
      void client.invalidateQueries({ queryKey: summaryKey(host) });
      toast.show(result.message, { variant: "success" });
      done?.(result);
    },
    onError: (error) => toast.error(error.message),
  });
}
