/**
 * Real-run collection-error stop test
 * (public boundary: evaluation/runner/cli.mjs run -> real.mjs).
 *
 * Fake-only and offline: a loopback fake upstream, scenario-driven fake
 * Pi runtime (nonzero = plain task failure, corrupt-git = collection
 * error). Contract: a collection-error attempt is an infrastructure
 * stop (nonzero exit, no further arms reserved), while an earlier plain
 * task failure keeps the run going.
 */

import { test, describe } from "node:test";
import assert from "node:assert/strict";
import { fileURLToPath } from "node:url";
import { dirname, join } from "node:path";
import { existsSync, mkdtempSync, readdirSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { spawn, spawnSync } from "node:child_process";
import { startFakeUpstream, writeCredentialSource } from "./real-attempt-fakes.mjs";
import { readJson, journalEvents, makeScenarioPiRuntime, prepareRealRun } from "./real-multi.test.mjs";

const repoRoot = join(dirname(fileURLToPath(import.meta.url)), "..", "..");
const cli = join(repoRoot, "evaluation", "runner", "cli.mjs");

describe("real run collection-error stop", () => {
  test("collection-error stops the run while an earlier plain task failure continues", { timeout: 240_000 }, async () => {
    const work = mkdtempSync(join(tmpdir(), "cm-infra-collect-"));
    const runsDir = join(work, "runs");
    const cacheDir = join(work, "cache");
    const runId = "infra-collect-01";
    let upstream = null;
    try {
      prepareRealRun(runsDir, runId);
      const runDir = join(runsDir, runId);
      const firstArm = readJson(join(runDir, "run.json")).armOrder["task-02"][0];
      const manifest = readJson(join(repoRoot, "evaluation", "task-manifest.json"));
      const promptOf = (taskId) => manifest.tasks.find((entry) => entry.id === taskId).prompt;
      const solutionOf = (taskId) => readJson(join(repoRoot, "evaluation", "scorers", "solutions", `${taskId}.json`));
      upstream = await startFakeUpstream();
      const credentialSource = join(work, "models.json");
      writeCredentialSource(credentialSource, `http://127.0.0.1:${upstream.port}`);
      // Manifest order runs task-01 before task-02: task-01 fails plainly on
      // both arms and must continue; task-02's first arm corrupts its git and
      // must stop the run.
      const piRuntime = makeScenarioPiRuntime(cacheDir, [
        { match: promptOf("task-01").slice(0, 60), behavior: "nonzero", solution: solutionOf("task-01") },
        { match: promptOf("task-02").slice(0, 60), behavior: "corrupt-git", solution: solutionOf("task-02") },
      ]);

      const runResult = await new Promise((resolve) => {
        const child = spawn(process.execPath, [
          cli, "run", "--runs-dir", runsDir, "--run-id", runId, "--task", "task-01", "--task", "task-02",
          "--confirm-paid", "--credential-source", credentialSource,
          "--cache-dir", cacheDir, "--pi-runtime", piRuntime, "--timeout-ms", "60000",
        ], { cwd: repoRoot });
        let stdout = "";
        let stderr = "";
        child.stdout.on("data", (chunk) => {
          stdout += chunk;
        });
        child.stderr.on("data", (chunk) => {
          stderr += chunk;
        });
        child.on("error", (error) => resolve({ status: 1, stdout, stderr: `${stderr}${error.message}` }));
        child.on("close", (code) => resolve({ status: code, stdout, stderr }));
      });
      assert.notEqual(runResult.status, 0, `a collection error must stop the run with a nonzero exit: ${runResult.stderr.slice(0, 400)}`);

      const summary = JSON.parse(runResult.stdout.trim().split("\n").pop());
      assert.equal(summary.infrastructureFailed, true);
      assert.equal(summary.outcomes.length, 3, "both task-01 arms run; the task-02 collection error stops the rest");
      for (const outcome of summary.outcomes.slice(0, 2)) {
        assert.equal(outcome.taskId, "task-01");
        assert.equal(outcome.status, "failed", `a plain task failure must not stop the run: ${JSON.stringify(outcome)}`);
      }
      assert.equal(summary.outcomes[2].taskId, "task-02");
      assert.equal(summary.outcomes[2].arm, firstArm);
      assert.equal(summary.outcomes[2].status, "collection-error");
      assert.equal(summary.stopped.taskId, "task-02");
      assert.equal(summary.stopped.arm, firstArm);
      assert.equal(summary.stopped.status, "collection-error");

      const task01Dir = join(runDir, "attempts", "task-01");
      for (const arm of readdirSync(task01Dir)) {
        assert.equal(
          existsSync(join(task01Dir, arm, "attempt-001", "invocations.jsonl")),
          true,
          `task-01/${arm} must have been invoked before the stop`,
        );
      }
      const events = journalEvents(runDir);
      assert.equal(
        events.some((event) => event.type === "attempt-reserved" && event.taskId === "task-02" && event.arm !== firstArm),
        false,
        "the second arm of the collected-error task must never be reserved",
      );
      const snapshot = readJson(join(runDir, "snapshot.json"));
      assert.equal(snapshot.selection["task-01:upstream"], undefined, "a failed task never auto-selects");
    } finally {
      if (upstream) await upstream.close();
      spawnSync("git", ["-C", repoRoot, "worktree", "prune"]);
      rmSync(work, { recursive: true, force: true });
    }
  });
});
