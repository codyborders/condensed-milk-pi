/**
 * Provider-study freeze lock (grown test-first).
 *
 * The freeze binds every study input: both manifests, the hidden
 * holdout scorers, the arm identities, the plan hashes, and the frozen
 * provider/model/Pi pins. A later mismatch refuses before any
 * reservation exists.
 */

import { test } from "node:test";
import assert from "node:assert/strict";
import { mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { fileURLToPath } from "node:url";
import { providerStudyFreeze, providerStudyFreezeMatches, providerStudyFreezeLockPath } from "../runner/freeze.mjs";

const repoRoot = join(fileURLToPath(import.meta.url), "..", "..", "..", "..");

test("freeze writes a lock over every study input and validates it", () => {
  const work = mkdtempSync(join(tmpdir(), "cm-ps-freeze-"));
  try {
    const lockPath = join(work, "freeze-lock.json");
    const lock = providerStudyFreeze(repoRoot, { lockPath });
    assert.equal(lock.written, true);
    assert.ok(providerStudyFreezeLockPath(repoRoot).endsWith(join("evaluation", "provider-study", "freeze-lock.json")));
    const check = providerStudyFreezeMatches(repoRoot, { lockPath });
    assert.equal(check.ok, true, check.problems?.join("; "));
  assert.match(lock.digests.developmentManifestSha256, /^[0-9a-f]{64}$/);
  assert.match(lock.digests.holdoutManifestSha256, /^[0-9a-f]{64}$/);
  assert.match(lock.digests.holdoutScorerSha256["holdout-task-01"], /^[0-9a-f]{64}$/);
  assert.match(lock.digests.armIdentitySha256["remediated-archive"], /^[0-9a-f]{64}$/);
  assert.match(lock.digests.planSha256.development, /^[0-9a-f]{64}$/);
  assert.match(lock.digests.planSha256.holdout, /^[0-9a-f]{64}$/);
    assert.match(lock.digests.evaluator.commit, /^[0-9a-f]{40}$/, "the freeze binds the evaluator commit");
    assert.match(lock.digests.evaluator.headTree, /^[0-9a-f]{40}$/, "the freeze binds the clean tree digest");
    assert.match(lock.digests.evaluator.sourceSha256, /^[0-9a-f]{64}$/, "the freeze binds the evaluator source digest");
    assert.match(lock.digests.runnerModulesSha256, /^[0-9a-f]{64}$/);
    assert.match(lock.digests.runtimeModulesSha256, /^[0-9a-f]{64}$/);
    assert.match(lock.digests.libModulesSha256, /^[0-9a-f]{64}$/);
    assert.match(lock.digests.developmentScorersSha256, /^[0-9a-f]{64}$/);
    assert.match(lock.digests.taskManifestSha256, /^[0-9a-f]{64}$/);
    assert.match(lock.digests.protocolSha256, /^[0-9a-f]{64}$/);
    assert.match(lock.digests.profilesSha256, /^[0-9a-f]{64}$/);
    assert.match(lock.digests.neutralStubSha256, /^[0-9a-f]{64}$/);
    assert.match(lock.digests.judgeRubricSha256, /^[0-9a-f]{64}$/);
    assert.match(lock.digests.statsCodeSha256, /^[0-9a-f]{64}$/);
    assert.match(lock.digests.piRuntimeSha256, /^[0-9a-f]{64}$/, "the freeze binds the Pi runtime digest");
    const tamperedEvaluator = { ...lock, digests: { ...lock.digests, evaluator: { ...lock.digests.evaluator, commit: "f".repeat(40) } } };
    assert.equal(providerStudyFreezeMatches(repoRoot, { lock: tamperedEvaluator }).ok, false, "an evaluator commit change refuses");
    const tamperedSource = { ...lock, digests: { ...lock.digests, evaluator: { ...lock.digests.evaluator, sourceSha256: "0".repeat(64) } } };
    assert.equal(providerStudyFreezeMatches(repoRoot, { lock: tamperedSource }).ok, false, "an evaluator source change refuses");
    const tamperedRunner = { ...lock, digests: { ...lock.digests, runnerModulesSha256: "0".repeat(64) } };
    assert.equal(providerStudyFreezeMatches(repoRoot, { lock: tamperedRunner }).ok, false, "a runner module change refuses");
    const mutated = { ...lock, digests: { ...lock.digests, holdoutManifestSha256: "0".repeat(64) } };
    assert.equal(providerStudyFreezeMatches(repoRoot, { lock: mutated }).ok, false);
  } finally {
    rmSync(work, { recursive: true, force: true });
  }
});
