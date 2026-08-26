/**
 * env/printenv output filter.
 *
 * Privacy boundary: masks sensitive values via token-aware name matching
 * (API_KEY, SECRET, TOKEN, PASSWORD, PASS, AUTH, CREDENTIAL, PRIVATE_KEY
 * at underscore or name boundaries). Non-sensitive lines are preserved
 * byte-for-byte and in original order — no truncation, no variable cap,
 * no dropped diagnostics.
 */
import { registerFilter, type FilterResult } from "./dispatch.js";

const REDACTED = "[REDACTED]";

// Single-segment sensitive tokens. Matched case-insensitively against
// underscore-delimited segments of the variable name, so MONKEY and
// KEYBOARD ("KEY" mid-word, no boundary) and APIARY ("API" mid-word)
// never match, while AWS_ACCESS_KEY_ID and LICENSE_KEY (KEY as its own
// underscore-bounded segment) do.
const SINGLE_SEGMENT_TOKENS = new Set([
  "SECRET", "TOKEN", "PASSWORD", "PASS", "AUTH", "CREDENTIAL", "KEY",
]);
// Sensitive tokens that span two underscore-delimited segments.
const TWO_SEGMENT_TOKENS = new Set(["API_KEY", "PRIVATE_KEY"]);

function isSensitive(key: string): boolean {
  const segments = key.toUpperCase().split("_");
  for (let i = 0; i < segments.length; i++) {
    if (SINGLE_SEGMENT_TOKENS.has(segments[i])) return true;
    if (i + 1 < segments.length && TWO_SEGMENT_TOKENS.has(`${segments[i]}_${segments[i + 1]}`)) return true;
  }
  return false;
}

function filterEnv(input: string): FilterResult | null {
  if (input.length === 0) return null;

  const lines = input.split("\n");
  const out: string[] = [];
  let redactedAny = false;

  for (const line of lines) {
    const eq = line.indexOf("=");
    // Lines without a KEY= prefix (blank lines, diagnostics, prose) are
    // preserved verbatim and in order.
    if (eq <= 0) {
      out.push(line);
      continue;
    }

    const key = line.slice(0, eq);

    if (isSensitive(key)) {
      out.push(`${key}=${REDACTED}`);
      redactedAny = true;
    } else {
      // Non-sensitive lines pass through byte-for-byte — never truncated.
      out.push(line);
    }
  }

  // Nothing sensitive: leave the output untouched (dispatch passes it
  // through as-is). Something sensitive: always emit the redacted form,
  // even when [REDACTED] makes it longer than the input — the mandatory
  // flag lets this one filter through the central shorter-output gate.
  if (!redactedAny) return null;
  return { output: out.join("\n"), category: "fast", mandatory: true };
}

registerFilter("env", filterEnv, "fast");
registerFilter("printenv", filterEnv, "fast");
