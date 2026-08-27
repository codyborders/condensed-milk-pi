import { registerFilter, type FilterResult } from "./dispatch.js";

function filterGitLog(input: string, command: string): FilterResult | null {
  if (input.length === 0) return null;
  // Any option can request details that this summary would discard. Preserve
  // patches, stats, decorations, graph data, signatures, notes, formatting,
  // short flags, and unknown options byte-for-byte.
  if (command.slice("git log".length).trim().length > 0) return null;

  const lines = input.split("\n");
  const out: string[] = [];
  let i = 0;
  while (i < lines.length) {
    if (lines[i] === "") { i++; continue; }
    const match = /^commit ([0-9a-f]{40})$/.exec(lines[i]);
    if (!match) return null;
    i++;
    let author = false;
    let date = false;
    while (i < lines.length && lines[i] !== "") {
      if (lines[i].startsWith("Author: ")) author = true;
      if (lines[i].startsWith("Date: ")) date = true;
      i++;
    }
    if (!author || !date) return null;
    while (i < lines.length && lines[i] === "") i++;
    if (i >= lines.length || !lines[i].startsWith("    ")) return null;
    const subject = lines[i].trim();
    if (subject.length === 0) return null;
    out.push(`${match[1]} ${subject}`);
    i++;
    while (i < lines.length && !/^commit /.test(lines[i])) i++;
    if (i < lines.length && !/^commit [0-9a-f]{40}$/.test(lines[i])) return null;
  }
  if (out.length === 0) return null;
  const result = out.join("\n");
  return result.length < input.length ? { output: result, category: "slow" } : null;
}

registerFilter("git log", filterGitLog, "slow");
