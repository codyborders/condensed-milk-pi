/**
 * Real attempt resume-readiness tests
 * (boundary: evaluation/runner/real-attempt.mjs executeRealAttempt).
 *
 * Fake-only: after one terminal attempt, the artifact set must be
 * complete enough for resume/report/select, and a second execution on
 * the same attempt directory must refuse before any new provider call.
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

describe("real attempt resume readiness", () => {
  test("terminal artifacts are resume-ready and a second execution refuses before spawning", { timeout: 120_000 }, async () => {
    const work = mkdtempSync(join(tmpdir(), "cm-real-resume-"));
    const upstream = await startFakeUpstream();
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
      const inputs = {
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
        identity: { runId: "resume-01", attempt: 1 },
      };
      const first = await executeRealAttempt(inputs);
      assert.equal(first.status, "completed");
      assert.equal(first.attempt, 1);
      const resultBefore = readFileSync(join(attemptDir, "result.json"), "utf8");

      // The resume-ready artifact set.
      for (const name of [
        "result.json",
        "pinned.json",
        "scorer.json",
        "final-state.json",
        "final-state/porcelain-v2.txt",
        "final-state/staged.patch",
        "final-state/unstaged.patch",
        "final-state/ls-files.txt",
        "proxy.json",
        "invocations.jsonl",
        "pi-stdout.jsonl",
        "pi-stderr.txt",
        "worktree/stats.py",
        "sessions",
      ]) {
        assert.equal(existsSync(join(attemptDir, name)), true, `missing resume artifact ${name}`);
      }
      const result = readJson(join(attemptDir, "result.json"));
      assert.equal(result.runId, "resume-01");
      assert.equal(result.attempt, 1);
      assert.ok(["completed", "failed", "timeout", "interrupted", "collection-error"].includes(result.status), "the stored status is terminal");

      // A restart must refuse to spawn Pi again for the same attempt.
      await assert.rejects(
        () => executeRealAttempt(inputs),
        (error) => {
          assert.match(error.message, /terminal status; refusing/);
          return true;
        },
        "a terminal attempt must never be respawned",
      );
      assert.equal(upstream.seen.length, 1, "the refusal happened before any second provider request");
      assert.equal(readFileSync(join(attemptDir, "result.json"), "utf8"), resultBefore, "the terminal result is immutable");
      assert.equal(readFileSync(join(attemptDir, "invocations.jsonl"), "utf8").trim().split("\n").length, 1);
    } finally {
      await upstream.close();
      spawnSync("git", ["-C", repoRoot, "worktree", "prune"]);
      rmSync(work, { recursive: true, force: true });
    }
  });
});
