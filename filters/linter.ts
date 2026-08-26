/**
 * Linter output aggregation filter.
 * Compresses verbose eslint/ruff/mypy/pylint/flake8/clippy output into
 * a summary while retaining complete diagnostics for the model.
 *
 * Adapted from MasuRii/pi-rtk-optimizer techniques/linter.ts
 */
import { registerFilter, type FilterResult } from "./dispatch.js";

interface Issue {
  severity: "ERROR" | "WARNING";
  rule: string;
  file: string;
  line: number;
  column: number;
  message: string;
  original: string;
}

const MAX_RETAINED_DIAGNOSTICS = 10;

function detectLinterType(command: string): string {
  if (/eslint\b/.test(command)) return "ESLint";
  if (/ruff\b/.test(command)) return "Ruff";
  if (/pylint\b/.test(command)) return "Pylint";
  if (/mypy\b/.test(command)) return "MyPy";
  if (/flake8\b/.test(command)) return "Flake8";
  if (/clippy\b/.test(command)) return "Clippy";
  if (/golangci-lint\b/.test(command)) return "GolangCI-Lint";
  if (/prettier\b/.test(command)) return "Prettier";
  if (/black\b/.test(command)) return "Black";
  return "Linter";
}

function parseLine(line: string): Issue | null {
  // Supported form: file:line:column: severity: message [rule]
  // Parenthesized rules are accepted for tools using that conventional form.
  const match = line.match(
    /^(.+):(\d+):(\d+):\s*(error|warning)\s*:?\s+(.+?)\s+(?:\[([^\]\r\n]+)\]|\(([^()\r\n]+)\))$/i,
  );
  if (!match) return null;

  const file = match[1];
  const lineNum = Number.parseInt(match[2], 10);
  const columnNum = Number.parseInt(match[3], 10);
  const severityText = match[4].toLowerCase();
  const message = match[5];
  const rule = match[6] ?? match[7];
  if (!file || !message || !rule || !Number.isSafeInteger(lineNum) || !Number.isSafeInteger(columnNum)) return null;

  return {
    severity: severityText === "warning" ? "WARNING" : "ERROR",
    rule,
    file,
    line: lineNum,
    column: columnNum,
    message,
    original: line,
  };
}

function filterLinter(stdout: string, command: string): FilterResult | null {
  const linterType = detectLinterType(command);
  if (linterType === "Prettier" || linterType === "Black") return null;
  if (/(?:^|\s)(?:-w|--watch)(?:\s|$)/.test(command)) return null;
  if (/watch(?:ing| mode)|file changes detected|starting compilation in watch mode/i.test(stdout)) return null;

  const issues: Issue[] = [];
  for (const line of stdout.split("\n")) {
    if (line.trim().length === 0) continue;
    const parsed = parseLine(line);
    if (!parsed) return null;
    issues.push(parsed);
  }

  // Need enough issues to justify compression.
  if (issues.length < 5) return null;

  const errors = issues.filter((issue) => issue.severity === "ERROR").length;
  const warnings = issues.filter((issue) => issue.severity === "WARNING").length;
  const files = new Set(issues.map((issue) => issue.file));
  const retained = issues.slice(0, MAX_RETAINED_DIAGNOSTICS);
  const omitted = issues.length - retained.length;
  const lines = [`${linterType}: ${errors} errors, ${warnings} warnings in ${files.size} files`];
  lines.push(...retained.map((issue) => issue.original));
  if (omitted > 0) lines.push(`+${omitted} more diagnostics`);

  return { output: lines.join("\n"), category: "medium" };
}

// Register for all linter command prefixes. These IDs remain default-off in dispatch.
const LINTER_COMMANDS = [
  "eslint", "npx eslint", "pnpm eslint",
  "ruff", "ruff check",
  "pylint", "mypy", "flake8", "black",
  "prettier", "npx prettier",
  "cargo clippy",
  "golangci-lint",
];

for (const cmd of LINTER_COMMANDS) {
  registerFilter(cmd, filterLinter, "medium");
}
