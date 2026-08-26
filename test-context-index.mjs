#!/usr/bin/env node
import { spawnSync } from "node:child_process";
import { mkdtempSync, writeFileSync, readFileSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";

const tmp = mkdtempSync(join(tmpdir(), "cm-context-index-"));
writeFileSync(join(tmp, "context-compress.ts"), readFileSync("filters/context-compress.ts", "utf8"));
writeFileSync(join(tmp, "profiles.ts"), readFileSync("filters/profiles.ts", "utf8"));
const tsc = spawnSync("./node_modules/.bin/tsc", [ "--target", "es2022", "--module", "esnext", "--moduleResolution", "bundler", "--skipLibCheck", "--strict", "false", "--noImplicitAny", "false", "--outDir", tmp, join(tmp, "context-compress.ts")], { encoding: "utf8" });
if (tsc.status !== 0) { console.error(tsc.stdout, tsc.stderr); process.exit(1); }
const { compressStaleToolResults, parseCdPrefix, resolveRules, emptyUserConfig, decideCutoff } = await import(join(tmp, "context-compress.js"));
const firstCutoff = decideCutoff(100, { thresholds: [0.2, 0.5], coverage: [0.4, 0.8], contextUsage: 0.2, previousCutoff: 0, zoneEntered: -1 });
const nextCutoff = decideCutoff(200, { thresholds: [0.2, 0.5], coverage: [0.4, 0.8], contextUsage: 0.5, previousCutoff: firstCutoff.cutoffIdx, zoneEntered: firstCutoff.activeZone });
if (nextCutoff.cutoffIdx < firstCutoff.cutoffIdx) throw new Error("cutoff regressed");
if (parseCdPrefix('cd "repo with spaces" && git status').cwd !== "repo with spaces" || parseCdPrefix('cd "repo with spaces" && git status').cmd !== "git status") throw new Error("double-quoted cwd parsing failed");
if (parseCdPrefix("cd repo\\ with\\ spaces && git status").cwd !== "repo with spaces" || parseCdPrefix("cd repo\\ with\\ spaces && git status").cmd !== "git status") throw new Error("escaped-space cwd parsing failed");
if (parseCdPrefix("cd /repo\t&& git status").cwd !== "/repo" || parseCdPrefix("cd /repo\t&& git status").cmd !== "git status") throw new Error("tab whitespace parsing failed");
const rules = resolveRules(emptyUserConfig());
const long = "x".repeat(200);
const bash = (command) => ({ role: "toolResult", toolName: "bash", isError: false, details: { command }, content: [{ type: "text", text: long }] });
const output = compressStaleToolResults([{ role: "user", content: [{ type: "text", text: "turn" }] }, bash('cd "$REPO" && git status'), bash('cd "$REPO" && git add file')], { thresholds: [1], coverage: [0.5], contextUsage: 0, previousCutoff: 1, zoneEntered: -1, rules });
if (output && (output.messages[0].content?.[0]?.text ?? "").startsWith("[cm-masked bash]")) throw new Error("unresolved cwd was not conservative");
const priorInvalidator = compressStaleToolResults([{ role: "user", content: [{ type: "text", text: "turn" }] }, bash('cd "repo with spaces" && git add file'), bash('cd "repo with spaces" && git status')], { thresholds: [1], coverage: [0.5], contextUsage: 0, previousCutoff: 1, zoneEntered: -1, rules });
if (priorInvalidator && (priorInvalidator.messages[2].content?.[0]?.text ?? "").startsWith("[cm-masked bash]")) throw new Error("prior invalidator masked later status");
const quotedSame = compressStaleToolResults([{ role: "user", content: [{ type: "text", text: "turn" }] }, bash('cd "repo with spaces" && git status'), bash('cd "repo with spaces" && git add file')], { thresholds: [1], coverage: [0.5], contextUsage: 0, previousCutoff: 1, zoneEntered: -1, rules });
if (!quotedSame || !(quotedSame.messages[1].content?.[0]?.text ?? "").startsWith("[cm-masked bash]")) throw new Error("same quoted cwd did not invalidate");
const isolated = compressStaleToolResults([{ role: "user", content: [{ type: "text", text: "turn" }] }, bash("cd /repo-one && git status"), bash("cd /repo-two && git add file")], { thresholds: [1], coverage: [0.5], contextUsage: 0, previousCutoff: 1, zoneEntered: -1, rules });
if (isolated && (isolated.messages[1].content?.[0]?.text ?? "").startsWith("[cm-masked bash]")) throw new Error("cross-repository cwd isolation failed");
const deterministic = [{ role: "user", content: [{ type: "text", text: "turn" }] }, bash("cd /repo && git status"), bash("cd /repo && git add file")];
if (JSON.stringify(compressStaleToolResults(deterministic, { thresholds: [1], coverage: [0.5], contextUsage: 0, previousCutoff: 1, zoneEntered: -1, rules })) !== JSON.stringify(compressStaleToolResults(deterministic, { thresholds: [1], coverage: [0.5], contextUsage: 0, previousCutoff: 1, zoneEntered: -1, rules }))) throw new Error("invalidation output was not deterministic");
const makeDense = (count) => [
  { role: "user", content: [{ type: "text", text: "turn" }] },
  ...Array.from({ length: count }, () => bash("cd /dense && git add file")),
  ...Array.from({ length: count }, () => bash("cd /dense && git status")),
];
const denseTimed = (count) => {
  const started = Date.now();
  compressStaleToolResults(makeDense(count), { thresholds: [1], coverage: [0.5], contextUsage: 0, previousCutoff: 1, zoneEntered: -1, rules });
  return Date.now() - started;
};
const denseMedian = (count) => {
  denseTimed(count);
  const samples = [denseTimed(count), denseTimed(count), denseTimed(count)].sort((a, b) => a - b);
  return samples[1];
};
const denseSmallMs = denseMedian(1000);
const denseLargeMs = denseMedian(4000);
console.log("dense timings", denseSmallMs, denseLargeMs);
if (denseLargeMs > denseSmallMs * 4 + 20) throw new Error(`dense invalidation scaling regressed: ${denseSmallMs}ms to ${denseLargeMs}ms`);
const makeBranch = (count) => [
  { role: "user", content: [{ type: "text", text: "turn" }] },
  ...Array.from({ length: count }, () => bash("cd /repo && git status")),
  bash("cd /repo && git add file"),
];
const timed = (count) => {
  const started = Date.now();
  compressStaleToolResults(makeBranch(count), { thresholds: [1], coverage: [0.5], contextUsage: 0, previousCutoff: 1, zoneEntered: -1, rules });
  return Date.now() - started;
};
const timings = [100, 1000, 5000, 10000].map((count) => [count, timed(count)]);
const smallMs = timings[1][1];
const largeMs = timings[2][1];
if (largeMs > smallMs * 12 + 500) throw new Error(`invalidation scaling regressed: ${smallMs}ms to ${largeMs}ms`);
if (timings.some(([, elapsed]) => elapsed >= 10000)) throw new Error(`invalidation timing exceeded bound: ${JSON.stringify(timings)}`);
console.log("timings", JSON.stringify(timings));
rmSync(tmp, { recursive: true, force: true });
console.log("unresolved cwd and scaling tests passed");
