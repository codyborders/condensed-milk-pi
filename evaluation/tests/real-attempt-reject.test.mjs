/**
 * Real attempt upstream rejection tests
 * (boundary: evaluation/runner/real-attempt.mjs executeRealAttempt).
 *
 * Fake-only: the loopback fake upstream answers 401. The proxy streams
 * the rejection through, Pi exits nonzero, and the attempt reaches a
 * terminal failure with proxy telemetry that stores no bodies.
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

describe("real attempt upstream rejection", () => {
  test("an upstream rejection reaches a terminal failure without storing bodies or keys", { timeout: 120_000 }, async () => {
    const work = mkdtempSync(join(tmpdir(), "cm-real-reject-"));
    const upstream = await startFakeUpstream({ mode: "reject" });
    try {
      const credentialSource = join(work, "models.json");
      writeCredentialSource(credentialSource, `http://127.0.0.1:${upstream.port}`);
      const { verifyArmWorktree } = await import(join(repoRoot, "evaluation", "runner", "real-runtime.mjs"));
      const armInfo = verifyArmWorktree({ repoRoot, arm: UPSTREAM_ARM, cacheRoot: join(work, "cache") });
      const { solution } = loadTaskData(repoRoot, TASK.id);
      const piCliPath = makeFakePiRuntime(join(work, "cache"), { behavior: "ok", solution });
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

      assert.equal(upstream.seen.length, 1);
      assert.equal(upstream.seen[0].headers["x-api-key"], SENTINEL_KEY);

      const result = readJson(join(attemptDir, "result.json"));
      assert.equal(result.status, "failed");
      assert.equal(result.exit.code, 4, "the fake Pi surfaces the upstream rejection as a nonzero exit");
      assert.deepEqual(result.usage, { input: null, output: null, cacheRead: null, cacheWrite: null }, "no assistant usage happened");
      assert.equal(result.scorer.status, "failed", "no solution was applied");
      assert.equal(result.proxy.requestCount, 1);

      const proxy = readJson(join(attemptDir, "proxy.json"));
      assert.equal(proxy.requests.length, 1);
      assert.equal(proxy.requests[0].status, 401, "the upstream rejection status is recorded");
      const proxyFlat = JSON.stringify(proxy);
      assert.ok(!proxyFlat.includes("UPSTREAM-ERROR-MARKER"), "rejection bodies must never be stored");
      assert.ok(!proxyFlat.includes(SENTINEL_KEY), "the key must never be stored");
      assert.equal(existsSync(join(attemptDir, "agent", "models.json")), false);
      assert.equal(readJson(join(attemptDir, "final-state.json")).status, "collected");
    } finally {
      await upstream.close();
      spawnSync("git", ["-C", repoRoot, "worktree", "prune"]);
      rmSync(work, { recursive: true, force: true });
    }
  });
});
