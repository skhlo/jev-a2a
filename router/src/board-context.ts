// The model as the page's viewer sees it, read once for every panel: the
// tasks by id, the needs-you items with what the viewer may do, the groups
// the task list shows, the selected task, and the questions the panels ask
// of them.
import type { BoardModel, TaskView } from "./board.ts";
import { age, dated, slot } from "./board-parts.ts";
import type { NeedsYouItem, Role } from "./types.ts";

// A needs-you item with its place in the model and what the viewer may do.
export type NeedsItem = {
  path: string;
  group: number;
  principal: string;
  item: NeedsYouItem;
  // It counts for the viewer: the viewer holds its principal. Without a
  // viewer the page shows every principal's items, read only.
  mine: boolean;
  // The viewer's post for it is signed as its principal, so the actions
  // endpoint accepts it.
  act: boolean;
};

const ASKING: TaskView["status"][] = [
  "needs_answer",
  "needs_recipient",
  "uncertain",
];

// `asked` is the task the page was asked for, its `task` query parameter.
export function pageContext(
  model: BoardModel,
  asked: string | null | undefined,
) {
  const { actor, at, times } = model;
  const roleOf = (principal: string): Role | undefined =>
    actor?.principals.find((p) => p.principal === principal)?.role;
  // The principal a post is signed as. A post does not name one: the
  // actions endpoint takes the viewer's first principal in the role the
  // action needs, so the page offers forms for that principal's items only.
  const signer = (role: Role): string | undefined =>
    actor?.principals.find((p) => p.role === role)?.principal;

  const tasks = new Map<string, { path: string; task: TaskView }>();
  model.open.forEach((task, i) =>
    tasks.set(task.id, { path: `open[${i}]`, task }),
  );
  model.finished.forEach((task, i) =>
    tasks.set(task.id, { path: `finished[${i}]`, task }),
  );
  const items: NeedsItem[] = model.needsYou.flatMap((entry, group) =>
    entry.items.map((item, k) => ({
      path: `needsYou[${group}].items[${k}]`,
      group,
      principal: entry.principal,
      item,
      mine: actor === null || roleOf(entry.principal) !== undefined,
      act:
        entry.principal ===
        signer(item.kind === "resolve" ? "operator" : "requester"),
    })),
  );
  const itemsFor = (taskId: string): NeedsItem[] =>
    items.filter((it) => it.item.taskId === taskId);
  const answers = (deliveryId: string) =>
    items.flatMap((it) =>
      it.item.kind === "answer" && it.item.deliveryId === deliveryId
        ? [{ ...it, item: it.item }]
        : [],
    );
  const asksViewer = (deliveryId: string): boolean =>
    answers(deliveryId).some((it) => it.mine);
  // The open questions that wait on the viewer, by id.
  const asking = new Set(
    items.flatMap((it) =>
      it.mine && it.item.kind === "answer" ? [it.item.questionId] : [],
    ),
  );

  // One group per task. Needs you holds each task with an item of the
  // viewer's, finished or not; In flight and Done hold the rest.
  const needs = new Map<string, NeedsItem>();
  for (const it of items)
    if (it.mine && !needs.has(it.item.taskId)) needs.set(it.item.taskId, it);
  const rest = (list: TaskView[], name: string) =>
    list.flatMap((task, i) =>
      needs.has(task.id) ? [] : [{ task, path: `${name}[${i}]` }],
    );
  const flight = rest(model.open, "open");
  const done = rest(model.finished, "finished");
  const requested = asked ?? "";
  const selected =
    tasks.has(requested) || needs.has(requested)
      ? requested
      : ([...needs.keys()][0] ??
        model.open[0]?.id ??
        model.finished[0]?.id ??
        null);

  const source = (t: TaskView): string =>
    t.source.slice(0, t.source.lastIndexOf("/"));
  // Only the sender may cancel, and only while the task is open. The core
  // refuses a task whose work may have reached a participant, and says so.
  const mayCancel = (t: TaskView): boolean =>
    !t.final && source(t) === signer("requester");
  // A row's class and dot. Blue means the viewer is needed: a task that
  // waits on someone else's decision waits like a queued one.
  const taskClass = (t: TaskView): [string, string] =>
    needs.has(t.id)
      ? ["ask", "ask"]
      : t.final
        ? [t.status === "canceled" ? "done canceled" : "done", "done"]
        : ASKING.includes(t.status) || t.status === "queued"
          ? ["held", "wait"]
          : ["work", "work"];
  const ago = (
    path: string,
    iso: string | null | undefined,
    cls: string,
    text = age(iso, at),
  ) => slot(path, text, cls, "span", dated(iso));

  return {
    model,
    actor,
    at,
    times,
    tasks,
    needs,
    flight,
    done,
    selected,
    asking,
    itemsFor,
    answers,
    asksViewer,
    source,
    mayCancel,
    taskClass,
    ago,
  };
}
