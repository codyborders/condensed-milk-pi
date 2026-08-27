/**
 * Real multi-task execution tests (public boundary:
 * evaluation/runner/cli.mjs run -> real.mjs).
 *
 * Fake-only and offline: loopback fake z.ai upstream, scenario-driven
 * fake Pi runtime, fixture git worktrees, sentinel credential.
 *
 * Contract under test:
 * - repeated --task flags select several tasks in manifest order and
 *   every selected task pair executes (both arms, persisted order);
 * - arms never run concurrently; one paid call per attempt;
 * - progress streams to stderr, final JSON to stdout;
 * - raw private artifacts survive; the sentinel key never leaks;
 * - the real-mode report after two fake tasks shows slots and
 *   selected pairs.
 */

import { test, describe } from "node:test";
import assert from "node:assert/strict";
import { fileURLToPath } from "node:url";
import { dirname, join } from "node:path";
import { existsSync, readFileSync } from "node:fs";
import { spawnSync } from "node:child_process";
import {
  SENTINEL_KEY,
  journalEvents,
  collectFiles,
  readJson,
  runCliAsync,
  withFakeEnvironment,
} from "./real-multi.test.mjs";

const repoRoot = join(dirname(fileURLToPath(import.meta.url)), "..", "..");
const cli = join(repoRoot, "evaluation", "runner", "cli.mjs");

function runCli(args, extra = {}) {
  return spawnSync(process.execPath, [cli, ...args], {
    cwd: repoRoot,
    encoding: "utf8",
    timeout: 240_000,
    ...extra,
  });
}

function prepareRealRun(runsDir, runId) {
  const prepared = runCli(["prepare", "--runs-dir", runsDir, "--run-id", runId, "--mode", "real"]);
  assert.equal(prepared.status, 0, `prepare failed: ${prepared.stderr}`);
}

describe("real multi-task execution", () => {
  test("two selected tasks execute four attempts sequentially with one paid call each", async () => {
    await withFakeEnvironment("cm-multi-two-", ["task-01", "task-02"], async ({ runsDir, cacheDir, credentialSource, piRuntime, upstream }) => {
      const runId = "multi-two-01";
      prepareRealRun(runsDir, runId);
      const runDir = join(runsDir, runId);
      const armOrder = readJson(join(runDir, "run.json")).armOrder;

      const runResult = await runCliAsync([
        "run", "--runs-dir", runsDir, "--run-id", runId,
        "--task", "task-01", "--task", "task-02",
        "--confirm-paid", "--credential-source", credentialSource,
        "--cache-dir", cacheDir, "--pi-runtime", piRuntime, "--timeout-ms", "60000",
      ], { timeout: 240_000 });
      assert.equal(runResult.status, 0, `run failed: ${runResult.stderr.slice(0, 800)}`);
      assert.ok(runResult.stderr.includes("run:"), "incremental progress must stream to stderr");

      const summary = JSON.parse(runResult.stdout.trim().split("\n").pop());
      assert.deepEqual(summary.tasks, ["task-01", "task-02"], "selection keeps manifest order");
      assert.deepEqual(summary.slots, { planned: 4, executed: 4, skipped: 0 });
      assert.equal(summary.stopped, null);
      assert.equal(summary.infrastructureFailed, false);
      assert.equal(summary.outcomes.length, 4);
      for (const outcome of summary.outcomes) {
        const attemptDir = join(runDir, "attempts", outcome.taskId, outcome.arm, "attempt-001");
        const failedResult = existsSync(join(attemptDir, "result.json")) ? readJson(join(attemptDir, "result.json")) : null;
        const piStderr = existsSync(join(attemptDir, "pi-stderr.txt"))
          ? readFileSync(join(attemptDir, "pi-stderr.txt"), "utf8").slice(0, 600)
          : "";
        assert.equal(
          outcome.status,
          "completed",
          `attempt must complete: ${JSON.stringify(outcome)}; failures=${JSON.stringify(failedResult?.failures)}; exit=${JSON.stringify(failedResult?.exit)}; pi-stderr=${piStderr}`,
        );
      }

      const attemptsRoot = join(runDir, "attempts");
      for (const taskId of ["task-01", "task-02"]) {
        for (const arm of armOrder[taskId]) {
          const attemptDir = join(attemptsRoot, taskId, arm, "attempt-001");
          const result = readJson(join(attemptDir, "result.json"));
          assert.equal(result.status, "completed", `${taskId}/${arm} result`);
          assert.equal(result.scorer.status, "passed", `${taskId}/${arm} scorer`);
          assert.equal(readFileSync(join(attemptDir, "invocations.jsonl"), "utf8").trim().split("\n").length, 1);
          // Raw private artifacts survive per attempt.
          assert.ok(existsSync(join(attemptDir, "worktree")));
          assert.ok(existsSync(join(attemptDir, "final-state", "porcelain-v2.txt")));
          assert.ok(existsSync(join(attemptDir, "sessions")));
          assert.ok(existsSync(join(attemptDir, "proxy.json")));
          assert.ok(existsSync(join(attemptDir, "scorer.json")));
        }
      }
      assert.equal(upstream.seen.length, 4, "exactly one paid call per attempt");
      for (const seen of upstream.seen) {
        assert.equal(seen.headers["x-api-key"], SENTINEL_KEY, "the proxy must send the real key upstream");
      }

      // Arms never run concurrently: within each task the first arm
      // finishes before the second arm is reserved.
      const events = journalEvents(runDir);
      for (const taskId of ["task-01", "task-02"]) {
        const [firstArm, secondArm] = armOrder[taskId];
        const firstFinished = events.find(
          (event) => event.type === "attempt-finished" && event.taskId === taskId && event.arm === firstArm,
        );
        const secondReserved = events.find(
          (event) => event.type === "attempt-reserved" && event.taskId === taskId && event.arm === secondArm,
        );
        assert.ok(firstFinished, `first arm of ${taskId} must finish`);
        assert.ok(secondReserved, `second arm of ${taskId} must be reserved`);
        assert.ok(
          firstFinished.seq < secondReserved.seq,
          `${taskId}: ${firstArm} must finish before ${secondArm} is reserved`,
        );
      }

      // The sentinel key never reaches any artifact or the child env.
      for (const file of collectFiles(runDir)) {
        assert.ok(!file.body.includes(SENTINEL_KEY), `sentinel key leaked into ${file.path}`);
      }
      const firstAttemptDir = join(attemptsRoot, "task-01", armOrder["task-01"][0], "attempt-001");
      const recordedEnv = readJson(join(firstAttemptDir, "sessions", "record-env.json")).env;
      assert.ok(!JSON.stringify(recordedEnv).includes(SENTINEL_KEY), "sentinel must never enter the child environment");

      // Real-mode report after two fake tasks: slots and selected pairs.
      const report = runCli(["report", "--runs-dir", runsDir, "--run-id", runId]);
      assert.equal(report.status, 0, `report failed: ${report.stderr.slice(0, 400)}`);
      const reportSummary = readJson(join(runDir, "summary.json"));
      assert.equal(reportSummary.slots.total, 40);
      assert.equal(reportSummary.slots.completed, 4, "two completed pairs complete four slots");
      assert.equal(reportSummary.attempts.total, 4);
      assert.equal(reportSummary.pairs.valid, 2, "both selected pairs must be valid");
      assert.equal(reportSummary.pairs.incomplete, 18);
      assert.deepEqual(
        reportSummary.selection,
        {
          "task-01:upstream": 1,
          "task-01:fork": 1,
          "task-02:upstream": 1,
          "task-02:fork": 1,
        },
      );
    });
  });
});
