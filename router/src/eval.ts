// `router eval`: the configured roster judged against labeled requests, so a
// responsibility text or a threshold is changed on evidence. Pure except for
// the judge it is handed; nothing here touches the journal.
import { readFileSync } from "node:fs";
import { routingQuestion } from "./core.ts";
import type { JudgeResult } from "./jev.ts";
import type { JudgmentQuestion } from "./types.ts";

// One labeled request: who should get it (`none` for no participant).
export type Labeled = { text: string; expect: string; lang: string };

export type Verdict = Labeled & {
  choice: string | null; // null when Jev gave no usable answer
  p: number; // probability of the choice; 0 without an answer
  reason?: string;
};

export type Point = {
  threshold: number;
  dispatched: number; // chose a participant at or above the threshold
  wrong: number; // dispatched to someone other than `expect`
  handedBack: number; // the rest: none, under the threshold, or no answer
};

export const THRESHOLDS = [0.6, 0.65, 0.7, 0.75, 0.8, 0.85, 0.9, 0.95];

const isRecord = (value: unknown): value is Record<string, unknown> =>
  value !== null && typeof value === "object" && !Array.isArray(value);

// The set is JSON lines, one `{text, expect, lang}` each; blank lines and
// lines starting with # are skipped.
export function parseSet(source: string, options: string[]): Labeled[] {
  const set: Labeled[] = [];
  const seen = new Set<string>();
  source.split("\n").forEach((line, index) => {
    const at = `line ${index + 1}`;
    if (!line.trim() || line.startsWith("#")) return;
    let value: unknown;
    try {
      value = JSON.parse(line);
    } catch {
      throw new Error(`${at}: not JSON`);
    }
    if (
      !isRecord(value) ||
      typeof value.text !== "string" ||
      !value.text.trim() ||
      typeof value.expect !== "string" ||
      typeof value.lang !== "string"
    )
      throw new Error(`${at}: needs text, expect and lang`);
    if (!options.includes(value.expect))
      throw new Error(
        `${at}: expect "${value.expect}" is not one of ${options.join(", ")}`,
      );
    if (seen.has(value.text)) throw new Error(`${at}: duplicate text`);
    seen.add(value.text);
    set.push({ text: value.text, expect: value.expect, lang: value.lang });
  });
  if (!set.length) throw new Error("The set is empty.");
  return set;
}

export function readSet(path: string, options: string[]): Labeled[] {
  return parseSet(readFileSync(path, "utf8"), options);
}

// Asks the judge once per request, in order.
export async function evaluate(
  set: Labeled[],
  responsibilities: Record<string, string>,
  judge: (question: JudgmentQuestion) => Promise<JudgeResult>,
): Promise<Verdict[]> {
  const verdicts: Verdict[] = [];
  for (const item of set) {
    const result = await judge(routingQuestion(responsibilities, item.text));
    verdicts.push(
      result.ok
        ? {
            ...item,
            choice: result.choice,
            p: result.probabilities[result.choice] ?? 0,
          }
        : { ...item, choice: null, p: 0, reason: result.reason },
    );
  }
  return verdicts;
}

export const correct = (v: Verdict): boolean => v.choice === v.expect;

const dispatched = (v: Verdict, threshold: number): boolean =>
  v.choice !== null && v.choice !== "none" && v.p >= threshold;

export function curve(
  verdicts: Verdict[],
  thresholds: number[] = THRESHOLDS,
): Point[] {
  return thresholds.map((threshold) => {
    const sent = verdicts.filter((v) => dispatched(v, threshold));
    return {
      threshold,
      dispatched: sent.length,
      wrong: sent.filter((v) => !correct(v)).length,
      handedBack: verdicts.length - sent.length,
    };
  });
}

// The table and the curve, as lines.
export function renderEval(
  verdicts: Verdict[],
  points: Point[],
  model: string,
): string[] {
  const lines: string[] = [];
  for (const v of verdicts) {
    const mark = correct(v) ? "ok " : "NO ";
    const got =
      v.choice === null
        ? `no answer (${v.reason ?? "unknown"})`
        : `${v.choice} ${v.p.toFixed(2)}`;
    lines.push(
      `${mark} ${v.lang} ${v.expect.padEnd(12)} ${got.padEnd(18)} ${v.text}`,
    );
  }
  const right = verdicts.filter(correct).length;
  lines.push("");
  lines.push(
    `${right}/${verdicts.length} correct on ${verdicts.length} requests, model ${model}`,
  );
  lines.push("threshold  dispatched  wrong  handed back");
  for (const point of points)
    lines.push(
      `${point.threshold.toFixed(2).padEnd(10)} ${String(point.dispatched).padStart(10)}  ${String(point.wrong).padStart(5)}  ${String(point.handedBack).padStart(11)}`,
    );
  return lines;
}
