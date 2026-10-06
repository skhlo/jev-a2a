// The app's words for the board (client/format.ts): the list's groups and
// rows, the detail's lines, and what the viewer may do, read from what
// serve's board API returns for the router's own fixtures, and held to the
// HTML board's page and formats for the same records.
import test from "node:test";
import assert from "node:assert/strict";
import { fullTask, summarize } from "../../src/board-api.ts";
import { renderBoard } from "../../src/board-page.ts";
import * as boardParts from "../../src/board-parts.ts";
import {
  boardModel,
  boardState,
  identify,
  messageTimes,
} from "../../src/board.ts";
import {
  answeredJournal,
  attemptingJournal,
  config,
  deliveredJournal,
  NOW,
  replacedJournal,
  sampleJournal,
  viaJournal,
} from "../../src/board-fixture.ts";
import type { Entry } from "../../src/journal.ts";
import type { FullTask, Summary } from "../shared/rpc.ts";
import {
  age,
  conversation,
  count,
  countdown,
  deliveryLine,
  deliveryState,
  firstLine,
  judgmentLines,
  label,
  metaLine,
  resolveWhy,
  rowDot,
  rowLine,
  rowSub,
  shortSession,
  span,
  statusTone,
  time,
  verdict,
  viewerOf,
  waitWords,
  type ListRow,
  type Part,
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
  const page = (task: string | null = null): string =>
    renderBoard(model, { task });
  const task = (id: string): FullTask => {
    const full = fullTask(model, id);
    assert.ok(full, `${id} is on the board`);
    return full;
  };
  return { summary, task, page };
}

// Text as the page shows it: tags dropped, entities read.
const plain = (html: string): string =>
  html
    .replace(/<[^>]+>/g, "")
    .replace(/&lt;/g, "<")
    .replace(/&gt;/g, ">")
    .replace(/&quot;/g, '"')
    .replace(/&amp;/g, "&");

const words = (parts: Part[]): string =>
  parts.map((p) => (p.tone ? `${p.text} [${p.tone}]` : p.text)).join(" · ");
const lines = (rows: ListRow[]): string[] =>
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
    "- T1 · orchestrator · waits for orchestrator@mbp to be ready · 17m left",
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
  assert.equal(viewer.onHold("orchestrator@mbp"), false);
  assert.equal(viewer.onHold("environment@mbp"), true);
  assert.equal(viewer.onHold("nobody@mbp"), null);
  assert.equal(viewer.requester, "you");
});

test("client: each row's reading is the HTML board's row for the same record", () => {
  let rows = 0;
  for (const entries of [
    sampleJournal,
    answeredJournal,
    deliveredJournal,
    attemptingJournal,
    replacedJournal,
    viaJournal,
  ]) {
    const { summary, page } = board(entries);
    const html = page();
    const viewer = viewerOf(summary);
    for (const row of [...viewer.needs, ...viewer.flight, ...viewer.done]) {
      const at = html.indexOf(`data-task="${row.id}"`);
      assert.ok(at >= 0, `${row.id} is a row on the board`);
      const sub =
        /<span class="sub">([\s\S]*?)<\/span><(?:span class="route"|\/div>)/.exec(
          html.slice(at),
        );
      assert.ok(sub?.[1] !== undefined, `${row.id} has a sub line`);
      const app = row.head
        ? [
            ...row.items
              .filter((it) => !it.mine)
              .map((it) => `waits on ${it.principal}`),
            ...rowSub(row.head, NOW).map((p) => p.text),
          ]
        : rowLine(row, NOW)
            .slice(1)
            .map((p) => p.text);
      assert.equal(app.join(" · "), plain(sub[1]), row.id);
      rows += 1;
    }
  }
  assert.ok(rows >= 25, `${rows} rows compared`);
});

test("client: the detail's delivery states, chosen-by words and resolve sentences are the HTML board's", () => {
  let states = 0;
  for (const entries of [sampleJournal, attemptingJournal, replacedJournal]) {
    const { summary, task, page } = board(entries);
    for (const head of [...summary.open, ...summary.finished]) {
      const full = task(head.id);
      const html = page(head.id);
      const text = plain(html);
      if (full.task.chosenBy)
        assert.ok(text.includes(metaLine(full, NOW)[2]?.text ?? "?"), head.id);
      full.task.deliveries.forEach((d, di) => {
        if (d.end) return;
        const tr = new RegExp(
          `<tr data-path="[^"]*\\.deliveries\\[${di}\\]">([\\s\\S]*?)</tr>`,
        ).exec(html);
        const cell = tr?.[1]?.split("<td")[4];
        assert.ok(cell, `${d.id} has a state cell`);
        assert.equal(deliveryState(d, false).text, plain(`<td${cell}`), d.id);
        states += 1;
      });
    }
    const viewer = viewerOf(summary);
    for (const it of viewer.items) {
      if (it.item.kind !== "resolve") continue;
      const { deliveryId, reason, taskId } = it.item;
      const d = task(taskId).task.deliveries.find((x) => x.id === deliveryId);
      assert.ok(
        plain(page(taskId)).includes(
          resolveWhy(reason, d?.send.outcome ?? null),
        ),
        `${deliveryId}'s resolve sentence`,
      );
    }
  }
  assert.ok(states >= 4, `${states} delivery states compared`);
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
  // alice's question is no warning to the viewer, as on the board.
  const asked = requester.items.find((it) => it.kind === "answer");
  assert.ok(asked && t2.head);
  assert.equal(viewer.asksViewer(asked.deliveryId), false);
  assert.equal(viewerOf(summary).asksViewer(asked.deliveryId), true);
  assert.equal(statusTone(t2.head.status, false), "muted");
  assert.equal(statusTone(t2.head.status, true), "warn");
  assert.ok(viewer.items.every((it) => it.mine === (it.principal !== "alice")));
  assert.ok(viewer.items.every((it) => it.act === it.mine));
  const orphan = viewer.needs.find((r) => r.id === "T99");
  assert.ok(orphan);
  assert.equal(orphan.head, null);
  assert.equal(
    words(rowLine(orphan, NOW)),
    `T99 · ${resolve.deliveryId} · send ${resolve.messageId} · session replaced`,
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
      "you · request · 09:40Z · accepted: Summarize the review pipeline notes",
      "knowledge@mini · working · 09:44Z: Reading the notes",
    ],
  );
  const [d] = t4.task.deliveries;
  assert.ok(d);
  assert.deepEqual(deliveryState(d, false), { text: "working" });
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
    verdict: "environment at 0.62 is under the threshold 0.9",
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
  for (const iso of ["2026-09-30T09:05:00Z", "2026-09-28T09:45:00Z", null])
    assert.equal(
      age(iso, NOW),
      boardParts.age(iso, new Date(NOW).toISOString()),
    );
  for (const deadline of ["2026-09-30T10:45:00Z", "2026-09-30T09:00:00Z"])
    assert.equal(
      countdown(deadline, NOW).text,
      boardParts.left(deadline, new Date(NOW).toISOString()),
    );
  for (const id of [
    "7e2c5f10-4b8a-4d3e-9f21-0a6c8e1b2d41",
    "terminal:7e2c5f10-4b8a-4d3e-9f21-0a6c8e1b2d41",
    "K1",
  ])
    assert.equal(shortSession(id), boardParts.shortId(id), id);
  assert.equal(label("needs_recipient"), boardParts.label("needs_recipient"));
  for (const n of [0, 1, 2]) {
    assert.equal(count(n, "line"), boardParts.count(n, "line"));
    assert.equal(
      count(n, "reply", "replies"),
      boardParts.count(n, "reply", "replies"),
    );
  }
  for (const reason of [
    "queued_behind",
    "held",
    "not_ready",
    "in_flight",
    "session_replaced",
  ] as const)
    for (const behind of ["D2", null])
      assert.equal(
        waitWords("knowledge@mini", { reason, behind }),
        boardParts.waitWords("knowledge@mini", { reason, behind }),
        reason,
      );
  for (const text of ["One line", "\n  First\r\nSecond", "   ", ""])
    assert.equal(
      firstLine(text),
      boardParts.headline(text),
      JSON.stringify(text),
    );
});
