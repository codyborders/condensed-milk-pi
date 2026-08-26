/**
 * Git mutation command filters: add, commit, push.
 *
 * These run 5-20x per session and produce verbose output the model never needs.
 * Zero risk — compressed output preserves success/failure + hash/branch.
 */
import { registerFilter, type FilterResult } from "./dispatch.js";

function filterGitAdd(_input: string): FilterResult | null {
  // git add normally succeeds silently. Never claim staging succeeded from arbitrary output.
  return null;
}

function filterGitCommit(input: string): FilterResult | null {
  if (/^nothing to commit, working tree clean\s*$/m.test(input.trim())) {
    return { output: "nothing to commit, working tree clean", category: "mutation" };
  }
  const match = /^\[([\w/.-]+)\s+([a-f0-9]{7,40})\]\s+(.+)$/m.exec(input);
  if (!match) return null;
  return { output: `commit ${match[2]} ${match[3].trim()}`, category: "mutation" };
}

function filterGitPush(input: string): FilterResult | null {
  if (/^Everything up-to-date\s*$/m.test(input.trim())) {
    return { output: "Everything up-to-date", category: "mutation" };
  }
  const destination = /^To (.+)$/m.exec(input);
  const ref = /^\s*(?:[0-9a-f]+\.\.[0-9a-f]+|\*\s+\[[^\]]+\]|\[[^\]]+\])\s+(.+ -> .+)(?:\s+\(.+\))?\s*$/m.exec(input);
  if (!destination || !ref) return null;
  return { output: `pushed To ${destination[1].trim()}; ${ref[1].trim()}`, category: "mutation" };
}

registerFilter("git add", filterGitAdd, "mutation");
registerFilter("git commit", filterGitCommit, "mutation");
registerFilter("git push", filterGitPush, "mutation");
