// Jev adapter: one Choice per unaddressed request, over TypeSafe's System One
// API (POST /v1/systemone, bearer auth). Read from docs.typesafe.ai/api and
// /primitives/choice on 2026-09-30: the answer sits under
// answers.<question>.{choice, probabilities, confidence}; probabilities sum
// to 1; confidence is a spread measure, not the chosen probability; 401 and
// 422 are final, 429 and 529 want backoff. The core decides on the chosen
// option's probability; confidence and usage are recorded for tuning.
import type { JudgmentQuestion } from "./types.ts";

export type JevOptions = {
  apiKey: string;
  url?: string;
  model?: string;
  timeoutMs?: number;
  fetch?: typeof fetch;
  // Pause before the one retry; tests shorten it.
  retryMs?: number;
};

export type JudgeResult =
  | {
      ok: true;
      choice: string;
      probabilities: Record<string, number>;
      confidence: number | null;
      model: string | null;
      usage: unknown;
      ms: number;
    }
  | { ok: false; reason: string; ms: number };

const QUESTION = "recipient";
const isRecord = (value: unknown): value is Record<string, unknown> =>
  value !== null && typeof value === "object" && !Array.isArray(value);

export function jevRequest(
  question: JudgmentQuestion,
  model: string,
): Record<string, unknown> {
  return {
    model,
    state: question.state,
    questions: {
      [QUESTION]: {
        type: "choice",
        instructions: question.instructions,
        criteria: question.criteria,
      },
    },
  };
}

// The parts of a response the router uses, or why it cannot use them. Pure,
// so the mapping is testable without the network.
export function parseJudgment(body: unknown, ms: number): JudgeResult {
  if (!isRecord(body) || !isRecord(body.answers))
    return { ok: false, reason: "response has no answers", ms };
  const answer = body.answers[QUESTION];
  if (
    !isRecord(answer) ||
    typeof answer.choice !== "string" ||
    !isRecord(answer.probabilities)
  )
    return { ok: false, reason: `response has no ${QUESTION} choice`, ms };
  const probabilities: Record<string, number> = {};
  for (const [key, value] of Object.entries(answer.probabilities)) {
    if (typeof value !== "number")
      return {
        ok: false,
        reason: `probability for ${key} is not a number`,
        ms,
      };
    probabilities[key] = value;
  }
  return {
    ok: true,
    choice: answer.choice,
    probabilities,
    confidence:
      typeof answer.confidence === "number" ? answer.confidence : null,
    model: typeof body.model === "string" ? body.model : null,
    usage: body.usage ?? null,
    ms,
  };
}

export async function judge(
  question: JudgmentQuestion,
  options: JevOptions,
): Promise<JudgeResult> {
  const url = options.url ?? "https://api.typesafe.ai/v1/systemone";
  const model = options.model ?? "jev-latest";
  const timeoutMs = options.timeoutMs ?? 20_000;
  const call = options.fetch ?? fetch;
  const started = Date.now();
  const elapsed = (): number => Date.now() - started;
  const body = JSON.stringify(jevRequest(question, model));
  // One retry with backoff for the two statuses the docs say to back off on.
  for (let attempt = 0; ; attempt++) {
    let response: Response;
    try {
      response = await call(url, {
        method: "POST",
        headers: {
          authorization: `Bearer ${options.apiKey}`,
          "content-type": "application/json",
        },
        body,
        signal: AbortSignal.timeout(timeoutMs),
      });
    } catch (error: unknown) {
      return {
        ok: false,
        reason: `unreachable (${error instanceof Error ? error.message : String(error)})`,
        ms: elapsed(),
      };
    }
    if (response.ok) {
      const json: unknown = await response.json().catch(() => null);
      return parseJudgment(json, elapsed());
    }
    const retry = [429, 529].includes(response.status) && attempt === 0;
    if (!retry) {
      const text = await response.text().catch(() => "");
      return {
        ok: false,
        reason: `HTTP ${response.status}${text ? ` ${text.slice(0, 200)}` : ""}`,
        ms: elapsed(),
      };
    }
    await new Promise((resolve) =>
      setTimeout(resolve, options.retryMs ?? 1500),
    );
  }
}
