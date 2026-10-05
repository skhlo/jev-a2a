// Executable contract for core.ts. Run: pnpm test
import test from "node:test";
import assert from "node:assert/strict";
import * as Core from "../src/core.ts";
import { initial, reduce, commands, currentSend, isOpen } from "../src/core.ts";
import config from "../src/example-config.ts";
import type {
  Accepted,
  AdapterOutcome,
  Command,
  Config,
  Delivery,
  Event,
  Outcome,
  Policy,
  Send,
  State,
  Status,
  Task,
} from "../src/types.ts";

const ORCH_ID = "orchestrator";
const ORCH = "orchestrator@mbp#1";
const KNOW = "knowledge@mini#1";
const LAB = "incus@lab01#1";

// ---- Typed access to values the tests rely on existing ----

// Fails where reading through a missing value would have thrown.
function must<T>(value: T | null | undefined, what = "a value"): T {
  if (value === null || value === undefined)
    throw new Error(`Expected ${what}.`);
  return value;
}
// reduce records the outcome of every event it applies.
const outcomeOf = (state: State): Outcome => must(state.last, "an outcome");
// The outcome of an event expectOk already accepted.
function accepted(state: State): Accepted {
  const outcome = outcomeOf(state);
  if (!outcome.ok)
    throw new Error(`Expected an accepted outcome: ${outcome.message}`);
  return outcome;
}
// A command the test expects to be a judgment request.
function judgeOf(
  command: Command | undefined,
): Extract<Command, { type: "judge" }> {
  const found = must(command, "a command");
  if (found.type !== "judge")
    throw new Error(`Expected a judge command, got ${found.type}.`);
  return found;
}
// A command's delivery ID; a judge command has none.
const deliveryIdOf = (command: Command): string | undefined =>
  command.type === "deliver" ? command.deliveryId : undefined;

// ---- Oracle: invariants checked independently of the implementation ----
// The oracle derives eligibility, in-flight, status and judgment validity
// itself, so a wrong rule in the core cannot approve its own behavior.

const last = (d: Delivery): Send =>
  must(
    d.sends.findLast((send) => send.outcome !== "withdrawn"),
    `a current send on ${d.id}`,
  );
const open = (d: Delivery): boolean => d.end === null;
const unconfirmed = (d: Delivery): boolean =>
  open(d) &&
  d.session !== null &&
  ["attempting", "unknown"].includes(last(d).outcome);
// As recorded on the delivery: the configuration may have changed since.
const isIdempotent = (_state: State, d: Delivery): boolean => d.idempotent;
const deliveriesOf = (state: State): Delivery[] =>
  state.tasks.flatMap((t) => t.deliveries);
// Older means created earlier. Deliveries are numbered from one counter;
// task order differs once a task gets its recipient after a newer one.
const createdBefore = (a: Delivery, b: Delivery): boolean =>
  Number(a.id.slice(1)) < Number(b.id.slice(1));

function oracleEligible(state: State, d: Delivery): boolean {
  const task = must(state.tasks.find((t) => t.id === d.taskId));
  const placement = must(state.placements[d.placement]);
  const send = last(d);
  if (task.final || !open(d)) return false;
  const retry = send.outcome === "unknown" && isIdempotent(state, d);
  if (send.outcome !== "pending" && !retry) return false;
  if (!placement.ready || placement.hold) return false;
  if (d.session !== null && d.session !== placement.session) return false;
  const all = deliveriesOf(state);
  if (all.some((o) => o !== d && o.placement === d.placement && unconfirmed(o)))
    return false;
  // A notice on its way to the session holds it like an unconfirmed send.
  if (
    state.tasks.some((t) =>
      t.notices.some(
        (n) => n.outcome === "attempting" && n.session === placement.session,
      ),
    )
  )
    return false;
  if (d.session === null) {
    if (
      all.some(
        (o) =>
          createdBefore(o, d) &&
          o.placement === d.placement &&
          o.session === null &&
          open(o) &&
          !must(state.tasks.find((t) => t.id === o.taskId)).final,
      )
    )
      return false;
  }
  return true;
}

function oracleStatus(task: Task): Status {
  if (task.final) return task.final.status;
  if (task.routing)
    return task.routing.state === "judging" ? "routing" : "needs_recipient";
  const live = task.deliveries.filter(open);
  if (live.some((d) => d.question)) return "needs_answer";
  const outcomes = live.map((d) => last(d).outcome);
  if (outcomes.includes("unknown")) return "uncertain";
  if (outcomes.includes("accepted")) return "working";
  if (outcomes.includes("attempting")) return "delivering";
  return "queued";
}

// The "needs you" list is complete and every item is actionable: it names
// exactly the decisions its principal can make right now, and nothing else.
function needsYouViolations(state: State): string[] {
  const out: string[] = [];
  const sessionOf = (id: string): string | undefined =>
    Object.values(state.placements).find((p) => p.participant === id)?.session;
  const principals = [
    ...Object.keys(state.config.principals),
    ...state.config.participants.map((p) => p.id),
  ];
  for (const principal of principals) {
    const items = Core.needsYou(state, principal);
    // Every participant has a placement, so it always has a session.
    const by = must(
      state.config.principals[principal] ? principal : sessionOf(principal),
      `a caller for ${principal}`,
    );
    if (state.config.principals[principal] === "operator") {
      const expected = deliveriesOf(state).filter((d) => {
        if (!open(d) || d.session === null || last(d).outcome === "attempting")
          return false;
        const task = must(state.tasks.find((t) => t.id === d.taskId));
        if (task.final) return last(d).outcome !== "accepted";
        return (
          must(state.placements[d.placement]).session !== d.session ||
          (last(d).outcome === "unknown" && !isIdempotent(state, d))
        );
      });
      if (
        items.length !== expected.length ||
        items.some(
          (item, i) =>
            item.kind !== "resolve" || item.deliveryId !== must(expected[i]).id,
        )
      )
        out.push(`operator list differs from the stuck deliveries`);
      for (const item of items) {
        // Only a resolve item names a message to reconcile; any other kind
        // already made the list differ from the stuck deliveries above.
        if (item.kind !== "resolve") continue;
        const next = reduce(state, {
          type: "resolve",
          by,
          deliveryId: item.deliveryId,
          messageId: item.messageId,
          outcome: "finished",
          evidence: "oracle",
        });
        const outcome = outcomeOf(next);
        if (!outcome.ok)
          out.push(
            `${item.deliveryId}: listed for the operator but not resolvable (${outcome.code})`,
          );
      }
      continue;
    }
    const mine = state.tasks.filter((t) => t.source === principal && !t.final);
    const chooses = mine
      .filter((t) => t.status === "needs_recipient")
      .map((t) => t.id);
    const answers = mine.flatMap((t) =>
      t.deliveries
        .filter(
          (d) =>
            open(d) &&
            d.question &&
            must(state.placements[d.placement]).session === d.session,
        )
        .map((d) => must(d.question).id),
    );
    const listed = {
      choose: items.filter((i) => i.kind === "choose").map((i) => i.taskId),
      answer: items.filter((i) => i.kind === "answer").map((i) => i.questionId),
    };
    if (
      items.length !== chooses.length + answers.length ||
      JSON.stringify(listed.choose) !== JSON.stringify(chooses) ||
      JSON.stringify(listed.answer) !== JSON.stringify(answers)
    )
      out.push(`${principal}: needs-you list differs from open decisions`);
    for (const item of items) {
      // A requester is never offered a resolve item; one here already made
      // the list differ from the open decisions above.
      if (item.kind === "resolve") continue;
      const permitted = state.config.permissions[principal] || [];
      const event: Event =
        item.kind === "choose"
          ? {
              type: "choose",
              by,
              taskId: item.taskId,
              // A task waits for a recipient only when its sender may address someone.
              to: must(item.suggestions[0] ?? permitted[0], "a recipient"),
            }
          : {
              type: "answer",
              by,
              taskId: item.taskId,
              messageId: "oracle-answer",
              questionId: item.questionId,
              deliveryId: item.deliveryId,
              text: "oracle",
            };
      const next = reduce(state, event);
      const outcome = outcomeOf(next);
      if (!outcome.ok)
        out.push(
          `${item.taskId}: listed for ${principal} but not actionable (${outcome.code})`,
        );
    }
  }
  return out;
}

function stateViolations(state: State): string[] {
  const out: string[] = [];
  const { policy, permissions } = state.config;
  const deliveries = deliveriesOf(state);
  for (const task of state.tasks) {
    const receipt = state.receipts[`${task.source}/${task.messageId}`];
    if (receipt?.taskId !== task.id)
      out.push(`${task.id}: missing request receipt`);
    if (task.status !== oracleStatus(task))
      out.push(`${task.id}: stale status`);
    if (
      task.to !== null &&
      (task.judgments.length || (task.recipient && task.chosenBy !== "address"))
    )
      out.push(`${task.id}: addressed request used a judgment`);
    if (task.judgments.length > 1)
      out.push(`${task.id}: more than one judgment`);
    // Authorization is judged by the rules when the request was made; the
    // configuration may have changed since.
    if (task.recipient && !task.permitted.includes(task.recipient))
      out.push(`${task.id}: unauthorized recipient`);
    if (task.chosenBy === "judgment") {
      const j = task.judgments.at(-1);
      const options = [...task.permitted, "none"];
      const p = j?.probabilities;
      const sound =
        p &&
        Object.keys(p).length === options.length &&
        options.every(
          (id) => typeof p[id] === "number" && p[id] >= 0 && p[id] <= 1,
        ) &&
        Math.abs(Object.values(p).reduce((a, b) => a + b, 0) - 1) < 0.01;
      if (
        !sound ||
        must(j).choice !== task.recipient ||
        // A missing probability compares false, as undefined does.
        (p[must(j).choice] ?? NaN) < must(j).threshold
      )
        out.push(`${task.id}: selected without a confident valid judgment`);
    }
    if (
      task.status === "completed" &&
      !(
        task.deliveries.length &&
        task.deliveries.every(
          (d) => d.end?.reason === "completed" && d.end.by === d.session,
        )
      )
    )
      out.push(`${task.id}: completed without every pinned session's result`);
    if (
      task.status === "canceled" &&
      task.deliveries.some((d) =>
        d.sends.some((s) =>
          s.trail.some(
            (step, i) => step === "attempting" && s.trail[i + 1] !== "not_sent",
          ),
        ),
      )
    )
      out.push(`${task.id}: canceled after work may have been delivered`);
    if (
      task.final &&
      task.deliveries.some((d) => open(d) && d.session === null)
    )
      out.push(`${task.id}: terminal task still has sendable work`);
    // The verdict counts the hosts that had answered when the task ended;
    // later results are evidence only.
    if (task.final && task.final.status !== "canceled") {
      const lateDone = task.late.filter((l) => l.kind === "completed").length;
      const done =
        task.deliveries.filter((d) => d.end?.reason === "completed").length -
        lateDone;
      const notDone = task.deliveries.length - done;
      const { status: verdict, completed, of } = task.final;
      const consistent =
        completed === done &&
        of === task.deliveries.length &&
        (verdict === "completed"
          ? done > 0 && notDone === 0
          : verdict === "partial"
            ? done > 0 && notDone > 0
            : verdict === "failed" && done === 0);
      if (!consistent)
        out.push(
          `${task.id}: verdict ${verdict} disagrees with its deliveries`,
        );
    }
  }
  const holders: Record<string, string> = {};
  for (const d of deliveries) {
    if (unconfirmed(d)) {
      if (holders[d.placement])
        out.push(
          `${d.placement}: two unconfirmed sends (${holders[d.placement]}, ${d.id})`,
        );
      holders[d.placement] = d.id;
    }
    if (d.session !== null) {
      const owner = state.sessions[d.session];
      if (owner?.participant !== d.participant || owner.host !== d.host)
        out.push(`${d.id}: pinned to a foreign session`);
    }
    // A delivery that may have reached a session stays pinned to it.
    if (
      d.session === null &&
      d.sends.some((s) =>
        s.trail.some((step) =>
          ["unknown", "accepted", "reply_seen"].includes(step),
        ),
      )
    )
      out.push(`${d.id}: unpinned after a possibly delivered attempt`);
    if (d.question && !open(d))
      out.push(`${d.id}: question on a closed delivery`);
    if (
      d.end !== null &&
      ["completed", "failed"].includes(d.end.reason) &&
      d.end.by !== d.session
    )
      out.push(`${d.id}: result from another session`);
    // A message is sent again only after a definite not_sent, or after
    // unknown through an adapter that deduplicates by the same message key.
    const safeBefore = isIdempotent(state, d)
      ? ["not_sent", "unknown"]
      : ["not_sent"];
    for (const send of d.sends) {
      send.trail.forEach((step, i) => {
        if (
          step === "attempting" &&
          i > 0 &&
          !safeBefore.includes(must(send.trail[i - 1]))
        )
          out.push(`${d.id}/${send.messageId}: unsafe resend`);
      });
    }
  }
  out.push(...needsYouViolations(state));
  out.push(...noticeViolations(state));
  return out;
}

// What the spec says a participant sender is owed now, restated here: the
// end once the task is terminal; otherwise the choice while Jev's hand-back
// stands and each open question whose session still holds the delivery.
function oracleDue(state: State, task: Task): string[] {
  if (task.via === null) return [];
  if (task.final) return ["final"];
  const due: string[] = [];
  if (task.routing?.state === "needs_recipient")
    due.push(`choose/${task.judgments.length}`);
  for (const d of task.deliveries)
    if (
      open(d) &&
      d.question &&
      d.session === must(state.placements[d.placement]).session
    )
      due.push(`question/${d.id}/${d.question.id}`);
  return due;
}

// A due notice may be attempted when it was not accepted; is not in flight
// or withdrawn; if unknown, its adapter deduplicates and its session is
// still the placement's; and nothing holds the placement: no unconfirmed
// send or in-flight notice there, no hold, and it was seen idle.
function oracleNoticeEligible(state: State, task: Task, key: string): boolean {
  const n = task.notices.find((x) => x.key === key);
  if (n && n.outcome !== "pending" && n.outcome !== "unknown") return false;
  const placement = must(state.placements[must(task.via)]);
  if (
    n?.outcome === "unknown" &&
    (!n.idempotent || n.session !== placement.session)
  )
    return false;
  if (!placement.ready || placement.hold) return false;
  if (
    deliveriesOf(state).some((d) => d.placement === task.via && unconfirmed(d))
  )
    return false;
  return !state.tasks.some((t) =>
    t.notices.some(
      (x) => x.outcome === "attempting" && x.session === placement.session,
    ),
  );
}

// Notices: only a participant sender is told; what is due is recorded as
// pending the moment it is due and each key once; an attempt goes to the
// sender's current session and is the only thing in flight there; a repeat
// attempt follows the same rule as a resend; commands() offers exactly the
// eligible notices.
function noticeViolations(state: State): string[] {
  const out: string[] = [];
  const attempting: Record<string, string> = {};
  const offered = new Set(
    commands(state)
      .filter((c) => c.type === "notify")
      .map((c) => `${c.taskId}/${c.key}`),
  );
  for (const task of state.tasks) {
    if (task.via === null && task.notices.length)
      out.push(`${task.id}: a person was sent a notice`);
    const keys = task.notices.map((n) => n.key);
    if (new Set(keys).size !== keys.length)
      out.push(`${task.id}: a notice key recorded twice`);
    const due = oracleDue(state, task);
    for (const key of due) {
      if (!keys.includes(key))
        out.push(`${task.id}/${key}: due but not recorded`);
      const eligible = oracleNoticeEligible(state, task, key);
      if (eligible !== offered.has(`${task.id}/${key}`))
        out.push(
          `${task.id}/${key}: commands() disagrees with the oracle on eligibility`,
        );
      offered.delete(`${task.id}/${key}`);
    }
    for (const n of task.notices) {
      // Repeating an unknown notice is safe only through an adapter that
      // deduplicates, as recorded when the notice fell due.
      const safeBefore = n.idempotent ? ["not_sent", "unknown"] : ["not_sent"];
      if (n.kind === "final" && !task.final)
        out.push(`${task.id}/${n.key}: final notice before the end`);
      // A notice that stopped standing is withdrawn, never left waiting;
      // an accepted or attempting one keeps its outcome.
      if (!due.includes(n.key) && ["pending", "unknown"].includes(n.outcome))
        out.push(`${task.id}/${n.key}: no longer due but still waiting`);
      if (n.outcome === "withdrawn" && n.kind === "final")
        out.push(`${task.id}/${n.key}: a final notice withdrawn`);
      if ((n.text === null) !== !n.trail.includes("attempting"))
        out.push(`${task.id}/${n.key}: text and attempts disagree`);
      n.trail.forEach((step, i) => {
        if (
          step === "attempting" &&
          i > 0 &&
          !safeBefore.includes(must(n.trail[i - 1]))
        )
          out.push(`${task.id}/${n.key}: unsafe repeat`);
      });
      if (n.outcome !== "attempting") continue;
      // The session may have been replaced since; it was the sender's.
      const via = task.via === null ? undefined : state.placements[task.via];
      const owner = state.sessions[n.session ?? ""];
      if (
        !via ||
        owner?.participant !== via.participant ||
        owner.host !== via.host
      )
        out.push(`${task.id}/${n.key}: attempting at a foreign session`);
      const session = n.session ?? "";
      if (attempting[session])
        out.push(
          `${session}: two notices attempting (${attempting[session]}, ${task.id}/${n.key})`,
        );
      attempting[session] = `${task.id}/${n.key}`;
      if (
        deliveriesOf(state).some(
          (d) => d.placement === task.via && unconfirmed(d),
        )
      )
        out.push(`${task.id}/${n.key}: attempting beside an unconfirmed send`);
    }
  }
  for (const key of offered) out.push(`${key}: offered but not due`);
  return out;
}

function stepViolations(prev: State, event: Event, next: State): string[] {
  const out: string[] = [];
  if (!outcomeOf(next).ok) {
    for (const key of [
      "tasks",
      "receipts",
      "placements",
      "sessions",
      "now",
      "boot",
    ] as const)
      if (JSON.stringify(prev[key]) !== JSON.stringify(next[key]))
        out.push(`rejected ${event.type} changed ${key}`);
    return out;
  }
  for (const [key, receipt] of Object.entries(prev.receipts))
    if (JSON.stringify(next.receipts[key]) !== JSON.stringify(receipt))
      out.push(`receipt ${key} changed`);
  let newAttempts = 0;
  for (const before of prev.tasks) {
    const after = must(next.tasks.find((task) => task.id === before.id));
    if (
      before.final &&
      JSON.stringify(before.final) !== JSON.stringify(after.final)
    )
      out.push(`${before.id}: terminal state changed`);
    if (before.recipient && before.recipient !== after.recipient)
      out.push(`${before.id}: recipient changed`);
    for (const d of before.deliveries) {
      const d2 = must(after.deliveries.find((entry) => entry.id === d.id));
      if (d.end && JSON.stringify(d.end) !== JSON.stringify(d2.end))
        out.push(`${d.id}: closed delivery reopened`);
      if (
        d.session !== null &&
        d2.session !== d.session &&
        !(event.type === "adapterResult" && event.outcome === "not_sent")
      )
        out.push(`${d.id}: session changed without definite non-delivery`);
      d.sends.forEach((send, i) => {
        const trail = must(d2.sends[i]).trail;
        if (
          JSON.stringify(trail.slice(0, send.trail.length)) !==
          JSON.stringify(send.trail)
        )
          out.push(`${d.id}: history rewritten`);
        const added = trail
          .slice(send.trail.length)
          .filter((step) => step === "attempting").length;
        if (added) {
          newAttempts += added;
          if (
            event.type !== "attempt" ||
            event.deliveryId !== d.id ||
            !oracleEligible(prev, d)
          )
            out.push(`${d.id}: attempted without an eligible attempt event`);
        }
      });
    }
  }
  if (newAttempts > 1) out.push("more than one attempt in one event");
  if (event.type === "attempt") {
    const placement = must(Core.findDelivery(next, event.deliveryId)).placement;
    if (must(next.placements[placement]).ready)
      out.push(
        `${placement}: still ready after a send; the next send could interrupt it`,
      );
  }
  if (event.type === "observe" && event.session !== undefined) {
    const p = must(next.placements[event.placement]);
    const replaced =
      p.session !== must(prev.placements[event.placement]).session;
    if (replaced && p.ready && event.ready !== true)
      out.push(
        `${event.placement}: replaced session counted as ready unobserved`,
      );
  }
  // The shell is offered exactly the eligible work.
  const offered = new Set(
    commands(next)
      .filter((c) => c.type === "deliver")
      .map((c) => c.deliveryId),
  );
  for (const d of deliveriesOf(next))
    if (oracleEligible(next, d) !== offered.has(d.id))
      out.push(`${d.id}: commands() disagrees with the oracle on eligibility`);
  return out;
}

function apply(state: State, event: Event): State {
  const next = reduce(state, event);
  const problems = [
    ...stepViolations(state, event, next),
    ...stateViolations(next),
  ];
  assert.deepEqual(problems, [], `after ${JSON.stringify(event)}`);
  return next;
}

function expectOk(state: State, event: Event): State {
  const next = apply(state, event);
  const outcome = outcomeOf(next);
  assert.ok(outcome.ok, `${event.type} rejected: ${outcome.message}`);
  return next;
}

function expectReject(state: State, event: Event, code: string): State {
  const next = apply(state, event);
  const outcome = outcomeOf(next);
  assert.equal(outcome.ok, false, `${event.type} should be rejected`);
  assert.equal(outcome.code, code, outcome.message);
  return next;
}

const task = (state: State, id = "T1") =>
  must(Core.findTask(state, id), `task ${id}`);
const idle = (state: State, placement = "orchestrator@mbp") =>
  expectOk(state, { type: "observe", placement, ready: true });
// A participant whose adapter cannot deduplicate, like a herdr pane.
const strictConfig = structuredClone(config);
must(
  strictConfig.participants.find((p) => p.id === "orchestrator"),
).idempotent = false;
strictConfig.policy.maxOpenTasks = 3;
const deliver = (
  state: State,
  deliveryId: string,
  outcome: AdapterOutcome = "accepted",
) => {
  state = expectOk(state, { type: "attempt", deliveryId });
  const messageId = currentSend(
    must(Core.findDelivery(state, deliveryId)),
  ).messageId;
  return expectOk(state, {
    type: "adapterResult",
    deliveryId,
    messageId,
    outcome,
  });
};
const judge = (state: State, taskId: string, choice: string, p: number) => {
  const options = Object.keys(
    Core.judgmentQuestion(state, task(state, taskId)).criteria,
  );
  const rest = (1 - p) / (options.length - 1);
  const probabilities = Object.fromEntries(
    options.map((id) => [id, id === choice ? p : rest]),
  );
  return expectOk(state, {
    type: "judged",
    taskId,
    choice,
    probabilities,
    model: "jev-1.13.0",
  });
};
type SubmitFields = Omit<Extract<Event, { type: "submit" }>, "type" | "by">;
const submit = (state: State, fields: SubmitFields) =>
  expectOk(state, { type: "submit", by: "you", ...fields });

// ---- Walkthroughs ----

test("unaddressed coding request: one judgment, delivery, result readable later", () => {
  let s = submit(initial(config), {
    messageId: "M1",
    text: "Fix reply handling in jev-a2a.",
  });
  assert.equal(task(s).status, "routing");
  assert.deepEqual(
    commands(s).map((c) => c.type),
    ["judge"],
  );
  assert.ok(
    "none" in judgeOf(commands(s)[0]).question.criteria,
    "Choice always offers an abstention",
  );
  s = judge(s, "T1", "orchestrator", 0.95);
  assert.equal(task(s).recipient, "orchestrator");
  assert.deepEqual(commands(s), [
    { type: "deliver", deliveryId: "D1", messageId: "M1" },
  ]);
  s = deliver(s, "D1");
  assert.equal(task(s).status, "working");
  s = expectOk(s, {
    type: "update",
    by: ORCH,
    taskId: "T1",
    messageId: "R1",
    inReplyTo: "M1",
    kind: "working",
    text: "Implementing",
  });
  s = expectOk(s, {
    type: "update",
    by: ORCH,
    taskId: "T1",
    messageId: "R2",
    inReplyTo: "M1",
    kind: "completed",
    text: "Reviewed fix ready.",
  });
  assert.equal(task(s).status, "completed");
  assert.equal(task(s).judgments.length, 1);
  assert.equal(Core.A2A_STATE[task(s).status], "TASK_STATE_COMPLETED");
});

test("question, answer and final result stay on one pinned session", () => {
  let s = submit(initial(config), {
    messageId: "M1",
    text: "Change harness settings in dotfiles.",
  });
  s = judge(s, "T1", "orchestrator", 0.93);
  s = deliver(s, "D1");
  s = expectOk(s, {
    type: "update",
    by: ORCH,
    taskId: "T1",
    messageId: "Q1",
    inReplyTo: "M1",
    kind: "question",
    text: "Include mini?",
  });
  assert.equal(task(s).status, "needs_answer");
  s = expectReject(
    s,
    {
      type: "update",
      by: ORCH,
      taskId: "T1",
      messageId: "Q2",
      inReplyTo: "M1",
      kind: "question",
      text: "Also mba?",
    },
    "question_open",
  );
  s = expectReject(
    s,
    {
      type: "answer",
      by: ORCH,
      taskId: "T1",
      messageId: "A0",
      questionId: "Q1",
      text: "yes",
    },
    "forbidden",
  );
  s = expectOk(s, {
    type: "answer",
    by: "you",
    taskId: "T1",
    messageId: "A1",
    questionId: "Q1",
    text: "Yes, all three.",
  });
  s = expectOk(s, {
    type: "answer",
    by: "you",
    taskId: "T1",
    messageId: "A1",
    questionId: "Q1",
    text: "Yes, all three.",
  });
  assert.equal(accepted(s).duplicate, true);
  s = expectReject(
    s,
    {
      type: "answer",
      by: "you",
      taskId: "T1",
      messageId: "A2",
      questionId: "Q1",
      text: "No.",
    },
    "no_question",
  );
  assert.deepEqual(
    commands(s),
    [],
    "the answer waits until the session is idle",
  );
  s = idle(s);
  assert.deepEqual(commands(s), [
    { type: "deliver", deliveryId: "D1", messageId: "A1" },
  ]);
  s = deliver(s, "D1");
  // A late reply to the original request cannot finish the current exchange.
  s = expectOk(s, {
    type: "update",
    by: ORCH,
    taskId: "T1",
    messageId: "R1",
    inReplyTo: "M1",
    kind: "completed",
    text: "stale",
  });
  assert.equal(task(s).status, "working");
  s = expectOk(s, {
    type: "update",
    by: ORCH,
    taskId: "T1",
    messageId: "R2",
    inReplyTo: "A1",
    kind: "completed",
    text: "Prepared change.",
  });
  assert.equal(task(s).status, "completed");
});

test("a person can hold a session, and a question settled in the session clears itself", () => {
  let s = submit(initial(config), {
    messageId: "M1",
    text: "Draft the Q3 memo.",
    to: "knowledge",
  });
  // Holding an idle session keeps the router out until the hold is lifted.
  s = expectOk(s, { type: "observe", placement: "knowledge@mini", hold: true });
  assert.equal(Core.blockedReason(s, must(Core.findDelivery(s, "D1"))), "held");
  assert.deepEqual(commands(s), []);
  s = expectReject(s, { type: "attempt", deliveryId: "D1" }, "not_eligible");
  s = expectOk(s, {
    type: "observe",
    placement: "knowledge@mini",
    hold: false,
  });
  s = deliver(s, "D1");
  const KNOW = "knowledge@mini#1";
  s = expectOk(s, {
    type: "update",
    by: KNOW,
    taskId: "T1",
    messageId: "Q1",
    inReplyTo: "M1",
    kind: "question",
    text: "Which quarter's numbers?",
  });
  assert.equal(task(s).status, "needs_answer");
  // The person answers in the session; the participant's next progress
  // update tells the router the question is settled.
  s = expectOk(s, {
    type: "update",
    by: KNOW,
    taskId: "T1",
    messageId: "R1",
    inReplyTo: "M1",
    kind: "working",
    text: "Using the confirmed Q3 figures.",
  });
  assert.equal(task(s).status, "working");
  assert.equal(must(Core.findDelivery(s, "D1")).question, null);
  s = expectReject(
    s,
    {
      type: "answer",
      by: "you",
      taskId: "T1",
      messageId: "A1",
      questionId: "Q1",
      text: "Q3",
    },
    "no_question",
  );
  // A hold belongs to the person, so it survives a replaced session.
  s = expectOk(s, { type: "observe", placement: "knowledge@mini", hold: true });
  s = expectOk(s, {
    type: "observe",
    placement: "knowledge@mini",
    session: "knowledge@mini#2",
    ready: true,
  });
  assert.equal(must(s.placements["knowledge@mini"]).hold, true);
  assert.deepEqual(commands(s), []);
});

const ask = (
  s: State,
  by: string,
  messageId: string,
  inReplyTo: string,
  text: string,
) =>
  expectOk(s, {
    type: "update",
    by,
    taskId: "T1",
    messageId,
    inReplyTo,
    kind: "question",
    text,
  });
const answerQ = (
  s: State,
  messageId: string,
  questionId: string,
  text: string,
) =>
  expectOk(s, {
    type: "answer",
    by: "you",
    taskId: "T1",
    messageId,
    questionId,
    text,
  });

test("a hold also stops pinned sends: a queued answer and a deduplicated retry", () => {
  let s = submit(initial(config), {
    messageId: "M1",
    text: "Draft.",
    to: "knowledge",
  });
  s = deliver(s, "D1");
  s = ask(s, KNOW, "Q1", "M1", "Which?");
  s = answerQ(s, "A1", "Q1", "That one.");
  s = idle(s, "knowledge@mini");
  s = expectOk(s, { type: "observe", placement: "knowledge@mini", hold: true });
  assert.equal(Core.blockedReason(s, must(Core.findDelivery(s, "D1"))), "held");
  s = expectOk(s, {
    type: "observe",
    placement: "knowledge@mini",
    hold: false,
  });
  assert.deepEqual(commands(s), [
    { type: "deliver", deliveryId: "D1", messageId: "A1" },
  ]);
  // A retry after an unknown send is a pinned send too.
  let r = submit(initial(config), {
    messageId: "M1",
    text: "Draft.",
    to: "knowledge",
  });
  r = deliver(r, "D1", "unknown");
  r = idle(r, "knowledge@mini");
  r = expectOk(r, { type: "observe", placement: "knowledge@mini", hold: true });
  assert.equal(Core.blockedReason(r, must(Core.findDelivery(r, "D1"))), "held");
});

test("a queued answer is withdrawn when the participant moves on in the session", () => {
  let s = submit(initial(config), {
    messageId: "M1",
    text: "Draft.",
    to: "knowledge",
  });
  s = deliver(s, "D1");
  s = ask(s, KNOW, "Q1", "M1", "Which?");
  s = answerQ(s, "A1", "Q1", "That one.");
  // The person answered in the session before the router could send A1.
  s = expectOk(s, {
    type: "update",
    by: KNOW,
    taskId: "T1",
    messageId: "R1",
    inReplyTo: "M1",
    kind: "working",
    text: "Going with the second.",
  });
  const d = must(Core.findDelivery(s, "D1"));
  assert.equal(must(d.sends[1]).outcome, "withdrawn");
  assert.equal(Core.currentSend(d).messageId, "M1");
  assert.equal(task(s).status, "working");
  s = idle(s, "knowledge@mini");
  assert.deepEqual(commands(s), []);
  // The exchange continues on M1.
  s = expectOk(s, {
    type: "update",
    by: KNOW,
    taskId: "T1",
    messageId: "R2",
    inReplyTo: "M1",
    kind: "completed",
    text: "Done.",
  });
  assert.equal(task(s).status, "completed");
  // Once an answer has been attempted, a stale reply to the request can
  // neither withdraw it nor settle a later question.
  let t = submit(initial(config), {
    messageId: "M1",
    text: "Draft.",
    to: "knowledge",
  });
  t = deliver(t, "D1");
  t = ask(t, KNOW, "Q1", "M1", "Which?");
  t = answerQ(t, "A1", "Q1", "That.");
  t = idle(t, "knowledge@mini");
  t = deliver(t, "D1");
  t = ask(t, KNOW, "Q2", "A1", "Sure?");
  t = expectOk(t, {
    type: "update",
    by: KNOW,
    taskId: "T1",
    messageId: "R0",
    inReplyTo: "M1",
    kind: "working",
    text: "stale",
  });
  assert.equal(must(must(Core.findDelivery(t, "D1")).question).id, "Q2");
  assert.equal(
    must(must(Core.findDelivery(t, "D1")).sends[1]).outcome,
    "accepted",
  );
});

test("the needs-you list names exactly the open decisions per principal", () => {
  let s = submit(initial(config), { messageId: "M1", text: "Do the thing." });
  assert.deepEqual(Core.needsYou(s, "you"), []);
  s = judge(s, "T1", "orchestrator", 0.5);
  assert.deepEqual(Core.needsYou(s, "you"), [
    {
      kind: "choose",
      taskId: "T1",
      reason: "low_confidence",
      suggestions: must(task(s).routing).suggestions,
    },
  ]);
  assert.deepEqual(Core.needsYou(s, "operator"), []);
  s = expectOk(s, { type: "choose", by: "you", taskId: "T1", to: "knowledge" });
  s = deliver(s, "D1");
  s = expectOk(s, {
    type: "update",
    by: KNOW,
    taskId: "T1",
    messageId: "Q1",
    inReplyTo: "M1",
    kind: "question",
    text: "Which thing?",
  });
  assert.deepEqual(Core.needsYou(s, "you"), [
    {
      kind: "answer",
      taskId: "T1",
      deliveryId: "D1",
      questionId: "Q1",
      text: "Which thing?",
    },
  ]);
  // Another requester's question is not this requester's decision.
  assert.deepEqual(Core.needsYou(s, ORCH_ID), []);
  // A pin to a replaced session is the operator's, not the requester's: an
  // answer could no longer be delivered.
  s = expectOk(s, {
    type: "observe",
    placement: "knowledge@mini",
    session: "knowledge@mini#2",
  });
  assert.deepEqual(Core.needsYou(s, "you"), []);
  assert.deepEqual(Core.needsYou(s, "operator"), [
    {
      kind: "resolve",
      taskId: "T1",
      deliveryId: "D1",
      messageId: "M1",
      reason: "session_replaced",
    },
  ]);
  s = expectOk(s, {
    type: "resolve",
    by: "operator",
    deliveryId: "D1",
    messageId: "M1",
    outcome: "finished",
    evidence: "Session gone; the answer was given in person.",
  });
  assert.deepEqual(Core.needsYou(s, "you"), []);
  assert.deepEqual(Core.needsYou(s, "operator"), []);
  assert.equal(task(s).status, "failed");
});

test("addressed service request fans out per host with zero judgments", () => {
  let s = submit(initial(config), {
    messageId: "M1",
    text: "Inspect applied configs.",
    to: "environment",
    hosts: ["mini", "mba", "mbp"],
  });
  assert.equal(task(s).judgments.length, 0);
  assert.deepEqual(
    task(s).deliveries.map((d) => d.host),
    ["mba", "mbp", "mini"],
  );
  for (const id of ["D1", "D2", "D3"]) s = deliver(s, id);
  s = expectOk(s, {
    type: "update",
    by: "environment@mba#1",
    taskId: "T1",
    messageId: "R1",
    inReplyTo: "M1",
    kind: "completed",
    text: "cfg-12",
  });
  assert.equal(
    task(s).status,
    "working",
    "one device result cannot complete the others",
  );
  s = expectReject(
    s,
    {
      type: "update",
      by: "environment@mba#1",
      taskId: "T1",
      messageId: "R1",
      inReplyTo: "M1",
      kind: "completed",
      text: "cfg-13",
    },
    "conflict",
  );
  s = expectOk(s, {
    type: "update",
    by: "environment@mbp#1",
    taskId: "T1",
    messageId: "R2",
    inReplyTo: "M1",
    kind: "completed",
    text: "cfg-12",
  });
  s = expectOk(s, {
    type: "update",
    by: "environment@mini#1",
    taskId: "T1",
    messageId: "R3",
    inReplyTo: "M1",
    kind: "failed",
    text: "drift: cfg-11",
  });
  // Two hosts answered, one reported failure: the answers are the result.
  assert.equal(task(s).status, "partial");
  assert.deepEqual(task(s).final, {
    status: "partial",
    reason: "delivery",
    completed: 2,
    of: 3,
  });
  expectReject(
    initial(config),
    { type: "submit", by: "you", messageId: "M1", text: "x", hosts: ["mba"] },
    "invalid",
  );
  expectReject(
    initial(config),
    {
      type: "submit",
      by: "you",
      messageId: "M1",
      text: "x",
      to: "incus",
      hosts: ["mba"],
    },
    "invalid",
  );
});

test("a multi-host request ends partial at the deadline when a host never woke; none answered means failed", () => {
  // mba is asleep: its placement never becomes ready.
  let s = expectOk(initial(config), {
    type: "observe",
    placement: "environment@mba",
    ready: false,
  });
  s = submit(s, {
    messageId: "M1",
    text: "Check dotfiles.",
    to: "environment",
  });
  s = deliver(s, "D2");
  s = deliver(s, "D3");
  for (const [by, id, text] of [
    ["environment@mbp#1", "R2", "cfg-12"],
    ["environment@mini#1", "R3", "cfg-12"],
  ] as const)
    s = expectOk(s, {
      type: "update",
      by,
      taskId: "T1",
      messageId: id,
      inReplyTo: "M1",
      kind: "completed",
      text,
    });
  // Only the sleeping host's delivery is still open.
  assert.equal(task(s).status, "queued");
  s = expectOk(s, { type: "tick", now: task(s).deadline });
  assert.deepEqual(task(s).final, {
    status: "partial",
    reason: "deadline",
    completed: 2,
    of: 3,
  });
  assert.equal(must(must(Core.findDelivery(s, "D1")).end).reason, "expired");
  assert.equal(Core.A2A_STATE.partial, "TASK_STATE_COMPLETED");
  assert.deepEqual(Core.needsYou(s, "you"), []);
  assert.deepEqual(Core.needsYou(s, "operator"), []);
  // A single-host request is all or nothing; nothing answered means failed.
  let f = submit(initial(config), {
    messageId: "M1",
    text: "Check.",
    to: "incus",
  });
  f = expectOk(f, { type: "tick", now: task(f).deadline });
  assert.deepEqual(task(f).final, {
    status: "failed",
    reason: "deadline",
    completed: 0,
    of: 1,
  });
});

test("orchestrator may request a VM; unready hosts queue; other agents are forbidden", () => {
  let s = expectOk(initial(config), {
    type: "observe",
    placement: "incus@lab01",
    ready: false,
  });
  s = expectOk(s, {
    type: "submit",
    by: ORCH,
    messageId: "M1",
    text: "Prepare a scratch VM.",
    to: "incus",
  });
  assert.equal(task(s).source, "orchestrator");
  assert.deepEqual(commands(s), []);
  s = expectReject(s, { type: "attempt", deliveryId: "D1" }, "not_eligible");
  assert.equal(task(s).status, "queued");
  s = expectOk(s, { type: "observe", placement: "incus@lab01", ready: true });
  s = deliver(s, "D1");
  s = expectOk(s, {
    type: "update",
    by: LAB,
    taskId: "T1",
    messageId: "R1",
    inReplyTo: "M1",
    kind: "completed",
    text: "scratch-vm ready",
  });
  assert.equal(task(s).status, "completed");
  expectReject(
    initial(config),
    {
      type: "submit",
      by: KNOW,
      messageId: "M1",
      text: "VM please",
      to: "incus",
    },
    "forbidden",
  );
  expectReject(
    initial(config),
    { type: "submit", by: "mallory", messageId: "M1", text: "hi" },
    "unauthenticated",
  );
  expectReject(
    initial(config),
    { type: "submit", by: "operator", messageId: "M1", text: "hi" },
    "unauthenticated",
  );
});

const notifies = (s: State) =>
  commands(s)
    .filter((c) => c.type === "notify")
    .map((c) => `${c.taskId}/${c.key}`);
const notice = (s: State, key: string, id = "T1") =>
  must(Core.findNotice(task(s, id), key), `notice ${key}`);
const tell = (
  s: State,
  key: string,
  outcome: AdapterOutcome = "accepted",
  taskId = "T1",
) => {
  s = expectOk(s, { type: "noticeAttempt", taskId, key, text: key });
  return expectOk(s, { type: "noticeResult", taskId, key, outcome });
};

test("a participant sender hears a question, then the final word, once each, at its own idle session", () => {
  let s = idle(idle(initial(config)), "incus@lab01");
  s = expectOk(s, {
    type: "submit",
    by: ORCH,
    messageId: "M1",
    text: "Prepare a scratch VM.",
    to: "incus",
  });
  assert.equal(task(s).via, "orchestrator@mbp");
  assert.deepEqual(task(s).notices, []);
  assert.deepEqual(Core.dueNotices(s, task(s)), []);
  s = deliver(s, "D1");
  s = expectOk(s, {
    type: "update",
    by: LAB,
    taskId: "T1",
    messageId: "Q1",
    inReplyTo: "M1",
    kind: "question",
    text: "Which image?",
  });
  // The question is due at the sender's placement and recorded as owed; it
  // goes out like a send.
  assert.deepEqual(Core.dueNotices(s, task(s)), [
    {
      key: "question/D1/Q1",
      kind: "question",
      deliveryId: "D1",
      questionId: "Q1",
    },
  ]);
  assert.partialDeepStrictEqual(notice(s, "question/D1/Q1"), {
    kind: "question",
    deliveryId: "D1",
    questionId: "Q1",
    text: null,
    session: null,
    outcome: "pending",
    trail: [],
  });
  assert.deepEqual(notifies(s), ["T1/question/D1/Q1"]);
  s = expectOk(s, {
    type: "noticeAttempt",
    taskId: "T1",
    key: "question/D1/Q1",
    text: "q",
  });
  assert.equal(notice(s, "question/D1/Q1").session, ORCH);
  assert.equal(notice(s, "question/D1/Q1").outcome, "attempting");
  assert.equal(s.placements["orchestrator@mbp"]?.ready, false);
  assert.deepEqual(notifies(s), []);
  expectReject(
    s,
    { type: "noticeAttempt", taskId: "T1", key: "question/D1/Q1", text: "q" },
    "not_eligible",
  );
  expectReject(
    s,
    { type: "noticeResult", taskId: "T1", key: "final", outcome: "accepted" },
    "stale_ack",
  );
  // While the notice is in flight nothing else goes to that session.
  let busy = submit(s, { messageId: "M2", text: "x", to: "orchestrator" });
  busy = idle(busy);
  assert.equal(
    Core.blockedReason(busy, must(Core.findDelivery(busy, "D2"))),
    "in_flight",
  );
  s = expectOk(s, {
    type: "noticeResult",
    taskId: "T1",
    key: "question/D1/Q1",
    outcome: "accepted",
  });
  assert.equal(Core.noticeBlockedReason(s, task(s), "question/D1/Q1"), "told");
  assert.deepEqual(notifies(idle(s)), []);
  // The sender answers through the same door as a person.
  s = expectOk(s, {
    type: "answer",
    by: ORCH,
    taskId: "T1",
    messageId: "A1",
    questionId: "Q1",
    text: "ubuntu-24.04",
  });
  assert.deepEqual(Core.dueNotices(s, task(s)), []);
  s = deliver(idle(s, "incus@lab01"), "D1");
  s = expectOk(s, {
    type: "update",
    by: LAB,
    taskId: "T1",
    messageId: "R1",
    inReplyTo: "A1",
    kind: "completed",
    text: "scratch-vm ready",
  });
  assert.equal(task(s).status, "completed");
  assert.deepEqual(Core.dueNotices(s, task(s)), [
    { key: "final", kind: "final" },
  ]);
  // The notice waits on the sender's idle like a send would, and on a
  // hold or a send in flight to the same placement; a refused send is
  // retried, an unknown one only through a deduplicating adapter.
  assert.equal(Core.noticeBlockedReason(s, task(s), "final"), "not_ready");
  assert.equal(Core.waitsOnSessions(s), true, "a look could release it");
  s = idle(s);
  const held = expectOk(s, {
    type: "observe",
    placement: "orchestrator@mbp",
    hold: true,
  });
  assert.equal(Core.noticeBlockedReason(held, task(held), "final"), "held");
  assert.deepEqual(notifies(held), []);
  let sending = submit(s, { messageId: "M3", text: "y", to: "orchestrator" });
  sending = expectOk(sending, { type: "attempt", deliveryId: "D2" });
  assert.equal(
    Core.noticeBlockedReason(sending, task(sending), "final"),
    "in_flight",
  );
  assert.deepEqual(notifies(idle(sending)), []);
  // Only readiness is worth looking again for: a send in flight resolves
  // by its adapter result, a hold waits on a person, and a notice told or
  // withdrawn waits on nothing.
  assert.equal(Core.waitsOnSessions(sending), false);
  assert.equal(Core.waitsOnSessions(held), false);
  assert.equal(
    Core.waitsOnSessions(s),
    false,
    "the sender is idle: sendable now",
  );
  assert.equal(
    Core.waitsOnSessions(sending, (p) => p !== "orchestrator@mbp"),
    false,
    "only placements this router serves count",
  );
  s = tell(s, "final", "not_sent");
  assert.equal(notice(s, "final").outcome, "pending");
  assert.equal(Core.noticeBlockedReason(s, task(s), "final"), "not_ready");
  s = tell(idle(s), "final", "unknown");
  assert.equal(Core.noticeBlockedReason(idle(s), task(s), "final"), null);
  // A repeat goes out under the same key with the same text, or not at all.
  expectReject(
    idle(s),
    { type: "noticeAttempt", taskId: "T1", key: "final", text: "other" },
    "conflict",
  );
  s = tell(idle(s), "final");
  assert.equal(notice(s, "final").text, "final");
  assert.equal(notice(s, "final").idempotent, true);
  assert.equal(notice(s, "final").outcome, "accepted");
  assert.deepEqual(notice(s, "final").trail, [
    "attempting",
    "not_sent",
    "attempting",
    "unknown",
    "attempting",
    "accepted",
  ]);
  assert.deepEqual(notifies(idle(s)), []);
  assert.deepEqual(stateViolations(s), []);
});

test("notices follow the record: no sender session, no notice; a dropped question or choice is never told late; restart marks an attempt unknown", () => {
  // A person's request produces no notices, whatever happens to it.
  let s = submit(idle(initial(config)), {
    messageId: "M1",
    text: "x",
    to: "orchestrator",
  });
  s = deliver(s, "D1");
  s = expectOk(s, {
    type: "update",
    by: ORCH,
    taskId: "T1",
    messageId: "Q1",
    inReplyTo: "M1",
    kind: "question",
    text: "?",
  });
  assert.equal(task(s).via, null);
  assert.deepEqual(Core.dueNotices(s, task(s)), []);
  expectReject(
    s,
    { type: "noticeAttempt", taskId: "T1", key: "question/D1/Q1", text: "q" },
    "not_due",
  );
  // Jev hands back: the sender is asked to choose, once per judgment.
  s = idle(initial(strictConfig));
  s = expectOk(s, {
    type: "submit",
    by: ORCH,
    messageId: "M1",
    text: "Something vague.",
  });
  s = judge(s, "T1", "incus", 0.5);
  assert.equal(task(s).routing?.state, "needs_recipient");
  assert.deepEqual(notifies(s), ["T1/choose/1"]);
  s = expectOk(s, {
    type: "noticeAttempt",
    taskId: "T1",
    key: "choose/1",
    text: "c",
  });
  // A restart while the attempt is out leaves it unknown; without
  // deduplication it is not repeated, and the sender still sees its choice
  // in the needs-you list.
  s = expectOk(s, { type: "restart" });
  assert.equal(notice(s, "choose/1").outcome, "unknown");
  assert.equal(
    Core.noticeBlockedReason(idle(s), task(s), "choose/1"),
    "not_pending",
  );
  assert.deepEqual(notifies(idle(s)), []);
  assert.equal(Core.needsYou(s, "orchestrator").length, 1);
  // The sender withdraws: the choice is no longer due, only the end is;
  // the unknown choice notice is withdrawn and the record says so.
  s = expectOk(s, { type: "cancel", by: ORCH, taskId: "T1" });
  assert.deepEqual(Core.dueNotices(s, task(s)), [
    { key: "final", kind: "final" },
  ]);
  assert.equal(notice(s, "choose/1").outcome, "withdrawn");
  assert.deepEqual(notice(s, "choose/1").trail, [
    "attempting",
    "unknown",
    "withdrawn",
  ]);
  assert.match(
    s.log.at(-1)?.text ?? "",
    /^T1 notice choose\/1 withdrawn: the choice no longer stands\.$/,
  );
  assert.equal(notice(s, "choose/1").idempotent, false);
  s = tell(idle(s), "final");
  assert.deepEqual(notifies(idle(s)), []);
  // A question whose session was replaced is not told: the delivery stays
  // pinned to the old session for the operator, and only it can be asked.
  s = idle(idle(initial(config)), "incus@lab01");
  s = expectOk(s, {
    type: "submit",
    by: ORCH,
    messageId: "M1",
    text: "VM please",
    to: "incus",
  });
  s = deliver(s, "D1");
  s = expectOk(s, {
    type: "update",
    by: LAB,
    taskId: "T1",
    messageId: "Q1",
    inReplyTo: "M1",
    kind: "question",
    text: "Which image?",
  });
  assert.deepEqual(notifies(s), ["T1/question/D1/Q1"]);
  s = expectOk(s, {
    type: "noticeAttempt",
    taskId: "T1",
    key: "question/D1/Q1",
    text: "q",
  });
  s = expectOk(s, {
    type: "noticeResult",
    taskId: "T1",
    key: "question/D1/Q1",
    outcome: "not_sent",
  });
  s = expectOk(s, {
    type: "observe",
    placement: "incus@lab01",
    ready: true,
    session: "incus@lab01#2",
  });
  assert.deepEqual(Core.dueNotices(s, task(s)), []);
  assert.equal(notice(s, "question/D1/Q1").outcome, "withdrawn");
  assert.match(s.log.at(-1)?.text ?? "", /question no longer stands/);
  // A replaced sender session may not submit; the current one may.
  s = expectOk(s, {
    type: "observe",
    placement: "orchestrator@mbp",
    ready: true,
    session: "orchestrator@mbp#2",
  });
  expectReject(
    s,
    { type: "submit", by: ORCH, messageId: "M9", text: "x", to: "incus" },
    "unauthenticated",
  );
  s = expectOk(s, {
    type: "submit",
    by: "orchestrator@mbp#2",
    messageId: "M9",
    text: "x",
    to: "incus",
  });
  assert.equal(task(s, "T2").via, "orchestrator@mbp");
  assert.deepEqual(stateViolations(s), []);
});

test("two deliveries of one fan-out asking under the same id are told and answered apart; a replaced session may not choose", () => {
  // The orchestrator asks the service on two hosts; both ask back as Q1.
  let s = idle(idle(initial(config)), "environment@mbp");
  s = expectOk(s, {
    type: "observe",
    placement: "environment@mba",
    ready: true,
    session: "environment@mba#1",
  });
  s = expectOk(s, {
    type: "submit",
    by: ORCH,
    messageId: "M1",
    text: "Which shell is active?",
    to: "environment",
    hosts: ["mba", "mbp"],
  });
  s = deliver(deliver(s, "D1"), "D2");
  for (const [by, text] of [
    ["environment@mba#1", "mba: login or interactive?"],
    ["environment@mbp#1", "mbp: login or interactive?"],
  ] as const)
    s = expectOk(s, {
      type: "update",
      by,
      taskId: "T1",
      messageId: "Q1",
      inReplyTo: "M1",
      kind: "question",
      text,
    });
  // Each question is its own notice, naming its delivery.
  assert.deepEqual(Core.dueNotices(s, task(s)), [
    {
      key: "question/D1/Q1",
      kind: "question",
      deliveryId: "D1",
      questionId: "Q1",
    },
    {
      key: "question/D2/Q1",
      kind: "question",
      deliveryId: "D2",
      questionId: "Q1",
    },
  ]);
  assert.deepEqual(notifies(s), ["T1/question/D1/Q1", "T1/question/D2/Q1"]);
  // An answer by question id alone is ambiguous; naming the delivery is not.
  expectReject(
    s,
    {
      type: "answer",
      by: ORCH,
      taskId: "T1",
      messageId: "A1",
      questionId: "Q1",
      text: "interactive",
    },
    "ambiguous",
  );
  s = expectOk(s, {
    type: "answer",
    by: ORCH,
    taskId: "T1",
    messageId: "A1",
    questionId: "Q1",
    deliveryId: "D2",
    text: "interactive",
  });
  assert.equal(must(Core.findDelivery(s, "D2")).question, null);
  assert.equal(must(Core.findDelivery(s, "D1")).question?.id, "Q1");
  // The same message id for the other delivery is a conflict, not a repeat;
  // a delivery the task does not have is named as such.
  expectReject(
    s,
    {
      type: "answer",
      by: ORCH,
      taskId: "T1",
      messageId: "A1",
      questionId: "Q1",
      deliveryId: "D1",
      text: "interactive",
    },
    "conflict",
  );
  expectReject(
    s,
    {
      type: "answer",
      by: ORCH,
      taskId: "T1",
      messageId: "A9",
      questionId: "Q1",
      deliveryId: "D7",
      text: "x",
    },
    "not_found",
  );
  assert.deepEqual(
    Core.dueNotices(s, task(s)).map((d) => d.key),
    ["question/D1/Q1"],
  );
  assert.equal(notice(s, "question/D2/Q1").outcome, "withdrawn");
  // With one left, the id alone is enough again.
  s = expectOk(s, {
    type: "answer",
    by: ORCH,
    taskId: "T1",
    messageId: "A2",
    questionId: "Q1",
    text: "login",
  });
  assert.equal(must(Core.findDelivery(s, "D1")).question, null);
  // A replaced sender session may neither submit nor choose.
  let r = idle(initial(strictConfig));
  r = expectOk(r, { type: "submit", by: ORCH, messageId: "M1", text: "vague" });
  r = judge(r, "T1", "incus", 0.5);
  r = expectOk(r, {
    type: "observe",
    placement: "orchestrator@mbp",
    ready: true,
    session: "orchestrator@mbp#2",
  });
  expectReject(
    r,
    { type: "choose", by: ORCH, taskId: "T1", to: "incus" },
    "unauthenticated",
  );
  r = expectOk(r, {
    type: "choose",
    by: "orchestrator@mbp#2",
    taskId: "T1",
    to: "incus",
  });
  assert.equal(task(r).recipient, "incus");
  assert.deepEqual(stateViolations(r), []);
});

test("a look again is owed only for work blocked on readiness; holds, queues, hand-backs and stuck sends wait on people or events", () => {
  // Queued behind: the head waits on readiness, the second on the head.
  let s = expectOk(initial(config), {
    type: "observe",
    placement: "orchestrator@mbp",
    ready: false,
  });
  s = submit(s, { messageId: "M1", text: "a", to: "orchestrator" });
  s = submit(s, { messageId: "M2", text: "b", to: "orchestrator" });
  assert.equal(Core.waitsOnSessions(s), true, "the head waits for an idle");
  s = idle(s);
  assert.equal(Core.waitsOnSessions(s), false, "sendable now, no look owed");
  s = deliver(s, "D1");
  assert.equal(
    Core.blockedReason(s, must(Core.findDelivery(s, "D2"))),
    "not_ready",
  );
  assert.equal(Core.waitsOnSessions(s), true);
  // A hand-back waits on the sender; a replaced session on the operator.
  let h = submit(initial(config), { messageId: "M1", text: "vague" });
  h = judge(h, "T1", "incus", 0.5);
  assert.equal(Core.waitsOnSessions(h), false);
  let r = idle(
    submit(initial(config), { messageId: "M1", text: "a", to: "orchestrator" }),
  );
  r = deliver(r, "D1");
  r = expectOk(r, {
    type: "observe",
    placement: "orchestrator@mbp",
    ready: true,
    session: "orchestrator@mbp#2",
  });
  assert.equal(Core.waitsOnSessions(r), false);
  // A retryable unknown holds the placement; the holder itself reads
  // not_ready, so a look is owed, unless a person holds the session.
  let u = idle(
    submit(initial(config), { messageId: "M1", text: "a", to: "orchestrator" }),
  );
  u = submit(u, { messageId: "M2", text: "b", to: "orchestrator" });
  u = deliver(u, "D1", "unknown");
  assert.equal(
    Core.blockedReason(u, must(Core.findDelivery(u, "D2"))),
    "in_flight",
  );
  assert.equal(Core.waitsOnSessions(u), true);
  const held = expectOk(u, {
    type: "observe",
    placement: "orchestrator@mbp",
    hold: true,
  });
  assert.equal(Core.waitsOnSessions(held), false);
  // A stuck unknown (no deduplication) waits on the operator, and so does
  // everything queued behind it.
  let k = idle(
    submit(initial(strictConfig), {
      messageId: "M1",
      text: "a",
      to: "orchestrator",
    }),
  );
  k = submit(k, { messageId: "M2", text: "b", to: "orchestrator" });
  k = deliver(k, "D1", "unknown");
  assert.equal(Core.waitsOnSessions(k), false);
});

test("without deduplication, restart keeps uncertainty; duplicates and wrong replies change nothing; a matching late reply resolves", () => {
  let s = submit(initial(strictConfig), {
    messageId: "M1",
    text: "Report workflow status.",
    to: "orchestrator",
  });
  s = expectOk(s, { type: "attempt", deliveryId: "D1" });
  s = expectOk(s, { type: "restart" });
  s = idle(s);
  assert.equal(task(s).status, "uncertain");
  assert.equal(Core.A2A_STATE.uncertain, "TASK_STATE_WORKING");
  assert.deepEqual(
    commands(s),
    [],
    "unknown is never resent without deduplication",
  );
  s = submit(s, {
    messageId: "M1",
    text: "Report workflow status.",
    to: "orchestrator",
  });
  assert.equal(accepted(s).taskId, "T1");
  s = expectReject(
    s,
    {
      type: "submit",
      by: "you",
      messageId: "M1",
      text: "Changed.",
      to: "orchestrator",
    },
    "conflict",
  );
  s = expectReject(s, { type: "attempt", deliveryId: "D1" }, "not_eligible");
  s = expectReject(
    s,
    {
      type: "adapterResult",
      deliveryId: "D1",
      messageId: "M1",
      outcome: "accepted",
    },
    "stale_ack",
  );
  s = expectReject(
    s,
    {
      type: "update",
      by: ORCH,
      taskId: "T1",
      messageId: "R1",
      inReplyTo: "M9",
      kind: "completed",
    },
    "wrong_message",
  );
  s = expectReject(
    s,
    {
      type: "update",
      by: "orchestrator@mba#1",
      taskId: "T1",
      messageId: "R1",
      inReplyTo: "M1",
      kind: "completed",
    },
    "wrong_session",
  );
  s = expectReject(
    s,
    {
      type: "update",
      by: KNOW,
      taskId: "T1",
      messageId: "R1",
      inReplyTo: "M1",
      kind: "completed",
    },
    "wrong_session",
  );
  s = expectOk(s, {
    type: "update",
    by: ORCH,
    taskId: "T1",
    messageId: "R1",
    inReplyTo: "M1",
    kind: "completed",
    text: "Status: green.",
  });
  assert.equal(task(s).status, "completed");
});

test("an unknown send is not repeated once its participant stops deduplicating, and never starts again", () => {
  let s = submit(initial(config), {
    messageId: "M1",
    text: "Report workflow status.",
    to: "orchestrator",
  });
  s = idle(s);
  s = deliver(s, "D1", "unknown");
  // The placement moves to a terminal, which takes no message key.
  s = idle(expectOk(s, { type: "configured", config: strictConfig }));
  assert.equal(must(Core.findDelivery(s, "D1")).idempotent, false);
  assert.deepEqual(commands(s), [], "no repeat that could run twice");
  s = idle(expectOk(s, { type: "configured", config }));
  assert.deepEqual(
    commands(s),
    [],
    "a later deduplicating adapter has no receipt",
  );
  // A sender's unknown notice follows the same rule.
  let n = idle(initial(config));
  n = expectOk(n, {
    type: "submit",
    by: ORCH,
    messageId: "M1",
    text: "Something vague.",
  });
  n = judge(n, "T1", "incus", 0.5);
  n = expectOk(n, {
    type: "noticeAttempt",
    taskId: "T1",
    key: "choose/1",
    text: "c",
  });
  n = expectOk(n, { type: "restart" });
  n = idle(expectOk(n, { type: "configured", config: strictConfig }));
  assert.equal(Core.noticeBlockedReason(n, task(n), "choose/1"), "not_pending");
});

test("with deduplication, an unknown send is retried with the same key", () => {
  let s = submit(initial(config), {
    messageId: "M1",
    text: "Report workflow status.",
    to: "orchestrator",
  });
  s = expectOk(s, { type: "attempt", deliveryId: "D1" });
  s = expectOk(s, { type: "restart" });
  assert.equal(task(s).status, "uncertain");
  assert.deepEqual(
    commands(s),
    [],
    "no retry until a fresh observation says idle",
  );
  s = idle(s);
  assert.deepEqual(commands(s), [
    { type: "deliver", deliveryId: "D1", messageId: "M1" },
  ]);
  // Paseo still holds a pending receipt: the retry cannot tell either.
  s = deliver(s, "D1", "unknown");
  s = idle(s);
  // The daemon had completed the first send: the retry is a no-op that confirms it.
  s = deliver(s, "D1", "accepted");
  assert.deepEqual(currentSend(must(Core.findDelivery(s, "D1"))).trail, [
    "attempting",
    "unknown",
    "attempting",
    "unknown",
    "attempting",
    "accepted",
  ]);
  assert.equal(task(s).status, "working");
  // A persistently pending receipt (daemon crashed mid-send) needs an operator.
  let stuck = submit(initial(config), {
    messageId: "M1",
    text: "x",
    to: "orchestrator",
  });
  stuck = deliver(stuck, "D1", "unknown");
  stuck = expectOk(stuck, {
    type: "resolve",
    by: "operator",
    deliveryId: "D1",
    messageId: "M1",
    outcome: "finished",
    evidence: "Checked the agent's history: the prompt ran.",
  });
  assert.equal(task(stuck).status, "failed");
});

test("reply before the adapter acknowledgment is authoritative", () => {
  let s = submit(initial(config), {
    messageId: "M1",
    text: "Status?",
    to: "orchestrator",
  });
  s = expectOk(s, { type: "attempt", deliveryId: "D1" });
  s = expectOk(s, {
    type: "update",
    by: ORCH,
    taskId: "T1",
    messageId: "R1",
    inReplyTo: "M1",
    kind: "completed",
    text: "done",
  });
  s = expectReject(
    s,
    {
      type: "adapterResult",
      deliveryId: "D1",
      messageId: "M1",
      outcome: "not_sent",
    },
    "stale_ack",
  );
  assert.equal(task(s).status, "completed");
});

test("sends only to an idle session, in arrival order; open tasks do not block new ones", () => {
  let s = initial(config);
  for (const id of ["M1", "M2", "M3"])
    s = submit(s, { messageId: id, text: `Job ${id}`, to: "orchestrator" });
  assert.deepEqual(commands(s).map(deliveryIdOf), ["D1"]);
  assert.equal(
    Core.blockedReason(s, must(Core.findDelivery(s, "D2"))),
    "queued_behind",
  );
  s = deliver(s, "D1");
  // The turn started: sending now would interrupt it (Paseo cancels an active turn).
  assert.deepEqual(commands(s), []);
  s = expectReject(s, { type: "attempt", deliveryId: "D2" }, "not_eligible");
  // The orchestrator handed T1 to subagents and went idle. T1 is still open;
  // how much runs in parallel is the orchestrator's decision.
  s = idle(s);
  assert.equal(task(s).status, "working");
  assert.deepEqual(commands(s).map(deliveryIdOf), ["D2"]);
  s = deliver(s, "D2", "unknown");
  s = idle(s);
  // An unconfirmed send holds its session: only its own retry may go next.
  assert.deepEqual(commands(s).map(deliveryIdOf), ["D2"]);
  assert.equal(
    Core.blockedReason(s, must(Core.findDelivery(s, "D3"))),
    "in_flight",
  );
  // Replies for different tasks correlate independently.
  s = expectOk(s, {
    type: "update",
    by: ORCH,
    taskId: "T2",
    messageId: "R2",
    inReplyTo: "M2",
    kind: "completed",
  });
  s = expectOk(s, {
    type: "update",
    by: ORCH,
    taskId: "T1",
    messageId: "R1",
    inReplyTo: "M1",
    kind: "completed",
  });
  assert.deepEqual(
    [task(s, "T1").status, task(s, "T2").status],
    ["completed", "completed"],
  );
  assert.deepEqual(commands(s).map(deliveryIdOf), ["D3"]);
});

test("a placement's queue follows delivery creation, not task order", () => {
  let s = expectOk(initial(config), {
    type: "observe",
    placement: "knowledge@mini",
    ready: false,
  });
  s = submit(s, { messageId: "M1", text: "Handle this." });
  s = judge(s, "T1", "none", 0.9);
  s = submit(s, { messageId: "M2", text: "Summarize.", to: "knowledge" });
  // T1 waited for a recipient, so its delivery comes after T2's.
  s = expectOk(s, { type: "choose", by: "you", taskId: "T1", to: "knowledge" });
  assert.deepEqual(
    [task(s, "T1").deliveries, task(s, "T2").deliveries].map((list) =>
      list.map((d) => d.id),
    ),
    [["D2"], ["D1"]],
  );
  s = idle(s, "knowledge@mini");
  assert.deepEqual(commands(s).map(deliveryIdOf), ["D1"]);
  assert.equal(
    Core.blockedReason(s, must(Core.findDelivery(s, "D2"))),
    "queued_behind",
  );
  s = expectReject(s, { type: "attempt", deliveryId: "D2" }, "not_eligible");
  s = deliver(s, "D1");
  s = idle(s, "knowledge@mini");
  assert.deepEqual(commands(s).map(deliveryIdOf), ["D2"]);
});

test("a placement's queue head is its oldest open, unpinned delivery", () => {
  const head = (state: State, placement = "knowledge@mini") =>
    Core.queueHead(state, placement)?.id ?? null;
  let s = expectOk(initial(config), {
    type: "observe",
    placement: "knowledge@mini",
    ready: false,
  });
  assert.equal(head(s), null);
  s = submit(s, { messageId: "M1", text: "Handle this." });
  s = judge(s, "T1", "none", 0.9);
  s = submit(s, { messageId: "M2", text: "Summarize.", to: "knowledge" });
  s = submit(s, { messageId: "M3", text: "Outline.", to: "knowledge" });
  s = expectOk(s, { type: "choose", by: "you", taskId: "T1", to: "knowledge" });
  // Task order lists T1's D3 first; the queue goes by creation.
  assert.equal(head(s), "D1");
  assert.equal(head(s, "orchestrator@mbp"), null);
  // A canceled task's delivery leaves the queue.
  s = expectOk(s, { type: "cancel", by: "you", taskId: "T2" });
  assert.equal(head(s), "D2");
  // A hold stops the queue without reordering it.
  s = expectOk(s, { type: "observe", placement: "knowledge@mini", hold: true });
  assert.equal(head(s), "D2");
  assert.equal(Core.blockedReason(s, must(Core.findDelivery(s, "D3"))), "held");
  s = expectOk(s, {
    type: "observe",
    placement: "knowledge@mini",
    hold: false,
    ready: true,
  });
  assert.equal(
    Core.blockedReason(s, must(Core.findDelivery(s, "D3"))),
    "queued_behind",
  );
  // Once sent, a delivery is pinned to its session and no longer queued.
  s = deliver(s, "D2");
  assert.equal(head(s), "D3");
  s = idle(s, "knowledge@mini");
  s = deliver(s, "D3");
  assert.equal(head(s), null);
});

test("deadline fails the task; an unconfirmed send still blocks its session until reconciled", () => {
  let s = submit(initial(config), {
    messageId: "M1",
    text: "Long job",
    to: "orchestrator",
  });
  s = deliver(s, "D1", "unknown");
  const lines = s.log.length;
  s = expectOk(s, { type: "tick", now: 50 });
  assert.equal(s.log.length, lines, "a clock that ends nothing logs nothing");
  s = submit(s, { messageId: "M2", text: "Next job", to: "orchestrator" });
  s = expectOk(s, { type: "tick", now: 100 });
  assert.match(s.log.at(-1)?.text ?? "", /^Deadline passed: T1 failed/);
  assert.equal(task(s).status, "failed");
  assert.equal(task(s, "T2").status, "queued");
  s = idle(s);
  assert.deepEqual(
    commands(s),
    [],
    "the uncertain send still holds the session",
  );
  assert.equal(
    Core.blockedReason(s, must(Core.findDelivery(s, "D1"))),
    "closed",
    "no retry after the deadline",
  );
  assert.equal(
    Core.blockedReason(s, must(Core.findDelivery(s, "D2"))),
    "in_flight",
  );
  s = expectReject(
    s,
    {
      type: "resolve",
      by: "you",
      deliveryId: "D1",
      messageId: "M1",
      outcome: "finished",
      evidence: "x",
    },
    "forbidden",
  );
  s = expectReject(
    s,
    {
      type: "resolve",
      by: "operator",
      deliveryId: "D1",
      messageId: "M1",
      outcome: "finished",
      evidence: "",
    },
    "invalid",
  );
  s = expectOk(s, {
    type: "resolve",
    by: "operator",
    deliveryId: "D1",
    messageId: "M1",
    outcome: "finished",
    evidence: "Checked Paseo: turn ended.",
  });
  assert.deepEqual(commands(s).map(deliveryIdOf), ["D2"]);
  s = expectOk(s, {
    type: "update",
    by: ORCH,
    taskId: "T1",
    messageId: "R1",
    inReplyTo: "M1",
    kind: "completed",
    text: "late",
  });
  assert.equal(
    task(s).status,
    "failed",
    "late evidence never reopens a terminal task",
  );
  s = expectReject(
    s,
    {
      type: "answer",
      by: "you",
      taskId: "T1",
      messageId: "A1",
      questionId: "Q1",
      text: "x",
    },
    "terminal",
  );
});

test("late final reply after the deadline is kept as evidence", () => {
  let s = submit(initial(config), {
    messageId: "M1",
    text: "Long job",
    to: "orchestrator",
  });
  s = deliver(s, "D1");
  s = submit(s, { messageId: "M2", text: "Queued job", to: "orchestrator" });
  s = expectOk(s, { type: "tick", now: 100 });
  assert.equal(task(s, "T2").status, "failed");
  assert.equal(must(must(Core.findDelivery(s, "D2")).end).reason, "expired");
  s = expectOk(s, {
    type: "update",
    by: ORCH,
    taskId: "T1",
    messageId: "R1",
    inReplyTo: "M1",
    kind: "completed",
    text: "late",
  });
  assert.deepEqual(
    task(s).late.map((l) => l.kind),
    ["completed"],
  );
  assert.equal(isOpen(must(Core.findDelivery(s, "D1"))), false);
});

test("unclear, low-confidence, invalid or unavailable routing asks the sender", () => {
  let s = submit(initial(config), { messageId: "M1", text: "Handle this." });
  s = judge(s, "T1", "none", 0.9);
  assert.equal(task(s).status, "needs_recipient");
  assert.equal(Core.A2A_STATE.needs_recipient, "TASK_STATE_INPUT_REQUIRED");
  assert.deepEqual(commands(s), []);
  s = expectReject(
    s,
    { type: "choose", by: KNOW, taskId: "T1", to: "knowledge" },
    "forbidden",
  );
  s = expectOk(s, { type: "choose", by: "you", taskId: "T1", to: "knowledge" });
  s = expectReject(
    s,
    { type: "choose", by: "you", taskId: "T1", to: "orchestrator" },
    "not_waiting",
  );
  assert.equal(task(s).recipient, "knowledge");

  s = submit(s, { messageId: "M2", text: "Summarize my Incus notes." });
  s = judge(s, "T2", "incus", 0.6);
  assert.equal(must(task(s, "T2").routing).reason, "low_confidence");
  assert.ok(must(task(s, "T2").routing).suggestions.includes("incus"));

  s = submit(s, { messageId: "M3", text: "x" });
  s = expectOk(s, {
    type: "judged",
    taskId: "T3",
    choice: "incus",
    probabilities: { incus: 1 },
  });
  assert.equal(must(task(s, "T3").routing).reason, "invalid_judgment");
  s = expectReject(
    s,
    {
      type: "judged",
      taskId: "T3",
      choice: "incus",
      probabilities: { incus: 1 },
    },
    "not_routing",
  );

  s = submit(s, { messageId: "M4", text: "y" });
  s = expectOk(s, { type: "judgeFailed", taskId: "T4", reason: "timed out" });
  assert.equal(must(task(s, "T4").routing).reason, "routing_unavailable");

  // A caller with no permitted recipients has nobody to route to.
  s = expectReject(
    s,
    { type: "submit", by: KNOW, messageId: "K1", text: "help" },
    "forbidden",
  );
  // A task that never got a delivery cannot have completed.
  s = expectOk(s, { type: "submit", by: "you", messageId: "M5", text: "z" });
  s = expectOk(s, { type: "tick", now: task(s, "T5").deadline });
  assert.deepEqual(task(s, "T5").final, {
    status: "failed",
    reason: "deadline",
    completed: 0,
    of: 0,
  });
});

test("not_sent requeues safely; replaced sessions get new work, old pins keep theirs", () => {
  let s = submit(initial(config), {
    messageId: "M1",
    text: "Job",
    to: "orchestrator",
  });
  s = deliver(s, "D1", "not_sent");
  assert.equal(task(s).status, "queued");
  s = expectOk(s, {
    type: "observe",
    placement: "orchestrator@mbp",
    session: "orchestrator@mbp#2",
    ready: true,
  });
  s = deliver(s, "D1");
  assert.equal(must(Core.findDelivery(s, "D1")).session, "orchestrator@mbp#2");
  s = expectReject(
    s,
    {
      type: "update",
      by: ORCH,
      taskId: "T1",
      messageId: "R1",
      inReplyTo: "M1",
      kind: "completed",
    },
    "wrong_session",
  );
  s = expectReject(
    s,
    { type: "submit", by: ORCH, messageId: "O1", text: "VM", to: "incus" },
    "unauthenticated",
  );
  s = expectReject(
    s,
    { type: "observe", placement: "orchestrator@mbp", session: ORCH },
    "invalid",
  );

  // An answer pinned to a replaced session waits for an operator; it is never redirected.
  s = expectOk(s, {
    type: "update",
    by: "orchestrator@mbp#2",
    taskId: "T1",
    messageId: "Q1",
    inReplyTo: "M1",
    kind: "question",
    text: "?",
  });
  s = expectOk(s, {
    type: "answer",
    by: "you",
    taskId: "T1",
    messageId: "A1",
    questionId: "Q1",
    text: "!",
  });
  s = expectOk(s, {
    type: "observe",
    placement: "orchestrator@mbp",
    session: "orchestrator@mbp#3",
    ready: true,
  });
  assert.equal(
    Core.blockedReason(s, must(Core.findDelivery(s, "D1"))),
    "session_replaced",
  );
  s = expectOk(s, {
    type: "resolve",
    by: "operator",
    deliveryId: "D1",
    messageId: "A1",
    outcome: "not_sent",
    evidence: "Session #2 closed.",
  });
  assert.equal(task(s).status, "failed");
});

test("cancel only while nothing may have reached the participant", () => {
  let s = expectOk(initial(config), {
    type: "observe",
    placement: "incus@lab01",
    ready: false,
  });
  s = submit(s, { messageId: "M1", text: "VM", to: "incus" });
  s = expectReject(s, { type: "cancel", by: ORCH, taskId: "T1" }, "forbidden");
  s = expectOk(s, { type: "cancel", by: "you", taskId: "T1" });
  assert.equal(Core.A2A_STATE[task(s).status], "TASK_STATE_CANCELED");
  s = submit(s, { messageId: "M2", text: "Status", to: "orchestrator" });
  s = deliver(s, "D2", "not_sent");
  s = expectOk(s, { type: "cancel", by: "you", taskId: "T2" });
  s = idle(s);
  s = submit(s, { messageId: "M3", text: "Status", to: "orchestrator" });
  s = expectOk(s, { type: "attempt", deliveryId: "D3" });
  expectReject(
    s,
    { type: "cancel", by: "you", taskId: "T3" },
    "not_cancelable",
  );
});

test("input limits", () => {
  const s = initial(config);
  expectReject(
    s,
    { type: "submit", by: "you", messageId: "has space", text: "x" },
    "invalid",
  );
  expectReject(
    s,
    { type: "submit", by: "you", messageId: "M1", text: "   " },
    "invalid",
  );
  expectReject(
    s,
    { type: "submit", by: "you", messageId: "M1", text: "x".repeat(4001) },
    "invalid",
  );
  expectReject(
    s,
    { type: "submit", by: "you", messageId: "M1", text: "x", to: "ghost" },
    "invalid",
  );
  // Deliberately not an Event: the core must refuse an unknown type.
  expectReject(s, { type: "nonsense" } as unknown as Event, "unknown_event");
  let full = s;
  for (let i = 0; i < 20; i++)
    full = submit(full, { messageId: `M${i}`, text: "x", to: "knowledge" });
  expectReject(
    full,
    { type: "submit", by: "you", messageId: "M99", text: "x", to: "knowledge" },
    "capacity",
  );
});

test("the core carries no deployment: any valid configuration works, invalid ones are refused", () => {
  // Deliberately no configuration.
  assert.throws(
    () => initial(undefined as unknown as Config),
    /configuration object is required/,
  );
  assert.throws(
    () => initial({ ...config, permissions: { you: ["ghost"] } }),
    /unknown participant ghost/,
  );
  assert.throws(
    // Deliberately not a Role.
    () =>
      initial({ ...config, principals: { you: "admin" } } as unknown as Config),
    /unknown role/,
  );
  const withPolicy = (policy: Partial<Policy>): Config => ({
    ...config,
    policy: { ...config.policy, ...policy },
  });
  // The patch may deliberately break the participant's shape.
  const withParticipant = (patch: Record<string, unknown>) => ({
    ...config,
    participants: [
      { ...config.participants[0], ...patch },
      ...config.participants.slice(1),
    ],
  });
  // Deliberately invalid configurations, so each is only `unknown` here.
  const cases: [broken: unknown, message: RegExp][] = [
    [withPolicy({ threshold: 5 }), /threshold/],
    [withPolicy({ threshold: NaN }), /threshold/],
    [withPolicy({ deadline: -1 }), /deadline/],
    [withPolicy({ maxOpenTasks: 0 }), /maxOpenTasks/],
    [withParticipant({ kind: "robot" }), /kind/],
    [withParticipant({ hosts: ["mbp", "mbp"] }), /distinct host/],
    [withParticipant({ hosts: [7] }), /distinct host/],
    [withParticipant({ idempotent: "yes" }), /idempotent/],
    [{ ...config, participants: [null] }, /participant ids/],
    [{ ...config, permissions: { you: "orchestrator" } }, /must be a list/],
    [{ ...config, principals: [] }, /principals must be an object/],
  ];
  for (const [broken, message] of cases)
    assert.throws(() => initial(broken as Config), message);
  const other: Config = {
    policy: {
      threshold: 0.8,
      deadline: 10,
      maxText: 100,
      maxOpenTasks: 2,
    },
    principals: { alice: "requester", bob: "requester", ops: "operator" },
    participants: [
      {
        id: "writer",
        name: "Writer",
        kind: "agent",
        hosts: ["desk"],
        idempotent: false,
        responsibility: "Drafts text.",
      },
      {
        id: "editor",
        name: "Editor",
        kind: "agent",
        hosts: ["desk", "lap"],
        idempotent: true,
        responsibility: "Edits drafts.",
      },
    ],
    permissions: { alice: ["writer"], writer: ["editor"] },
  };
  let s = expectOk(initial(other), {
    type: "submit",
    by: "alice",
    messageId: "m1",
    text: "Draft it.",
  });
  assert.deepEqual(Object.keys(judgeOf(commands(s)[0]).question.criteria), [
    "writer",
    "none",
  ]);
  s = judge(s, "T1", "writer", 0.85);
  s = deliver(s, "D1");
  s = expectOk(s, {
    type: "submit",
    by: "writer@desk#1",
    messageId: "w1",
    text: "Edit it.",
    to: "editor",
    hosts: ["lap"],
  });
  assert.equal(must(task(s, "T2").deliveries[0]).placement, "editor@lap");
  expectReject(
    s,
    { type: "submit", by: "bob", messageId: "b1", text: "x", to: "writer" },
    "forbidden",
  );
  expectReject(
    s,
    { type: "submit", by: "ops", messageId: "o1", text: "x" },
    "unauthenticated",
  );
  expectReject(
    s,
    {
      type: "resolve",
      by: "alice",
      deliveryId: "D1",
      messageId: "m1",
      outcome: "finished",
      evidence: "x",
    },
    "forbidden",
  );
});

test("the record carries its configuration: rules change without breaking replay", () => {
  // A request dispatched at threshold 0.9 with a 0.92 judgment.
  let s = initial(config);
  s = expectOk(s, { type: "tick", now: 1 });
  s = idle(s);
  s = submit(s, { messageId: "M1", text: "Check the dotfiles everywhere." });
  s = judge(s, "T1", "orchestrator", 0.92);
  assert.equal(task(s).status, "queued");
  s = deliver(s, "D1");
  // The deployment raises the threshold and adds a participant on a new
  // host. Recorded, the change applies from here on; what happened before
  // stands, and the new placement exists.
  const stricter: Config = structuredClone(config);
  stricter.policy.threshold = 0.95;
  stricter.participants.push({
    id: "reviewer",
    name: "Reviewer",
    kind: "agent",
    hosts: ["mba"],
    idempotent: true,
    responsibility: "Reviews drafts.",
  });
  must(stricter.permissions).you?.push("reviewer");
  s = expectOk(s, { type: "configured", config: stricter });
  assert.equal(s.config.policy.threshold, 0.95);
  assert.ok(s.placements["reviewer@mba"]);
  assert.equal(s.placements["orchestrator@mbp"]?.ready, false, "kept");
  assert.equal(task(s).status, "working", "earlier dispatch stands");
  s = submit(s, { messageId: "M2", text: "Check the dotfiles again." });
  s = judge(s, "T2", "orchestrator", 0.92);
  assert.equal(task(s, "T2").status, "needs_recipient", "new rule applies");
  assert.ok(
    Object.keys(Core.judgmentQuestion(s, task(s, "T2")).criteria).includes(
      "reviewer",
    ),
  );
  // Removing a participant keeps its placement and its open delivery.
  const smaller: Config = structuredClone(config);
  smaller.participants = smaller.participants.filter(
    (p) => p.id !== "orchestrator",
  );
  must(smaller.permissions).you = ["knowledge", "environment", "incus"];
  delete must(smaller.permissions).orchestrator;
  s = expectOk(s, { type: "configured", config: smaller });
  assert.ok(s.placements["orchestrator@mbp"]);
  assert.equal(task(s).status, "working");
  assert.ok(!task(s, "T2").routing?.suggestions.includes("orchestrator"));
  assert.deepEqual(
    Core.commands(s).filter((c) => c.type === "deliver"),
    [],
  );
  // An invalid configuration is refused and changes nothing.
  const broken = structuredClone(config) as unknown as { policy: unknown };
  broken.policy = { threshold: 2 };
  s = expectReject(
    s,
    { type: "configured", config: broken as unknown as Config },
    "invalid",
  );
  assert.equal(s.config.participants.length, smaller.participants.length);
});

test("a retry that comes back not_sent keeps the pin: the first attempt may have arrived", () => {
  let s = submit(initial(config), {
    messageId: "M1",
    text: "Job",
    to: "orchestrator",
  });
  s = deliver(s, "D1", "unknown");
  s = idle(s);
  s = deliver(s, "D1", "not_sent");
  const d = must(Core.findDelivery(s, "D1"));
  assert.equal(d.session, ORCH, "still pinned");
  assert.deepEqual(currentSend(d).trail, [
    "attempting",
    "unknown",
    "attempting",
    "not_sent",
  ]);
  s = expectReject(
    s,
    { type: "cancel", by: "you", taskId: "T1" },
    "not_cancelable",
  );
  // The session is replaced: the message must not follow to the new one.
  s = expectOk(s, {
    type: "observe",
    placement: "orchestrator@mbp",
    session: "orchestrator@mbp#2",
    ready: true,
  });
  assert.equal(
    Core.blockedReason(s, must(Core.findDelivery(s, "D1"))),
    "session_replaced",
  );
  assert.deepEqual(commands(s), []);
  s = expectOk(s, {
    type: "resolve",
    by: "operator",
    deliveryId: "D1",
    messageId: "M1",
    outcome: "not_sent",
    evidence: "Old session's history shows no prompt.",
  });
  assert.equal(task(s).status, "failed");
});

test("guards with exact boundaries", () => {
  // Threshold: exactly the threshold dispatches; just below asks the sender.
  let s = submit(initial(config), { messageId: "M1", text: "a" });
  s = judge(s, "T1", "orchestrator", 0.9);
  assert.equal(task(s).recipient, "orchestrator");
  s = submit(s, { messageId: "M2", text: "b" });
  s = judge(s, "T2", "orchestrator", 0.89);
  assert.equal(must(task(s, "T2").routing).reason, "low_confidence");
  assert.deepEqual(must(task(s, "T2").routing).suggestions[0], "orchestrator");
  // Probabilities must sum to one.
  s = submit(s, { messageId: "M3", text: "c" });
  const options = Object.keys(Core.judgmentQuestion(s, task(s, "T3")).criteria);
  s = expectOk(s, {
    type: "judged",
    taskId: "T3",
    choice: "orchestrator",
    probabilities: Object.fromEntries(options.map((id) => [id, 0.5])),
  });
  assert.equal(must(task(s, "T3").routing).reason, "invalid_judgment");
  // Time never moves backwards.
  s = expectOk(s, { type: "tick", now: 5 });
  s = expectReject(s, { type: "tick", now: 4 }, "invalid");
  // An operator cannot resolve an attempt in progress, nor call an accepted send not_sent.
  s = submit(s, { messageId: "M4", text: "d", to: "knowledge" });
  s = expectOk(s, { type: "attempt", deliveryId: "D2" });
  s = expectReject(
    s,
    {
      type: "resolve",
      by: "operator",
      deliveryId: "D2",
      messageId: "M4",
      outcome: "finished",
      evidence: "x",
    },
    "in_progress",
  );
  s = expectOk(s, {
    type: "adapterResult",
    deliveryId: "D2",
    messageId: "M4",
    outcome: "accepted",
  });
  s = expectReject(
    s,
    {
      type: "resolve",
      by: "operator",
      deliveryId: "D2",
      messageId: "M4",
      outcome: "not_sent",
      evidence: "x",
    },
    "invalid",
  );
  // A reply to a message that was never sent is not a reply.
  s = expectOk(s, {
    type: "update",
    by: KNOW,
    taskId: "T4",
    messageId: "Q1",
    inReplyTo: "M4",
    kind: "question",
    text: "?",
  });
  s = expectOk(s, {
    type: "answer",
    by: "you",
    taskId: "T4",
    messageId: "A1",
    questionId: "Q1",
    text: "!",
  });
  s = expectReject(
    s,
    {
      type: "update",
      by: KNOW,
      taskId: "T4",
      messageId: "R1",
      inReplyTo: "A1",
      kind: "completed",
    },
    "wrong_message",
  );
  // A replaced session is not ready until observed.
  s = expectOk(s, {
    type: "observe",
    placement: "knowledge@mini",
    session: "knowledge@mini#2",
  });
  assert.equal(must(s.placements["knowledge@mini"]).ready, false);
});

test("every status maps to an A2A v1.0 task state", () => {
  for (const name of [
    "routing",
    "queued",
    "delivering",
    "working",
    "uncertain",
    "needs_recipient",
    "needs_answer",
    "completed",
    "partial",
    "failed",
    "canceled",
  ] satisfies Status[])
    assert.match(Core.A2A_STATE[name], /^TASK_STATE_/);
});

// ---- Random sequences: every event, every step, checked by the oracle ----

function rng(seed: number): () => number {
  return () => {
    seed = (seed + 0x6d2b79f5) | 0;
    let t = Math.imul(seed ^ (seed >>> 15), 1 | seed);
    t = (t + Math.imul(t ^ (t >>> 7), 61 | t)) ^ t;
    return ((t ^ (t >>> 14)) >>> 0) / 4294967296;
  };
}

function randomEvent(s: State, r: () => number): Event {
  // Every list picked from is non-empty.
  const pick = <T>(list: readonly T[]): T =>
    must(list[Math.floor(r() * list.length)], "a pick");
  const deliveries = s.tasks.flatMap((t) => t.deliveries);
  const taskId = s.tasks.length ? pick(s.tasks).id : "T1";
  const sessions = Object.keys(s.sessions);
  const sends = deliveries.flatMap((d) => d.sends.map((x) => x.messageId));
  const questions = deliveries
    .filter((d) => d.question)
    .map((d) => must(d.question).id);
  const participants = [
    "orchestrator",
    "knowledge",
    "environment",
    "incus",
    "ghost",
  ];
  const work = commands(s);
  switch (
    pick([
      "submit",
      "submit",
      "work",
      "work",
      "work",
      "judged",
      "choose",
      "attempt",
      "attempt2",
      "attempt3",
      "ack",
      "ack",
      "noticeResult",
      "noticeResult",
      "noticeAttempt",
      "noticeAttempt",
      "update",
      "update",
      "update",
      "answer",
      "cancel",
      "resolve",
      "observe",
      "restart",
      "tick",
    ])
  ) {
    case "submit": {
      const to = r() < 0.5 ? pick(participants) : null;
      const hosts =
        to && r() < 0.3 ? [pick(["mba", "mbp", "mini", "lab01"])] : null;
      return {
        type: "submit",
        by: pick(["you", "you", ORCH, KNOW, "mallory"]),
        messageId: r() < 0.03 ? "" : `M${Math.floor(r() * 8)}`,
        text: pick(["a", "b"]),
        to,
        hosts,
      };
    }
    case "work": {
      if (!work.length) return { type: "restart" };
      const c = pick(work);
      if (c.type === "deliver")
        return { type: "attempt", deliveryId: c.deliveryId };
      if (c.type === "notify")
        return {
          type: "noticeAttempt",
          taskId: c.taskId,
          key: c.key,
          text: pick(["n", "n", "m"]),
        };
      if (r() < 0.15) return { type: "judgeFailed", taskId: c.taskId };
      const options = Object.keys(c.question.criteria);
      const choice = pick(options);
      const p = pick([0.95, 0.5, 1]);
      const probabilities = Object.fromEntries(
        options.map((id) => [
          id,
          id === choice ? p : (1 - p) / (options.length - 1),
        ]),
      );
      return { type: "judged", taskId: c.taskId, choice, probabilities };
    }
    case "judged":
      return {
        type: "judged",
        taskId,
        choice: pick(participants),
        probabilities: { orchestrator: 1 },
      };
    case "choose":
      return {
        type: "choose",
        by: pick(["you", ORCH]),
        taskId,
        to: pick(participants),
      };
    case "attempt":
    case "attempt2":
    case "attempt3": {
      // Now and then aim at a pinned delivery, which is rarer than a queued
      // one: a held session refusing an answer is otherwise seldom seen.
      const pinned = deliveries.filter((d) => d.session !== null);
      const pool = pinned.length && r() < 0.5 ? pinned : deliveries;
      return {
        type: "attempt",
        deliveryId: pool.length ? pick(pool).id : "D1",
      };
    }
    case "noticeResult": {
      // For the notice in flight when there is one; otherwise for any
      // recorded notice, which the core must refuse as stale.
      const all = s.tasks.flatMap((t) =>
        t.notices.map((n) => ({
          taskId: t.id,
          key: n.key,
          outcome: n.outcome,
        })),
      );
      const inFlight = all.filter((n) => n.outcome === "attempting");
      const pool = inFlight.length && r() < 0.9 ? inFlight : all;
      const n = pool.length ? pick(pool) : null;
      return {
        type: "noticeResult",
        taskId: n?.taskId ?? taskId,
        key: n?.key ?? "final",
        outcome: pick(["accepted", "not_sent", "unknown"]),
      };
    }
    case "noticeAttempt": {
      // An eligible notice when there is one, with the same text as before
      // most of the time; otherwise one that is not necessarily due.
      const notify = work.filter((c) => c.type === "notify");
      if (notify.length && r() < 0.8) {
        const c = pick(notify);
        return {
          type: "noticeAttempt",
          taskId: c.taskId,
          key: c.key,
          text: pick(["n", "n", "n", "m"]),
        };
      }
      return {
        type: "noticeAttempt",
        taskId,
        key: pick([
          "final",
          "choose/1",
          `question/D${1 + Math.floor(r() * 6)}/R${Math.floor(r() * 12)}`,
        ]),
        text: "n",
      };
    }
    case "ack": {
      const d = deliveries.length ? pick(deliveries) : null;
      return {
        type: "adapterResult",
        deliveryId: d?.id ?? "D1",
        messageId: d ? currentSend(d).messageId : "M1",
        outcome: pick(["accepted", "accepted", "not_sent", "unknown"]),
      };
    }
    case "update": {
      const d = deliveries.length ? pick(deliveries) : null;
      const by = d?.session && r() < 0.8 ? d.session : pick(sessions);
      const kind = pick([
        "working",
        "question",
        "question",
        "completed",
        "failed",
      ] as const);
      return {
        type: "update",
        by,
        taskId: d?.taskId ?? taskId,
        // Questions draw from a small pool so two deliveries of one
        // fan-out sometimes ask under the same id.
        messageId:
          kind === "question"
            ? `R${Math.floor(r() * 3)}`
            : `R${3 + Math.floor(r() * 9)}`,
        inReplyTo:
          sends.length && r() < 0.9
            ? d && r() < 0.7
              ? currentSend(d).messageId
              : pick(sends)
            : "M404",
        kind,
        text: pick(["x", "y"]),
      };
    }
    case "answer": {
      // Half the time aim at an open question on its own task, mostly by
      // question id alone, now and then naming the delivery; otherwise
      // anything, which the core must refuse.
      const asking = deliveries.filter((d) => open(d) && d.question);
      const aimed = asking.length && r() < 0.5 ? pick(asking) : null;
      return {
        type: "answer",
        by: pick(["you", ORCH]),
        taskId: aimed?.taskId ?? taskId,
        messageId: `A${Math.floor(r() * 6)}`,
        questionId:
          aimed?.question?.id ??
          (questions.length && r() < 0.8 ? pick(questions) : "R0"),
        deliveryId:
          r() < 0.3 && deliveries.length
            ? (aimed?.id ?? pick(deliveries).id)
            : null,
        text: "ok",
      };
    }
    case "cancel":
      return {
        type: "cancel",
        by: pick(["you", ORCH]),
        taskId: r() < 0.05 ? "T999" : taskId,
      };
    case "resolve": {
      const d = deliveries.length ? pick(deliveries) : null;
      return {
        type: "resolve",
        by: pick(["operator", "operator", "you"]),
        deliveryId: d?.id ?? "D1",
        messageId: d ? currentSend(d).messageId : "M1",
        outcome: pick(["finished", "not_sent"]),
        evidence: "checked",
      };
    }
    case "observe": {
      // Now and then wake the placement a sender waits at, so a notice
      // refused as not_sent gets its second attempt within the run.
      const owed = s.tasks
        .filter((t) => t.notices.some((n) => n.outcome === "pending"))
        .map((t) => must(t.via));
      if (owed.length && r() < 0.3)
        return { type: "observe", placement: pick(owed), ready: true };
      // And now and then hold the placement of a pinned, queued send, so
      // the hold is seen refusing an answer, not only a new request.
      const queuedPins = deliveries.filter(
        (d) => d.session !== null && open(d) && last(d).outcome === "pending",
      );
      if (queuedPins.length && r() < 0.3)
        return {
          type: "observe",
          placement: pick(queuedPins).placement,
          hold: true,
        };
      const placement = pick(Object.keys(s.placements));
      return r() < 0.2
        ? {
            type: "observe",
            placement,
            session: `${placement}#${2 + Math.floor(r() * 1e6)}`,
          }
        : r() < 0.15
          ? { type: "observe", placement, hold: r() < 0.5 }
          : { type: "observe", placement, ready: r() < 0.7 };
    }
    case "restart":
      // Deliberately not an Event now and then: the core must refuse it.
      return r() < 0.1
        ? ({ type: "nonsense" } as unknown as Event)
        : { type: "restart" };
    default:
      return { type: "tick", now: s.now + Math.floor(r() * 40) };
  }
}

test("random event sequences never violate the contract", () => {
  const reached = new Set<string>();
  for (let seed = 1; seed <= 400; seed++) {
    const r = rng(seed);
    // Half the runs use a participant whose adapter cannot deduplicate.
    let s = initial(seed % 2 ? config : strictConfig);
    for (let step = 0; step < 120; step++) {
      const event = randomEvent(s, r);
      s = apply(s, event);
      for (const t of s.tasks) reached.add(t.status);
      for (const principal of ["you", ORCH_ID, "operator"])
        for (const item of Core.needsYou(s, principal))
          reached.add(
            `needs:${item.kind}${"reason" in item && item.reason ? ":" + item.reason : ""}`,
          );
      const outcome = outcomeOf(s);
      if (outcome.ok) reached.add(`ok:${event.type}`);
      else {
        reached.add(
          `reject:${outcome.code}${outcome.code === "not_eligible" ? " " + outcome.message.split(": ").pop() : ""}`,
        );
        if (
          outcome.message.endsWith("held.") &&
          // Only an attempt is refused as held, and it names its delivery.
          event.type === "attempt" &&
          must(Core.findDelivery(s, event.deliveryId)).session !== null
        )
          reached.add("held pinned");
      }
      for (const d of Core.allDeliveries(s))
        if (d.sends.some((send) => send.outcome === "withdrawn"))
          reached.add("withdrawn");
      for (const t of s.tasks)
        for (const n of t.notices) {
          if (n.outcome === "accepted") reached.add("notice told");
          if (n.outcome === "withdrawn") reached.add("notice withdrawn");
          n.trail.forEach((step, i) => {
            if (step === "attempting" && i > 0)
              reached.add(`notice repeat after ${n.trail[i - 1]}`);
          });
        }
      for (const d of Core.allDeliveries(s))
        for (const send of d.sends)
          send.trail.forEach((step, i) => {
            if (step === "attempting" && i > 0)
              reached.add(`resend after ${send.trail[i - 1]}`);
          });
    }
  }
  // Guard against a vacuous run: the generator must reach every state and accepted event.
  for (const expected of [
    "routing",
    "needs_recipient",
    "queued",
    "delivering",
    "working",
    "uncertain",
    "needs_answer",
    "completed",
    "partial",
    "failed",
    "canceled",
    "ok:submit",
    "ok:judged",
    "ok:choose",
    "ok:attempt",
    "ok:adapterResult",
    "ok:update",
    "ok:answer",
    "ok:cancel",
    "ok:resolve",
    "ok:observe",
    "ok:restart",
    "ok:tick",
    "ok:noticeAttempt",
    "ok:noticeResult",
    "notice told",
    "notice withdrawn",
    "notice repeat after not_sent",
    "notice repeat after unknown",
    "reject:not_due",
    "reject:ambiguous",
    "resend after not_sent",
    "needs:choose:no_owner",
    "needs:choose:low_confidence",
    "needs:answer",
    "needs:resolve:task_ended",
    "needs:resolve:session_replaced",
    "needs:resolve:unknown_send",
    "resend after unknown",
    // Every blocking reason and rejection path must occur, or the random run
    // says nothing about them.
    "reject:not_eligible not ready.",
    "reject:not_eligible held.",
    "held pinned",
    "withdrawn",
    "ok:judgeFailed",
    "reject:invalid",
    "reject:not_found",
    "reject:capacity",
    "reject:unknown_event",
    "reject:not_eligible in flight.",
    "reject:not_eligible queued behind.",
    "reject:not_eligible session replaced.",
    "reject:not_eligible closed.",
    "reject:not_eligible not pending.",
    "reject:conflict",
    "reject:forbidden",
    "reject:unauthenticated",
    "reject:stale_ack",
    "reject:wrong_session",
    "reject:wrong_message",
    "reject:question_open",
    "reject:no_question",
    "reject:not_cancelable",
    "reject:not_pinned",
    "reject:in_progress",
    "reject:terminal",
    "reject:not_waiting",
    "reject:not_routing",
  ])
    assert.ok(reached.has(expected), `random run never reached ${expected}`);
});
