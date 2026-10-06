// The selected task: its head (title, status, meta line and Cancel task),
// the viewer's forms first, then Conversation, Deliveries, Notices, Jev and
// Log.
import { useState } from "react";
import { View } from "react-native";
import type { FullTask } from "../shared/rpc.ts";
import { useTask } from "./data.ts";
import {
  conversation,
  count,
  deliveryLine,
  deliveryState,
  firstLine,
  itemKey,
  itemWaits,
  judgmentLines,
  label,
  metaLine,
  shortSession,
  statusTone,
  type Item,
  type Viewer,
} from "./format.ts";
import {
  AnswerForm,
  CancelModal,
  ChooseForm,
  HoldButton,
  ResolveForm,
} from "./forms.tsx";
import {
  BackRow,
  Button,
  CardRow,
  Parts,
  Pill,
  Page,
  Section,
  Txt,
  useFormButton,
  useLook,
} from "./ui.tsx";

type Props = {
  host: string;
  id: string;
  viewer: Viewer;
  now: number;
  // Where the back row returns: the list, or the Agents page.
  back: "Tasks" | "Agents";
  onBack: () => void;
};

export function TaskDetail({ host, id, viewer, now, back, onBack }: Props) {
  const { mode } = useLook();
  const head = viewer.head(id);
  const query = useTask(host, id, head?.rev ?? null);
  const full = query.data ?? null;
  const items = viewer.itemsFor(id);
  const waiting = items.filter((it) => !it.act);
  return (
    <Page>
      {/* Each settings section keeps its own space below it. */}
      <View style={{ marginBottom: 24 }}>
        {mode === "wide" ? null : <BackRow label={back} onPress={onBack} />}
        {full ? (
          <Head host={host} full={full} viewer={viewer} now={now} />
        ) : (
          <Txt muted>
            {query.isPending
              ? "Loading..."
              : query.error
                ? query.error.message
                : `${id} is not among the last finished tasks`}
          </Txt>
        )}
      </View>
      {items
        .filter((it) => it.act)
        .map((it) => (
          <Form key={itemKey(it.item)} host={host} it={it} full={full} />
        ))}
      {waiting.length ? (
        <View style={{ gap: 8, marginBottom: 24, marginLeft: 4 }}>
          {waiting.map((it) => (
            <Txt key={itemKey(it.item)} size="sm" muted>
              {itemWaits(it, full?.task ?? null)}
            </Txt>
          ))}
        </View>
      ) : null}
      {full ? <Record host={host} full={full} viewer={viewer} /> : null}
      {full && mode === "compact" && mayCancel(viewer, full) ? (
        <CancelButton host={host} full={full} />
      ) : null}
    </Page>
  );
}

const mayCancel = (viewer: Viewer, { task }: FullTask): boolean =>
  viewer.mayCancel(task.source, !task.final);

function Head({
  host,
  full,
  viewer,
  now,
}: {
  host: string;
  full: FullTask;
  viewer: Viewer;
  now: number;
}) {
  const { mode } = useLook();
  const t = full.task;
  return (
    <View style={{ gap: 8 }}>
      <View style={{ flexDirection: "row", alignItems: "flex-start", gap: 12 }}>
        <View style={{ flex: 1, minWidth: 0, gap: 8 }}>
          <Txt size="lg" strong lines={2}>
            {firstLine(t.text)}
          </Txt>
          <View style={{ flexDirection: "row" }}>
            <Pill
              part={{
                text: label(t.status),
                tone: statusTone(
                  t.status,
                  viewer.itemsFor(t.id).some((it) => it.mine),
                ),
              }}
            />
          </View>
        </View>
        {mode !== "compact" && mayCancel(viewer, full) ? (
          <CancelButton host={host} full={full} />
        ) : null}
      </View>
      <Parts parts={metaLine(full, now)} wrap />
    </View>
  );
}

// In the head, or at full width after the Log on a phone.
function CancelButton({ host, full }: { host: string; full: FullTask }) {
  const [open, setOpen] = useState(false);
  const button = useFormButton();
  return (
    <>
      <Button
        {...button}
        variant="outline"
        label="Cancel task"
        onPress={() => setOpen(true)}
      />
      <CancelModal
        host={host}
        task={full.task}
        open={open}
        onOpenChange={setOpen}
      />
    </>
  );
}

function Form({
  host,
  it,
  full,
}: {
  host: string;
  it: Item;
  full: FullTask | null;
}) {
  const t = full?.task ?? null;
  const item = it.item;
  const delivery = (id: string) => t?.deliveries.find((d) => d.id === id);
  switch (item.kind) {
    case "answer":
      return (
        <AnswerForm
          host={host}
          principal={it.principal}
          item={item}
          placement={
            delivery(item.deliveryId)?.placement ?? t?.recipient ?? "the agent"
          }
        />
      );
    case "choose":
      return <ChooseForm host={host} item={item} task={t} />;
    case "resolve":
      return (
        <ResolveForm
          host={host}
          principal={it.principal}
          item={item}
          outcome={delivery(item.deliveryId)?.send.outcome ?? null}
        />
      );
  }
}

// The task's record: what was said, where it went, what Jev judged and the
// router's log.
function Record({
  host,
  full,
  viewer,
}: {
  host: string;
  full: FullTask;
  viewer: Viewer;
}) {
  const { task: t, times } = full;
  const digits = String(Math.max(0, ...t.log.map((e) => e.n))).length;
  return (
    <>
      <Section title="Conversation">
        {conversation(full).map((said, i) => (
          <CardRow key={said.key} first={i === 0}>
            {said.who ? (
              <>
                <Txt size="sm" muted>
                  {said.who}
                </Txt>
                <Txt size="content">{said.text}</Txt>
              </>
            ) : (
              <Txt size="sm" muted>
                {said.text}
              </Txt>
            )}
          </CardRow>
        ))}
      </Section>
      {t.deliveries.length ? (
        <Section title="Deliveries">
          {t.deliveries.map((d, i) => (
            <CardRow key={d.id} first={i === 0}>
              <View
                style={{ flexDirection: "row", alignItems: "center", gap: 8 }}
              >
                <View style={{ flex: 1, minWidth: 0 }}>
                  <Txt lines={1}>{d.placement}</Txt>
                </View>
                <Pill part={deliveryState(d, viewer.asksViewer(d.id))} />
                {viewer.identified && !d.end && !t.final ? (
                  <HoldButton
                    host={host}
                    placement={d.placement}
                    viewer={viewer}
                  />
                ) : null}
              </View>
              <Txt size="sm" muted lines={1}>
                {deliveryLine(d, times)}
              </Txt>
            </CardRow>
          ))}
        </Section>
      ) : (
        <View style={{ gap: 12, marginBottom: 24 }}>
          <Txt size="sm" muted style={{ marginLeft: 4 }}>
            Deliveries
          </Txt>
          <Txt size="sm" muted style={{ marginLeft: 4 }}>
            No delivery yet
          </Txt>
        </View>
      )}
      {t.via && t.notices.length ? (
        <Section title={`Notices to ${t.via}`}>
          {t.notices.map((n, i) => (
            <CardRow key={n.key} first={i === 0}>
              <View
                style={{ flexDirection: "row", alignItems: "center", gap: 8 }}
              >
                <View style={{ flex: 1, minWidth: 0 }}>
                  <Txt lines={1}>{n.key}</Txt>
                </View>
                <Pill part={{ text: n.outcome }} />
              </View>
              <Txt size="sm" muted>
                {`${n.kind} · ${n.session ? shortSession(n.session) : "no session"}`}
              </Txt>
            </CardRow>
          ))}
        </Section>
      ) : null}
      {t.judgments.length ? (
        <Section title="Jev">
          {t.judgments.map((j, i) => {
            const lines = judgmentLines(j);
            return (
              <CardRow key={i} first={i === 0}>
                <Txt>{lines.verdict}</Txt>
                <Txt size="sm" muted>
                  {lines.table}
                </Txt>
              </CardRow>
            );
          })}
        </Section>
      ) : null}
      <Section title={`Log · ${count(t.log.length, "line", "lines")}`}>
        <View style={{ padding: 16, gap: 6 }}>
          {t.log.map((e) => (
            <View key={e.n} style={{ flexDirection: "row", gap: 12 }}>
              {/* The journal's line numbers, padded to the widest in the
                  monospace face so they right-align at any length. */}
              <Txt size="code" muted>
                {String(e.n).padStart(digits)}
              </Txt>
              <View style={{ flex: 1, minWidth: 0 }}>
                <Txt size="code">{`${e.actor}: ${e.text}`}</Txt>
              </View>
            </View>
          ))}
        </View>
      </Section>
    </>
  );
}
