/**
 * Conservative build summaries.
 *
 * Only Cargo, Gradle, and Maven terminal success formats are supported.
 * Every other build command declines until its output format is proven safe.
 */
import { registerFilter, type FilterContext, type FilterResult } from "./dispatch.js";

const MAX_INPUT = 50_000;
const BAD_OUTPUT = /\b(?:warning|warn|error|errors|failed|failure|exception|panic|stacktrace|stack trace|caused by)\b/i;

function terminalLine(lines: string[], pattern: RegExp): string | null {
  const nonBlank = lines.filter((line) => line.trim().length > 0);
  const matches = nonBlank.filter((line) => pattern.test(line.trim()));
  if (matches.length !== 1) return null;
  return matches[0].trim();
}

function cargo(stdout: string): string | null {
  const lines = stdout.split("\n");
  const summary = terminalLine(lines, /^Finished\s+.+\s+in\s+\S+$/i);
  if (!summary) return null;
  for (const line of lines) {
    const trimmed = line.trim();
    if (!trimmed || /^Finished\s+.+\s+in\s+\S+$/i.test(trimmed)) continue;
    if (/^(?:Compiling|Checking|Downloading|Downloaded|Fetching|Fetched|Updating|Updated|Fresh|Locking)\s+.+$/i.test(trimmed)) continue;
    return null;
  }
  return summary;
}

function gradle(stdout: string): string | null {
  const lines = stdout.split("\n");
  const summary = terminalLine(lines, /^BUILD SUCCESSFUL\s+in\s+\S+$/i);
  if (!summary) return null;
  for (const line of lines) {
    const trimmed = line.trim();
    if (!trimmed || /^BUILD SUCCESSFUL\s+in\s+\S+$/i.test(trimmed)) continue;
    if (/^(?:>\s+Task\s+:\S+|Starting a Gradle Daemon|Welcome to Gradle\b|\d+\s+actionable tasks?:\s+.+)$/i.test(trimmed)) continue;
    return null;
  }
  return summary;
}

function maven(stdout: string): string | null {
  const lines = stdout.split("\n");
  const summary = terminalLine(lines, /^\[INFO\]\s+BUILD SUCCESS$/i);
  if (!summary) return null;
  for (const line of lines) {
    const trimmed = line.trim();
    if (!trimmed || /^\[INFO\]\s+BUILD SUCCESS$/i.test(trimmed)) continue;
    if (/^\[INFO\](?:\s+.*)?$/i.test(trimmed)) continue;
    return null;
  }
  return summary;
}

function filterBuild(context: FilterContext): FilterResult | null {
  const { stdout, command } = context;
  if (stdout.length < 80 || stdout.length > MAX_INPUT) return null;
  if (BAD_OUTPUT.test(stdout)) return null;

  let summary: string | null = null;
  let label = "";
  if (/^cargo\s+(?:build|check)\b/i.test(command)) {
    summary = cargo(stdout);
    label = "Cargo";
  } else if (/^gradle(?:\s|$)/i.test(command)) {
    summary = gradle(stdout);
    label = "Gradle";
  } else if (/^(?:mvn|maven)(?:\s|$)/i.test(command)) {
    summary = maven(stdout);
    label = "Maven";
  } else {
    return null;
  }
  if (!summary) return null;
  return { output: `${label}: ${summary}`, category: "medium" };
}

const BUILD_COMMANDS = [
  "cargo build", "cargo check",
  "npm run build", "pnpm build", "pnpm run build", "yarn build",
  "make", "cmake",
  "go build", "go install",
  "gradle", "mvn",
  "python setup.py build",
  "bun build",
];

for (const cmd of BUILD_COMMANDS) {
  registerFilter(cmd, filterBuild, "medium", { context: true });
}
