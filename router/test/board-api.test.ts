// The board as the Paseo plugin reads it: the summary and its revs, one
// task, and the actions as the events the page's forms make.
import test from "node:test";
import assert from "node:assert/strict";
import {
  actionEvent,
  boardModel,
  boardState,
  messageTimes,
} from "../src/board.ts";
import {
  actedOn,
  apiEvent,
  appActor,
  fullTask,
  summarize,
} from "../src/board-api.ts";
import {
  answeredJournal,
  config,
  extend,
  journal,
  NOW,
  sampleJournal,
} from "../src/board-fixture.ts";
import type { Entry } from "../src/journal.ts";
import type { Outcome } from "../src/types.ts";

const actor = appActor(config);
const roles = config.principals ?? {};
const modelOf = (entries: Entry[], at = NOW) =>
  boardModel(
    boardState(config, entries, at),
    config,
    at,
    messageTimes(entries),
    actor,
  );

test("the app acts as the CLI here does without --as: the first principal of each role", () => {
  assert.deepEqual(actor, { login: "paseo", principals: ["you", "operator"] });
  assert.deepEqual(
    appActor({
      ...config,
      principals: { ops: "operator", me: "requester", other: "requester" },
    }),
    { login: "paseo", principals: ["me", "ops"] },
  );
  assert.equal(appActor({ ...config, principals: {} }), null);
});

test("the summary heads each task with what its row shows", () => {
  const summary = summarize(modelOf(journal));
  assert.equal(summary.at, new Date(NOW).toISOString());
  assert.deepEqual(
    summary.actor?.principals.map((p) => p.principal),
    ["you", "operator"],
  );
  assert.deepEqual(
    summary.needsYou[0]?.items.map((item) => item.kind),
    ["choose", "answer"],
  );
  assert.deepEqual(summary.placements[2], {
    key: "environment@mbp",
    participant: "environment",
    host: "mbp",
    ready: true,
    hold: true,
  });
  assert.deepEqual(
    summary.open.map((t) => t.id),
    ["T4", "T2", "T1"],
  );
  assert.deepEqual(
    summary.finished.map((t) => t.id),
    ["T3"],
  );
  const head = (id: string) =>
    [...summary.open, ...summary.finished].find((t) => t.id === id);
  // Routed with a low confidence: the reason and Jev's pick.
  assert.equal(head("T1")?.reason, "low_confidence");
  assert.deepEqual(head("T1")?.judgment, {
    choice: "orchestrator",
    probability: 0.6,
  });
  assert.equal(head("T1")?.latest, null);
  // Asked a second question after its first answer: the open question,
  // and no answer, as the page shows it.
  assert.equal(head("T2")?.question, "Force push?");
  assert.equal(head("T2")?.sentAt, "2026-09-30T09:10:00.000Z");
  assert.deepEqual(head("T2")?.latest, {
    id: "D1",
    placement: "orchestrator@mbp",
    sendKind: "answer",
    outcome: "accepted",
    waits: null,
    update: { kind: "question", text: "Force push?" },
    answered: null,
  });
  // A delivery that waits says why, as its row on the page does.
  const waiting = summarize(modelOf(sampleJournal)).open.find(
    (t) => t.id === "T1",
  );
  assert.deepEqual(
    [waiting?.latest?.placement, waiting?.latest?.waits],
    ["orchestrator@mbp", { reason: "not_ready", behind: null }],
  );
  // Before the session replied to the first answer, the answer shows.
  const answered = summarize(
    modelOf(answeredJournal, Date.parse("2026-09-30T09:16:00Z")),
  ).open.find((t) => t.id === "T2");
  assert.equal(answered?.question, null);
  assert.deepEqual(answered?.latest?.answered, {
    text: "main",
    at: "2026-09-30T09:16:00.000Z",
  });
  assert.equal(head("T3")?.final?.status, "completed");
  assert.equal(head("T4")?.stale, null);
});

test("the summary's rev changes with the board, not the clock, and a task's with the task", () => {
  const before = summarize(modelOf(journal));
  const later = summarize(modelOf(journal, NOW + 1000));
  assert.notEqual(later.at, before.at);
  assert.equal(later.rev, before.rev);
  // T1 is chosen: the board and T1 change, T4 does not.
  const chosen = summarize(
    modelOf(
      extend({ type: "choose", by: "you", taskId: "T1", to: "orchestrator" }),
    ),
  );
  assert.notEqual(chosen.rev, before.rev);
  const revOf = (s: typeof before, id: string) =>
    [...s.open, ...s.finished].find((t) => t.id === id)?.rev;
  assert.notEqual(revOf(chosen, "T1"), revOf(before, "T1"));
  assert.equal(revOf(chosen, "T4"), revOf(before, "T4"));
});

test("a task in full, with its own messages' times and the rev its head carries", () => {
  const model = modelOf(journal);
  const full = fullTask(model, "T4");
  assert.ok(full);
  assert.deepEqual(
    full.task,
    model.open.find((t) => t.id === "T4"),
  );
  assert.deepEqual(full.times, {
    M4: "2026-09-30T09:40:00.000Z",
    W2: "2026-09-30T09:44:00.000Z",
  });
  const head = summarize(model).open.find((t) => t.id === "T4");
  assert.equal(full.rev, head?.rev);
  assert.equal(fullTask(model, "T9"), null);
});

test("an action is the event the page's form makes, with the app's principals", () => {
  assert.ok(actor);
  const form = (body: string) =>
    actionEvent(new URLSearchParams(body), actor, roles);
  assert.deepEqual(
    apiEvent(
      { action: "choose", taskId: "T1", recipient: "knowledge" },
      actor,
      roles,
    ),
    form("action=choose&task=T1&to=knowledge"),
  );
  assert.deepEqual(
    apiEvent({ action: "cancel", taskId: "T1" }, actor, roles),
    form("action=cancel&task=T1"),
  );
  assert.deepEqual(
    apiEvent({ action: "hold", placement: "environment@mini" }, actor, roles),
    form("action=hold&placement=environment%40mini&hold=1"),
  );
  assert.deepEqual(
    apiEvent({ action: "release", placement: "environment@mbp" }, actor, roles),
    form("action=hold&placement=environment%40mbp"),
  );
  // An answer and a request get a new message id each.
  const answer = apiEvent(
    {
      action: "answer",
      taskId: "T2",
      deliveryId: "D1",
      questionId: "Q2",
      text: " no ",
    },
    actor,
    roles,
  );
  assert.ok(answer.ok && answer.event.type === "answer");
  assert.match(answer.event.messageId, /^m-/);
  assert.deepEqual(
    { ...answer.event, messageId: "" },
    {
      type: "answer",
      by: "you",
      taskId: "T2",
      messageId: "",
      questionId: "Q2",
      deliveryId: "D1",
      text: "no",
    },
  );
  const submit = apiEvent(
    { action: "submit", text: " Tidy the notes ", to: "knowledge" },
    actor,
    roles,
  );
  assert.ok(submit.ok && submit.event.type === "submit");
  assert.match(submit.event.messageId, /^m-/);
  assert.deepEqual(
    { ...submit.event, messageId: "" },
    {
      type: "submit",
      by: "you",
      messageId: "",
      text: "Tidy the notes",
      to: "knowledge",
      hosts: null,
    },
  );
  // A placement row names its host as well.
  const placed = apiEvent(
    { action: "submit", text: "Tidy", to: "knowledge", host: "mini" },
    actor,
    roles,
  );
  assert.ok(placed.ok && placed.event.type === "submit");
  assert.deepEqual(placed.event.hosts, ["mini"]);
  const routed = apiEvent({ action: "submit", text: "Tidy" }, actor, roles);
  assert.ok(routed.ok && routed.event.type === "submit");
  assert.equal(routed.event.to, null);
  // The app's own message id, kept, so a retry is a repeat.
  for (const action of [
    { action: "submit", text: "Tidy", messageId: "app-1" },
    {
      action: "answer",
      taskId: "T2",
      deliveryId: "D1",
      questionId: "Q2",
      text: "no",
      messageId: "app-1",
    },
  ]) {
    const kept = apiEvent(action, actor, roles);
    assert.ok(kept.ok && "messageId" in kept.event);
    assert.equal(kept.event.messageId, "app-1");
  }
  // A resolve as the operator, with evidence that says where it came from
  // when the app gives none.
  assert.deepEqual(
    apiEvent(
      {
        action: "resolve",
        deliveryId: "D3",
        messageId: "M4",
        outcome: "finished",
      },
      actor,
      roles,
    ),
    {
      ok: true,
      event: {
        type: "resolve",
        by: "operator",
        deliveryId: "D3",
        messageId: "M4",
        outcome: "finished",
        evidence: "Marked finished in the Paseo app.",
      },
    },
  );
  const resolve = apiEvent(
    {
      action: "resolve",
      deliveryId: "D3",
      messageId: "M4",
      outcome: "not_sent",
      evidence: "The session never saw it",
    },
    actor,
    roles,
  );
  assert.ok(resolve.ok && resolve.event.type === "resolve");
  assert.equal(resolve.event.evidence, "The session never saw it");
});

test("an action the router cannot take is refused with the reason", () => {
  assert.ok(actor);
  const refused = (body: unknown) => {
    const result = apiEvent(body, actor, roles);
    return result.ok ? null : result.message;
  };
  assert.equal(refused(null), "A JSON object.");
  assert.equal(refused(["submit"]), "A JSON object.");
  assert.equal(refused({ action: "submit", text: "  " }), "Missing text.");
  assert.equal(refused({ action: "choose", taskId: "T1" }), "Missing to.");
  assert.equal(
    refused({ action: "resolve", deliveryId: "D3", outcome: "finished" }),
    "Missing message.",
  );
  assert.ok(refused({ action: "launch" }));
  // Without a requester principal, no request.
  assert.equal(
    apiEvent(
      { action: "submit", text: "Tidy" },
      { login: "paseo", principals: ["operator"] },
      roles,
    ).ok,
    false,
  );
});

test("an action's task: the one the router's outcome names, the one the action names, or the one holding the delivery", () => {
  const model = modelOf(journal);
  const done: Outcome = { ok: true, message: "done" };
  // A request: the task the router recorded it as, even where another
  // sender's task shares its message id.
  assert.equal(
    actedOn(
      { type: "submit", by: "you", messageId: "M4", text: "x", to: null },
      { ...done, taskId: "T5" },
      model,
    ),
    "T5",
  );
  assert.equal(
    actedOn({ type: "cancel", by: "you", taskId: "T2" }, done, model),
    "T2",
  );
  assert.equal(
    actedOn(
      {
        type: "resolve",
        by: "operator",
        deliveryId: "D3",
        messageId: "M4",
        outcome: "finished",
        evidence: "seen",
      },
      done,
      model,
    ),
    "T4",
  );
  assert.equal(
    actedOn(
      { type: "observe", placement: "environment@mbp", hold: true },
      done,
      model,
    ),
    null,
  );
});
