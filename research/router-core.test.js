// Executable contract for router-core.js. Run: node --test research/router-core.test.js
const test = require("node:test");
const assert = require("node:assert/strict");
const Core = require("./router-core.js");
const config = require("./router-example-config.js");

const { initial, reduce, commands, currentSend, isOpen } = Core;
const ORCH_ID = "orchestrator";
const ORCH = "orchestrator@mbp#1";
const KNOW = "knowledge@mini#1";
const LAB = "incus@lab01#1";

// ---- Oracle: invariants checked independently of the implementation ----
// The oracle derives eligibility, in-flight, status and judgment validity
// itself, so a wrong rule in the core cannot approve its own behavior.

const last = (d) => d.sends.findLast((send) => send.outcome !== "withdrawn");
const open = (d) => d.end === null;
const unconfirmed = (d) =>
  open(d) &&
  d.session !== null &&
  ["attempting", "unknown"].includes(last(d).outcome);
// As recorded on the delivery: the configuration may have changed since.
const isIdempotent = (state, d) => d.idempotent;
const deliveriesOf = (state) => state.tasks.flatMap((t) => t.deliveries);
// Older means created earlier. Deliveries are numbered from one counter;
// task order differs once a task gets its recipient after a newer one.
const createdBefore = (a, b) => Number(a.id.slice(1)) < Number(b.id.slice(1));

function oracleEligible(state, d) {
  const task = state.tasks.find((t) => t.id === d.taskId);
  const placement = state.placements[d.placement];
  const send = last(d);
  if (task.final || !open(d)) return false;
  const retry = send.outcome === "unknown" && isIdempotent(state, d);
  if (send.outcome !== "pending" && !retry) return false;
  if (!placement.ready || placement.hold) return false;
  if (d.session !== null && d.session !== placement.session) return false;
  const all = deliveriesOf(state);
  if (all.some((o) => o !== d && o.placement === d.placement && unconfirmed(o)))
    return false;
  if (d.session === null) {
    if (
      all.some(
        (o) =>
          createdBefore(o, d) &&
          o.placement === d.placement &&
          o.session === null &&
          open(o) &&
          !state.tasks.find((t) => t.id === o.taskId).final,
      )
    )
      return false;
  }
  return true;
}

function oracleStatus(task) {
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
function needsYouViolations(state) {
  const out = [];
  const sessionOf = (id) =>
    Object.values(state.placements).find((p) => p.participant === id)?.session;
  const principals = [
    ...Object.keys(state.config.principals),
    ...state.config.participants.map((p) => p.id),
  ];
  for (const principal of principals) {
    const items = Core.needsYou(state, principal);
    const by = state.config.principals[principal]
      ? principal
      : sessionOf(principal);
    if (state.config.principals[principal] === "operator") {
      const expected = deliveriesOf(state).filter((d) => {
        if (!open(d) || d.session === null || last(d).outcome === "attempting")
          return false;
        const task = state.tasks.find((t) => t.id === d.taskId);
        if (task.final) return last(d).outcome !== "accepted";
        return (
          state.placements[d.placement].session !== d.session ||
          (last(d).outcome === "unknown" && !isIdempotent(state, d))
        );
      });
      if (
        items.length !== expected.length ||
        items.some(
          (item, i) =>
            item.kind !== "resolve" || item.deliveryId !== expected[i].id,
        )
      )
        out.push(`operator list differs from the stuck deliveries`);
      for (const item of items) {
        const next = reduce(state, {
          type: "resolve",
          by,
          deliveryId: item.deliveryId,
          messageId: item.messageId,
          outcome: "finished",
          evidence: "oracle",
        });
        if (!next.last.ok)
          out.push(
            `${item.deliveryId}: listed for the operator but not resolvable (${next.last.code})`,
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
            state.placements[d.placement].session === d.session,
        )
        .map((d) => d.question.id),
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
      const permitted = state.config.permissions[principal] || [];
      const event =
        item.kind === "choose"
          ? {
              type: "choose",
              by,
              taskId: item.taskId,
              to: item.suggestions[0] ?? permitted[0],
            }
          : {
              type: "answer",
              by,
              taskId: item.taskId,
              messageId: "oracle-answer",
              questionId: item.questionId,
              text: "oracle",
            };
      const next = reduce(state, event);
      if (!next.last.ok)
        out.push(
          `${item.taskId}: listed for ${principal} but not actionable (${next.last.code})`,
        );
    }
  }
  return out;
}

function stateViolations(state) {
  const out = [];
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
        j.choice !== task.recipient ||
        p[j.choice] < j.threshold
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
  const holders = {};
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
      ["completed", "failed"].includes(d.end?.reason) &&
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
          !safeBefore.includes(send.trail[i - 1])
        )
          out.push(`${d.id}/${send.messageId}: unsafe resend`);
      });
    }
  }
  out.push(...needsYouViolations(state));
  return out;
}

function stepViolations(prev, event, next) {
  const out = [];
  if (!next.last.ok) {
    for (const key of [
      "tasks",
      "receipts",
      "placements",
      "sessions",
      "now",
      "boot",
    ])
      if (JSON.stringify(prev[key]) !== JSON.stringify(next[key]))
        out.push(`rejected ${event.type} changed ${key}`);
    return out;
  }
  for (const [key, receipt] of Object.entries(prev.receipts))
    if (JSON.stringify(next.receipts[key]) !== JSON.stringify(receipt))
      out.push(`receipt ${key} changed`);
  let newAttempts = 0;
  for (const before of prev.tasks) {
    const after = next.tasks.find((task) => task.id === before.id);
    if (
      before.final &&
      JSON.stringify(before.final) !== JSON.stringify(after.final)
    )
      out.push(`${before.id}: terminal state changed`);
    if (before.recipient && before.recipient !== after.recipient)
      out.push(`${before.id}: recipient changed`);
    for (const d of before.deliveries) {
      const d2 = after.deliveries.find((entry) => entry.id === d.id);
      if (d.end && JSON.stringify(d.end) !== JSON.stringify(d2.end))
        out.push(`${d.id}: closed delivery reopened`);
      if (
        d.session !== null &&
        d2.session !== d.session &&
        !(event.type === "adapterResult" && event.outcome === "not_sent")
      )
        out.push(`${d.id}: session changed without definite non-delivery`);
      d.sends.forEach((send, i) => {
        const trail = d2.sends[i].trail;
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
    const placement = Core.findDelivery(next, event.deliveryId).placement;
    if (next.placements[placement].ready)
      out.push(
        `${placement}: still ready after a send; the next send could interrupt it`,
      );
  }
  if (event.type === "observe" && event.session !== undefined) {
    const p = next.placements[event.placement];
    const replaced = p.session !== prev.placements[event.placement].session;
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

function apply(state, event) {
  const next = reduce(state, event);
  const problems = [
    ...stepViolations(state, event, next),
    ...stateViolations(next),
  ];
  assert.deepEqual(problems, [], `after ${JSON.stringify(event)}`);
  return next;
}

function expectOk(state, event) {
  const next = apply(state, event);
  assert.ok(next.last.ok, `${event.type} rejected: ${next.last.message}`);
  return next;
}

function expectReject(state, event, code) {
  const next = apply(state, event);
  assert.equal(next.last.ok, false, `${event.type} should be rejected`);
  assert.equal(next.last.code, code, next.last.message);
  return next;
}

const task = (state, id = "T1") => Core.findTask(state, id);
const idle = (state, placement = "orchestrator@mbp") =>
  expectOk(state, { type: "observe", placement, ready: true });
// A participant whose adapter cannot deduplicate, like a herdr pane.
const strictConfig = structuredClone(config);
strictConfig.participants.find((p) => p.id === "orchestrator").idempotent =
  false;
strictConfig.policy.maxOpenTasks = 3;
const deliver = (state, deliveryId, outcome = "accepted") => {
  state = expectOk(state, { type: "attempt", deliveryId });
  const messageId = currentSend(Core.findDelivery(state, deliveryId)).messageId;
  return expectOk(state, {
    type: "adapterResult",
    deliveryId,
    messageId,
    outcome,
  });
};
const judge = (state, taskId, choice, p) => {
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
const submit = (state, fields) =>
  expectOk(state, { type: "submit", by: "you", ...fields });

// ---- Walkthroughs ----

test("unaddressed coding request: one judgment, delivery, result readable later", () => {
  let s = submit(initial(config), {
    messageId: "M1",
    text: "Fix reply handling in jev-a2a.",
    via: "Paseo on mba",
  });
  assert.equal(task(s).status, "routing");
  assert.deepEqual(
    commands(s).map((c) => c.type),
    ["judge"],
  );
  assert.ok(
    "none" in commands(s)[0].question.criteria,
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
  assert.equal(s.last.duplicate, true);
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
  assert.equal(Core.blockedReason(s, Core.findDelivery(s, "D1")), "held");
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
  assert.equal(Core.findDelivery(s, "D1").question, null);
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
  assert.equal(s.placements["knowledge@mini"].hold, true);
  assert.deepEqual(commands(s), []);
});

const ask = (s, by, messageId, inReplyTo, text) =>
  expectOk(s, {
    type: "update",
    by,
    taskId: "T1",
    messageId,
    inReplyTo,
    kind: "question",
    text,
  });
const answerQ = (s, messageId, questionId, text) =>
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
  assert.equal(Core.blockedReason(s, Core.findDelivery(s, "D1")), "held");
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
  assert.equal(Core.blockedReason(r, Core.findDelivery(r, "D1")), "held");
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
  const d = Core.findDelivery(s, "D1");
  assert.equal(d.sends[1].outcome, "withdrawn");
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
  assert.equal(Core.findDelivery(t, "D1").question.id, "Q2");
  assert.equal(Core.findDelivery(t, "D1").sends[1].outcome, "accepted");
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
      suggestions: task(s).routing.suggestions,
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
  ])
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
  assert.equal(Core.findDelivery(s, "D1").end.reason, "expired");
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
  assert.equal(s.last.taskId, "T1");
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
  assert.deepEqual(currentSend(Core.findDelivery(s, "D1")).trail, [
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
  assert.deepEqual(
    commands(s).map((c) => c.deliveryId),
    ["D1"],
  );
  assert.equal(
    Core.blockedReason(s, Core.findDelivery(s, "D2")),
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
  assert.deepEqual(
    commands(s).map((c) => c.deliveryId),
    ["D2"],
  );
  s = deliver(s, "D2", "unknown");
  s = idle(s);
  // An unconfirmed send holds its session: only its own retry may go next.
  assert.deepEqual(
    commands(s).map((c) => c.deliveryId),
    ["D2"],
  );
  assert.equal(Core.blockedReason(s, Core.findDelivery(s, "D3")), "in_flight");
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
  assert.deepEqual(
    commands(s).map((c) => c.deliveryId),
    ["D3"],
  );
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
  assert.deepEqual(
    commands(s).map((c) => c.deliveryId),
    ["D1"],
  );
  assert.equal(
    Core.blockedReason(s, Core.findDelivery(s, "D2")),
    "queued_behind",
  );
  s = expectReject(s, { type: "attempt", deliveryId: "D2" }, "not_eligible");
  s = deliver(s, "D1");
  s = idle(s, "knowledge@mini");
  assert.deepEqual(
    commands(s).map((c) => c.deliveryId),
    ["D2"],
  );
});

test("deadline fails the task; an unconfirmed send still blocks its session until reconciled", () => {
  let s = submit(initial(config), {
    messageId: "M1",
    text: "Long job",
    to: "orchestrator",
  });
  s = deliver(s, "D1", "unknown");
  s = expectOk(s, { type: "tick", now: 50 });
  s = submit(s, { messageId: "M2", text: "Next job", to: "orchestrator" });
  s = expectOk(s, { type: "tick", now: 100 });
  assert.equal(task(s).status, "failed");
  assert.equal(task(s, "T2").status, "queued");
  s = idle(s);
  assert.deepEqual(
    commands(s),
    [],
    "the uncertain send still holds the session",
  );
  assert.equal(
    Core.blockedReason(s, Core.findDelivery(s, "D1")),
    "closed",
    "no retry after the deadline",
  );
  assert.equal(Core.blockedReason(s, Core.findDelivery(s, "D2")), "in_flight");
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
  assert.deepEqual(
    commands(s).map((c) => c.deliveryId),
    ["D2"],
  );
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
  assert.equal(Core.findDelivery(s, "D2").end.reason, "expired");
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
  assert.equal(isOpen(Core.findDelivery(s, "D1")), false);
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
  assert.equal(task(s, "T2").routing.reason, "low_confidence");
  assert.ok(task(s, "T2").routing.suggestions.includes("incus"));

  s = submit(s, { messageId: "M3", text: "x" });
  s = expectOk(s, {
    type: "judged",
    taskId: "T3",
    choice: "incus",
    probabilities: { incus: 1 },
  });
  assert.equal(task(s, "T3").routing.reason, "invalid_judgment");
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
  assert.equal(task(s, "T4").routing.reason, "routing_unavailable");

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
  assert.equal(Core.findDelivery(s, "D1").session, "orchestrator@mbp#2");
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
    Core.blockedReason(s, Core.findDelivery(s, "D1")),
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
  expectReject(s, { type: "nonsense" }, "unknown_event");
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
  assert.throws(() => initial(), /configuration object is required/);
  assert.throws(
    () => initial({ ...config, permissions: { you: ["ghost"] } }),
    /unknown participant ghost/,
  );
  assert.throws(
    () => initial({ ...config, principals: { you: "admin" } }),
    /unknown role/,
  );
  const withPolicy = (policy) => ({
    ...config,
    policy: { ...config.policy, ...policy },
  });
  const withParticipant = (patch) => ({
    ...config,
    participants: [
      { ...config.participants[0], ...patch },
      ...config.participants.slice(1),
    ],
  });
  for (const [broken, message] of [
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
  ])
    assert.throws(() => initial(broken), message);
  const other = {
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
  assert.deepEqual(Object.keys(commands(s)[0].question.criteria), [
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
  assert.equal(task(s, "T2").deliveries[0].placement, "editor@lap");
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
  const stricter = structuredClone(config);
  stricter.policy.threshold = 0.95;
  stricter.participants.push({
    id: "reviewer",
    name: "Reviewer",
    kind: "agent",
    hosts: ["mba"],
    idempotent: true,
    responsibility: "Reviews drafts.",
  });
  stricter.permissions.you.push("reviewer");
  s = expectOk(s, { type: "configured", config: stricter });
  assert.equal(s.config.policy.threshold, 0.95);
  assert.ok(s.placements["reviewer@mba"]);
  assert.equal(s.placements["orchestrator@mbp"].ready, false, "kept");
  assert.equal(task(s).status, "working", "earlier dispatch stands");
  s = submit(s, { messageId: "M2", text: "Check the dotfiles again." });
  s = judge(s, "T2", "orchestrator", 0.92);
  assert.equal(task(s, "T2").status, "needs_recipient", "new rule applies");
  assert.ok(
    Object.keys(Core.judgmentQuestion(s, task(s, "T2")).criteria).includes(
      "reviewer",
    ),
  );
  // Removing a participant keeps its placement and its open delivery, and
  // drops it from pending suggestions.
  const smaller = structuredClone(config);
  smaller.participants = smaller.participants.filter(
    (p) => p.id !== "orchestrator",
  );
  smaller.permissions.you = ["knowledge", "environment", "incus"];
  delete smaller.permissions.orchestrator;
  s = expectOk(s, { type: "configured", config: smaller });
  assert.ok(s.placements["orchestrator@mbp"]);
  assert.equal(task(s).status, "working");
  assert.ok(!task(s, "T2").routing.suggestions.includes("orchestrator"));
  assert.deepEqual(Core.commands(s).filter((c) => c.type === "deliver"), []);
  // An invalid configuration is refused and changes nothing.
  const broken = structuredClone(config);
  broken.policy = { threshold: 2 };
  s = expectReject(s, { type: "configured", config: broken }, "invalid");
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
  const d = Core.findDelivery(s, "D1");
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
    Core.blockedReason(s, Core.findDelivery(s, "D1")),
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
  assert.equal(task(s, "T2").routing.reason, "low_confidence");
  assert.deepEqual(task(s, "T2").routing.suggestions[0], "orchestrator");
  // Probabilities must sum to one.
  s = submit(s, { messageId: "M3", text: "c" });
  const options = Object.keys(Core.judgmentQuestion(s, task(s, "T3")).criteria);
  s = expectOk(s, {
    type: "judged",
    taskId: "T3",
    choice: "orchestrator",
    probabilities: Object.fromEntries(options.map((id) => [id, 0.5])),
  });
  assert.equal(task(s, "T3").routing.reason, "invalid_judgment");
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
  assert.equal(s.placements["knowledge@mini"].ready, false);
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
  ])
    assert.match(Core.A2A_STATE[name], /^TASK_STATE_/);
});

// ---- Random sequences: every event, every step, checked by the oracle ----

function rng(seed) {
  return () => {
    seed = (seed + 0x6d2b79f5) | 0;
    let t = Math.imul(seed ^ (seed >>> 15), 1 | seed);
    t = (t + Math.imul(t ^ (t >>> 7), 61 | t)) ^ t;
    return ((t ^ (t >>> 14)) >>> 0) / 4294967296;
  };
}

function randomEvent(s, r) {
  const pick = (list) => list[Math.floor(r() * list.length)];
  const deliveries = s.tasks.flatMap((t) => t.deliveries);
  const taskId = s.tasks.length ? pick(s.tasks).id : "T1";
  const sessions = Object.keys(s.sessions);
  const sends = deliveries.flatMap((d) => d.sends.map((x) => x.messageId));
  const questions = deliveries
    .filter((d) => d.question)
    .map((d) => d.question.id);
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
    case "attempt3":
      return {
        type: "attempt",
        deliveryId: deliveries.length ? pick(deliveries).id : "D1",
      };
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
      return {
        type: "update",
        by,
        taskId: d?.taskId ?? taskId,
        messageId: `R${Math.floor(r() * 12)}`,
        inReplyTo:
          sends.length && r() < 0.9
            ? d && r() < 0.7
              ? currentSend(d).messageId
              : pick(sends)
            : "M404",
        kind: pick(["working", "question", "question", "completed", "failed"]),
        text: pick(["x", "y"]),
      };
    }
    case "answer":
      return {
        type: "answer",
        by: pick(["you", ORCH]),
        taskId,
        messageId: `A${Math.floor(r() * 6)}`,
        questionId: questions.length && r() < 0.8 ? pick(questions) : "R0",
        text: "ok",
      };
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
      return r() < 0.1 ? { type: "nonsense" } : { type: "restart" };
    default:
      return { type: "tick", now: s.now + Math.floor(r() * 40) };
  }
}

test("random event sequences never violate the contract", () => {
  const reached = new Set();
  for (let seed = 1; seed <= 400; seed++) {
    const r = rng(seed);
    // Half the runs use a participant whose adapter cannot deduplicate.
    let s = initial(seed % 2 ? config : strictConfig);
    for (let step = 0; step < 90; step++) {
      const event = randomEvent(s, r);
      s = apply(s, event);
      for (const t of s.tasks) reached.add(t.status);
      for (const principal of ["you", ORCH_ID, "operator"])
        for (const item of Core.needsYou(s, principal))
          reached.add(
            `needs:${item.kind}${item.reason ? ":" + item.reason : ""}`,
          );
      if (s.last.ok) reached.add(`ok:${event.type}`);
      else {
        reached.add(
          `reject:${s.last.code}${s.last.code === "not_eligible" ? " " + s.last.message.split(": ").pop() : ""}`,
        );
        if (
          s.last.message.endsWith("held.") &&
          Core.findDelivery(s, event.deliveryId).session !== null
        )
          reached.add("held pinned");
      }
      for (const d of Core.allDeliveries(s))
        if (d.sends.some((send) => send.outcome === "withdrawn"))
          reached.add("withdrawn");
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
