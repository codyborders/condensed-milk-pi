/**
 * git status output filter.
 *
 * Parses porcelain v2, v1 (--short), and plain format.
 * Output: "on <branch>: N staged, N modified, N untracked [file1, file2, ...]"
 * Passthrough if input < 80 bytes (already compact).
 */
import { registerFilter, type FilterResult } from "./dispatch.js";

interface Counts {
  branch: string;
  staged: number;
  modified: number;
  untracked: number;
  conflicted: number;
}

function filterGitStatus(input: string, command: string): FilterResult | null {
  // Plain section output is ambiguous. Only summarize explicit porcelain/short output.
  if (!/(?:--porcelain(?:=v?[12])?|--short|-s)(?:\s|$)/.test(command)) return null;
  if (input.length === 0) return { output: "git status: no output", category: "fast" };
  if (input.length < 80) return null; // Already compact

  // v1.9.0 (ADR-029 follow-up): confident-detection guard. When dispatch
  // routes us the combined stdout of a compound command (e.g.
  // `bd update … && git status`), the non-git-status bytes at the start
  // used to trip detectFormat into a default 'v2' interpretation, then
  // parsing counted nothing and we emitted 'on unknown: clean' — hiding
  // the user's real output. Require at least one git-status marker
  // anywhere in the input before we're willing to compress.
  const format = detectFormat(input);
  if (format === null) return null;

  const counts: Counts = { branch: "unknown", staged: 0, modified: 0, untracked: 0, conflicted: 0 };
  const files: string[] = [];

  const lines = input.split("\n");
  for (const line of lines) {
    if (line.length === 0) continue;

    if (format === "v2") {
      if (line.startsWith("# branch.head ")) {
        counts.branch = line.slice("# branch.head ".length);
      } else if (line[0] === "1" && line[1] === " " && line.length > 3) {
        const record = parseV2Record(line, 8);
        if (!record) return null;
        countV2(record.x, record.y, counts);
        if (files.length < 15) files.push(record.path);
      } else if (line[0] === "2" && line[1] === " " && line.length > 3) {
        const record = parseV2Record(line, 9);
        if (!record) return null;
        countV2(record.x, record.y, counts);
        if (files.length < 15) files.push(record.path);
      } else if (line[0] === "?" && line[1] === " " && line.length > 2) {
        const path = parsePath(line.slice(2));
        if (!path) return null;
        counts.untracked++;
        if (files.length < 15) files.push(path);
      } else if (line[0] === "u" && line[1] === " " && line.length > 3) {
        const record = parseV2Record(line, 10);
        if (!record) return null;
        counts.conflicted++;
        if (files.length < 15) files.push(record.path);
      }
    } else if (format === "v1") {
      parseV1Line(line, counts, files);
    } else {
      parsePlainLine(line, counts);
    }
  }

  const total = counts.staged + counts.modified + counts.untracked + counts.conflicted;
  if (total === 0) return { output: `on ${counts.branch}: clean`, category: "fast" };

  const parts: string[] = [];
  if (counts.staged > 0) parts.push(`${counts.staged} staged`);
  if (counts.modified > 0) parts.push(`${counts.modified} modified`);
  if (counts.untracked > 0) parts.push(`${counts.untracked} untracked`);
  if (counts.conflicted > 0) parts.push(`${counts.conflicted} conflicted`);

  let result = `on ${counts.branch}: ${parts.join(", ")}`;
  if (files.length > 0) result += ` [${files.join(", ")}]`;

  return { output: result, category: "fast" };
}

type Format = "v2" | "v1" | "plain";

// v1 --short status lines look like two-char code + space + path, where
// each code char is one of the known git porcelain status codes. Used as
// a confidence marker when no format header is present.
const STATUS_CODES = new Set([" ", "M", "A", "D", "R", "C", "U", "?", "!", "T"]);
function looksLikeV1Line(line: string): boolean {
  if (line.length < 4) return false;
  if (line[2] !== " ") return false;
  return STATUS_CODES.has(line[0]) && STATUS_CODES.has(line[1]);
}

function detectFormat(input: string): Format | null {
  const lines = input.split("\n").filter((line) => line.length > 0);
  if (lines.length === 0) return null;

  if (lines.some((line) => line.startsWith("# branch."))) {
    return lines.every((line) =>
      line.startsWith("# ") ||
      /^1 [^ ]{2} /.test(line) ||
      /^2 [^ ]{2} /.test(line) ||
      /^u /.test(line) ||
      /^\? /.test(line),
    ) ? "v2" : null;
  }

  if (lines.some((line) => line.startsWith("## "))) {
    return lines.every((line) => line.startsWith("## ") || looksLikeV1Line(line)) ? "v1" : null;
  }

  if (lines.some((line) => line.startsWith("On branch "))) return "plain";
  // A status stream without branch headers is valid, but require two records
  // before compressing. This avoids interpreting arbitrary command output.
  return lines.length >= 2 && lines.every(looksLikeV1Line) ? "v1" : null;
}

function countV2(c1: string, c2: string, counts: Counts): void {
  if (c1 !== ".") counts.staged++;
  if (c2 !== ".") counts.modified++;
}

interface V2Record {
  x: string;
  y: string;
  path: string;
}

function parseV2Record(line: string, fixedFields: number): V2Record | null {
  const fields: string[] = [];
  let start = 0;
  for (let i = 0; i < fixedFields; i++) {
    const separator = line.indexOf(" ", start);
    if (separator <= start) return null;
    fields.push(line.slice(start, separator));
    start = separator + 1;
  }
  const rawPath = line.slice(start);
  if (fields[1]?.length !== 2) return null;
  if (fields[0] === "2") {
    const tab = rawPath.indexOf("\t");
    if (tab < 1) return null;
    if (!parsePath(rawPath.slice(tab + 1))) return null;
    const destination = parsePath(rawPath.slice(0, tab));
    return destination ? { x: fields[1][0], y: fields[1][1], path: destination } : null;
  }
  const path = parsePath(rawPath);
  return path ? { x: fields[1][0], y: fields[1][1], path } : null;
}

function parsePath(raw: string): string | null {
  if (raw.length === 0) return null;
  if (raw[0] === '"') return parseQuotedPath(raw);
  if (raw.includes('"')) return null;
  return raw;
}

function parseQuotedPath(raw: string): string | null {
  let path = "";
  for (let i = 1; i < raw.length; i++) {
    const ch = raw[i];
    if (ch === '"') return i === raw.length - 1 ? path : null;
    if (ch !== "\\") {
      if (ch.charCodeAt(0) < 32) return null;
      path += ch;
      continue;
    }
    if (++i >= raw.length) return null;
    const escaped = raw[i];
    const simple: Record<string, string> = { '"': '"', "\\": "\\", a: "\x07", b: "\b", t: "\t", n: "\n", v: "\v", f: "\f", r: "\r" };
    if (simple[escaped] !== undefined) {
      path += simple[escaped];
      continue;
    }
    if (!/[0-7]/.test(escaped)) return null;
    let octal = escaped;
    while (octal.length < 3 && i + 1 < raw.length && /[0-7]/.test(raw[i + 1])) octal += raw[++i];
    path += String.fromCharCode(parseInt(octal, 8));
  }
  return null;
}

function parseV1Line(line: string, counts: Counts, files: string[]): void {
  if (line.startsWith("## ")) {
    const branchPart = line.slice(3);
    const dotDot = branchPart.indexOf("...");
    if (branchPart.startsWith("No commits yet on ")) {
      counts.branch = branchPart.slice("No commits yet on ".length);
    } else {
      counts.branch = dotDot >= 0 ? branchPart.slice(0, dotDot) : branchPart;
    }
    return;
  }
  if (line.length < 4 || !looksLikeV1Line(line)) return;
  const x = line[0];
  const y = line[1];
  if (x === "?" && y === "?") counts.untracked++;
  else if (x === "!" && y === "!") return;
  else if (x === "U" || y === "U") counts.conflicted++;
  else {
    if (x !== " ") counts.staged++;
    if (y !== " ") counts.modified++;
  }
  if (files.length < 15) {
    const path = line.slice(3).trim();
    const arrow = path.indexOf(" -> ");
    files.push(arrow >= 0 ? path.slice(arrow + 4) : path);
  }
}

function parsePlainLine(line: string, counts: Counts): void {
  if (line.startsWith("On branch ")) {
    counts.branch = line.slice("On branch ".length);
  } else if (line.includes("modified:")) {
    counts.modified++;
  } else if (line.includes("new file:")) {
    counts.staged++;
  } else if (line.includes("deleted:")) {
    counts.staged++;
  } else if (line.includes("Untracked files:")) {
    // Next lines are untracked — simplified: just count
    counts.untracked++;
  }
}

// Register for both short and long forms
registerFilter("git status", filterGitStatus, "fast");
