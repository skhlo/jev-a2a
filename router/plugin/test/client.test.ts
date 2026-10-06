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
  extend,
  NOW,
  replacedJournal,
  sampleJournal,
  viaJournal,
} from "../../src/board-fixture.ts";
import type { Entry } from "../../src/journal.ts";
import type { FullTask, Summary } from "../shared/rpc.ts";
import {
  age,
  readiness,
  conversation,
  count,
  countdown,
  deliveryLine,
  deliveryState,
  firstLine,
  headDeliveryState,
  itemWaits,
  judgmentLines,
  label,
  metaLine,
  resolveWhy,
  rowDot,
  rowLines,
  shortSession,
  span,
  statusTone,
  taskLine,
  time,
  verdict,
  viewerOf,
  waitWords,
  type ListRow,
  type Part,
} from "../client/format.ts";

// The board as serve's API gives it to the fixture's operator login, or
// to a viewer serve cannot identify, at the fixture's clock or later.
function board(
  entries: Entry[],
  login: string | null = "me@example.com",
  at = NOW,
) {
  const actor = login
    ? identify({ "tailscale-user-login": login }, config.serve.identities)
    : null;
  const model = boardModel(
    boardState(config, entries, at),
    config,
    at,
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
// A row's dot, then its lines 2 and 3 split by " / ".
const lines = (rows: ListRow[]): string[] =>
  rows.map(
    (r) => `${rowDot(r) ?? "-"} ${rowLines(r, NOW).map(words).join(" / ")}`,
  );

test("client: the list groups the viewer's tasks and each row reads as the board's", () => {
  const { summary } = board(sampleJournal);
  const viewer = viewerOf(summary);
  assert.deepEqual(lines(viewer.needs), [
    "warn T2 · you → orchestrator · needs answer / Force push?",
    "warn T6 · from you · needs recipient / low confidence · Jev environment 0.62",
  ]);
  assert.deepEqual(lines(viewer.flight), [
    "- T4 · you → knowledge · working / Reading the notes · 55m left",
    "- T1 · you → orchestrator · queued / waits for orchestrator@mbp to be ready · 17m left",
  ]);
  assert.deepEqual(lines(viewer.done), [
    "- T5 · orchestrator → incus · completed / 1 of 1 delivery",
    "- T3 · you → orchestrator · completed / 1 of 1 delivery",
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
      const [line2 = [], line3 = []] = rowLines(row, NOW);
      // The board keeps the stale warning off its sub line.
      const sub3 = row.head?.stale ? line3.slice(0, -1) : line3;
      const app = (row.head ? sub3 : line2.slice(1)).map((p) => p.text);
      assert.equal(app.join(" · "), plain(sub[1]), row.id);
      if (row.head) {
        const state =
          /<div class="line2"><span class="state"[^>]*>([^<]*)</.exec(
            html.slice(at),
          )?.[1];
        assert.equal(line2[2]?.text, state, `${row.id}'s status`);
      }
      rows += 1;
    }
  }
  assert.ok(rows >= 25, `${rows} rows compared`);
});

test("client: a stale row ends line 3 with the board's stale words", () => {
  const later = NOW + 40 * 60_000;
  const { summary, page } = board(deliveredJournal, "me@example.com", later);
  const html = page();
  const viewer = viewerOf(summary);
  const stale = [...viewer.needs, ...viewer.flight].filter(
    (r) => r.head?.stale,
  );
  assert.ok(stale.length > 0, "a delivered task is stale 40 minutes on");
  for (const row of stale) {
    const at = html.indexOf(`data-task="${row.id}"`);
    const words = /class="stale[^"]*"[^>]*>([^<]*)</.exec(html.slice(at))?.[1];
    assert.deepEqual(rowLines(row, later)[1]?.slice(-1), [
      { text: words, tone: "warn" },
    ]);
  }
});

test("client: the detail's delivery states, chosen-by words and resolve sentences are the HTML board's", () => {
  const seen = new Set<string>();
  let states = 0;
  for (const entries of [
    sampleJournal,
    attemptingJournal,
    replacedJournal,
    answeredJournal,
    deliveredJournal,
    // The operator resolves the send the replaced session took.
    extend(
      { type: "observe", placement: "knowledge@mini", session: "K2" },
      {
        type: "resolve",
        by: "operator",
        deliveryId: "D3",
        messageId: "M4",
        outcome: "finished",
        evidence: "The session's transcript shows the request.",
      },
    ),
  ]) {
    const { summary, task, page } = board(entries);
    const viewer = viewerOf(summary);
    for (const head of [...summary.open, ...summary.finished]) {
      const full = task(head.id);
      const html = page(head.id);
      const text = plain(html);
      if (full.task.chosenBy)
        assert.ok(text.includes(metaLine(full, NOW)[2]?.text ?? "?"), head.id);
      full.task.deliveries.forEach((d, di) => {
        const tr = new RegExp(
          `<tr data-path="[^"]*\\.deliveries\\[${di}\\]">([\\s\\S]*?)</tr>`,
        ).exec(html);
        const cell = tr?.[1]?.split("<td")[4];
        assert.ok(cell, `${d.id} has a state cell`);
        const state = deliveryState(d, viewer.asksViewer(d.id));
        assert.equal(state.text, plain(`<td${cell}`), d.id);
        assert.equal(state.tone === "warn", cell.includes("badge ask"), d.id);
        seen.add(state.text);
        states += 1;
      });
    }
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
  assert.ok(states >= 6, `${states} delivery states compared`);
  for (const state of [
    "answered",
    "delivered",
    "question",
    "resolved_finished",
  ])
    assert.ok(seen.has(state), `a delivery reads ${state}`);
});

test("client: a status pill warns exactly where the board's badge asks", () => {
  let asks = 0;
  for (const entries of [
    sampleJournal,
    attemptingJournal,
    replacedJournal,
    answeredJournal,
    deliveredJournal,
    viaJournal,
  ]) {
    const { summary, page } = board(entries);
    const viewer = viewerOf(summary);
    for (const h of [...summary.open, ...summary.finished]) {
      const badge =
        /<div class="title"><h2[^]*?<\/h2><span class="([^"]*)"/.exec(
          page(h.id),
        )?.[1];
      assert.ok(badge?.startsWith("badge"), `${h.id} has a badge`);
      const needed = viewer.itemsFor(h.id).some((it) => it.mine);
      assert.equal(
        statusTone(h.status, needed) === "warn",
        badge === "badge ask",
        h.id,
      );
      if (needed) asks += 1;
    }
  }
  assert.ok(asks >= 4, `${asks} badges ask`);
});

test("client: an item the viewer may not act on reads as the board's, without a form", () => {
  let compared = 0;
  for (const entries of [sampleJournal, replacedJournal]) {
    const { summary, task, page } = board(entries, null);
    const viewer = viewerOf(summary);
    for (const it of viewer.items) {
      assert.equal(it.act, false);
      if (!viewer.head(it.item.taskId)) continue;
      const words = itemWaits(it, task(it.item.taskId).task);
      assert.ok(plain(page(it.item.taskId)).includes(words), words);
      compared += 1;
    }
  }
  assert.ok(compared >= 3, `${compared} items compared`);
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
  assert.deepEqual(rowLines(t2, NOW).map(words), [
    "T2 · you → orchestrator · needs answer",
    "waits on alice · Force push?",
  ]);
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
  assert.deepEqual(rowLines(orphan, NOW).map(words), [
    `T99 · ${resolve.deliveryId} · send ${resolve.messageId} · session replaced`,
  ]);
});

test("client: the agents read by host and participant, with their state and open tasks", () => {
  const viewer = viewerOf(board(sampleJournal).summary);
  assert.equal(readiness(viewer.agents), "0 of 4 ready · 1 held");
  assert.deepEqual(
    viewer.hosts.flatMap((h) =>
      h.agents.map(
        (a) =>
          `${h.host} ${a.participant} [${a.state}] ${a.words}: ${
            a.tasks
              .map((t) => words(taskLine(t, viewer.asksViewer(t.delivery.id))))
              .join(" | ") || "no open task"
          }`,
      ),
    ),
    [
      "mbp environment [held] held · ready: no open task",
      "mbp orchestrator [not_ready] not ready: T2 · question [warn] · Ask me something | T1 · waits for orchestrator@mbp to be ready · Fix <b>the</b> build",
      "mini environment [not_ready] not ready: no open task",
      "mini knowledge [not_ready] not ready: T4 · working · Summarize the review pipeline notes",
    ],
  );
});

test("client: hosts sort by name, whatever their agents are called", () => {
  // incus@lab01 comes last in the summary and sorts after environment@mbp
  // by participant, but its host sorts first.
  const { summary } = board(sampleJournal);
  const { hosts } = viewerOf({
    ...summary,
    placements: [
      ...summary.placements,
      {
        key: "incus@lab01",
        participant: "incus",
        host: "lab01",
        ready: true,
        hold: false,
      },
    ],
  });
  assert.deepEqual(
    hosts.map((h) => h.host),
    ["lab01", "mbp", "mini"],
  );
});

test("client: a task line's state is its delivery's pill, read from the summary alone", () => {
  let lines = 0;
  for (const entries of [
    sampleJournal,
    attemptingJournal,
    replacedJournal,
    answeredJournal,
    deliveredJournal,
    viaJournal,
  ]) {
    const { summary, task } = board(entries);
    const viewer = viewerOf(summary);
    for (const head of [...summary.open, ...summary.finished])
      for (const d of head.deliveries) {
        const full = task(head.id).task.deliveries.find((x) => x.id === d.id);
        assert.ok(full && !full.end, `${d.id} is open`);
        const asks = viewer.asksViewer(d.id);
        assert.deepEqual(
          headDeliveryState(d, asks),
          deliveryState(full, asks),
          d.id,
        );
        lines += 1;
      }
  }
  assert.ok(lines >= 10, `${lines} deliveries compared`);
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
  assert.equal(
    deliveryLine(
      { ...d, send: { ...d.send, messageId: "0123456789abcdef" } },
      t4.times,
    ),
    "D3 · request 01234567 · accepted · session K1 · last reply 09:44Z",
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
