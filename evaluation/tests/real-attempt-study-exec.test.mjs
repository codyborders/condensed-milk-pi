/**
 * Study-injected real attempt execution (boundary: executeRealAttempt).
 *
 * A study configuration carries exact profile bytes, ordered extension
 * paths, an explicit scorer digest, extra pins, and an injected hidden
 * score function. Nothing about the scorer reaches argv, env, or the
 * child-visible config. The standard path stays untouched.
 */

import { test, describe } from "node:test";
import assert from "node:assert/strict";
import { existsSync, mkdtempSync, mkdirSync, readFileSync, rmSync, statSync } from "node:fs";
import { tmpdir } from "node:os";
import { join, dirname } from "node:path";
import { fileURLToPath } from "node:url";
import { createHash } from "node:crypto";
import { startFakeUpstream, writeCredentialSource, SENTINEL_KEY, makeFakePiRuntime } from "./real-attempt-fakes.mjs";
import { loadManifestFile, loadTaskData } from "../lib/manifest.mjs";
import { maskingObserverStudyObservers } from "../runner/masking-observer.mjs";

const repoRoot = join(dirname(fileURLToPath(import.meta.url)), "..", "..");
const manifest = loadManifestFile(join(repoRoot, "evaluation", "task-manifest.json"));
const TASK = manifest.tasks[0];
const UPSTREAM_ARM = manifest.evaluation.arms[0];

const PROFILE_BYTES = '{\n  "schemaVersion": 1,\n  "profile": "eval-masking"\n}\n';

describe("study-injected real attempt execution", () => {
  test("study config flows through execution without leaking scorer paths", { timeout: 120_000 }, async () => {
    const work = mkdtempSync(join(tmpdir(), "cm-study-exec-"));
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
      let scorerCalls = 0;
      const study = {
        profileBytes: PROFILE_BYTES,
        profileSha256: createHash("sha256").update(PROFILE_BYTES).digest("hex"),
        extensionPaths: [join(attemptDir, "worktree", "implementation", "index.ts")],
        scorerSha256: "5".repeat(64),
        extraPins: { study: "masking", profileSha256: "6".repeat(64) },
        scoreWorktree: () => {
          scorerCalls += 1;
          return { schemaVersion: 1, taskId: TASK.id, status: "passed", checks: [], passedCount: 2, totalCount: 2, error: null };
        },
      };
      const { executeRealAttempt } = await import(join(repoRoot, "evaluation", "runner", "real-attempt.mjs"));
      const outcome = await executeRealAttempt({
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
      });
      assert.equal(outcome.status, "completed");
      assert.equal(scorerCalls, 1, "the injected hidden score function must be used exactly once");
      const scorer = JSON.parse(readFileSync(join(attemptDir, "scorer.json"), "utf8"));
      assert.equal(scorer.passedCount, 2);
      const pinned = JSON.parse(readFileSync(join(attemptDir, "pinned.json"), "utf8"));
      assert.equal(pinned.study, "masking");
      assert.equal(pinned.profileSha256, "6".repeat(64));
      assert.equal(pinned.scorerSha256, "5".repeat(64));
      const homeConfig = readFileSync(join(attemptDir, "home", ".config", "condensed-milk.json"), "utf8");
      assert.equal(homeConfig, PROFILE_BYTES);
      assert.equal(upstream.seen.length, 1);
      assert.equal(upstream.seen[0].headers["x-api-key"], SENTINEL_KEY);
    } finally {
      await upstream.close();
      rmSync(work, { recursive: true, force: true });
    }
  });

  test("study observers generate before invocation, force the extension order, and instrument after collection", { timeout: 120_000 }, async () => {
    const work = mkdtempSync(join(tmpdir(), "cm-study-obs-exec-"));
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
      let extractCalls = 0;
      const observers = maskingObserverStudyObservers({ diagnosticMarkers: [] });
      const study = {
        profileBytes: PROFILE_BYTES,
        profileSha256: createHash("sha256").update(PROFILE_BYTES).digest("hex"),
        scorerSha256: "5".repeat(64),
        extraPins: { study: "masking" },
        scoreWorktree: () => ({ schemaVersion: 1, taskId: TASK.id, status: "passed", checks: [], passedCount: 1, totalCount: 1, error: null }),
        observers: {
          generate: observers.generate,
          extract: ({ attemptDir: dir }) => {
            extractCalls += 1;
            // The extractor runs only after scoring and final collection.
            assert.ok(existsSync(join(dir, "scorer.json")), "scorer.json must exist at extraction time");
            assert.ok(existsSync(join(dir, "final-state.json")), "final-state.json must exist at extraction time");
            return { schemaVersion: 1, source: "observer-test", pairs: { total: 0 } };
          },
        },
      };
      const { executeRealAttempt } = await import(join(repoRoot, "evaluation", "runner", "real-attempt.mjs"));
      const outcome = await executeRealAttempt({
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
      });
      assert.equal(outcome.status, "completed");
      assert.equal(extractCalls, 1, "the extractor must run exactly once");
      // Observer extensions were generated inside the attempt and loaded
      // in the forced order around the arm implementation.
      const prePath = join(attemptDir, "observer", "pre.mjs");
      const postPath = join(attemptDir, "observer", "post.mjs");
      assert.ok(existsSync(prePath) && existsSync(postPath));
      assert.equal(statSync(prePath).mode & 0o777, 0o600);
      const recorded = JSON.parse(readFileSync(join(attemptDir, "sessions", "record-argv.json"), "utf8"));
      const flagged = recorded.argv.flatMap((part, index) => (part === "-e" ? [recorded.argv[index + 1]] : []));
      assert.deepEqual(flagged, [prePath, join(attemptDir, "worktree", "implementation", "index.ts"), postPath]);
      const pinned = JSON.parse(readFileSync(join(attemptDir, "pinned.json"), "utf8"));
      assert.match(pinned.observerSha256, /^[0-9a-f]{64}$/);
      assert.match(pinned.observerWrapperSha256, /^[0-9a-f]{64}$/);
      const instrumentation = JSON.parse(readFileSync(join(attemptDir, "instrumentation.json"), "utf8"));
      assert.equal(instrumentation.source, "observer-test");
    } finally {
      await upstream.close();
      rmSync(work, { recursive: true, force: true });
    }
  });
});
