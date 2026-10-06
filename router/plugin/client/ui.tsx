// The surface's small parts, drawn from the plugin theme's colours and
// Paseo's scales only (the design's tokens): text, buttons, pills, dots,
// radios and card rows. The layout mode rides along, since it sizes the
// form buttons.
import type { PluginSurfaceProps } from "@getpaseo/plugin/client";
import { Icon, ScrollView } from "@getpaseo/plugin/client/react-native";
import { SettingsCard, SettingsSection } from "@getpaseo/plugin/client/ui";
import { createContext, useContext, type ReactNode } from "react";
import {
  Platform,
  Pressable,
  Text,
  View,
  type StyleProp,
  type TextStyle,
  type ViewStyle,
} from "react-native";
import type { AgentState, Part, Tone } from "./format.ts";

type Colors = PluginSurfaceProps["theme"]["colors"];
// wide: list and detail side by side; single: one pane at a time; compact:
// single with phone controls (layout.compact).
export type Mode = "wide" | "single" | "compact";
type Look = { c: Colors; mode: Mode };

const LookContext = createContext<Look | null>(null);
export const LookProvider = LookContext.Provider;
export function useLook(): Look {
  const look = useContext(LookContext);
  if (!look) throw new Error("useLook outside the board surface");
  return look;
}

const toneColor = (c: Colors, tone: Tone | undefined): string =>
  tone === "warn"
    ? c.statusWarning
    : tone === "danger"
      ? c.statusDanger
      : tone === "ok"
        ? c.statusSuccess
        : c.foregroundMuted;

export const SIZE = { sm: 12, base: 14, lg: 16, content: 15, code: 12 };
// A native font family is one name; the web takes a fallback list.
const MONO = Platform.select({
  ios: "Menlo",
  android: "monospace",
  default: "Menlo, Consolas, monospace",
});

type TxtProps = {
  children: ReactNode;
  size?: keyof typeof SIZE;
  muted?: boolean;
  tone?: Tone;
  strong?: boolean;
  lines?: number;
  style?: StyleProp<TextStyle>;
};

export function Txt({
  children,
  size = "base",
  muted,
  tone,
  strong,
  lines,
  style,
}: TxtProps) {
  const { c } = useLook();
  return (
    <Text
      numberOfLines={lines}
      style={[
        {
          color: tone
            ? toneColor(c, tone)
            : muted
              ? c.foregroundMuted
              : c.foreground,
          fontSize: SIZE[size],
          lineHeight: Math.round(SIZE[size] * 1.4),
          fontWeight: strong ? "500" : "400",
        },
        size === "code" && { fontFamily: MONO },
        style,
      ]}
    >
      {children}
    </Text>
  );
}

// Parts joined by " · ", each in its tone, on one line unless they wrap.
export function Parts({ parts, wrap }: { parts: Part[]; wrap?: boolean }) {
  const { c } = useLook();
  return (
    <Txt size="sm" muted {...(wrap ? {} : { lines: 1 })}>
      {parts.map((p, i) => (
        <Text key={i}>
          {i ? " · " : ""}
          <Text style={p.tone ? { color: toneColor(c, p.tone) } : undefined}>
            {p.text}
          </Text>
        </Text>
      ))}
    </Txt>
  );
}

type Variant = "primary" | "secondary" | "outline" | "danger";

export type ButtonProps = {
  label: string;
  onPress: () => void;
  variant?: Variant;
  // md in a form footer or a Modal; sm in a row or the head. Compact form
  // footers take md at full width.
  size?: "sm" | "md";
  full?: boolean;
  busy?: boolean;
  disabled?: boolean;
  icon?: string;
};

export function Button({
  label,
  onPress,
  variant = "secondary",
  size = "sm",
  full,
  busy,
  disabled,
  icon,
}: ButtonProps) {
  const { c } = useLook();
  const [fill, edge, ink] = {
    primary: [c.accent, c.accent, c.accentForeground] as const,
    secondary: [c.surface2, c.surface2, c.foreground] as const,
    outline: [undefined, c.border, c.foreground] as const,
    danger: [c.statusDanger, c.statusDanger, c.surface0] as const,
  }[variant];
  const off = !!(busy || disabled);
  return (
    <Pressable
      accessibilityRole="button"
      accessibilityLabel={label}
      accessibilityState={{ disabled: off, busy: !!busy }}
      disabled={off}
      onPress={onPress}
      style={{
        flexDirection: "row",
        alignItems: "center",
        justifyContent: "center",
        gap: 6,
        height: size === "md" ? 44 : 32,
        paddingHorizontal: size === "md" ? 16 : 12,
        borderRadius: size === "md" ? 16 : 12,
        borderWidth: 1,
        backgroundColor: fill,
        borderColor: edge,
        ...(full ? { alignSelf: "stretch" } : {}),
      }}
    >
      {icon ? <Icon name={icon} size={14} color={ink} /> : null}
      <Text style={{ color: ink, fontSize: SIZE.base }}>
        {busy ? "Sending..." : label}
      </Text>
    </Pressable>
  );
}

// A form's button size: md at full width on a phone, else sm.
export function useFormButton(): Pick<ButtonProps, "size" | "full"> {
  const { mode } = useLook();
  return mode === "compact" ? { size: "md", full: true } : { size: "sm" };
}

// A modal's buttons, md and right-aligned; on a phone they share the width.
export function ModalFoot({ buttons }: { buttons: ButtonProps[] }) {
  const { mode } = useLook();
  const compact = mode === "compact";
  return (
    <View style={{ flexDirection: "row", justifyContent: "flex-end", gap: 8 }}>
      {buttons.map((b) => (
        <View key={b.label} style={compact ? { flex: 1 } : undefined}>
          <Button {...b} size="md" full={compact} />
        </View>
      ))}
    </View>
  );
}

// Status text on a surface2 shell.
export function Pill({ part }: { part: Part }) {
  const { c } = useLook();
  return (
    <View
      style={{
        height: 22,
        paddingHorizontal: 8,
        borderRadius: 999,
        borderWidth: 1,
        borderColor: c.border,
        backgroundColor: c.surface2,
        justifyContent: "center",
      }}
    >
      <Txt size="sm" tone={part.tone ?? "muted"} lines={1}>
        {part.text}
      </Txt>
    </View>
  );
}

export function Dot({ tone }: { tone: Tone }) {
  const { c } = useLook();
  return (
    <View
      style={{
        width: 8,
        height: 8,
        borderRadius: 999,
        backgroundColor: toneColor(c, tone),
      }}
    />
  );
}

// A page in the detail pane, or the whole surface when narrow: one column
// at most 720 wide, centred.
export function Page({ children }: { children: ReactNode }) {
  const { mode } = useLook();
  return (
    <ScrollView style={{ flex: 1 }}>
      <View
        style={{
          width: "100%",
          maxWidth: 720,
          alignSelf: "center",
          paddingHorizontal: 16,
          paddingTop: mode === "wide" ? 24 : 4,
          paddingBottom: 32,
        }}
      >
        {children}
      </View>
    </ScrollView>
  );
}

// A narrow page's way back, named for where it goes.
export function BackRow({
  label,
  onPress,
}: {
  label: string;
  onPress: () => void;
}) {
  const { c } = useLook();
  return (
    <Pressable
      accessibilityRole="button"
      accessibilityLabel={`Back to ${label.toLowerCase()}`}
      onPress={onPress}
      style={{
        flexDirection: "row",
        alignItems: "center",
        gap: 4,
        height: 44,
        marginLeft: -4,
      }}
    >
      <Icon name="ChevronLeft" size={20} color={c.foregroundMuted} />
      <Txt muted>{label}</Txt>
    </Pressable>
  );
}

// An agent's mark, one Lucide Bot at 16 px so that one mark reads as one
// agent, its shape carrying the state with its colour: ready the Bot with
// Paseo's online dot on its lower right, ringed in the surface under it;
// not ready a muted Bot; held a muted BotOff, since a held agent takes no
// send.
export function AgentMark({
  state,
  label,
  behind,
}: {
  state: AgentState;
  // The agent's name and state words.
  label: string;
  // The colour of the surface the mark sits on.
  behind: string;
}) {
  const { c } = useLook();
  return (
    <View
      accessible
      accessibilityLabel={label}
      style={{ width: 16, height: 16 }}
    >
      <Icon
        name={state === "held" ? "BotOff" : "Bot"}
        size={16}
        color={state === "ready" ? c.foreground : c.foregroundMuted}
      />
      {state === "ready" ? (
        <View
          style={{
            position: "absolute",
            right: -3,
            bottom: -2,
            width: 6,
            height: 6,
            borderRadius: 999,
            borderWidth: 1.5,
            borderColor: behind,
            backgroundColor: c.statusSuccess,
          }}
        />
      ) : null}
    </View>
  );
}

function Radio({ on }: { on: boolean }) {
  const { c } = useLook();
  return (
    <View
      style={{
        width: 16,
        height: 16,
        borderRadius: 999,
        borderWidth: 1.5,
        borderColor: on ? c.accent : c.foregroundMuted,
        alignItems: "center",
        justifyContent: "center",
      }}
    >
      {on ? (
        <View
          style={{
            width: 8,
            height: 8,
            borderRadius: 999,
            backgroundColor: c.accent,
          }}
        />
      ) : null}
    </View>
  );
}

// A titled card of rows: the SDK's settings section and card.
export function Section({
  title,
  children,
}: {
  title: string;
  children: ReactNode;
}) {
  return (
    <SettingsSection title={title}>
      <SettingsCard>{children}</SettingsCard>
    </SettingsSection>
  );
}

// A row inside a card, padded 16, with a border above all but the first.
export function CardRow({
  first,
  children,
  style,
}: {
  first?: boolean;
  children: ReactNode;
  style?: StyleProp<ViewStyle>;
}) {
  const { c } = useLook();
  return (
    <View
      style={[
        { padding: 16, gap: 4 },
        !first && { borderTopWidth: 1, borderTopColor: c.border },
        style,
      ]}
    >
      {children}
    </View>
  );
}

// A card row of radio rows' kind: a pressable line.
export function RadioRow({
  on,
  onPress,
  first,
  children,
}: {
  on: boolean;
  onPress: () => void;
  first?: boolean;
  children: ReactNode;
}) {
  const { c } = useLook();
  return (
    <Pressable
      accessibilityRole="radio"
      accessibilityState={{ checked: on }}
      onPress={onPress}
      style={[
        { padding: 16, flexDirection: "row", alignItems: "center", gap: 8 },
        !first && { borderTopWidth: 1, borderTopColor: c.border },
      ]}
    >
      <Radio on={on} />
      {children}
    </Pressable>
  );
}

// A form's last card row: a hint and its buttons, stacked full width on a
// phone.
export function FormFoot({
  hint,
  children,
}: {
  hint: string;
  children: ReactNode;
}) {
  const { mode } = useLook();
  const compact = mode === "compact";
  return (
    <CardRow
      style={{
        flexDirection: compact ? "column" : "row",
        alignItems: compact ? "stretch" : "center",
        gap: 12,
      }}
    >
      <View style={compact ? undefined : { flex: 1 }}>
        <Txt size="sm" muted>
          {hint}
        </Txt>
      </View>
      {children}
    </CardRow>
  );
}
