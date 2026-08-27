/**
 * Runner CLI tests (public boundary: evaluation/runner/cli.mjs).
 *
 * Scope:
 * - validate checks the strict manifest and exits 0.
 */

import { test, describe } from "node:test";
import assert from "node:assert/strict";
import { fileURLToPath } from "node:url";
import { dirname, join } from "node:path";
import { mkdtempSync, rmSync, readFileSync, writeFileSync, existsSync, readdirSync, statSync } from "node:fs";
import { tmpdir } from "node:os";
import { spawnSync, spawn } from "node:child_process";
import { createHash } from "node:crypto";
import { loadManifestFile } from "../lib/manifest.mjs";
import { scorerDefinitionSha256 } from "../lib/scorer.mjs";

const repoRoot = join(dirname(fileURLToPath(import.meta.url)), "..", "..");
const cli = join(repoRoot, "evaluation", "runner", "cli.mjs");
const manifest = loadManifestFile(join(repoRoot, "evaluation", "task-manifest.json"));

export function runCli(args, extra = {}) {
  return spawnSync(process.execPath, [cli, ...args], {
    cwd: repoRoot,
    encoding: "utf8",
    ...extra,
  });
}

describe("runner CLI", () => {
  test("validate passes on the checked-in manifest", () => {
    assert.equal(manifest.tasks.length, 20);
    const validate = runCli(["validate"]);
    assert.equal(validate.status, 0, `validate failed: ${validate.stderr}`);
  });

  test("prepare persists per-task arm order before any attempt exists", () => {
    const runsDir = mkdtempSync(join(tmpdir(), "cm-eval-runner-"));
    try {
      const prepare = runCli(["prepare", "--runs-dir", runsDir, "--run-id", "run-cli-01"]);
      assert.equal(prepare.status, 0, `prepare failed: ${prepare.stderr}`);
      const runDir = join(runsDir, "run-cli-01");
      const run = JSON.parse(readFileSync(join(runDir, "run.json"), "utf8"));
      assert.equal(run.runId, "run-cli-01");
      assert.equal(run.mode, "dry-run");
      assert.equal(Object.keys(run.armOrder).length, 20);
      for (const [taskId, order] of Object.entries(run.armOrder)) {
        assert.equal(order.length, 2, `${taskId} needs both arms`);
        assert.ok(order.includes("upstream") && order.includes("fork"));
      }
      assert.equal(existsSync(join(runDir, "attempts")), false);
      assert.ok(existsSync(join(runDir, "journal.jsonl")));
      assert.ok(existsSync(join(runDir, "snapshot.json")));
    } finally {
      rmSync(runsDir, { recursive: true, force: true });
    }
  });

  test("dry-run executes one fake attempt end to end for a single arm", () => {
    const runsDir = mkdtempSync(join(tmpdir(), "cm-eval-runner-"));
    try {
      assert.equal(runCli(["prepare", "--runs-dir", runsDir, "--run-id", "run-cli-02"]).status, 0);
      const dry = runCli([
        "dry-run", "--task", "task-01", "--arm", "upstream",
        "--runs-dir", runsDir, "--run-id", "run-cli-02",
      ]);
      assert.equal(dry.status, 0, `dry-run failed: ${dry.stderr.slice(0, 500)}`);
      assert.ok(dry.stdout.includes("runId"), "must emit run id");
      const attemptDir = join(runsDir, "run-cli-02", "attempts", "task-01", "upstream", "attempt-001");
      const result = JSON.parse(readFileSync(join(attemptDir, "result.json"), "utf8"));
      assert.equal(result.status, "completed");
      assert.equal(result.scorer.status, "passed");
      assert.ok(existsSync(join(attemptDir, "worktree", "stats.py")));
    } finally {
      rmSync(runsDir, { recursive: true, force: true });
    }
  });

  test("dry-run executes both arms of one task in the persisted order", () => {
    const runsDir = mkdtempSync(join(tmpdir(), "cm-eval-runner-"));
    try {
      assert.equal(runCli(["prepare", "--runs-dir", runsDir, "--run-id", "run-cli-03"]).status, 0);
      const dry = runCli(["dry-run", "--task", "task-01", "--runs-dir", runsDir, "--run-id", "run-cli-03"]);
      assert.equal(dry.status, 0, `dry-run failed: ${dry.stderr.slice(0, 500)}`);
      const order = JSON.parse(readFileSync(join(runsDir, "run-cli-03", "run.json"), "utf8")).armOrder["task-01"];
      assert.equal(order.length, 2);
      for (const arm of order) {
        const attemptDir = join(runsDir, "run-cli-03", "attempts", "task-01", arm, "attempt-001");
        const result = JSON.parse(readFileSync(join(attemptDir, "result.json"), "utf8"));
        assert.equal(result.status, "completed", `${arm} failed: ${JSON.stringify(result.failures)}`);
        assert.equal(result.scorer.status, "passed");
        assert.equal(readFileSync(join(attemptDir, "invocations.jsonl"), "utf8").trim().split("\n").length, 1);
      }
    } finally {
      rmSync(runsDir, { recursive: true, force: true });
    }
  });

  test("dry-run --all executes and scores all 40 attempts", () => {
    const runsDir = mkdtempSync(join(tmpdir(), "cm-eval-runner-"));
    try {
      assert.equal(runCli(["prepare", "--runs-dir", runsDir, "--run-id", "run-cli-04"]).status, 0);
      const dry = runCli(["dry-run", "--runs-dir", runsDir, "--run-id", "run-cli-04", "--all"], { timeout: 600_000 });
      assert.equal(dry.status, 0, `dry-run --all failed: ${dry.stderr.slice(0, 500)}`);
      assert.ok(dry.stdout.includes('"executed":40'), `stdout: ${dry.stdout.slice(0, 200)}`);
      const attemptsRoot = join(runsDir, "run-cli-04", "attempts");
      assert.equal(readdirSync(attemptsRoot).length, 20);
      let attemptDirs = 0;
      let scoredPassed = 0;
      for (const taskId of readdirSync(attemptsRoot)) {
        for (const arm of ["upstream", "fork"]) {
          const numbers = readdirSync(join(attemptsRoot, taskId, arm));
          attemptDirs += numbers.length;
          for (const number of numbers) {
            const result = JSON.parse(readFileSync(join(attemptsRoot, taskId, arm, number, "result.json"), "utf8"));
            if (result.scorer.status === "passed") scoredPassed += 1;
          }
        }
      }
      assert.equal(attemptDirs, 40);
      assert.equal(scoredPassed, 40, "every dry-run attempt must pass its scorer");
    } finally {
      rmSync(runsDir, { recursive: true, force: true });
    }
  });

  test("crash after reservation never respawns; retry creates a new immutable attempt", () => {
    const runsDir = mkdtempSync(join(tmpdir(), "cm-eval-runner-"));
    const runDir = join(runsDir, "run-cli-05");
    try {
      assert.equal(runCli(["prepare", "--runs-dir", runsDir, "--run-id", "run-cli-05"]).status, 0);
      const order = JSON.parse(readFileSync(join(runDir, "run.json"), "utf8")).armOrder["task-01"];
      const crash = runCli(["dry-run", "--runs-dir", runsDir, "--run-id", "run-cli-05", "--task", "task-01", "--crash-after", "first"]);
      assert.equal(crash.status, 70, `simulated crash must exit 70, got ${crash.status}`);
      const first = join(runDir, "attempts", "task-01", order[0], "attempt-001");
      assert.equal(readFileSync(join(first, "invocations.jsonl"), "utf8").trim().split("\n").length, 1);
      const second = join(runDir, "attempts", "task-01", order[1], "attempt-001");
      assert.equal(existsSync(join(second, "invocations.jsonl")), false, "reserved attempt must not have been invoked");

      const resume = runCli(["resume", "--runs-dir", runsDir, "--run-id", "run-cli-05"]);
      assert.equal(resume.status, 0, `resume failed: ${resume.stderr.slice(0, 300)}`);
      assert.equal(existsSync(join(second, "invocations.jsonl")), false, "resume must never spawn the reserved attempt");
      assert.equal(readFileSync(join(first, "invocations.jsonl"), "utf8").trim().split("\n").length, 1, "completed attempt must not be respawned");

      const denied = runCli(["retry", "--runs-dir", runsDir, "--run-id", "run-cli-05", "--task", "task-01", "--arm", order[1]]);
      assert.notEqual(denied.status, 0, "retry without the explicit flag must refuse");

      const retry = runCli(["retry", "--runs-dir", runsDir, "--run-id", "run-cli-05", "--task", "task-01", "--arm", order[1], "--allow-new-paid-attempt"]);
      assert.equal(retry.status, 0, `retry failed: ${retry.stderr.slice(0, 300)}`);
      const retryAttempt = join(runDir, "attempts", "task-01", order[1], "attempt-002");
      const retryResult = JSON.parse(readFileSync(join(retryAttempt, "result.json"), "utf8"));
      assert.equal(retryResult.status, "completed");
      assert.equal(retryResult.scorer.status, "passed");
      assert.equal(readFileSync(join(retryAttempt, "invocations.jsonl"), "utf8").trim().split("\n").length, 1);
      assert.equal(existsSync(join(second, "invocations.jsonl")), false, "original abandoned attempt stays uninvoked");
    } finally {
      rmSync(runsDir, { recursive: true, force: true });
    }
  });

  test("report aggregates pairs and excludes incomplete pairs", () => {
    const runsDir = mkdtempSync(join(tmpdir(), "cm-eval-runner-"));
    const runDir = join(runsDir, "run-cli-06");
    try {
      assert.equal(runCli(["prepare", "--runs-dir", runsDir, "--run-id", "run-cli-06"]).status, 0);
      assert.equal(runCli(["dry-run", "--runs-dir", runsDir, "--run-id", "run-cli-06", "--task", "task-02"]).status, 0);
      const report = runCli(["report", "--runs-dir", runsDir, "--run-id", "run-cli-06"]);
      assert.equal(report.status, 0, `report failed: ${report.stderr.slice(0, 300)}`);
      const summary = JSON.parse(readFileSync(join(runDir, "summary.json"), "utf8"));
      assert.equal(summary.runId, "run-cli-06");
      assert.equal(summary.slots.total, 40);
      assert.equal(summary.slots.completed, 2, "one completed pair completes exactly two slots");
      assert.equal(summary.attempts.total, 2, "attempts are counted separately from slots");
      assert.equal(summary.selection["task-02:upstream"], 1, "default selection is attempt-001");
      assert.equal(summary.pairs.valid, 1);
      assert.equal(summary.pairs.incomplete, 19, "pairs without both scored arms are excluded");
      const csv = readFileSync(join(runDir, "summary.csv"), "utf8");
      assert.ok(csv.includes("taskId,arm,attempt"));
      assert.ok(csv.split("\n").filter((line) => line.startsWith("task-02,")).length === 2);
      const markdown = readFileSync(join(runDir, "summary.md"), "utf8");
      assert.ok(markdown.includes("# Evaluation run run-cli-06"));
      assert.ok(markdown.includes("Pairs (valid / incomplete): 1 / 19"));
    } finally {
      rmSync(runsDir, { recursive: true, force: true });
    }
  });

  test("retry never auto-selects; pairs follow selection, not attempt directories", () => {
    const runsDir = mkdtempSync(join(tmpdir(), "cm-eval-runner-"));
    const runDir = join(runsDir, "run-cli-20");
    try {
      assert.equal(runCli(["prepare", "--runs-dir", runsDir, "--run-id", "run-cli-20"]).status, 0);
      assert.equal(
        runCli(["dry-run", "--runs-dir", runsDir, "--run-id", "run-cli-20", "--task", "task-01", "--arm", "upstream"]).status,
        0,
      );
      const retry = runCli([
        "retry", "--runs-dir", runsDir, "--run-id", "run-cli-20",
        "--task", "task-01", "--arm", "upstream", "--allow-new-paid-attempt",
      ]);
      assert.equal(retry.status, 0, `retry failed: ${retry.stderr.slice(0, 300)}`);
      assert.equal(
        runCli([
          "dry-run", "--runs-dir", runsDir, "--run-id", "run-cli-20",
          "--task", "task-01", "--arm", "fork", "--fault", "timeout",
        ], { timeout: 120_000 }).status,
        0,
      );
      const retryAfterTimeout = runCli([
        "retry", "--runs-dir", runsDir, "--run-id", "run-cli-20",
        "--task", "task-01", "--arm", "fork", "--allow-new-paid-attempt",
      ]);
      assert.equal(retryAfterTimeout.status, 0, `retry failed: ${retryAfterTimeout.stderr.slice(0, 300)}`);
      const forkRetry = JSON.parse(readFileSync(join(runDir, "attempts", "task-01", "fork", "attempt-002", "result.json"), "utf8"));
      assert.equal(forkRetry.status, "completed");
      assert.equal(forkRetry.scorer.status, "passed");
      assert.equal(
        runCli(["report", "--runs-dir", runsDir, "--run-id", "run-cli-20"]).status,
        0,
      );
      const summary = JSON.parse(readFileSync(join(runDir, "summary.json"), "utf8"));
      assert.deepEqual(summary.selection, { "task-01:upstream": 1 }, "attempt-002 must never claim selection, even for an unselected slot");
      assert.equal(summary.slots.completed, 1, "slots.completed counts selected completed attempts only");
      assert.equal(summary.attempts.total, 4, "every attempt directory is counted separately");
      assert.equal(summary.pairs.valid, 0, "a pair whose slot has no selection is not valid");
      assert.equal(summary.pairs.incomplete, 20);
    } finally {
      rmSync(runsDir, { recursive: true, force: true });
    }
  });

  test("select changes the slot's selected attempt after validating it is terminal", () => {
    const runsDir = mkdtempSync(join(tmpdir(), "cm-eval-runner-"));
    const runDir = join(runsDir, "run-cli-21");
    try {
      assert.equal(runCli(["prepare", "--runs-dir", runsDir, "--run-id", "run-cli-21"]).status, 0);
      assert.equal(
        runCli(["dry-run", "--runs-dir", runsDir, "--run-id", "run-cli-21", "--task", "task-01", "--arm", "upstream"]).status,
        0,
      );
      const retry = runCli([
        "retry", "--runs-dir", runsDir, "--run-id", "run-cli-21",
        "--task", "task-01", "--arm", "upstream", "--allow-new-paid-attempt",
      ]);
      assert.equal(retry.status, 0, `retry failed: ${retry.stderr.slice(0, 300)}`);
      const autoSnapshot = JSON.parse(readFileSync(join(runDir, "snapshot.json"), "utf8"));
      assert.equal(autoSnapshot.selection["task-01:upstream"], 1, "attempt-001 selection must persist at completion");
      const missing = runCli([
        "select", "--runs-dir", runsDir, "--run-id", "run-cli-21",
        "--task", "task-01", "--arm", "upstream", "--attempt", "3",
      ]);
      assert.notEqual(missing.status, 0, "selecting an attempt that does not exist must refuse");
      const select = runCli([
        "select", "--runs-dir", runsDir, "--run-id", "run-cli-21",
        "--task", "task-01", "--arm", "upstream", "--attempt", "2",
      ]);
      assert.equal(select.status, 0, `select failed: ${select.stderr.slice(0, 300)}`);
      assert.equal(
        runCli(["report", "--runs-dir", runsDir, "--run-id", "run-cli-21"]).status,
        0,
      );
      const summary = JSON.parse(readFileSync(join(runDir, "summary.json"), "utf8"));
      assert.equal(summary.selection["task-01:upstream"], 2, "explicit select must override attempt-001");
      assert.equal(summary.slots.completed, 1);
      assert.equal(summary.attempts.total, 2);
      const snapshot = JSON.parse(readFileSync(join(runDir, "snapshot.json"), "utf8"));
      assert.equal(snapshot.selection["task-01:upstream"], 2, "selection must persist in run state");
    } finally {
      rmSync(runsDir, { recursive: true, force: true });
    }
  });

  test("pinned-field mismatches make selected pairs invalid, not valid", () => {
    const runsDir = mkdtempSync(join(tmpdir(), "cm-eval-runner-"));
    const runDir = join(runsDir, "run-cli-22");
    const pinnedFor = (taskId, arm, overrides = {}) => {
      const task = manifest.tasks.find((entry) => entry.id === taskId);
      const armCommit = manifest.evaluation.arms.find((entry) => entry.name === arm).commit;
      return `${JSON.stringify({
        schemaVersion: 1,
        taskId,
        arm,
        promptSha256: createHash("sha256").update(task.prompt).digest("hex"),
        scorerSha256: scorerDefinitionSha256(repoRoot, taskId),
        provider: manifest.evaluation.provider,
        model: manifest.evaluation.model,
        thinking: manifest.evaluation.thinking,
        piVersion: manifest.evaluation.piVersion,
        armCommit,
        ...overrides,
      }, null, 2)}\n`;
    };
    try {
      assert.equal(runCli(["prepare", "--runs-dir", runsDir, "--run-id", "run-cli-22"]).status, 0);
      assert.equal(runCli(["dry-run", "--runs-dir", runsDir, "--run-id", "run-cli-22", "--task", "task-02"]).status, 0);
      assert.equal(runCli(["dry-run", "--runs-dir", runsDir, "--run-id", "run-cli-22", "--task", "task-03"]).status, 0);
      for (const [taskId, arm] of [["task-02", "upstream"], ["task-02", "fork"], ["task-03", "fork"]]) {
        writeFileSync(
          join(runDir, "attempts", taskId, arm, "attempt-001", "pinned.json"),
          pinnedFor(taskId, arm),
          "utf8",
        );
      }
      writeFileSync(
        join(runDir, "attempts", "task-02", "fork", "attempt-001", "pinned.json"),
        pinnedFor("task-02", "fork", { model: `${manifest.evaluation.model}-tampered` }),
        "utf8",
      );
      writeFileSync(
        join(runDir, "attempts", "task-03", "upstream", "attempt-001", "pinned.json"),
        pinnedFor("task-03", "upstream", {
          armCommit: manifest.evaluation.arms.find((entry) => entry.name === "fork").commit,
        }),
        "utf8",
      );
      assert.equal(runCli(["report", "--runs-dir", runsDir, "--run-id", "run-cli-22"]).status, 0);
      const summary = JSON.parse(readFileSync(join(runDir, "summary.json"), "utf8"));
      assert.equal(summary.pairs.valid, 0, "mismatched pinned fields must not enter valid pairs");
      assert.equal(summary.pairs.invalid, 2, "both mismatch kinds must be counted invalid");
      assert.equal(summary.pairs.incomplete, 18);
      assert.equal(summary.slots.completed, 4, "selection is unaffected by validity");
      const csv = readFileSync(join(runDir, "summary.csv"), "utf8");
      assert.ok(
        csv.split("\n").some((line) => line.startsWith("task-02,fork,1,") && line.endsWith(",false")),
        "invalid pairs must be marked false in the csv",
      );
    } finally {
      rmSync(runsDir, { recursive: true, force: true });
    }
  });

  test("fault timeout kills the fake Pi process group and records the timeout", () => {
    const runsDir = mkdtempSync(join(tmpdir(), "cm-eval-runner-"));
    const runDir = join(runsDir, "run-cli-07");
    try {
      assert.equal(runCli(["prepare", "--runs-dir", runsDir, "--run-id", "run-cli-07"]).status, 0);
      const dry = runCli([
        "dry-run", "--runs-dir", runsDir, "--run-id", "run-cli-07",
        "--task", "task-01", "--arm", "upstream", "--fault", "timeout",
      ], { timeout: 120_000 });
      assert.equal(dry.status, 0, `dry-run failed: ${dry.stderr.slice(0, 300)}`);
      const attemptDir = join(runDir, "attempts", "task-01", "upstream", "attempt-001");
      const result = JSON.parse(readFileSync(join(attemptDir, "result.json"), "utf8"));
      assert.equal(result.status, "timeout", `expected timeout status`);
      assert.equal(result.exit.timedOut, true);
      assert.ok(result.durationMs < 60_000, "timeout must be owned by the runner, not the CLI caller");
    } finally {
      rmSync(runsDir, { recursive: true, force: true });
    }
  });

  test("fault nonzero records a failed attempt with the child exit code", () => {
    const runsDir = mkdtempSync(join(tmpdir(), "cm-eval-runner-"));
    const runDir = join(runsDir, "run-cli-08");
    try {
      assert.equal(runCli(["prepare", "--runs-dir", runsDir, "--run-id", "run-cli-08"]).status, 0);
      const dry = runCli([
        "dry-run", "--runs-dir", runsDir, "--run-id", "run-cli-08",
        "--task", "task-01", "--arm", "upstream", "--fault", "nonzero",
      ], { timeout: 60_000 });
      assert.equal(dry.status, 0);
      const result = JSON.parse(readFileSync(join(runDir, "attempts", "task-01", "upstream", "attempt-001", "result.json"), "utf8"));
      assert.equal(result.status, "failed", `expected failed status`);
      assert.equal(result.exit.code, 3);
      assert.equal(result.exit.timedOut, false);
    } finally {
      rmSync(runsDir, { recursive: true, force: true });
    }
  });

  test("fault malformed keeps a completed attempt and counts malformed lines", () => {
    const runsDir = mkdtempSync(join(tmpdir(), "cm-eval-runner-"));
    const runDir = join(runsDir, "run-cli-09");
    try {
      assert.equal(runCli(["prepare", "--runs-dir", runsDir, "--run-id", "run-cli-09"]).status, 0);
      const dry = runCli([
        "dry-run", "--runs-dir", runsDir, "--run-id", "run-cli-09",
        "--task", "task-01", "--arm", "upstream", "--fault", "malformed",
      ], { timeout: 60_000 });
      assert.equal(dry.status, 0);
      const attemptDir = join(runDir, "attempts", "task-01", "upstream", "attempt-001");
      const result = JSON.parse(readFileSync(join(attemptDir, "result.json"), "utf8"));
      assert.equal(result.status, "completed", `expected completed status`);
      assert.ok(result.jsonl.malformedLines.length >= 1, "malformed final line must be counted");
      assert.ok(result.jsonl.lines > result.jsonl.malformedLines.length, "valid lines must still parse");
      assert.equal(result.scorer.status, "passed", "solution must still be applied");
    } finally {
      rmSync(runsDir, { recursive: true, force: true });
    }
  });

  test("npm run evaluation:dry-run executes 40 attempts and asserts 20 valid pairs", () => {
    const npm = spawnSync("npm", ["run", "evaluation:dry-run"], {
      cwd: repoRoot,
      encoding: "utf8",
      timeout: 600_000,
    });
    assert.equal(npm.status, 0, `evaluation:dry-run failed: ${(npm.stderr || "").slice(0, 400)}`);
    assert.ok(npm.stdout.includes('"pairsValid":20'), `summary line missing: ${npm.stdout.slice(-400)}`);
    assert.ok(npm.stdout.includes("runDir"), "must print its private run path");
  });

  test("npm run evaluation:fixtures regenerates the deterministic cache", () => {
    const npm = spawnSync("npm", ["run", "evaluation:fixtures"], {
      cwd: repoRoot,
      encoding: "utf8",
      timeout: 300_000,
    });
    assert.equal(npm.status, 0, `evaluation:fixtures failed: ${(npm.stderr || "").slice(0, 400)}`);
    assert.ok(npm.stdout.includes("fixtures: 20 tasks cached"), `summary missing: ${npm.stdout.slice(-300)}`);
    assert.ok(npm.stdout.includes("treeSha256"), "must print per-task tree hashes");
  });

  test("report --latest regenerates a report for the newest run", () => {
    const report = runCli(["report", "--latest"]);
    assert.equal(report.status, 0, `report --latest failed: ${report.stderr.slice(0, 300)}`);
    assert.ok(report.stdout.includes('"runId"'), `must print summary: ${report.stdout.slice(0, 200)}`);
  });

  test("fault missing-usage keeps every usage field null", () => {
    const runsDir = mkdtempSync(join(tmpdir(), "cm-eval-runner-"));
    const runDir = join(runsDir, "run-cli-10");
    try {
      assert.equal(runCli(["prepare", "--runs-dir", runsDir, "--run-id", "run-cli-10"]).status, 0);
      const dry = runCli([
        "dry-run", "--runs-dir", runsDir, "--run-id", "run-cli-10",
        "--task", "task-01", "--arm", "upstream", "--fault", "missing-usage",
      ], { timeout: 60_000 });
      assert.equal(dry.status, 0);
      const result = JSON.parse(readFileSync(join(runDir, "attempts", "task-01", "upstream", "attempt-001", "result.json"), "utf8"));
      assert.equal(result.status, "completed");
      assert.equal(result.usage.input, null, "input must stay null");
      assert.equal(result.usage.output, null, "output must stay null");
      assert.equal(result.usage.cacheRead, null);
      assert.equal(result.usage.cacheWrite, null);
      assert.equal(result.scorer.status, "passed", "solution must still be applied");
    } finally {
      rmSync(runsDir, { recursive: true, force: true });
    }
  });

  test("fault interrupted records the interruption signal", () => {
    const runsDir = mkdtempSync(join(tmpdir(), "cm-eval-runner-"));
    const runDir = join(runsDir, "run-cli-11");
    try {
      assert.equal(runCli(["prepare", "--runs-dir", runsDir, "--run-id", "run-cli-11"]).status, 0);
      const dry = runCli([
        "dry-run", "--runs-dir", runsDir, "--run-id", "run-cli-11",
        "--task", "task-01", "--arm", "upstream", "--fault", "interrupted",
      ], { timeout: 60_000 });
      assert.equal(dry.status, 0);
      const result = JSON.parse(readFileSync(join(runDir, "attempts", "task-01", "upstream", "attempt-001", "result.json"), "utf8"));
      assert.equal(result.status, "interrupted", `expected interrupted status`);
      assert.equal(result.exit.signal, "SIGINT");
      assert.equal(result.exit.timedOut, false);
    } finally {
      rmSync(runsDir, { recursive: true, force: true });
    }
  });

  test("fault scorer-failure is a task failure, not a scorer error", () => {
    const runsDir = mkdtempSync(join(tmpdir(), "cm-eval-runner-"));
    const runDir = join(runsDir, "run-cli-12");
    try {
      assert.equal(runCli(["prepare", "--runs-dir", runsDir, "--run-id", "run-cli-12"]).status, 0);
      const dry = runCli([
        "dry-run", "--runs-dir", runsDir, "--run-id", "run-cli-12",
        "--task", "task-01", "--arm", "upstream", "--fault", "scorer-failure",
      ], { timeout: 60_000 });
      assert.equal(dry.status, 0);
      const attemptDir = join(runDir, "attempts", "task-01", "upstream", "attempt-001");
      const result = JSON.parse(readFileSync(join(attemptDir, "result.json"), "utf8"));
      assert.equal(result.status, "completed");
      assert.equal(result.scorer.status, "failed", "scorer must report task failure");
      assert.equal(result.scorer.error, null, "task failure must not be a scorer error");
      const raw = JSON.parse(readFileSync(join(attemptDir, "scorer.json"), "utf8"));
      assert.equal(raw.status, "failed");
      assert.equal(raw.error, null);
    } finally {
      rmSync(runsDir, { recursive: true, force: true });
    }
  });

  test("secret-bearing environment names and values never reach artifacts", () => {
    const runsDir = mkdtempSync(join(tmpdir(), "cm-eval-runner-"));
    const runDir = join(runsDir, "run-cli-13");
    try {
      assert.equal(runCli(["prepare", "--runs-dir", runsDir, "--run-id", "run-cli-13"]).status, 0);
      const dry = spawnSync(process.execPath, [
        cli, "dry-run", "--runs-dir", runsDir, "--run-id", "run-cli-13",
        "--task", "task-01", "--arm", "upstream",
      ], {
        cwd: repoRoot,
        encoding: "utf8",
        timeout: 60_000,
        env: { ...process.env, CM_EVAL_SECRET_TOKEN: ["sentinel", "abc", "123"].join("-") },
      });
      assert.equal(dry.status, 0, `dry-run failed: ${dry.stderr.slice(0, 300)}`);
      const attemptDir = join(runDir, "attempts", "task-01", "upstream", "attempt-001");
      const invocation = JSON.parse(readFileSync(join(attemptDir, "invocation.json"), "utf8"));
      assert.ok(Array.isArray(invocation.envKeys), "invocation metadata must list env key names only");
      const allText = collectFiles(attemptDir).join("\n");
      assert.ok(!allText.includes(["sentinel", "abc", "123"].join("-")), "secret value leaked into artifacts");
      assert.ok(!allText.includes("CM_EVAL_SECRET_TOKEN"), "secret-bearing env name leaked into artifacts");
    } finally {
      rmSync(runsDir, { recursive: true, force: true });
    }
  });

  test("fault multi-turn aggregates usage across every assistant message_end", () => {
    const runsDir = mkdtempSync(join(tmpdir(), "cm-eval-runner-"));
    const runDir = join(runsDir, "run-cli-14");
    try {
      assert.equal(runCli(["prepare", "--runs-dir", runsDir, "--run-id", "run-cli-14"]).status, 0);
      const dry = runCli([
        "dry-run", "--runs-dir", runsDir, "--run-id", "run-cli-14",
        "--task", "task-01", "--arm", "upstream", "--fault", "multi-turn",
      ], { timeout: 60_000 });
      assert.equal(dry.status, 0);
      const result = JSON.parse(readFileSync(join(runDir, "attempts", "task-01", "upstream", "attempt-001", "result.json"), "utf8"));
      assert.equal(result.usage.input, 35, `input must sum all message_end usages`);
      assert.equal(result.usage.output, 60, `output must sum all message_end usages`);
      assert.equal(result.usage.cacheRead, null, "absent fields stay null");
    } finally {
      rmSync(runsDir, { recursive: true, force: true });
    }
  });

  test("concurrent dry-run commands yield exactly one invocation and a receipt", async () => {
    const runsDir = mkdtempSync(join(tmpdir(), "cm-eval-runner-"));
    const runDir = join(runsDir, "run-cli-15");
    const args = [
      cli, "dry-run", "--runs-dir", runsDir, "--run-id", "run-cli-15",
      "--task", "task-01", "--arm", "upstream",
    ];
    try {
      assert.equal(runCli(["prepare", "--runs-dir", runsDir, "--run-id", "run-cli-15"]).status, 0);
      const first = spawn(process.execPath, args, { stdio: "pipe" });
      const second = spawn(process.execPath, args, { stdio: "pipe" });
      const [firstExit, secondExit] = await Promise.all([waitFor(first), waitFor(second)]);
      const codes = [firstExit, secondExit].sort();
      assert.equal(codes[0], 0, "one concurrent command must succeed");
      assert.notEqual(codes[1], 0, "the other concurrent command must refuse the lock");
      const attemptDir = join(runDir, "attempts", "task-01", "upstream", "attempt-001");
      const invocations = readFileSync(join(attemptDir, "invocations.jsonl"), "utf8").trim().split("\n");
      assert.equal(invocations.length, 1, "exactly one invocation may exist");
      assert.ok(existsSync(join(attemptDir, "provider-invocation.json")), "durable receipt must exist before spawn");
      const reserved = journalEvents(runDir).filter((event) => event.type === "attempt-reserved");
      assert.equal(reserved.length, 1, `exactly one reservation event may exist, got ${reserved.length}`);
    } finally {
      rmSync(runsDir, { recursive: true, force: true });
    }
  });

  test("each attempt appends exactly one attempt-reserved journal event", () => {
    const runsDir = mkdtempSync(join(tmpdir(), "cm-eval-runner-"));
    const runDir = join(runsDir, "run-cli-16");
    try {
      assert.equal(runCli(["prepare", "--runs-dir", runsDir, "--run-id", "run-cli-16"]).status, 0);
      const dry = runCli(["dry-run", "--runs-dir", runsDir, "--run-id", "run-cli-16", "--task", "task-01"]);
      assert.equal(dry.status, 0, `dry-run failed: ${dry.stderr.slice(0, 500)}`);
      const events = journalEvents(runDir);
      const reserved = events.filter((event) => event.type === "attempt-reserved");
      assert.equal(reserved.length, 2, `two attempts must reserve exactly twice, got ${reserved.length}`);
      const receipts = events.filter((event) => event.type === "invocation-receipt-written");
      assert.equal(receipts.length, 2, "every attempt must write one durable receipt event");
      const finished = events.filter((event) => event.type === "attempt-finished");
      assert.equal(finished.length, 2);
    } finally {
      rmSync(runsDir, { recursive: true, force: true });
    }
  });

  test("fault attempts reserve exactly once and write a receipt before spawn", () => {
    const runsDir = mkdtempSync(join(tmpdir(), "cm-eval-runner-"));
    const runDir = join(runsDir, "run-cli-17");
    try {
      assert.equal(runCli(["prepare", "--runs-dir", runsDir, "--run-id", "run-cli-17"]).status, 0);
      const dry = runCli([
        "dry-run", "--runs-dir", runsDir, "--run-id", "run-cli-17",
        "--task", "task-01", "--arm", "upstream", "--fault", "timeout",
      ], { timeout: 120_000 });
      assert.equal(dry.status, 0);
      const attemptDir = join(runDir, "attempts", "task-01", "upstream", "attempt-001");
      assert.ok(existsSync(join(attemptDir, "provider-invocation.json")), "fault attempts need a receipt too");
      const reserved = journalEvents(runDir).filter((event) => event.type === "attempt-reserved");
      assert.equal(reserved.length, 1, `fault attempt must reserve exactly once, got ${reserved.length}`);
    } finally {
      rmSync(runsDir, { recursive: true, force: true });
    }
  });

  test("retry awaits fault execution; terminal artifacts exist at process exit", () => {
    const runsDir = mkdtempSync(join(tmpdir(), "cm-eval-runner-"));
    const runDir = join(runsDir, "run-cli-18");
    try {
      assert.equal(runCli(["prepare", "--runs-dir", runsDir, "--run-id", "run-cli-18"]).status, 0);
      assert.equal(
        runCli(["dry-run", "--runs-dir", runsDir, "--run-id", "run-cli-18", "--task", "task-01", "--arm", "upstream"]).status,
        0,
      );
      const retry = runCli([
        "retry", "--runs-dir", runsDir, "--run-id", "run-cli-18",
        "--task", "task-01", "--arm", "upstream", "--fault", "timeout", "--allow-new-paid-attempt",
      ], { timeout: 120_000 });
      assert.equal(retry.status, 0, `retry failed: ${retry.stderr.slice(0, 500)}`);
      const attemptDir = join(runDir, "attempts", "task-01", "upstream", "attempt-002");
      const result = JSON.parse(readFileSync(join(attemptDir, "result.json"), "utf8"));
      assert.equal(result.status, "timeout", "execution must settle before the process exits");
      const snapshot = JSON.parse(readFileSync(join(runDir, "snapshot.json"), "utf8"));
      assert.equal(snapshot.attempts["task-01:upstream:2"].status, "timeout", "state writes must land before exit");
    } finally {
      rmSync(runsDir, { recursive: true, force: true });
    }
  });
  test("reserved-but-crashed attempts carry a durable receipt and no invocation", () => {
    const runsDir = mkdtempSync(join(tmpdir(), "cm-eval-runner-"));
    const runDir = join(runsDir, "run-cli-19");
    try {
      assert.equal(runCli(["prepare", "--runs-dir", runsDir, "--run-id", "run-cli-19"]).status, 0);
      const order = JSON.parse(readFileSync(join(runDir, "run.json"), "utf8")).armOrder["task-01"];
      const crash = runCli(["dry-run", "--runs-dir", runsDir, "--run-id", "run-cli-19", "--task", "task-01", "--crash-after", "first"]);
      assert.equal(crash.status, 70);
      const reserved = join(runDir, "attempts", "task-01", order[1], "attempt-001");
      assert.equal(existsSync(join(reserved, "invocations.jsonl")), false, "crash must happen before any invocation");
      assert.ok(
        existsSync(join(reserved, "provider-invocation.json")),
        "reservation itself must produce the durable receipt before any spawn",
      );
      const receipt = JSON.parse(readFileSync(join(reserved, "provider-invocation.json"), "utf8"));
      assert.equal(receipt.taskId, "task-01");
      assert.equal(receipt.arm, order[1]);
      assert.equal(receipt.attempt, 1);
    } finally {
      rmSync(runsDir, { recursive: true, force: true });
    }
  });
});

function waitFor(child) {
  return new Promise((resolve) => child.on("close", (code) => resolve(code)));
}

export function journalEvents(runDir) {
  return readFileSync(join(runDir, "journal.jsonl"), "utf8")
    .split("\n")
    .filter((line) => line.trim().length > 0)
    .map((line) => JSON.parse(line));
}

function collectFiles(directory) {
  const out = [];
  for (const name of readdirSync(directory)) {
    const path = join(directory, name);
    if (statSync(path).isDirectory()) out.push(...collectFiles(path));
    else out.push(readFileSync(path, "utf8"));
  }
  return out;
}
