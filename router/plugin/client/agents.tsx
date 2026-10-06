// The Agents page: the placements by host, each with its state, its Hold
// or Release lever and a line per open task it holds; a line opens the
// task.
import { Pressable, View } from "react-native";
import { HoldButton } from "./detail.tsx";
import { agentCount, count, taskLine, type Viewer } from "./format.ts";
import {
  BackRow,
  CardRow,
  Glyph,
  Page,
  Parts,
  Section,
  Txt,
  useLook,
} from "./ui.tsx";

export function AgentsPage({
  host,
  viewer,
  onOpen,
  onBack,
}: {
  host: string;
  viewer: Viewer;
  onOpen: (taskId: string) => void;
  onBack: () => void;
}) {
  const { mode } = useLook();
  const agents = viewer.hosts.flatMap((h) => h.agents);
  return (
    <Page>
      <View style={{ marginBottom: 24, gap: 8 }}>
        {mode === "wide" ? null : <BackRow label="Tasks" onPress={onBack} />}
        <Txt size="lg" strong>
          Agents
        </Txt>
        <Txt size="sm" muted>
          {`${count(agents.length, "agent")} on ${count(viewer.hosts.length, "host")} · ${agentCount(viewer.hosts)}`}
        </Txt>
      </View>
      {viewer.hosts.map((h) => (
        <Section key={h.host} title={h.host}>
          {h.agents.map((a, i) => (
            <CardRow key={a.key} first={i === 0}>
              <View
                style={{ flexDirection: "row", alignItems: "center", gap: 8 }}
              >
                <Glyph state={a.state} words={a.words} />
                <View style={{ flex: 1, minWidth: 0 }}>
                  <Txt lines={1}>{a.participant}</Txt>
                </View>
                <Txt size="sm" muted>
                  {a.words}
                </Txt>
                {viewer.identified ? (
                  <HoldButton host={host} placement={a.key} viewer={viewer} />
                ) : null}
              </View>
              {a.tasks.length ? (
                a.tasks.map((t) => (
                  <Pressable
                    key={t.delivery.id}
                    accessibilityRole="button"
                    onPress={() => onOpen(t.head.id)}
                  >
                    <Parts
                      parts={taskLine(t, viewer.asksViewer(t.delivery.id))}
                    />
                  </Pressable>
                ))
              ) : (
                <Txt size="sm" muted>
                  no open task
                </Txt>
              )}
            </CardRow>
          ))}
        </Section>
      ))}
      <Txt size="sm" muted style={{ marginLeft: 4 }}>
        Hold makes new sends to an agent wait until you release it
      </Txt>
    </Page>
  );
}
