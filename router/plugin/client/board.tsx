// The Jev board surface. Its arrangement follows its own width, since the
// app sidebar takes a share of the window: wide (720 px or more) shows the
// list and the selected task or the Agents page side by side; narrower
// shows one at a time, with phone controls when the app is compact. The
// selection lives here; surfaces take no params, so a reload returns to the
// list.
import type { PluginSurfaceProps } from "@getpaseo/plugin/client";
import { useEffect, useMemo, useState } from "react";
import { View } from "react-native";
import { AgentsPage } from "./agents.tsx";
import { useSummary } from "./data.ts";
import { TaskDetail } from "./detail.tsx";
import { SubmitModal } from "./forms.tsx";
import { viewerOf, type Viewer } from "./format.ts";
import { TaskList } from "./list.tsx";
import { LookProvider, Txt, type Mode } from "./ui.tsx";

const WIDE = 720;

export function Board(props: PluginSurfaceProps) {
  // Another host is another board: start it afresh.
  return <Surface key={props.host.id} {...props} />;
}

// The board's own first pick for the wide detail: a task that needs the
// viewer, else the newest open one, else the newest finished one.
const firstPick = (v: Viewer): string | null =>
  v.needs[0]?.id ?? v.flight[0]?.id ?? v.done[0]?.id ?? null;

function Surface({ theme, host, layout }: PluginSurfaceProps) {
  const c = theme.colors;
  const [width, setWidth] = useState(0);
  const mode: Mode = layout.compact
    ? "compact"
    : width >= WIDE
      ? "wide"
      : "single";
  const summary = useSummary(host.id);
  const s = summary.data;
  const viewer = useMemo(() => (s ? viewerOf(s) : null), [s]);
  // Serve's clock, read at each poll.
  const now = (summary.dataUpdatedAt || Date.now()) + (s?.skew ?? 0);
  const [submitting, setSubmitting] = useState(false);
  // The task the viewer picked. Wide, the detail otherwise shows the
  // board's first pick, pinned once shown so that an action or a poll
  // moving it down the list does not move the detail; narrower, only a
  // pick opens a task. A task that has left the board gives way, as on
  // the board.
  const [picked, setPicked] = useState<string | null>(null);
  const [pinned, setPinned] = useState<string | null>(null);
  const onBoard = (id: string | null): id is string =>
    id !== null &&
    viewer !== null &&
    (viewer.head(id) !== null || viewer.itemsFor(id).length > 0);
  const first = mode === "wide" && viewer ? firstPick(viewer) : null;
  const pinnedOn = onBoard(pinned);
  useEffect(() => {
    if (!pinnedOn && first !== null) setPinned(first);
  }, [pinnedOn, first]);
  const selected = onBoard(picked)
    ? picked
    : mode === "wide"
      ? pinnedOn
        ? pinned
        : first
      : null;
  // The Agents page, when the viewer picked it over a task, and whether the
  // picked task was opened from it, so its back row returns there.
  const [agents, setAgents] = useState(false);
  const [fromAgents, setFromAgents] = useState(false);
  const openTask = (id: string, viaAgents: boolean) => {
    setPicked(id);
    setAgents(false);
    setFromAgents(viaAgents);
  };
  const task = agents ? null : selected;
  const look = useMemo(() => ({ c, mode }), [c, mode]);

  const body = () => {
    if (!s || !viewer)
      return (
        <View style={{ padding: 24 }}>
          <Txt muted>
            {summary.error
              ? `The router's board is not answering: ${summary.error.message}`
              : "Loading..."}
          </Txt>
        </View>
      );
    const list = (
      <TaskList
        viewer={viewer}
        now={now}
        selected={task}
        onSelect={(id) => openTask(id, false)}
        agentsOn={agents}
        onAgents={() => setAgents(true)}
        onNew={() => setSubmitting(true)}
        error={summary.error ? summary.error.message : null}
      />
    );
    const detail = agents ? (
      <AgentsPage
        host={host.id}
        viewer={viewer}
        onOpen={(id) => openTask(id, true)}
        onBack={() => setAgents(false)}
      />
    ) : task ? (
      <TaskDetail
        key={task}
        host={host.id}
        id={task}
        viewer={viewer}
        now={now}
        back={fromAgents ? "Agents" : "Tasks"}
        onBack={() => {
          setPicked(null);
          setAgents(fromAgents);
          setFromAgents(false);
        }}
      />
    ) : (
      <View style={{ flex: 1, padding: 24 }}>
        <Txt muted>No tasks yet</Txt>
      </View>
    );
    if (mode === "wide")
      return (
        <>
          {list}
          {detail}
        </>
      );
    return agents || task ? detail : list;
  };

  return (
    <LookProvider value={look}>
      <View
        style={{ flex: 1, flexDirection: "row", backgroundColor: c.surface0 }}
        onLayout={(e) => setWidth(e.nativeEvent.layout.width)}
      >
        {body()}
        {s && viewer ? (
          <SubmitModal
            host={host.id}
            open={submitting}
            onOpenChange={setSubmitting}
            agents={viewer.hosts.flatMap((h) => h.agents)}
            requester={viewer.requester}
            onSubmitted={(id) => openTask(id, false)}
          />
        ) : null}
      </View>
    </LookProvider>
  );
}
