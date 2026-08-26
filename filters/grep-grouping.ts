/**
 * Search/grep result grouping filter.
 * Groups grep/rg output by file with match counts.
 * Truncates individual match lines to 70 chars.
 *
 * Adapted from MasuRii/pi-rtk-optimizer techniques/search.ts
 */
import { registerFilter, type FilterResult } from "./dispatch.js";

interface SearchResult {
  file: string;
  lineNumber: string;
  content: string;
}

const MIN_RESULTS_TO_GROUP = 15;
const MAX_MATCHES_PER_FILE = 10;
function filterGrep(stdout: string, _command: string): FilterResult | null {
  const lines = stdout.split("\n");
  if (lines.at(-1) === "") lines.pop();
  if (lines.length === 0 || lines.some((line) => line.length === 0)) return null;

  const results: SearchResult[] = [];
  for (const line of lines) {
    if (!isSafeSearchLine(line)) return null;
    // Grep and rg default line output: complete-file-path:line-number:match.
    // Greedy path capture preserves colons in filenames.
    const match = line.match(/^(.+):(\d+):(.*)$/);
    if (!match) return null;
    results.push({ file: match[1] ?? "", lineNumber: match[2] ?? "", content: match[3] ?? "" });
  }

  if (results.length < MIN_RESULTS_TO_GROUP) return null;

  const byFile = new Map<string, SearchResult[]>();
  for (const result of results) byFile.set(result.file, [...(byFile.get(result.file) ?? []), result]);

  const out = [`${results.length} matches in ${byFile.size} files:`, ""];
  let shown = 0;
  for (const [file, matches] of [...byFile.entries()].sort((a, b) => a[0].localeCompare(b[0]))) {
    out.push(`> ${file} (${matches.length} matches):`);
    for (const match of matches.slice(0, MAX_MATCHES_PER_FILE)) {
      out.push(`    ${match.lineNumber}: ${match.content}`);
      shown++;
    }
    out.push("");
  }

  const omitted = results.length - shown;
  if (omitted > 0) out.push(`[${omitted} matches omitted]`);
  return { output: out.join("\n"), category: "fast" };
}

function isSafeSearchLine(line: string): boolean {
  if (/[\u0000-\u0008\u000b\u000c\u000e-\u001f\u007f\r]/.test(line)) return false;
  return !/^(?:grep|rg):\s/i.test(line) &&
    !/^(?:binary file|error:|warning:|permission denied|no such file)/i.test(line);
}

// Register for grep/rg command prefixes
const GREP_COMMANDS = [
  "grep", "grep -rn", "grep -rni", "grep -n",
  "rg", "ripgrep",
];

for (const cmd of GREP_COMMANDS) {
  registerFilter(cmd, filterGrep, "fast");
}
