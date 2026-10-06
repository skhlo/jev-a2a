// The app's words for the board (client/format.ts): the list's groups and
// rows, the detail's lines, and what the viewer may do, read from what
// serve's board API returns for the router's own fixtures.
import test from "node:test";
import assert from "node:assert/strict";
import { fullTask, summarize } from "../../src/board-api.ts";
import * as boardParts from "../../src/board-parts.ts";
import {
  boardModel,
  boardState,
  identify,
  messageTimes,
} from "../../src/board.ts";
import {
  config,
  NOW,
  replacedJournal,
  sampleJournal,
} from "../../src/board-fixture.ts";
import type { Entry } from "../../src/journal.ts";
import type { FullTask, Summary } from "../shared/rpc.ts";
import {
  conversation,
  countdown,
  firstLine,
  deliveryLine,
  deliveryState,
  judgmentLines,
  metaLine,
  rowDot,
  rowLine,
  span,
  time,
  verdict,
  viewerOf,
  type Part,
  type Row,
} from "../client/format.ts";

// The board as serve's API gives it to the fixture's operator login.
function board(entries: Entry[]) {
  const actor = identify(
    { "tailscale-user-login": "me@example.com" },
    config.serve.identities,
  );
  const model = boardModel(
    boardState(config, entries, NOW),
    config,
    NOW,
    messageTimes(entries),
    actor,
  );
  const summary: Summary = summarize(model);
  const task = (id: string): FullTask => {
    const full = fullTask(model, id);
    assert.ok(full, `${id} is on the board`);
    return full;
  };
  return { summary, task };
}

const words = (parts: Part[]): string =>
  parts.map((p) => (p.tone ? `${p.text} [${p.tone}]` : p.text)).join(" · ");
const lines = (rows: Row[]): string[] =>
  rows.map((r) => `${rowDot(r) ?? "-"} ${words(rowLine(r, NOW))}`);

test("client: the list groups the viewer's tasks and each row reads as the board's", () => {
  const { summary } = board(sampleJournal);
  const viewer = viewerOf(summary);
  assert.deepEqual(lines(viewer.needs), [
    "warn T2 · orchestrator · Force push?",
    "warn T6 · no recipient · low confidence · Jev environment 0.62",
  ]);
  assert.deepEqual(lines(viewer.flight), [
    "- T4 · knowledge · Reading the notes · 55m left",
    "- T1 · orchestrator · request pending [muted] · 17m left",
  ]);
  assert.deepEqual(lines(viewer.done), [
    "- T5 · incus · 1 of 1 delivery",
    "- T3 · orchestrator · 1 of 1 delivery",
  ]);
  // The forms are the viewer's: it signs both items as their principal.
  assert.deepEqual(
    viewer.items.map((it) => [it.item.kind, it.mine, it.act]),
    [
      ["answer", true, true],
      ["choose", true, true],
    ],
  );
  assert.equal(viewer.held("orchestrator@mbp"), false);
  assert.equal(viewer.held("nobody@mbp"), null);
});

test("client: an item of a principal the viewer lacks waits on it; one whose task left the board keeps a row", () => {
  const { summary } = board(replacedJournal);
  const [requester, operator] = summary.needsYou;
  assert.ok(requester && operator);
  const resolve = operator.items.find((it) => it.kind === "resolve");
  assert.ok(resolve, "the replaced session leaves a resolve item");
  const other: Summary = {
    ...summary,
    needsYou: [
      { ...requester, principal: "alice", items: requester.items },
      {
        ...operator,
        items: [...operator.items, { ...resolve, taskId: "T99" }],
      },
    ],
  };
  const viewer = viewerOf(other);
  const t2 = viewer.flight.find((r) => r.id === "T2");
  assert.ok(t2, "alice's question leaves T2 in flight");
  assert.match(words(rowLine(t2, NOW)), /^T2 · waits on alice · /);
  assert.equal(rowDot(t2), null);
  assert.ok(viewer.items.every((it) => it.mine === (it.principal !== "alice")));
  assert.ok(viewer.items.every((it) => it.act === it.mine));
  const orphan = viewer.needs.find((r) => r.id === "T99");
  assert.ok(orphan);
  assert.equal(orphan.head, null);
  assert.equal(
    words(rowLine(orphan, NOW)),
    `T99 · ${resolve.deliveryId} · send ${resolve.messageId}`,
  );
});

test("client: only the sender cancels, and only an open task", () => {
  const viewer = viewerOf(board(sampleJournal).summary);
  assert.equal(viewer.mayCancel("you/M1", true), true);
  assert.equal(viewer.mayCancel("you/M1", false), false);
  assert.equal(viewer.mayCancel("orchestrator/M9", true), false);
  const nobody = viewerOf({ ...board(sampleJournal).summary, actor: null });
  assert.equal(nobody.mayCancel("you/M1", true), false);
  assert.ok(nobody.items.every((it) => it.mine && !it.act));
});

test("client: the detail's meta line, conversation, deliveries and Jev's lines", () => {
  const { task } = board(sampleJournal);
  const t4 = task("T4");
  assert.equal(
    words(metaLine(t4, NOW)),
    "T4 · to knowledge · chosen by Jev · from you at 09:40Z · 55m left",
  );
  assert.deepEqual(
    conversation(t4).map((s) => `${s.who ?? "router"}: ${s.text}`),
    [
      "you · request · 09:40Z: Summarize the review pipeline notes",
      "knowledge@mini · working · 09:44Z: Reading the notes",
    ],
  );
  const [d] = t4.task.deliveries;
  assert.ok(d);
  assert.deepEqual(deliveryState(d), { text: "working" });
  assert.equal(
    deliveryLine(d, t4.times),
    "D3 · request M4 · accepted · session K1 · last reply 09:44Z",
  );
  const t6 = task("T6");
  assert.deepEqual(
    conversation(t6).map((s) => s.who ?? "router"),
    ["you · request · 09:44Z", "router"],
  );
  const [j] = t6.task.judgments;
  assert.ok(j);
  assert.deepEqual(judgmentLines(j), {
    verdict: "environment at 0.62 is under the threshold 0.90",
    table:
      "environment 0.62, orchestrator 0.33, knowledge 0.02, none 0.02, incus 0.01 · jev-1.13.0",
  });
  assert.equal(
    words(metaLine(task("T3"), NOW)),
    "T3 · to orchestrator · named on the request · from you at 09:15Z · 1 of 1 delivery",
  );
});

test("client: a countdown past its deadline reads overdue in the danger role, and a verdict names who ended it", () => {
  assert.deepEqual(countdown("2026-09-30T09:30:00Z", NOW), {
    text: "overdue 15m",
    tone: "danger",
  });
  assert.deepEqual(countdown("2026-09-30T11:50:00Z", NOW), {
    text: "2h 05m left",
  });
  assert.equal(
    words(
      verdict({
        status: "canceled",
        reason: "sender",
        completed: 0,
        of: 2,
        by: "you",
      }),
    ),
    "0 of 2 deliveries · sender · by you",
  );
});

test("client: its copies of the board's formats read as the board's own", () => {
  // Paseo builds the plugin from plugin/ alone, so the app repeats these.
  // Each unit, and each edge between two.
  for (const ms of [
    0,
    59_999,
    60_000,
    14 * 60_000,
    3600_000 - 1,
    3600_000,
    2 * 3600_000 + 5 * 60_000,
    86400_000 - 1,
    86400_000,
    3 * 86400_000,
    -90_000,
  ])
    assert.equal(span(ms), boardParts.span(ms), `span(${ms})`);
  for (const iso of ["2026-09-30T09:05:00Z", null, undefined, "not a time"])
    assert.equal(time(iso), boardParts.time(iso), `time(${iso})`);
  for (const text of ["One line", "\n  First\r\nSecond", "   ", ""])
    assert.equal(
      firstLine(text),
      boardParts.headline(text),
      JSON.stringify(text),
    );
});
