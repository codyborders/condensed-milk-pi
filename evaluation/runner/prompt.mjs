/**
 * Combined attempt prompt construction.
 *
 * The real Pi prompt is the checked-in attempt-prompt.md rules
 * followed by the task prompt. The exact combined string is what the
 * model sees, what the argv carries, and what the persisted SHA-256
 * covers, so prompt identity is comparable across arms and runs.
 */

import { readFileSync } from "node:fs";
import { createHash } from "node:crypto";
import { dirname, join } from "node:path";
import { fileURLToPath } from "node:url";

export const ATTEMPT_PROMPT_FILE = join(dirname(fileURLToPath(import.meta.url)), "attempt-prompt.md");

/** The exact combined prompt: attempt-prompt.md rules, then the task prompt. */
export function buildAttemptPrompt(taskPrompt) {
  return `${readFileSync(ATTEMPT_PROMPT_FILE, "utf8")}${taskPrompt}`;
}

export function sha256Text(text) {
  return createHash("sha256").update(text).digest("hex");
}
