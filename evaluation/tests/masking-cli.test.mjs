/**
 * Masking study CLI tests (public boundary: evaluation/runner/cli.mjs).
 *
 * Covers the free path, paid preflight refusal, and run-id path safety.
 */

import { test, describe } from "node:test";
import assert from "node:assert/strict";
import { mkdtempSync, mkdirSync, rmSync, readFileSync, existsSync } from "node:fs";
import { tmpdir } from "node:os";
import { join, dirname } from "node:path";
import { fileURLToPath } from "node:url";
import { spawnSync } from "node:child_process";

const repoRoot = join(dirname(fileURLToPath(import.meta.url)), "..", "..");
const cli = join(repoRoot, "evaluation", "runner", "cli.mjs");

function runCli(args) {
  return spawnSync(process.execPath, [cli, ...args], { cwd: repoRoot, encoding: "utf8" });
}

describe("masking CLI", () => {
  test("run-id traversal refuses before an out-of-root lock can be created", () => {
    const work = mkdtempSync(join(tmpdir(), "cm-masking-cli-path-"));
    try {
      const runsDir = join(work, "runs");
      mkdirSync(runsDir);
      const attempted = runCli([
        "masking-run",
        "--runs-dir", runsDir,
        "--run-id", "../outside",
        "--confirm-paid",
      ]);
      assert.notEqual(attempted.status, 0);
      assert.match(attempted.stderr, /run id refused/);
      assert.equal(existsSync(join(work, "outside", "lock.d")), false, "traversal must not create or remove a lock outside runsDir");
    } finally {
      rmSync(work, { recursive: true, force: true });
    }
  });

  test("free masking path: validate, prepare, plan, dry-run, report; paid run refuses", () => {
    const runsDir = mkdtempSync(join(tmpdir(), "cm-masking-cli-"));
    try {
      const validate = runCli(["masking-validate"]);
      assert.equal(validate.status, 0, `masking-validate failed: ${validate.stderr}`);

      const prepare = runCli(["masking-prepare", "--runs-dir", runsDir, "--run-id", "masking-cli-01"]);
      assert.equal(prepare.status, 0, `masking-prepare failed: ${prepare.stderr}`);

      const plan = runCli(["masking-plan", "--runs-dir", runsDir, "--run-id", "masking-cli-01"]);
      assert.equal(plan.status, 0, `masking-plan failed: ${plan.stderr}`);
      const planned = JSON.parse(plan.stdout.trim().split("\n").pop());
      assert.equal(planned.planOnly, true);
      assert.equal(planned.provider, "z-ai");
      assert.equal(planned.model, "glm-5.3-flash");
      assert.equal(planned.repetitionsPerTask, 3);
      assert.equal(planned.tasks.length, 8);

      const dryRun = runCli(["masking-dry-run", "--runs-dir", runsDir, "--run-id", "masking-cli-01"]);
      assert.equal(dryRun.status, 0, `masking-dry-run failed: ${dryRun.stderr}`);
      assert.equal(JSON.parse(dryRun.stdout).executed, 48);

      const report = runCli(["masking-report", "--runs-dir", runsDir, "--run-id", "masking-cli-01"]);
      assert.equal(report.status, 0, `masking-report failed: ${report.stderr}`);
      const summary = JSON.parse(readFileSync(join(runsDir, "masking-cli-01", "masking-summary.json"), "utf8"));
      assert.equal(summary.passing, true);

      const paidPrepare = runCli(["masking-prepare", "--runs-dir", runsDir, "--run-id", "masking-paid-cli", "--mode", "real"]);
      assert.equal(paidPrepare.status, 0);
      const paidRun = runCli(["masking-run", "--runs-dir", runsDir, "--run-id", "masking-paid-cli", "--confirm-paid"]);
      assert.notEqual(paidRun.status, 0, "paid masking run must fail closed");
      assert.match(paidRun.stderr, /preflight refused/);
      assert.equal(existsSync(join(runsDir, "masking-paid-cli", "attempts")), false, "no reservation may exist");
    } finally {
      rmSync(runsDir, { recursive: true, force: true });
    }
  });
});
