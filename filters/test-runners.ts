/**
 * Conservative terminal summaries for supported JavaScript test runners.
 *
 * A runner output is compressed only when its complete stream matches one
 * known all-pass format. Failed, partial, mixed, watch, or unknown output
 * remains untouched.
 */
import { registerFilter, type FilterContext, type FilterResult } from "./dispatch.js";

type Runner = "Vitest" | "Jest" | "Mocha";

interface Summary {
  runner: Runner;
  suites?: number;
  tests: number;
  skipped: number;
  duration?: string;
}

const MAX_INPUT = 50_000;
const FAILURE_OR_DIAGNOSTIC = /\b(?:fail(?:ed|ure|ing)?|error(?:s)?|exception|interrupted|cancelled|aborted|abort|timeout|warning(?:s)?)\b/i;
const WATCH_OUTPUT = /\b(?:watch|watching|rerun|file changes? detected|press .* to run)\b/i;

function terminalLines(lines: string[]): string[] {
  let end = lines.length;
  while (end > 0 && lines[end - 1]?.trim() === "") end--;
  return lines.slice(0, end);
}

function count(value: string): number | null {
  const parsed = Number.parseInt(value, 10);
  return Number.isSafeInteger(parsed) && parsed >= 0 ? parsed : null;
}

function parseVitest(lines: string[]): Summary | null {
  let suites: number | undefined;
  let tests: number | undefined;
  let skipped = 0;
  let duration: string | undefined;
  let hasHeader = false;
  let suiteTotal: number | undefined;
  let testTotal: number | undefined;

  for (const line of lines) {
    const trimmed = line.trim();
    if (!trimmed) continue;
    if (/^RUN\s+v\S+/i.test(trimmed)) { hasHeader = true; continue; }
    if (/^Start at\s+/i.test(trimmed)) continue;
    const suite = trimmed.match(/^Test Files\s+(\d+)\s+passed(?:\s*\|\s*(\d+)\s+skipped)?\s*\((\d+)\)/i);
    if (suite) {
      const suiteCount = count(suite[1]);
      const suiteSkipped = count(suite[2] ?? "0");
      const total = count(suite[3]);
      if (suiteCount === null || suiteSkipped === null || total === null) return null;
      suites = suiteCount;
      suiteTotal = total;
      skipped = Math.max(skipped, suiteSkipped);
      continue;
    }
    const test = trimmed.match(/^Tests\s+(\d+)\s+passed(?:\s*\|\s*(\d+)\s+skipped)?\s*\((\d+)\)/i);
    if (test) {
      const testCount = count(test[1]);
      const testSkipped = count(test[2] ?? "0");
      const total = count(test[3]);
      if (testCount === null || testSkipped === null || total === null) return null;
      tests = testCount;
      testTotal = total;
      skipped = Math.max(skipped, testSkipped);
      continue;
    }
    const durationMatch = trimmed.match(/^Duration\s+(.+)$/i);
    if (durationMatch) { duration = durationMatch[1]; continue; }
    if (/^(?:PASS|OK|\u2713|\u2714)\b/i.test(trimmed)) continue;
    return null;
  }

  if (!hasHeader || suites === undefined || tests === undefined) return null;
  if (suiteTotal !== undefined && suites + skipped > suiteTotal) return null;
  if (testTotal !== undefined && tests + skipped > testTotal) return null;
  return { runner: "Vitest", suites, tests, skipped, duration };
}

function parseJest(lines: string[]): Summary | null {
  let suites: number | undefined;
  let tests: number | undefined;
  let skipped = 0;
  let duration: string | undefined;
  let hasHeader = false;
  let suiteTotal: number | undefined;
  let testTotal: number | undefined;

  for (const line of lines) {
    const trimmed = line.trim();
    if (!trimmed) continue;
    if (/^PASS\s+\S+/i.test(trimmed)) { hasHeader = true; continue; }
    const suite = trimmed.match(/^Test Suites:\s*(\d+)\s+passed(?:,\s*(\d+)\s+skipped)?,\s*(\d+)\s+total$/i);
    if (suite) {
      const suiteCount = count(suite[1]);
      const suiteSkipped = count(suite[2] ?? "0");
      const total = count(suite[3]);
      if (suiteCount === null || suiteSkipped === null || total === null) return null;
      suites = suiteCount;
      suiteTotal = total;
      skipped = Math.max(skipped, suiteSkipped);
      continue;
    }
    const test = trimmed.match(/^Tests:\s*(\d+)\s+passed(?:,\s*(\d+)\s+skipped)?,\s*(\d+)\s+total$/i);
    if (test) {
      const testCount = count(test[1]);
      const testSkipped = count(test[2] ?? "0");
      const total = count(test[3]);
      if (testCount === null || testSkipped === null || total === null) return null;
      tests = testCount;
      testTotal = total;
      skipped = Math.max(skipped, testSkipped);
      continue;
    }
    if (/^Snapshots:\s+.+$/i.test(trimmed)) continue;
    if (/^Time:\s+.+$/i.test(trimmed)) { duration = trimmed.slice(5).trim(); continue; }
    if (/^Ran all test suites(?:\.|\s)/i.test(trimmed)) continue;
    if (/^(?:PASS|OK|\u2713|\u2714)\b/i.test(trimmed)) { hasHeader = true; continue; }
    return null;
  }

  if (!hasHeader || suites === undefined || tests === undefined) return null;
  if (suiteTotal !== undefined && suites + skipped > suiteTotal) return null;
  if (testTotal !== undefined && tests + skipped > testTotal) return null;
  return { runner: "Jest", suites, tests, skipped, duration };
}

function parseMocha(lines: string[]): Summary | null {
  let tests: number | undefined;
  let skipped = 0;
  let duration: string | undefined;
  for (const line of lines) {
    const trimmed = line.trim();
    if (!trimmed) continue;
    const passing = trimmed.match(/^(\d+)\s+passing(?:\s*\(([^)]+)\))?$/i);
    if (passing) {
      const testCount = count(passing[1]);
      if (testCount === null) return null;
      tests = testCount;
      duration = passing[2];
      continue;
    }
    const pending = trimmed.match(/^(\d+)\s+pending$/i);
    if (pending) {
      const value = count(pending[1]);
      if (value === null) return null;
      skipped = value;
      continue;
    }
    // Spec reporter titles and passing test names are indented. Unindented
    // text is not accepted because it can hide a second producer or failure.
    if (/^\s{2,}\S/.test(line)) continue;
    return null;
  }
  if (tests === undefined) return null;
  return { runner: "Mocha", tests, skipped, duration };
}

function runnerForCommand(command: string, output: string): Runner | null {
  if (/\b(?:npx\s+)?vitest\b/i.test(command)) return "Vitest";
  if (/\b(?:npx\s+)?jest\b/i.test(command)) return "Jest";
  if (/\b(?:npx\s+)?mocha\b/i.test(command)) return "Mocha";
  if (/^\s*RUN\s+v\S+/im.test(output)) return "Vitest";
  if (/^\s*PASS\s+\S+/im.test(output) && /Test Suites:/i.test(output)) return "Jest";
  if (/^\s*\d+\s+passing(?:\s*\(|$)/im.test(output)) return "Mocha";
  return null;
}

function formatSummary(summary: Summary): string {
  const parts = [`${summary.runner}:`];
  if (summary.suites !== undefined) parts.push(`${summary.suites} suites passed,`);
  parts.push(`${summary.tests} tests passed`);
  if (summary.skipped > 0) parts.push(`, ${summary.skipped} skipped`);
  const output = parts.join(" ");
  return summary.duration ? `${output}\nDuration: ${summary.duration}` : output;
}

function filterTestOutput(context: FilterContext): FilterResult | null {
  const { stdout, command } = context;
  if (stdout.length < 80 || stdout.length > MAX_INPUT) return null;
  if (FAILURE_OR_DIAGNOSTIC.test(stdout) || WATCH_OUTPUT.test(stdout)) return null;
  const runner = runnerForCommand(command, stdout);
  if (!runner) return null;
  const lines = terminalLines(stdout.split("\n"));
  if (lines.length < 2) return null;
  const summary = runner === "Vitest"
    ? parseVitest(lines)
    : runner === "Jest" ? parseJest(lines) : parseMocha(lines);
  if (!summary) return null;
  return { output: formatSummary(summary), category: "medium" };
}

const TEST_COMMANDS = [
  "npm test", "pnpm test", "yarn test", "bun test",
  "npx vitest", "vitest", "pnpm vitest",
  "npx jest", "jest", "pnpm jest",
  "mocha", "npx mocha",
];

for (const cmd of TEST_COMMANDS) {
  registerFilter(cmd, filterTestOutput, "medium", { context: true });
}
