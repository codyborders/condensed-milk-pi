/**
 * File operation filters: ls, find, grep/rg.
 *
 * ls/find: summarize only validated one-record-per-line output
 * grep/rg: group validated records by file with exact omission counts
 */
import { registerFilter, type FilterResult } from "./dispatch.js";

// ─── ls ────────────────────────────────────────────────────────────────

function filterLs(input: string, command = "ls"): FilterResult | null {
  if (/\s(?:-[^-\s]*l|--long)(?:\s|$)/.test(command)) return null;
  const lines = outputLines(input);
  if (lines === null || lines.length <= 20) return null;

  // Only summarize one-name-per-line output. Long, columnar, or permission
  // records have ambiguous filename boundaries, so they pass through.
  if (lines.some((line) => !isSafeRecord(line) || /^[-d].*[rwx-]{9}\s/.test(line) || line.includes("\t"))) return null;

  const shown = lines.slice(0, 10);
  const omitted = lines.length - shown.length;
  const parts = [`${lines.length} entries:`, "", ...shown];
  if (omitted > 0) parts.push(`... +${omitted} more`);
  return { output: parts.join("\n"), category: "fast" };
}

// ─── find ──────────────────────────────────────────────────────────────

function filterFind(input: string): FilterResult | null {
  const lines = outputLines(input);
  if (lines === null || lines.length <= 30) return null;
  if (lines.some((line) => !isSafeRecord(line) || !isFindPath(line))) return null;

  const shown = lines.slice(0, 15);
  const omitted = lines.length - shown.length;
  const parts = [`${lines.length} results`, "", ...shown];
  if (omitted > 0) parts.push(`... +${omitted} more (narrow your query)`);
  return { output: parts.join("\n"), category: "fast" };
}

function outputLines(input: string): string[] | null {
  if (input.length === 0) return null;
  const lines = input.split("\n");
  if (lines.at(-1) === "") lines.pop();
  if (lines.length === 0 || lines.some((line) => line.length === 0)) return null;
  return lines;
}

function isSafeRecord(line: string): boolean {
  if (/[\u0000-\u0008\u000b\u000c\u000e-\u001f\u007f\r]/.test(line)) return false;
  return !/^(?:ls|find|grep|rg)(?::|\s)/i.test(line) &&
    !/(?:permission denied|no such file|not found|cannot (?:open|access)|error:|failed)/i.test(line);
}

function isFindPath(line: string): boolean {
  // Find output is one complete path per line. Require path-like prefixes to
  // avoid treating unrelated producer lines as filenames.
  return /^(?:\/|\.\.?(?:\/|$)|~\/|[A-Za-z0-9_.-]+\/)/.test(line) &&
    !/^(?:warning|fatal|usage)\b/i.test(line);
}

// grep/rg now handled by grep-grouping.ts — removed duplicate

// Register
registerFilter("ls", filterLs, "fast");
registerFilter("find", filterFind, "fast");
