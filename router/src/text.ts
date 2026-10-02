// The text of a reply or an answer: --text, or --text-file for text that a
// shell cannot quote in one argument. The client repeats this rule, since it
// is installed alone on other hosts.
import { readFileSync } from "node:fs";

export function textOption(
  text: string | undefined,
  file: string | undefined,
): string {
  if (file === undefined) return text ?? "";
  if (text !== undefined)
    throw new Error("Pass --text or --text-file, not both.");
  try {
    return readFileSync(file, "utf8").trimEnd();
  } catch (error: unknown) {
    throw new Error(
      `--text-file: ${error instanceof Error ? error.message : String(error)}`,
    );
  }
}
