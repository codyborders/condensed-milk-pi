#!/usr/bin/env node
/**
 * Full free dry-run driver.
 *
 * Prepares one unique run under evaluation/runs (gitignored), executes
 * all 40 fake attempts through the public CLI, writes the report, and
 * asserts the run invariants: 20 valid pairs and no attempt spawned
 * twice. Prints the private run path. Never touches credentials and
 * never makes provider calls.
 */

import { spawnSync } from "node:child_process";
import { existsSync, mkdirSync, readFileSync, readdirSync } from "node:fs";
import { fileURLToPath } from "node:url";
import { dirname, join } from "node:path";

const repoRoot = join(dirname(fileURLToPath(import.meta.url)), "..", "..");
const cli = join(repoRoot, "evaluation", "runner", "cli.mjs");
const runsRoot = join(repoRoot, "evaluation", "runs");

function runCli(args) {
  const result = spawnSync(process.execPath, [cli, ...args], {
    cwd: repoRoot,
    encoding: "utf8",
    timeout: 600_000,
  });
  if (result.status !== 0) {
    process.stderr.write(`dry-run: cli ${args.join(" ")} failed (${result.status}): ${(result.stderr || "").slice(0, 500)}\n`);
    process.exit(1);
  }
  return result.stdout;
}

mkdirSync(runsRoot, { recursive: true });
const runId = `dry-${new Date().toISOString().replace(/[-:.TZ]/g, "").slice(0, 14)}-${process.pid}`;
const runDir = join(runsRoot, runId);

runCli(["prepare", "--runs-dir", runsRoot, "--run-id", runId]);
runCli(["dry-run", "--runs-dir", runsRoot, "--run-id", runId, "--all"]);
runCli(["report", "--runs-dir", runsRoot, "--run-id", runId]);

const summary = JSON.parse(readFileSync(join(runDir, "summary.json"), "utf8"));
const checksPass =
  summary.pairs.valid === 20 &&
  summary.slots.executed === 40 &&
  summary.checks.noDuplicateInvocations === true;

process.stdout.write(`${JSON.stringify({ runId, runDir, slots: summary.slots, pairsValid: summary.pairs.valid, checks: summary.checks })}\n`);
if (!checksPass) {
  process.stderr.write(`dry-run: invariants failed: ${JSON.stringify(summary)}\n`);
  process.exit(1);
}
void existsSync;
void readdirSync;
