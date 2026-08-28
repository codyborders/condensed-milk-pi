/**
 * Study observer instrumentation failure (boundary: executeRealAttempt).
 *
 * The extractor runs after scoring and final collection. When the
 * observer metrics are missing (the fake Pi child never loads
 * extensions), the strict extractor refuses and executeRealAttempt must
 * propagate the throw so the orchestrator stops later reservations
 * instead of writing an uninstrumented attempt result.
 */

import { test } from "node:test";
import assert from "node:assert/strict";
import { existsSync, mkdtempSync, mkdirSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join, dirname } from "node:path";
import { fileURLToPath } from "node:url";
import { createHash } from "node:crypto";
import { startFakeUpstream, writeCredentialSource, makeFakePiRuntime } from "./real-attempt-fakes.mjs";
import { loadManifestFile, loadTaskData } from "../lib/manifest.mjs";
import { maskingObserverStudyObservers } from "../runner/masking-observer.mjs";

const repoRoot = join(dirname(fileURLToPath(import.meta.url)), "..", "..");
const manifest = loadManifestFile(join(repoRoot, "evaluation", "task-manifest.json"));
const TASK = manifest.tasks[0];
const UPSTREAM_ARM = manifest.evaluation.arms[0];

const PROFILE_BYTES = '{\n  "schemaVersion": 1,\n  "profile": "eval-masking"\n}\n';

test("an instrumentation failure throws and leaves no attempt result", { timeout: 120_000 }, async () => {
  const work = mkdtempSync(join(tmpdir(), "cm-study-obs-fail-"));
  const upstream = await startFakeUpstream();
  try {
    const credentialSource = join(work, "models.json");
    writeCredentialSource(credentialSource, `http://127.0.0.1:${upstream.port}`);
    const { verifyArmWorktree } = await import(join(repoRoot, "evaluation", "runner", "real-runtime.mjs"));
    const armInfo = verifyArmWorktree({ repoRoot, arm: UPSTREAM_ARM, cacheRoot: join(work, "cache") });
    const { solution } = loadTaskData(repoRoot, TASK.id);
    const piCliPath = makeFakePiRuntime(join(work, "cache"), { behavior: "ok", solution });
    const fixtureDir = join(work, "fixture");
    const { generateFixture } = await import(join(repoRoot, "evaluation", "lib", "fixtures.mjs"));
    generateFixture({ repoRoot, task: TASK, outDir: fixtureDir });
    const attemptDir = join(work, "runs", "attempt-001");
    mkdirSync(attemptDir, { recursive: true });
    const observers = maskingObserverStudyObservers({ diagnosticMarkers: [] });
    const study = {
      profileBytes: PROFILE_BYTES,
      profileSha256: createHash("sha256").update(PROFILE_BYTES).digest("hex"),
      scorerSha256: "5".repeat(64),
      extraPins: { study: "masking" },
      scoreWorktree: () => ({ schemaVersion: 1, taskId: TASK.id, status: "passed", checks: [], passedCount: 1, totalCount: 1, error: null }),
      observers: { generate: observers.generate, extract: observers.extract },
    };
    const { executeRealAttempt } = await import(join(repoRoot, "evaluation", "runner", "real-attempt.mjs"));
    await assert.rejects(
      () =>
        executeRealAttempt({
          repoRoot,
          manifest,
          task: TASK,
          arm: "upstream",
          armInfo,
          attemptDir,
          fixtureDir,
          credentialSourcePath: credentialSource,
          piCliPath,
          timeoutMs: 60_000,
          study,
        }),
      (error) => {
        assert.match(error.message, /observer metrics missing/, "the missing-metrics refusal must propagate");
        return true;
      },
    );
    assert.equal(existsSync(join(attemptDir, "result.json")), false, "no result may be written for an uninstrumented attempt");
    assert.ok(existsSync(join(attemptDir, "scorer.json")), "scoring still completed before the refusal");
    assert.ok(existsSync(join(attemptDir, "final-state.json")), "collection still completed before the refusal");
    assert.equal(existsSync(join(attemptDir, "instrumentation.json")), false);
  } finally {
    await upstream.close();
    rmSync(work, { recursive: true, force: true });
  }
});
