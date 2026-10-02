// `router eval` without Jev: the set's shape, the curve's arithmetic, and
// that the question asked is the router's own.
import test from "node:test";
import assert from "node:assert/strict";
import { readFileSync } from "node:fs";
import { join } from "node:path";
import { curve, evaluate, parseSet, renderEval } from "./eval.ts";
import { responsibilityTexts, routingQuestion } from "./core.ts";
import type { JudgeResult } from "./jev.ts";
import base from "./example-config.ts";

const options = ["knowledge", "scratch", "none"];
// The live roster the committed set is labeled against.
const roster = ["knowledge", "dotfiles", "dotfiles-host", "design", "none"];

test("the committed set parses and names only known recipients", () => {
  const set = parseSet(
    readFileSync(
      join(import.meta.dirname, "..", "eval", "requests.jsonl"),
      "utf8",
    ),
    roster,
  );
  assert.ok(set.length >= 77);
  assert.ok(set.every((item) => ["ko", "en"].includes(item.lang)));
});

test("what the set refuses", () => {
  const cases: [string, RegExp][] = [
    ['{"text":"x","expect":"nobody","lang":"ko"}', /line 1: expect "nobody"/],
    ['{"text":"","expect":"none","lang":"ko"}', /needs text/],
    ["not json", /line 1: not JSON/],
    [
      '{"text":"x","expect":"none","lang":"ko"}\n{"text":"x","expect":"none","lang":"en"}',
      /line 2: duplicate/,
    ],
    ["# only a comment\n", /empty/],
  ];
  for (const [source, reason] of cases)
    assert.throws(() => parseSet(source, options), reason, source);
});

test("every example participant text ends with example requests", () => {
  for (const participant of base.participants)
    assert.match(
      participant.responsibility,
      /(Examples|예시): '.*'\.$/,
      participant.id,
    );
});

test("evaluate asks the router's question; the curve counts dispatches and wrong ones", async () => {
  const set = parseSet(
    [
      '{"text":"볼트 구조 알려줘","expect":"knowledge","lang":"ko"}',
      '{"text":"pong","expect":"scratch","lang":"ko"}',
      '{"text":"저녁 예약해줘","expect":"none","lang":"ko"}',
      '{"text":"flaky","expect":"knowledge","lang":"en"}',
    ].join("\n"),
    options,
  );
  const texts = { knowledge: "Vault.", scratch: "Test." };
  const asked: string[] = [];
  const scripted: Record<string, JudgeResult> = {
    "볼트 구조 알려줘": answer("knowledge", 0.92),
    pong: answer("knowledge", 0.7), // wrong, under 0.9, over 0.6
    "저녁 예약해줘": answer("none", 0.97),
    flaky: { ok: false, reason: "429 after retry", ms: 1 },
  };
  const verdicts = await evaluate(set, texts, (question) => {
    asked.push(JSON.stringify(question));
    const result = scripted[question.state.request];
    if (!result) throw new Error("unexpected request");
    return Promise.resolve(result);
  });
  assert.equal(
    asked[0],
    JSON.stringify(routingQuestion(texts, "볼트 구조 알려줘")),
  );
  assert.deepEqual(
    verdicts.map((v) => [v.choice, v.p]),
    [
      ["knowledge", 0.92],
      ["knowledge", 0.7],
      ["none", 0.97],
      [null, 0],
    ],
  );
  assert.deepEqual(curve(verdicts, [0.6, 0.9]), [
    { threshold: 0.6, dispatched: 2, wrong: 1, handedBack: 2 },
    { threshold: 0.9, dispatched: 1, wrong: 0, handedBack: 3 },
  ]);
  const lines = renderEval(verdicts, curve(verdicts, [0.9]), "jev-test");
  assert.match(lines[1] ?? "", /^NO  ko scratch\s+knowledge 0\.70/);
  assert.match(lines[3] ?? "", /no answer \(429 after retry\)/);
  assert.ok(lines.includes("1 of 4 requests got no usable answer."));
  assert.ok(
    lines.includes(
      "2/4 correct on 4 requests, model jev-test (answered by jev-9.9.9)",
    ),
  );
  assert.match(lines.at(-1) ?? "", /^0\.90\s+1\s+0\s+3$/);
});

test("an answer the router would refuse is no answer, not a dispatch", async () => {
  const set = parseSet(
    '{"text":"pong","expect":"scratch","lang":"ko"}',
    options,
  );
  const verdicts = await evaluate(
    set,
    { knowledge: "Vault.", scratch: "Test." },
    () =>
      Promise.resolve({
        ok: true,
        choice: "knowledge",
        // No probability for scratch: the router hands this back as invalid.
        probabilities: { knowledge: 0.95, none: 0.05 },
        confidence: null,
        model: "jev-9.9.9",
        usage: null,
        ms: 1,
      }),
  );
  assert.deepEqual(
    verdicts.map((v) => [v.choice, v.reason]),
    [[null, "invalid judgment"]],
  );
  assert.deepEqual(curve(verdicts, [0.6]), [
    { threshold: 0.6, dispatched: 0, wrong: 0, handedBack: 1 },
  ]);
});

test("the texts Jev sees follow the sender's permissions, in that order", () => {
  const participants = base.participants.map((p) => ({ ...p }));
  const [first, second] = participants.map((p) => p.id);
  assert.ok(first && second);
  assert.deepEqual(
    Object.keys(responsibilityTexts(participants, [second, first])),
    [second, first],
  );
});

function answer(choice: string, p: number): JudgeResult {
  const rest = (1 - p) / 2;
  const probabilities: Record<string, number> = {
    knowledge: rest,
    scratch: rest,
    none: rest,
  };
  probabilities[choice] = p;
  return {
    ok: true,
    choice,
    probabilities,
    confidence: null,
    model: "jev-9.9.9",
    usage: null,
    ms: 1,
  };
}
