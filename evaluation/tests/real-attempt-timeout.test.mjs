/**
 * Real attempt timeout cleanup tests
 * (boundary: evaluation/runner/real-attempt.mjs executeRealAttempt).
 *
 * Fake-only: fake Pi ignores SIGTERM with a stubborn grandchild. The
 * runner-owned timeout must tear down the whole process group, close
 * the proxy, remove models.json, and still write terminal artifacts.
 */

import { test, describe } from "node:test";
import assert from "node:assert/strict";
import { fileURLToPath } from "node:url";
import { dirname, join } from "node:path";
import { existsSync, mkdirSync, mkdtempSync, readFileSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { spawnSync } from "node:child_process";
import { loadManifestFile, loadTaskData } from "../lib/manifest.mjs";
import { startFakeUpstream, writeCredentialSource, makeFakePiRuntime } from "./real-attempt-fakes.mjs";

const repoRoot = join(dirname(fileURLToPath(import.meta.url)), "..", "..");
const manifest = loadManifestFile(join(repoRoot, "evaluation", "task-manifest.json"));
const UPSTREAM_ARM = manifest.evaluation.arms.find((arm) => arm.name === "upstream");
const FIXTURE_DIR = join(repoRoot, "evaluation", "cache", "fixtures", "task-01");
const TASK = manifest.tasks.find((entry) => entry.id === "task-01");

function readJson(path) {
  return JSON.parse(readFileSync(path, "utf8"));
}

describe("real attempt timeout cleanup", () => {
  test("a timeout tears down the process group, proxy, and credential file, then reaches terminal status", { timeout: 120_000 }, async () => {
    const work = mkdtempSync(join(tmpdir(), "cm-real-timeout-"));
    const upstream = await startFakeUpstream();
    try {
      const credentialSource = join(work, "models.json");
      writeCredentialSource(credentialSource, `http://127.0.0.1:${upstream.port}`);
      const { verifyArmWorktree } = await import(join(repoRoot, "evaluation", "runner", "real-runtime.mjs"));
      const armInfo = verifyArmWorktree({ repoRoot, arm: UPSTREAM_ARM, cacheRoot: join(work, "cache") });
      const { solution } = loadTaskData(repoRoot, TASK.id);
      const piCliPath = makeFakePiRuntime(join(work, "cache"), { behavior: "hang", solution });
      const attemptDir = join(work, "attempt-001");
      mkdirSync(attemptDir, { recursive: true });

      const { executeRealAttempt } = await import(join(repoRoot, "evaluation", "runner", "real-attempt.mjs"));
      const timeoutMs = 700;
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
        timeoutMs,
      });
      assert.equal(outcome.status, "timeout");

      const result = readJson(join(attemptDir, "result.json"));
      assert.equal(result.status, "timeout");
      assert.equal(result.exit.timedOut, true);
      assert.equal(result.exit.teardown.triggered, "timeout");
      assert.equal(result.exit.teardown.escalatedToSigkill, true, "a SIGTERM-ignoring group must be escalated to SIGKILL");
      assert.ok(result.failures.some((failure) => failure.includes("timeout")));
      assert.ok(result.durationMs >= timeoutMs);
      assert.equal(result.scorer.status, "failed", "the scorer runs on the untouched worktree");
      assert.equal(readJson(join(attemptDir, "final-state.json")).status, "collected");
      assert.equal(existsSync(join(attemptDir, "agent", "models.json")), false, "models.json is removed after a timeout");

      // The whole detached group died: the stubborn grandchild is gone.
      const tree = readJson(join(attemptDir, "sessions", "record-tree.json"));
      await new Promise((resolve) => setTimeout(resolve, 150));
      assert.throws(() => process.kill(tree.childPid, 0), /ESRCH|Process/, "the grandchild must die with the process group");

      // The proxy stopped listening after teardown.
      const proxy = readJson(join(attemptDir, "proxy.json"));
      assert.equal(typeof proxy.port, "number", "proxy telemetry records the loopback port so closure is verifiable");
      await assert.rejects(
        () => fetch(`http://127.0.0.1:${proxy.port}/v1/messages`, { method: "POST", body: "{}" }),
        /fetch failed|ECONNREFUSED/,
        "the proxy port must refuse connections after the attempt",
      );
      assert.equal(upstream.seen.length, 0, "a hanging fake Pi never reached the upstream");
      const proxyFlat = readFileSync(join(attemptDir, "proxy.json"), "utf8");
      assert.ok(!proxyFlat.includes("sentinel"), "proxy telemetry stays secret-free");
    } finally {
      await upstream.close();
      spawnSync("git", ["-C", repoRoot, "worktree", "prune"]);
      rmSync(work, { recursive: true, force: true });
    }
  });
});
