// The Jev board surface. Its arrangement follows its own width, since the
// app sidebar takes a share of the window: wide (720 px or more) shows the
// list and the selected task side by side; narrower shows one at a time,
// with phone controls when the app is compact. The selection lives here;
// surfaces take no params, so a reload returns to the list.
import type { PluginSurfaceProps } from "@getpaseo/plugin/client";
import { useEffect, useMemo, useState } from "react";
import { View } from "react-native";
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
  const [picked, setPicked] = useState<string | null>(null);
  const [submitting, setSubmitting] = useState(false);
  // The wide detail shows the first pick until the viewer picks another,
  // and keeps it when an action or a poll moves it down the list.
  const first = mode === "wide" && viewer ? firstPick(viewer) : null;
  useEffect(() => {
    if (picked === null && first !== null) setPicked(first);
  }, [picked, first]);
  const selected = picked ?? first;
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
        selected={selected}
        onSelect={setPicked}
        onNew={() => setSubmitting(true)}
        error={summary.error ? summary.error.message : null}
      />
    );
    const detail = selected ? (
      <TaskDetail
        key={selected}
        host={host.id}
        id={selected}
        viewer={viewer}
        now={now}
        onBack={() => setPicked(null)}
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
    return selected ? detail : list;
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
            placements={s.placements}
            requester={viewer.requester}
            onSubmitted={setPicked}
          />
        ) : null}
      </View>
    </LookProvider>
  );
}
