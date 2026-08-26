/**
 * tree output filter.
 *
 * Strips noise directories (node_modules, .git, __pycache__, .venv, etc.)
 * and their children. Caps at 80 lines.
 */
import { registerFilter, type FilterResult } from "./dispatch.js";

const NOISE_DIRS = new Set([
  "node_modules", ".git", "target", "__pycache__",
  ".next", "dist", "vendor", "build",
  ".venv", "venv", ".cache", ".ruff_cache",
  ".pytest_cache", ".mypy_cache", ".tox",
  "zig-out", "zig-cache",
]);

function filterTree(input: string): FilterResult | null {
  if (input.length === 0) return null;
  const raw = input.split("\n");
  if (raw.at(-1) === "") raw.pop();
  if (raw.length <= 20 || raw.length === 0) return null;

  const totalIndex = raw.length - 1;
  if (!isTotalsLine(raw[totalIndex] ?? "")) return null;

  const entries = raw.slice(0, totalIndex);
  if (entries.length === 0 || !isRootEntry(entries[0] ?? "") || entries.slice(1).some((line) => !parseBranch(line))) return null;

  const out: string[] = [];
  let omittedSubtrees = 0;
  let noiseDepth = -1;
  for (const line of entries) {
    const branch = parseBranch(line);
    if (!branch) {
      out.push(line);
      continue;
    }
    if (noiseDepth >= 0 && branch.depth > noiseDepth) continue;
    if (noiseDepth >= 0) noiseDepth = -1;
    if (NOISE_DIRS.has(branch.name) || NOISE_DIRS.has(branch.name.replace(/\/$/, ""))) {
      omittedSubtrees++;
      noiseDepth = branch.depth;
      continue;
    }
    out.push(line);
  }

  if (omittedSubtrees === 0) return null;
  out.push(`[${omittedSubtrees} noise subtree${omittedSubtrees === 1 ? "" : "s"} omitted]`);
  out.push(raw[totalIndex] ?? "");
  const result = out.join("\n");
  return result.length < input.length ? { output: result, category: "fast" } : null;
}

interface TreeBranch { depth: number; name: string }

function parseBranch(line: string): TreeBranch | null {
  const match = line.match(/^((?:│   |    )*)(?:├── |└── )(.*)$/);
  if (!match) return null;
  const name = match[2] ?? "";
  if (name.length === 0) return null;
  return { depth: (match[1]?.length ?? 0) / 4 + 1, name };
}

function isRootEntry(line: string): boolean {
  if (line.length === 0 || /[\u0000-\u001f\u007f\r]/.test(line)) return false;
  return !line.startsWith(" ") && !line.includes("──") &&
    !/^(?:tree|find|grep|rg):\s/i.test(line) &&
    !/(?:permission denied|no such file|error opening|not found)/i.test(line);
}

function isTotalsLine(line: string): boolean {
  return /^\d+ director(?:y|ies), \d+ files?$/.test(line) || /^\d+ files?$/.test(line);
}

registerFilter("tree", filterTree, "fast");
