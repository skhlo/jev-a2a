// The viewer's forms: answer, choose and resolve for its own needs-you
// items, and the New task and Cancel task modals. Each sends one RPC
// through useAct (data.ts).
import { useRpc } from "@getpaseo/plugin/client";
import { Modal, TextInput } from "@getpaseo/plugin/client/react-native";
import { useState, type ReactNode } from "react";
import { View } from "react-native";
import * as rpc from "../shared/rpc.ts";
import type { Acted, FullTask, Summary } from "../shared/rpc.ts";
import { useAct, useMessageId } from "./data.ts";
import { firstLine, label, resolveWhy, type Item } from "./format.ts";
import {
  Button,
  CardRow,
  FormFoot,
  LookProvider,
  ModalFoot,
  RadioRow,
  Section,
  SIZE,
  Txt,
  useFormButton,
  useLook,
} from "./ui.tsx";

type Task = FullTask["task"];
type ItemOf<K extends Item["item"]["kind"]> = Extract<
  Item["item"],
  { kind: K }
>;

function Input({
  value,
  onChange,
  placeholder,
  minHeight,
  label: name,
  multiline = true,
}: {
  value: string;
  onChange: (text: string) => void;
  placeholder: string;
  minHeight: number;
  label: string;
  multiline?: boolean;
}) {
  const { c } = useLook();
  return (
    <TextInput
      accessibilityLabel={name}
      value={value}
      onChangeText={onChange}
      placeholder={placeholder}
      placeholderTextColor={c.foregroundMuted}
      multiline={multiline}
      autoCapitalize={multiline ? "sentences" : "none"}
      textAlignVertical="top"
      style={{
        minHeight,
        padding: 12,
        borderRadius: 8,
        borderWidth: 1,
        borderColor: c.border,
        backgroundColor: c.surface2,
        color: c.foreground,
        fontSize: SIZE.content,
      }}
    />
  );
}

export function AnswerForm({
  host,
  principal,
  item,
  placement,
}: {
  host: string;
  principal: string;
  item: ItemOf<"answer">;
  placement: string;
}) {
  const [text, setText] = useState("");
  const [messageId, next] = useMessageId();
  const send = useAct(host, useRpc(rpc.taskAnswer), () => {
    setText("");
    next();
  });
  const button = useFormButton();
  return (
    <Section title={`Question from ${placement}`}>
      <CardRow first>
        <Txt size="content">{item.text}</Txt>
        <Txt size="sm" muted>
          {`${item.deliveryId} · ${item.questionId} · as ${principal}`}
        </Txt>
      </CardRow>
      <CardRow>
        <Input
          label={`Your answer to ${item.taskId}`}
          value={text}
          onChange={(value) => {
            setText(value);
            next();
          }}
          placeholder="Your answer reaches the session as its next turn"
          minHeight={88}
        />
      </CardRow>
      <FormFoot hint="The task stays open until the agent replies completed">
        <Button
          {...button}
          variant="primary"
          label="Send answer"
          busy={send.isPending}
          disabled={!text.trim()}
          onPress={() =>
            send.mutate({
              taskId: item.taskId,
              deliveryId: item.deliveryId,
              questionId: item.questionId,
              text,
              messageId,
            })
          }
        />
      </FormFoot>
    </Section>
  );
}

// Jev's suggestions in its order, the first chosen; a choice Jev no
// longer suggests falls back to the first. Without any (Jev's answer was
// unusable or Jev was not reached), the sender names the participant, as
// on the board.
export function ChooseForm({
  host,
  item,
  task,
}: {
  host: string;
  item: ItemOf<"choose">;
  task: Task | null;
}) {
  const [choice, setChoice] = useState(item.suggestions[0] ?? "");
  const first = item.suggestions[0];
  const chosen =
    first === undefined || item.suggestions.includes(choice) ? choice : first;
  const send = useAct(host, useRpc(rpc.taskChoose));
  const button = useFormButton();
  const judged = task?.judgments[task.judgments.length - 1];
  const probabilities = judged?.probabilities ?? {};
  const named = chosen.trim();
  return (
    <Section title={`Choose a recipient · ${label(item.reason)}`}>
      {item.suggestions.length ? (
        item.suggestions.map((name, i) => {
          const p = probabilities[name];
          return (
            <RadioRow
              key={name}
              first={i === 0}
              on={name === chosen}
              onPress={() => setChoice(name)}
            >
              <View style={{ flex: 1, minWidth: 0 }}>
                <Txt lines={1}>{name}</Txt>
              </View>
              {p === undefined ? null : <Txt muted>{p.toFixed(2)}</Txt>}
            </RadioRow>
          );
        })
      ) : (
        <CardRow first>
          <Input
            label={`Recipient for ${item.taskId}`}
            value={chosen}
            onChange={setChoice}
            placeholder="Participant id"
            minHeight={44}
            multiline={false}
          />
        </CardRow>
      )}
      <FormFoot
        hint={
          item.suggestions.length
            ? "Jev's order with its probabilities; the first is its choice"
            : "Jev suggested no one; name the participant"
        }
      >
        <Button
          {...button}
          variant="primary"
          label={named ? `Send to ${named}` : "Send"}
          busy={send.isPending}
          disabled={!named}
          onPress={() => send.mutate({ taskId: item.taskId, recipient: named })}
        />
      </FormFoot>
    </Section>
  );
}

// "Mark not sent" only while the send is not accepted; without the task,
// both, and the router refuses the one it cannot take.
export function ResolveForm({
  host,
  principal,
  item,
  outcome,
}: {
  host: string;
  principal: string;
  item: ItemOf<"resolve">;
  outcome: string | null;
}) {
  const send = useAct(host, useRpc(rpc.taskResolve));
  const button = useFormButton();
  const mark = (to: "finished" | "not_sent") =>
    send.mutate({
      deliveryId: item.deliveryId,
      messageId: item.messageId,
      outcome: to,
    });
  const which = send.isPending ? send.variables?.outcome : undefined;
  return (
    <Section title={`Resolve ${item.deliveryId} · ${label(item.reason)}`}>
      <CardRow first>
        <Txt size="content">{resolveWhy(item.reason, outcome)}</Txt>
        <Txt size="sm" muted>
          {`send ${item.messageId} · ${outcome ?? "unknown"} · as ${principal}`}
        </Txt>
      </CardRow>
      <FormFoot hint="Only the outcomes the router accepts are offered">
        {outcome === "accepted" ? null : (
          <Button
            {...button}
            variant="outline"
            label="Mark not sent"
            busy={which === "not_sent"}
            disabled={send.isPending}
            onPress={() => mark("not_sent")}
          />
        )}
        <Button
          {...button}
          variant="primary"
          label="Mark finished"
          busy={which === "finished"}
          disabled={send.isPending}
          onPress={() => mark("finished")}
        />
      </FormFoot>
    </Section>
  );
}

function Field({
  name,
  hint,
  children,
}: {
  name: string;
  hint: string;
  children: ReactNode;
}) {
  return (
    <View style={{ gap: 8 }}>
      <Txt strong>{name}</Txt>
      {children}
      <Txt size="sm" muted>
        {hint}
      </Txt>
    </View>
  );
}

// New task: the request, then whom to send it to: Jev's choice, or one
// placement with its host and readiness.
export function SubmitModal({
  host,
  open,
  onOpenChange,
  placements,
  requester,
  onSubmitted,
}: {
  host: string;
  open: boolean;
  onOpenChange: (open: boolean) => void;
  placements: Summary["placements"];
  // Who the request is sent as; without one, nobody may submit.
  requester: string | null;
  onSubmitted: (taskId: string) => void;
}) {
  const look = useLook();
  const { c } = look;
  const [text, setText] = useState("");
  const [to, setTo] = useState<string | null>(null);
  const [messageId, next] = useMessageId();
  const send = useAct(host, useRpc(rpc.taskSubmit), (result: Acted) => {
    setText("");
    setTo(null);
    next();
    onOpenChange(false);
    if (result.task) onSubmitted(result.task.task.id);
  });
  const choose = (key: string | null) => {
    setTo(key);
    next();
  };
  // A placement the roster no longer lists reads, and sends, as Jev's
  // choice.
  const placement = placements.find((p) => p.key === to);
  return (
    <Modal title="New task" open={open} onOpenChange={onOpenChange}>
      <Modal.Content>
        {/* The sheet renders this content outside the surface, so the look
            goes along. */}
        <LookProvider value={look}>
          <Field
            name="Request"
            hint={
              requester ? `Sends as ${requester}` : "No requester to send as"
            }
          >
            <Input
              label="Request"
              value={text}
              onChange={(value) => {
                setText(value);
                next();
              }}
              placeholder="What should happen, and by when"
              minHeight={104}
            />
          </Field>
          <Field
            name="Send to"
            hint="Jev picks a participant when you name none"
          >
            <View
              style={{
                backgroundColor: c.surface1,
                borderWidth: 1,
                borderColor: c.border,
                borderRadius: 8,
                overflow: "hidden",
              }}
            >
              <RadioRow first on={!placement} onPress={() => choose(null)}>
                <Txt>Let Jev choose</Txt>
              </RadioRow>
              {placements.map((p) => (
                <RadioRow
                  key={p.key}
                  on={p === placement}
                  onPress={() => choose(p.key)}
                >
                  <View style={{ flex: 1, minWidth: 0 }}>
                    <Txt lines={1}>
                      {p.participant} <Txt muted>{p.host}</Txt>
                    </Txt>
                  </View>
                  <Txt muted={!p.ready}>{p.ready ? "ready" : "not ready"}</Txt>
                </RadioRow>
              ))}
            </View>
          </Field>
          <ModalFoot
            buttons={[
              { label: "Cancel", onPress: () => onOpenChange(false) },
              {
                label: "Submit",
                variant: "primary",
                busy: send.isPending,
                disabled: !text.trim() || !requester,
                onPress: () =>
                  send.mutate({
                    text,
                    messageId,
                    ...(placement
                      ? { to: placement.participant, host: placement.host }
                      : {}),
                  }),
              },
            ]}
          />
        </LookProvider>
      </Modal.Content>
    </Modal>
  );
}

export function CancelModal({
  host,
  task,
  open,
  onOpenChange,
}: {
  host: string;
  task: Task;
  open: boolean;
  onOpenChange: (open: boolean) => void;
}) {
  const look = useLook();
  const send = useAct(host, useRpc(rpc.taskCancel), () => onOpenChange(false));
  const live = task.deliveries.filter((d) => !d.end);
  return (
    <Modal title={`Cancel ${task.id}?`} open={open} onOpenChange={onOpenChange}>
      <Modal.Content>
        <LookProvider value={look}>
          <Txt>{firstLine(task.text)}</Txt>
          <Txt muted>
            Work already sent keeps running; the router stops tracking it.
          </Txt>
          {live.length ? (
            <View>
              <Txt muted>Open deliveries</Txt>
              {live.map((d) => (
                <Txt key={d.id} muted>{`${d.id} to ${d.placement}`}</Txt>
              ))}
            </View>
          ) : null}
          <ModalFoot
            buttons={[
              { label: "Keep task", onPress: () => onOpenChange(false) },
              {
                label: "Cancel task",
                variant: "danger",
                busy: send.isPending,
                onPress: () => send.mutate({ taskId: task.id }),
              },
            ]}
          />
        </LookProvider>
      </Modal.Content>
    </Modal>
  );
}
