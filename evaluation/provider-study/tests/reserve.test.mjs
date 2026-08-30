/**
 * Provider-study reservations (grown test-first).
 *
 * Fail-closed slot ownership: a completed slot is never invoked again,
 * an abandoned receipt without a terminal result refuses instead of
 * overwriting, and every artifact is created with no-overwrite
 * semantics so a second claim of the same slot can never clobber the
 * first.
 */

import { test } from "node:test";
import assert from "node:assert/strict";
import { mkdirSync, readFileSync, rmSync, writeFileSync, existsSync } from "node:fs";
import { join } from "node:path";
import { tmpdir } from "node:os";
import { providerStudyPublishCompletion, providerStudyReserve, providerStudySlotPath } from "../runner/reserve.mjs";

function freshRunDir() {
  const dir = join(tmpdir(), `provider-study-reserve-${process.pid}-${Date.now()}-${Math.floor(Math.random() * 1e6)}`);
  mkdirSync(dir, { recursive: true });
  return dir;
}

const pins = { promptSha256: "a".repeat(64), armIdentitySha256: "b".repeat(64) };

test("reservation claims a slot once and refuses overwrite on a second claim", () => {
  const runDir = freshRunDir();
  try {
    const first = providerStudyReserve({
      runDir,
      runId: "run-x",
      phase: "development",
      taskId: "task-01",
      arm: "none",
      rep: 1,
      pins,
    });
    assert.equal(first.claimed, true);
    const second = providerStudyReserve({
      runDir,
      runId: "run-x",
      phase: "development",
      taskId: "task-01",
      arm: "none",
      rep: 1,
      pins,
    });
    assert.equal(second.claimed, false);
    assert.equal(second.reason, "slot-exists");
    const receipt = JSON.parse(readFileSync(join(first.attemptDir, "provider-invocation.json"), "utf8"));
    assert.equal(receipt.taskId, "task-01");
    assert.equal(receipt.arm, "none");
    assert.equal(receipt.rep, 1);
    assert.equal(receipt.study, "provider-study");
  } finally {
    rmSync(runDir, { recursive: true, force: true });
  }
});

test("completed slots resume without reinvocation and abandoned slots fail closed", () => {
  const runDir = freshRunDir();
  try {
    const claim = providerStudyReserve({
      runDir,
      runId: "run-x",
      phase: "development",
      taskId: "task-01",
      arm: "upstream",
      rep: 2,
      pins,
    });
    assert.equal(claim.claimed, true);
    // A preliminary shared result without the provider-study completion marker remains incomplete.
    writeFileSync(join(claim.attemptDir, "result.json"), '{"study":"provider-study","status":"completed"}\n', "utf8");
    const incomplete = providerStudyReserve({
      runDir,
      runId: "run-x",
      phase: "development",
      taskId: "task-01",
      arm: "upstream",
      rep: 2,
      pins,
    });
    assert.equal(incomplete.claimed, false);
    assert.notEqual(incomplete.reason, "completed");
    providerStudyPublishCompletion(claim.attemptDir);
    const resumed = providerStudyReserve({
      runDir,
      runId: "run-x",
      phase: "development",
      taskId: "task-01",
      arm: "upstream",
      rep: 2,
      pins,
    });
    assert.equal(resumed.claimed, false);
    assert.equal(resumed.reason, "completed");
    // Abandoned slot: receipt exists without a terminal result. Fail closed.
    const abandoned = providerStudyReserve({
      runDir,
      runId: "run-x",
      phase: "development",
      taskId: "task-01",
      arm: "none",
      rep: 3,
      pins,
    });
    assert.equal(abandoned.claimed, true);
    rmSync(join(abandoned.attemptDir, "pinned.json"), { force: true });
    const refused = providerStudyReserve({
      runDir,
      runId: "run-x",
      phase: "development",
      taskId: "task-01",
      arm: "none",
      rep: 3,
      pins,
    });
    assert.equal(refused.claimed, false);
    assert.equal(refused.reason, "abandoned");
  } finally {
    rmSync(runDir, { recursive: true, force: true });
  }
});

test("slot paths are phase-separated and path-safe", () => {
  const path = providerStudySlotPath("/runs", "development", "task-01", "none", 1);
  assert.equal(path, join("/runs", "development", "attempts", "task-01", "none", "attempt-001"));
  assert.throws(() => providerStudySlotPath("/runs", "development", "../escape", "none", 1), /taskId/);
  assert.equal(existsSync(providerStudySlotPath("/runs", "holdout", "holdout-task-01", "none", 10).startsWith("/runs")), false);
});
