/**
 * pytest output filter.
 *
 * All-pass: extract a positively identified terminal summary.
 * Failures and uncertain output pass through unchanged.
 */
import { registerFilter, type FilterResult } from "./dispatch.js";

const FORBIDDEN_SUMMARY_TOKENS =
  /\b(?:failed|failure|failures|error|errors|xfailed|xpassed|interrupted|keyboard\s+interrupt)\b/i;
const PASS_SUMMARY =
  /^\d+\s+passed(?:\s*,\s*\d+\s+(?:skipped|deselected|warnings?))*?(?:\s+in\s+\S+)?$/i;

function filterPytest(input: string): FilterResult | null {
  if (input.length === 0) return null;
  const summary = extractPassSummary(input);
  return summary ? { output: summary, category: "medium" } : null;
}

function extractPassSummary(input: string): string | null {
  // A passing line before a later failure is not a terminal result.
  if (FORBIDDEN_SUMMARY_TOKENS.test(input)) return null;

  const lines = input.split("\n");
  let finalIndex = lines.length - 1;
  while (finalIndex >= 0 && lines[finalIndex].trim().length === 0) finalIndex--;
  if (finalIndex < 0) return null;

  const terminalLine = lines[finalIndex];
  const candidate = terminalLine.trim()
    .replace(/^=+\s*/, "")
    .replace(/\s*=+$/, "")
    .trim();
  if (!PASS_SUMMARY.test(candidate)) return null;

  // Keep pytest's own terminal text byte-for-byte after our prefix.
  return `pytest: ${terminalLine}`;
}

registerFilter("pytest", filterPytest, "medium");
registerFilter("python -m pytest", filterPytest, "medium");
registerFilter("python3 -m pytest", filterPytest, "medium");
