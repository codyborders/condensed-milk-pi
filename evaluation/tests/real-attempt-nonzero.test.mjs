/**
 * Real attempt nonzero-exit fault tests
 * (boundary: evaluation/runner/real-attempt.mjs executeRealAttempt).
 *
 * Fake-only: fake Pi exits nonzero after emitting usage and applying
 * the reference solution. The attempt must reach a terminal "failed"
 * status with the full artifact set.
 */

import { test, describe } from "node:test";
import assert from "node:assert/strict";
import { fileURLToPath } from "node:url";
import { dirname, join } from "node:path";
import { existsSync, mkdirSync, mkdtempSync, readFileSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { spawnSync } from "node:child_process";
import { loadManifestFile, loadTaskData } from "../lib/manifest.mjs";
import { startFakeUpstream, writeCredentialSource, makeFakePiRuntime, SENTINEL_KEY } from "./real-attempt-fakes.mjs";

const repoRoot = join(dirname(fileURLToPath(import.meta.url)), "..", "..");
const manifest = loadManifestFile(join(repoRoot, "evaluation", "task-manifest.json"));
const UPSTREAM_ARM = manifest.evaluation.arms.find((arm) => arm.name === "upstream");
const FIXTURE_DIR = join(repoRoot, "evaluation", "cache", "fixtures", "task-01");
const TASK = manifest.tasks.find((entry) => entry.id === "task-01");

function readJson(path) {
  return JSON.parse(readFileSync(path, "utf8"));
}

describe("real attempt nonzero exit", () => {
  test("a nonzero Pi exit is a terminal failure with complete artifacts", { timeout: 120_000 }, async () => {
    const work = mkdtempSync(join(tmpdir(), "cm-real-nonzero-"));
    const upstream = await startFakeUpstream();
    try {
      const credentialSource = join(work, "models.json");
      writeCredentialSource(credentialSource, `http://127.0.0.1:${upstream.port}`);
      const { verifyArmWorktree } = await import(join(repoRoot, "evaluation", "runner", "real-runtime.mjs"));
      const armInfo = verifyArmWorktree({ repoRoot, arm: UPSTREAM_ARM, cacheRoot: join(work, "cache") });
      const { solution } = loadTaskData(repoRoot, TASK.id);
      const piCliPath = makeFakePiRuntime(join(work, "cache"), { behavior: "nonzero", solution });
      const attemptDir = join(work, "attempt-001");
      mkdirSync(attemptDir, { recursive: true });

      const { executeRealAttempt } = await import(join(repoRoot, "evaluation", "runner", "real-attempt.mjs"));
      const outcome = await executeRealAttempt({
        repoRoot,
        manifest,
        task: TASK,
        arm: "upstream",
        armInfo,
        attemptDir,
        fixtureDir: FIXTURE_DIR,
        credentialSourcePath: credentialSource,
        piCliPath,
        timeoutMs: 60_000,
      });
      assert.equal(outcome.status, "failed");

      const result = readJson(join(attemptDir, "result.json"));
      assert.equal(result.status, "failed");
      assert.equal(result.exit.code, 3);
      assert.equal(result.exit.timedOut, false);
      assert.deepEqual(result.failures, ["exit 3"]);
      assert.deepEqual(result.usage, { input: 1150, output: 270, cacheRead: null, cacheWrite: 40 });
      assert.equal(result.scorer.status, "passed", "the scorer still runs on the settled worktree");
      assert.equal(readJson(join(attemptDir, "final-state.json")).status, "collected");
      assert.equal(existsSync(join(attemptDir, "pinned.json")), true);
      assert.equal(existsSync(join(attemptDir, "agent", "models.json")), false, "models.json is removed on the failure path too");
      assert.ok(!readFileSync(join(attemptDir, "proxy.json"), "utf8").includes(SENTINEL_KEY));
      assert.equal(readFileSync(join(attemptDir, "invocations.jsonl"), "utf8").trim().split("\n").length, 1);
    } finally {
      await upstream.close();
      spawnSync("git", ["-C", repoRoot, "worktree", "prune"]);
      rmSync(work, { recursive: true, force: true });
    }
  });
});
