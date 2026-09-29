// Executable contract for router-core.js. Run: node --test research/
const test = require("node:test");
const assert = require("node:assert/strict");
const Core = require("./router-core.js");

const {
  initial,
  reduce,
  commands,
  currentSend,
  isOpen,
  inFlight,
  blockedReason,
} = Core;
const ORCH = "orchestrator@mbp#1";
const KNOW = "knowledge@mini#1";
const LAB = "incus@lab01#1";

// ---- Oracle: invariants checked independently of the implementation ----

function stateViolations(state) {
  const out = [];
  const { policy, permissions } = state.config;
  const deliveries = state.tasks.flatMap((task) => task.deliveries);
  for (const task of state.tasks) {
    const receipt = state.receipts[`${task.source}/${task.messageId}`];
    if (receipt?.taskId !== task.id)
      out.push(`${task.id}: missing request receipt`);
    if (task.status !== Core.status(task)) out.push(`${task.id}: stale status`);
    if (
      task.to !== null &&
      (task.judgments.length || (task.recipient && task.chosenBy !== "address"))
    )
      out.push(`${task.id}: addressed request used a judgment`);
    if (task.judgments.length > policy.maxJudgments)
      out.push(`${task.id}: judgment budget exceeded`);
    if (task.recipient && !permissions[task.source]?.includes(task.recipient))
      out.push(`${task.id}: unauthorized recipient`);
    if (task.chosenBy === "judgment") {
      const last = task.judgments.at(-1);
      if (
        !last?.valid ||
        last.choice !== task.recipient ||
        last.probabilities[last.choice] < policy.threshold
      )
        out.push(`${task.id}: selected without a confident valid judgment`);
    }
    if (
      task.status === "completed" &&
      !task.deliveries.every(
        (d) => d.end?.reason === "completed" && d.end.by === d.session,
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
      task.deliveries.some((d) => isOpen(d) && d.session === null)
    )
      out.push(`${task.id}: terminal task still has sendable work`);
  }
  const unconfirmed = {};
  for (const d of deliveries) {
    if (inFlight(d)) {
      if (unconfirmed[d.placement])
        out.push(
          `${d.placement}: two unconfirmed sends (${unconfirmed[d.placement]}, ${d.id})`,
        );
      unconfirmed[d.placement] = d.id;
    }
    if (d.session !== null) {
      const owner = state.sessions[d.session];
      if (owner?.participant !== d.participant || owner.host !== d.host)
        out.push(`${d.id}: pinned to a foreign session`);
    }
    if (d.question && !isOpen(d))
      out.push(`${d.id}: question on a closed delivery`);
    if (
      ["completed", "failed"].includes(d.end?.reason) &&
      d.end.by !== d.session
    )
      out.push(`${d.id}: result from another session`);
    // A message is sent again only after a definite not_sent, or after
    // unknown through an adapter that deduplicates by the same message key.
    const idempotent = state.config.participants.find(
      (p) => p.id === d.participant,
    ).idempotent;
    const safeBefore = idempotent ? ["not_sent", "unknown"] : ["not_sent"];
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
            blockedReason(prev, d) !== null
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
const strictConfig = structuredClone(Core.defaultConfig);
strictConfig.participants.find((p) => p.id === "orchestrator").idempotent =
  false;
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
  let s = submit(initial(), {
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
  let s = submit(initial(), {
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

test("addressed service request fans out per host with zero judgments", () => {
  let s = submit(initial(), {
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
  assert.equal(task(s).status, "failed");
  expectReject(
    initial(),
    { type: "submit", by: "you", messageId: "M1", text: "x", hosts: ["mba"] },
    "invalid",
  );
  expectReject(
    initial(),
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

test("orchestrator may request a VM; unready hosts queue; other agents are forbidden", () => {
  let s = expectOk(initial(), {
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
    initial(),
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
    initial(),
    { type: "submit", by: "mallory", messageId: "M1", text: "hi" },
    "unauthenticated",
  );
  expectReject(
    initial(),
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
  let s = submit(initial(), {
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
  let stuck = submit(initial(), {
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
  let s = submit(initial(), {
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
  let s = initial();
  for (const id of ["M1", "M2", "M3"])
    s = submit(s, { messageId: id, text: `Job ${id}`, to: "orchestrator" });
  assert.deepEqual(
    commands(s).map((c) => c.deliveryId),
    ["D1"],
  );
  assert.equal(blockedReason(s, Core.findDelivery(s, "D2")), "queued_behind");
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
  assert.equal(blockedReason(s, Core.findDelivery(s, "D3")), "in_flight");
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

test("deadline fails the task; an unconfirmed send still blocks its session until reconciled", () => {
  let s = submit(initial(), {
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
    blockedReason(s, Core.findDelivery(s, "D1")),
    "closed",
    "no retry after the deadline",
  );
  assert.equal(blockedReason(s, Core.findDelivery(s, "D2")), "in_flight");
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
  let s = submit(initial(), {
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
  let s = submit(initial(), { messageId: "M1", text: "Handle this." });
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

  // A caller with no permitted recipients never reaches Jev.
  s = expectOk(s, { type: "submit", by: KNOW, messageId: "K1", text: "help" });
  assert.equal(task(s, "T5").routing.reason, "no_permitted_participants");
  assert.equal(commands(s).filter((c) => c.type === "judge").length, 0);
});

test("not_sent requeues safely; replaced sessions get new work, old pins keep theirs", () => {
  let s = submit(initial(), {
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
    blockedReason(s, Core.findDelivery(s, "D1")),
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
  let s = expectOk(initial(), {
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
  const s = initial();
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

test("every status maps to an A2A v1.0 task state", () => {
  for (const name of [
    "routing",
    "queued",
    "delivering",
    "working",
    "uncertain",
    "needs_recipient",
    "needs_answer",
    ...Core.TERMINAL,
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
        messageId: `M${Math.floor(r() * 8)}`,
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
      return { type: "cancel", by: pick(["you", ORCH]), taskId };
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
        : { type: "observe", placement, ready: r() < 0.7 };
    }
    case "restart":
      return { type: "restart" };
    default:
      return { type: "tick", now: s.now + Math.floor(r() * 40) };
  }
}

test("random event sequences never violate the contract", () => {
  const reached = new Set();
  for (let seed = 1; seed <= 400; seed++) {
    const r = rng(seed);
    // Half the runs use a participant whose adapter cannot deduplicate.
    let s = initial(seed % 2 ? Core.defaultConfig : strictConfig);
    for (let step = 0; step < 90; step++) {
      const event = randomEvent(s, r);
      s = apply(s, event);
      for (const t of s.tasks) reached.add(t.status);
      if (s.last.ok) reached.add(`ok:${event.type}`);
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
    "resend after unknown",
  ])
    assert.ok(reached.has(expected), `random run never reached ${expected}`);
});
