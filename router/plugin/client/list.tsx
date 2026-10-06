// The task list: Needs you, In flight and Done (the last ten), each row the
// title, its age and a dot, then line 2 (format.ts rowLine). A group's
// heading collapses it to the heading and its count, as on the board.
import { Icon, ScrollView } from "@getpaseo/plugin/client/react-native";
import { useState } from "react";
import { Pressable, View } from "react-native";
import { age, rowDot, rowLine, type ListRow, type Viewer } from "./format.ts";
import { Button, Dot, Parts, Txt, useLook } from "./ui.tsx";

// The collapsed groups, kept while the app runs: the board keeps them on
// the device, but the plugin SDK has no device storage.
let collapsed: string[] = [];

type Props = {
  viewer: Viewer;
  now: number;
  selected: string | null;
  onSelect: (id: string) => void;
  onNew: () => void;
  // Why the summary failed, while it does.
  error: string | null;
};

export function TaskList({
  viewer,
  now,
  selected,
  onSelect,
  onNew,
  error,
}: Props) {
  const { c, mode } = useLook();
  const compact = mode === "compact";
  const [shut, setShut] = useState(collapsed);
  const toggle = (name: string) => {
    collapsed = shut.includes(name)
      ? shut.filter((n) => n !== name)
      : [...shut, name];
    setShut(collapsed);
  };
  const group = (name: string, n: string, rows: ListRow[]) => (
    <View key={name}>
      <Pressable
        accessibilityRole="button"
        accessibilityLabel={name}
        aria-expanded={!shut.includes(name)}
        onPress={() => toggle(name)}
        style={{
          flexDirection: "row",
          alignItems: "center",
          gap: 6,
          paddingHorizontal: 12,
          paddingTop: 12,
          paddingBottom: 8,
        }}
      >
        <View style={{ flexDirection: "row", alignItems: "baseline", gap: 8 }}>
          <Txt muted strong>
            {name}
          </Txt>
          <Txt size="sm" muted>
            {n}
          </Txt>
        </View>
        <Icon
          name={shut.includes(name) ? "ChevronRight" : "ChevronDown"}
          size={14}
          color={c.foregroundMuted}
        />
      </Pressable>
      {shut.includes(name) ? null : rows.length ? (
        rows.map((row) => (
          <TaskRow
            key={row.id}
            row={row}
            now={now}
            on={row.id === selected}
            onPress={() => onSelect(row.id)}
          />
        ))
      ) : (
        <View
          style={{ paddingHorizontal: 12, paddingBottom: 8, paddingTop: 4 }}
        >
          <Txt size="sm" muted>
            None
          </Txt>
        </View>
      )}
    </View>
  );
  return (
    <View
      style={
        mode === "wide"
          ? { width: 320, borderRightWidth: 1, borderRightColor: c.border }
          : { flex: 1, minWidth: 0 }
      }
    >
      {compact ? null : (
        <View
          style={{
            paddingTop: 12,
            paddingHorizontal: 12,
            paddingBottom: 4,
            alignItems: "flex-start",
          }}
        >
          <Button label="New task" icon="Plus" onPress={onNew} />
        </View>
      )}
      {error ? (
        <View style={{ paddingHorizontal: 24, paddingTop: 8 }}>
          <Txt size="sm" muted>
            {error}
          </Txt>
        </View>
      ) : null}
      <ScrollView
        contentContainerStyle={{
          paddingTop: 4,
          paddingHorizontal: 12,
          paddingBottom: compact ? 72 : 24,
        }}
      >
        {group("Needs you", String(viewer.needs.length), viewer.needs)}
        {group("In flight", String(viewer.flight.length), viewer.flight)}
        {group("Done", `last ${viewer.done.length}`, viewer.done)}
      </ScrollView>
      {compact ? (
        <Pressable
          accessibilityRole="button"
          accessibilityLabel="New task"
          onPress={onNew}
          style={{
            position: "absolute",
            right: 16,
            bottom: 16,
            width: 56,
            height: 56,
            borderRadius: 999,
            backgroundColor: c.surface2,
            borderWidth: 1,
            borderColor: c.border,
            alignItems: "center",
            justifyContent: "center",
          }}
        >
          <Icon name="Plus" size={20} color={c.foreground} />
        </Pressable>
      ) : null}
    </View>
  );
}

function TaskRow({
  row,
  now,
  on,
  onPress,
}: {
  row: ListRow;
  now: number;
  on: boolean;
  onPress: () => void;
}) {
  const { c } = useLook();
  const dot = rowDot(row);
  return (
    <Pressable
      accessibilityRole="button"
      accessibilityState={{ selected: on }}
      onPress={onPress}
      style={{
        gap: 2,
        paddingVertical: 8,
        paddingHorizontal: 12,
        borderRadius: 8,
        marginBottom: 4,
        ...(on ? { backgroundColor: c.surface2 } : {}),
      }}
    >
      <View style={{ flexDirection: "row", alignItems: "center", gap: 8 }}>
        <View style={{ flex: 1, minWidth: 0 }}>
          <Txt lines={1}>
            {row.head?.title ?? "Not among the last finished tasks"}
          </Txt>
        </View>
        <Txt size="sm" muted>
          {row.head ? age(row.head.sentAt, now) : ""}
        </Txt>
        {dot ? <Dot tone={dot} /> : null}
      </View>
      <Parts parts={rowLine(row, now)} />
    </Pressable>
  );
}
