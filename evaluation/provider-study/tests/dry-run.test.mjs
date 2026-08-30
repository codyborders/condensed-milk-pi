/**
 * Provider-study dry-run (grown test-first).
 *
 * The free dry-run executes the exact persisted plan: five preallocated
 * blocks per task, all four arms per block in the seeded order, one
 * immutable slot per (task, arm, rep). Every attempt gets a fresh
 * fixture worktree, an isolated home and session directory, the arm's
 * exact config bytes, and a deterministic fake metric row. Completed
 * slots are skipped on re-run and never invoked again.
 */

import { test } from "node:test";
import assert from "node:assert/strict";
import { existsSync, mkdirSync, readFileSync, readdirSync, rmSync } from "node:fs";
import { join } from "node:path";
import { tmpdir } from "node:os";
import { fileURLToPath } from "node:url";
import { providerStudyDryRun } from "../runner/study.mjs";
import { hashTree, gitStateHash } from "../../lib/fixtures.mjs";

const repoRoot = join(fileURLToPath(import.meta.url), "..", "..", "..", "..");

function freshRunsRoot() {
  const dir = join(tmpdir(), `provider-study-dry-${process.pid}-${Date.now()}-${Math.floor(Math.random() * 1e6)}`);
  mkdirSync(dir, { recursive: true });
  return dir;
}

test("dry-run executes all four arms across five reps for one task and resumes without reinvoking", async () => {
  const runsRoot = freshRunsRoot();
  try {
    const first = await providerStudyDryRun({ repoRoot, runsRoot, phase: "development", taskIds: ["task-01"] });
    assert.equal(first.executed, 20);
    assert.equal(first.skipped, 0);
    const arms = new Set();
    const reps = new Set();
    for (const taskId of ["task-01"]) {
      for (const arm of readdirSync(join(runsRoot, "development", "attempts", taskId))) {
        arms.add(arm);
        for (const slot of readdirSync(join(runsRoot, "development", "attempts", taskId, arm))) {
          const attemptDir = join(runsRoot, "development", "attempts", taskId, arm, slot);
          assert.ok(existsSync(join(attemptDir, "result.json")), `${attemptDir} needs a terminal result`);
          const result = JSON.parse(readFileSync(join(attemptDir, "result.json"), "utf8"));
          assert.equal(result.status, "completed");
          assert.equal(result.study, "provider-study");
          reps.add(result.rep);
        }
      }
    }
    assert.deepEqual([...arms].sort(), ["none", "remediated-archive", "remediated-defaults", "upstream"]);
    assert.deepEqual([...reps].sort(), [1, 2, 3, 4, 5]);
    const second = await providerStudyDryRun({ repoRoot, runsRoot, phase: "development", taskIds: ["task-01"] });
    assert.equal(second.executed, 0);
    assert.equal(second.skipped, 20);
  } finally {
    rmSync(runsRoot, { recursive: true, force: true });
  }
});

test("each attempt gets isolated home and sessions, a clean fixture worktree, and the identical tool surface", async () => {
  const runsRoot = freshRunsRoot();
  try {
    await providerStudyDryRun({ repoRoot, runsRoot, phase: "development", taskIds: ["task-01"] });
    const base = join(runsRoot, "development", "attempts", "task-01");
    const seen = [];
    for (const arm of readdirSync(base)) {
      for (const slot of readdirSync(join(base, arm))) {
        const attemptDir = join(base, arm, slot);
        const environment = JSON.parse(readFileSync(join(attemptDir, "environment.json"), "utf8"));
        assert.ok(environment.home.startsWith(attemptDir), "home must live inside the attempt directory");
        assert.ok(environment.sessions.startsWith(attemptDir), "sessions must live inside the attempt directory");
        assert.ok(existsSync(join(environment.home, ".config", "condensed-milk.json")), "the arm config bytes must be written");
        assert.equal(environment.tools, "read,bash,edit,write,grep,find,ls,condensed_milk_retrieve");
        seen.push(`${arm}:${environment.extensions.length}`);
        const before = JSON.parse(readFileSync(join(attemptDir, "fixture-before.json"), "utf8"));
        assert.match(before.contentSha256, /^[0-9a-f]{64}$/);
        assert.match(before.gitStateSha256, /^[0-9a-f]{64}$/);
        const result = JSON.parse(readFileSync(join(attemptDir, "result.json"), "utf8"));
        assert.equal(result.deterministicResult, true);
        assert.equal(typeof result.totalProviderTokens, "number");
      }
    }
    const noneEnvironment = JSON.parse(
      readFileSync(join(base, "none", "attempt-001", "environment.json"), "utf8"),
    );
    assert.equal(noneEnvironment.extensions.length, 1);
    assert.equal(noneEnvironment.extensions[0].endsWith("neutral-retrieval.mjs"), true);
  } finally {
    rmSync(runsRoot, { recursive: true, force: true });
  }
});

test("each attempt starts from a real fixture worktree and a hidden scorer result", async () => {
  const runsRoot = freshRunsRoot();
  try {
    await providerStudyDryRun({ repoRoot, runsRoot, phase: "development", taskIds: ["task-01"] });
    const attemptDir = join(runsRoot, "development", "attempts", "task-01", "none", "attempt-001");
    const before = JSON.parse(readFileSync(join(attemptDir, "fixture-before.json"), "utf8"));
    const fixtureEntry = join(repoRoot, "evaluation", "cache", "fixtures", "task-01");
    assert.equal(before.contentSha256, hashTree(fixtureEntry));
    assert.equal(before.gitStateSha256, gitStateHash(fixtureEntry));
    assert.ok(existsSync(join(attemptDir, "worktree", ".git")), "the attempt must run in a real git worktree");
    const scorer = JSON.parse(readFileSync(join(attemptDir, "scorer.json"), "utf8"));
    assert.equal(scorer.status, "passed");
    const result = JSON.parse(readFileSync(join(attemptDir, "result.json"), "utf8"));
    assert.equal(result.deterministicResult, true);
    assert.equal(result.scorer.status, "passed");
  } finally {
    rmSync(runsRoot, { recursive: true, force: true });
  }
});

test("every attempt records the full attempt-metric row with verbatim usage categories", async () => {
  const runsRoot = freshRunsRoot();
  try {
    await providerStudyDryRun({ repoRoot, runsRoot, phase: "development", taskIds: ["task-01"] });
    const base = join(runsRoot, "development", "attempts", "task-01");
    for (const arm of readdirSync(base)) {
      const result = JSON.parse(readFileSync(join(base, arm, "attempt-001", "result.json"), "utf8"));
      for (const field of [
        "usage",
        "totalProviderTokens",
        "peakContextTokens",
        "modelRequests",
        "wallTimeMs",
        "firstEventLatencyMs",
        "toolCalls",
        "shellReruns",
        "fileRereads",
        "testReruns",
        "buildReruns",
        "compressionEvents",
        "historicalMaskEvents",
        "archiveReferences",
        "retrievalCalls",
        "retrievalFailures",
        "qualityScore",
      ]) {
        assert.ok(field in result, `${arm}.${field} must be recorded`);
      }
      for (const field of ["input", "output", "cacheRead", "cacheWrite"]) {
        assert.ok(field in result.usage, `${arm}.usage.${field} must be recorded verbatim`);
      }
      assert.equal(result.qualityScore, null);
      assert.equal(result.qualityScoreSource, "judge-pending");
    }
  } finally {
    rmSync(runsRoot, { recursive: true, force: true });
  }
});
