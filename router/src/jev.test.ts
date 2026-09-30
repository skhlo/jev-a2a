// The Jev adapter's pure parts: the request built from the core's question
// and the response mapping, against the shapes documented by TypeSafe.
import test from "node:test";
import assert from "node:assert/strict";
import { jevRequest, judge, parseJudgment } from "./jev.ts";
import { initial, judgmentQuestion } from "./core.ts";
import config from "./example-config.ts";

// A task as the core would hold it while routing; only source and text matter
// to the question.
const question = judgmentQuestion(initial(config), {
  id: "T1",
  source: "you",
  messageId: "M1",
  text: "Check the dotfiles on every machine.",
  to: null,
  hosts: null,
  via: null,
  deadline: 100,
  permitted: ["orchestrator", "knowledge", "environment", "incus"],
  routing: { state: "judging", suggestions: [], reason: null },
  judgments: [],
  recipient: null,
  chosenBy: null,
  deliveries: [],
  late: [],
  final: null,
  status: "routing",
});

test("the request is one choice question over the core's criteria", () => {
  const request = jevRequest(question, "jev-latest");
  assert.deepEqual(request, {
    model: "jev-latest",
    state: { request: "Check the dotfiles on every machine." },
    questions: {
      recipient: {
        type: "choice",
        instructions: question.instructions,
        criteria: question.criteria,
      },
    },
  });
  assert.ok("none" in question.criteria);
});

test("a documented response maps to a judgment; malformed ones do not", () => {
  const good = parseJudgment(
    {
      model: "jev-1.13.0",
      answers: {
        recipient: {
          type: "choice",
          choice: "environment",
          probabilities: { orchestrator: 0.05, environment: 0.9, none: 0.05 },
          confidence: 0.81,
        },
      },
      usage: { input_tokens: 318, output_tokens: 34 },
    },
    120,
  );
  assert.deepEqual(good, {
    ok: true,
    choice: "environment",
    probabilities: { orchestrator: 0.05, environment: 0.9, none: 0.05 },
    confidence: 0.81,
    model: "jev-1.13.0",
    usage: { input_tokens: 318, output_tokens: 34 },
    ms: 120,
  });
  for (const body of [
    null,
    {},
    { answers: {} },
    { answers: { recipient: { choice: 1, probabilities: {} } } },
    { answers: { recipient: { choice: "a", probabilities: { a: "1" } } } },
  ]) {
    const bad = parseJudgment(body, 1);
    assert.equal(bad.ok, false, JSON.stringify(body));
  }
});

test("HTTP failures become judgeFailed reasons; 429 is retried once", async () => {
  const calls: number[] = [];
  const fake = (status: number, body: unknown): typeof fetch =>
    (() => {
      calls.push(status);
      return Promise.resolve(
        new Response(JSON.stringify(body), {
          status,
          headers: { "content-type": "application/json" },
        }),
      );
    }) as typeof fetch;
  const denied = await judge(question, { apiKey: "k", fetch: fake(401, {}) });
  assert.equal(denied.ok, false);
  assert.match(denied.ok ? "" : denied.reason, /HTTP 401/);
  let n = 0;
  const flaky = ((): Promise<Response> => {
    n++;
    return Promise.resolve(
      new Response(
        JSON.stringify(
          n === 1
            ? {}
            : {
                answers: {
                  recipient: { choice: "none", probabilities: { none: 1 } },
                },
              },
        ),
        {
          status: n === 1 ? 429 : 200,
        },
      ),
    );
  }) as typeof fetch;
  const result = await judge(question, {
    apiKey: "k",
    fetch: flaky,
    retryMs: 1,
  });
  assert.equal(n, 2);
  assert.equal(result.ok, true);
  if (result.ok) assert.equal(result.choice, "none");
  const down = await judge(question, {
    apiKey: "k",
    fetch: (() => Promise.reject(new Error("ECONNREFUSED"))) as typeof fetch,
  });
  assert.equal(down.ok, false);
  assert.match(down.ok ? "" : down.reason, /unreachable/);
});
