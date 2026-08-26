/**
 * git diff output filter.
 *
 * - Passthrough for --stat output (already compact)
 * - Passthrough small diffs (<10 lines)
 * - Condense large diffs: keep hunk headers + changed lines, drop unchanged context
 */
import { registerFilter, type FilterResult } from "./dispatch.js";

function filterGitDiff(input: string): FilterResult | null {
  if (input.length === 0) return null;

  // Passthrough: --stat output is already compact
  if (
    !input.includes("diff --git") &&
    input.includes("|") &&
    input.includes("files changed") &&
    (input.includes("insertion") || input.includes("deletion"))
  ) {
    return null; // Already compact
  }

  // Combined diffs use different hunk markers. Preserve them.
  if (/^diff --(?:cc|combined) /m.test(input) || /^@@@ /m.test(input)) return null;
  const hunkHeaders = input.match(/^@@ .* @@.*$/gm) ?? [];
  if (hunkHeaders.length === 0 || hunkHeaders.some((line) => !/^@@ -\d+(?:,\d+)? \+\d+(?:,\d+)? @@/.test(line))) return null;

  // Preserve file headers and all other decisive metadata.
  const stripped = input;

  const lineCount = countLines(stripped);
  if (lineCount < 10) {
    return stripped.length < input.length
      ? { output: stripped, category: "fast" }
      : null;
  }

  // Condense large diffs: keep diff --git, hunk headers, and changed lines
  const condensed = condenseLargeDiff(stripped);
  return condensed.length < input.length
    ? { output: condensed, category: "fast" }
    : null;
}

function condenseLargeDiff(input: string): string {
  const out: string[] = [];
  const context: string[] = [];
  let afterChange = false;

  const flushContext = (beforeChange: boolean): void => {
    if (context.length === 0) return;
    let kept: string[];
    if (afterChange && beforeChange && context.length > 4) {
      kept = [...context.slice(0, 2), ...context.slice(-2)];
    } else if (afterChange && beforeChange) {
      kept = [...context];
    } else if (afterChange) {
      kept = context.slice(0, 2);
    } else {
      kept = context.slice(-2);
    }
    const omitted = context.length - kept.length;
    if (omitted > 0) out.push(`  ... ${omitted} unchanged lines ...`);
    out.push(...kept);
    context.length = 0;
  };

  for (const line of input.split("\n")) {
    if (isStructural(line)) {
      flushContext(false);
      out.push(line);
      if (!line.startsWith("\\\\ No newline at end of file")) afterChange = false;
      continue;
    }
    if (line.startsWith("+") || line.startsWith("-")) {
      flushContext(true);
      out.push(line);
      afterChange = true;
      continue;
    }
    if (line.startsWith(" ")) {
      context.push(line);
      continue;
    }
    flushContext(false);
    out.push(line);
    afterChange = false;
  }
  flushContext(false);
  return out.join("\n");
}

function isStructural(line: string): boolean {
  return line.startsWith("diff --git") || line.startsWith("index ") ||
    line.startsWith("--- ") || line.startsWith("+++ ") || line.startsWith("old mode ") ||
    line.startsWith("new mode ") || line.startsWith("new file mode ") ||
    line.startsWith("deleted file mode ") || line.startsWith("similarity index ") ||
    line.startsWith("dissimilarity index ") || line.startsWith("rename from ") ||
    line.startsWith("rename to ") || line.startsWith("copy from ") || line.startsWith("copy to ") ||
    line.startsWith("Binary files ") || line === "GIT binary patch" || /^@@ /.test(line) ||
    line.startsWith("\\ No newline at end of file");
}

function countLines(s: string): number {
  let count = 0;
  for (const ch of s) {
    if (ch === "\n") count++;
  }
  return count;
}

// Register
registerFilter("git diff", filterGitDiff, "fast");
