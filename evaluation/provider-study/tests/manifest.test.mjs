/**
 * Provider-study manifest validation (grown test-first).
 *
 * Schema rejection: the four-arm study manifests are strict. A manifest
 * that changes provider, model, Pi version, tools, repetitions, arms,
 * or task shape is refused before any schedule or reservation exists.
 */

import { test } from "node:test";
import assert from "node:assert/strict";
import { readFileSync } from "node:fs";
import { join } from "node:path";
import { fileURLToPath } from "node:url";
import {
  validateProviderStudyManifest,
  loadProviderStudyManifestFile,
  providerStudyManifestPath,
  holdoutTaskIds,
  loadProviderStudyTaskData,
} from "../runner/manifest.mjs";

const repoRoot = join(fileURLToPath(import.meta.url), "..", "..", "..", "..");

const GENERAL_TASK_IDS = JSON.parse(
  readFileSync(join(repoRoot, "evaluation", "task-manifest.json"), "utf8"),
).tasks.map((task) => task.id);

test("schema rejection: development manifests that move any frozen pin are refused", () => {
  const base = JSON.parse(readFileSync(providerStudyManifestPath(repoRoot, "development"), "utf8"));
  const mutated = { ...base, evaluation: { ...base.evaluation, provider: "anthropic" } };
  const mutatedTasks = { ...base, tasks: [...base.tasks.filter((_, index) => index > 0), { id: "holdout-task-01", source: "holdout" }] };
  const mutatedPins = [
    { ...base, schemaVersion: 2 },
    { ...base, study: "other-study" },
    { ...base, phase: "holdout" },
    { ...base, evaluation: { ...base.evaluation, model: "gpt-5" } },
    { ...base, evaluation: { ...base.evaluation, thinking: "low" } },
    { ...base, evaluation: { ...base.evaluation, piVersion: "0.84.1" } },
    { ...base, evaluation: { ...base.evaluation, tools: ["read", "bash"] } },
    { ...base, evaluation: { ...base.evaluation, repetitionsPreallocated: 3 } },
    { ...base, evaluation: { ...base.evaluation, conditionalRepetitions: [6, 7] } },
    { ...base, evaluation: { ...base.evaluation, timeoutMsPerAttempt: 1000 } },
    { ...base, evaluation: { ...base.evaluation, noPaidRetry: false } },
    { ...base, evaluation: { ...base.evaluation, seed: "" } },
    { ...base, tasks: base.tasks.filter((_, index) => index < 11) },
    { ...base, tasks: [...base.tasks.filter((_, index) => index > 0), { id: "task-99", source: "general" }] },
    [],
  ];
  for (const value of [mutated, mutatedTasks, null, "string", ...mutatedPins]) {
    const check = validateProviderStudyManifest(value, { phase: "development", generalTaskIds: GENERAL_TASK_IDS });
    assert.equal(check.ok, false, `expected rejection for ${JSON.stringify(value)?.substring(0, 100)}`);
    assert.ok(check.errors.length > 0);
  }
});

test("schema rejection: holdout manifests that break shape or arm blindness are refused", () => {
  const base = JSON.parse(readFileSync(providerStudyManifestPath(repoRoot, "holdout"), "utf8"));
  const mutated = {
    ...base,
    tasks: base.tasks.map((task, index) => (index === 0 ? { ...task, prompt: "use the remediated-archive arm" } : task)),
  };
  const check = validateProviderStudyManifest(mutated, { phase: "holdout" });
  assert.equal(check.ok, false);
  assert.ok(check.errors.length > 0);
});

test("public holdout task loading refuses without the decrypted private bundle", () => {
  for (const id of holdoutTaskIds(repoRoot)) {
    assert.throws(
      () => loadProviderStudyTaskData(repoRoot, "holdout", id),
      /decrypted private task|encrypted bundle/,
    );
  }
});

test("phase separation refuses holdout data in development and general data in holdout", () => {
  assert.throws(
    () => loadProviderStudyTaskData(repoRoot, "development", "holdout-task-01"),
    /cross-phase/,
  );
  assert.throws(
    () => loadProviderStudyTaskData(repoRoot, "holdout", "task-01"),
    /cross-phase/,
  );
  const { tasks } = loadProviderStudyManifestFile(repoRoot, { phase: "development" });
  for (const task of tasks) {
    const { assertions, scorerSha256 } = loadProviderStudyTaskData(repoRoot, "development", task.id);
    assert.ok(Array.isArray(assertions) && assertions.length > 0);
    assert.match(scorerSha256, /^[0-9a-f]{64}$/);
  }
});

test("holdout manifest validates and pins exactly 8 new tasks with full coverage", () => {
  const { manifest } = loadProviderStudyManifestFile(repoRoot, { phase: "holdout" });
  assert.equal(manifest.tasks.length, 8);
  const ids = manifest.tasks.map((task) => task.id);
  assert.deepEqual(ids, holdoutTaskIds(repoRoot));
  for (const id of ids) assert.match(id, /^holdout-task-\d{2}$/);
  const development = loadProviderStudyManifestFile(repoRoot, { phase: "development" });
  const developmentIds = new Set(development.tasks.map((task) => task.id));
  for (const id of ids) {
    assert.equal(developmentIds.has(id), false, `holdout task ${id} must not appear in the development manifest`);
  }
  const covered = new Set(manifest.tasks.flatMap((task) => task.coverage));
  for (const tag of [
    "noisy-tests",
    "typescript-build-failures",
    "git-status-large-diffs",
    "repeated-reads",
    "search",
    "repetitive-logs",
    "successful-failed-commands",
    "long-masking-pressure",
    "exact-warnings-paths",
    "archive-recovery",
    "multi-step-implementation",
  ]) {
    assert.equal(covered.has(tag), true, `coverage tag ${tag} must be covered`);
  }
  for (const task of manifest.tasks) {
    assert.equal(task.prompt, undefined);
    assert.equal(task.fixture, undefined);
    assert.match(task.taskSha256, /^[0-9a-f]{64}$/);
    assert.match(task.scorerSha256, /^[0-9a-f]{64}$/);
    assert.match(task.solutionSha256, /^[0-9a-f]{64}$/);
    assert.match(task.fixtureSha256, /^[0-9a-f]{64}$/);
  }
  assert.equal(manifest.bundle.authenticated, true);
  assert.match(manifest.bundle.bundleSha256, /^[0-9a-f]{64}$/);
});

test("development manifest validates against the four-arm pins", () => {
  const { manifest, phase, sha256 } = loadProviderStudyManifestFile(repoRoot, { phase: "development" });
  assert.equal(phase, "development");
  assert.equal(manifest.evaluation.provider, "z-ai");
  assert.equal(manifest.evaluation.model, "glm-5.3-flash");
  assert.equal(manifest.evaluation.thinking, "high");
  assert.equal(manifest.evaluation.piVersion, "0.84.2");
  assert.equal(manifest.evaluation.repetitionsPreallocated, 5);
  assert.deepEqual(manifest.evaluation.conditionalRepetitions, [6, 7, 8, 9, 10]);
  assert.equal(manifest.evaluation.noPaidRetry, true);
  assert.match(sha256, /^[0-9a-f]{64}$/);
  assert.equal(manifest.tasks.length, 12);
  for (const task of manifest.tasks) {
    assert.equal(GENERAL_TASK_IDS.includes(task.id), true, `${task.id} must be an existing general task`);
  }
});
