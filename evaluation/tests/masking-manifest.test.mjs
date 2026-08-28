/**
 * Masking study manifest contract tests (test-first slice).
 *
 * Scope: the checked-in masking manifest validates strictly against its
 * study profile; tasks carry explicit masking threshold contracts.
 */

import { test, describe } from "node:test";
import assert from "node:assert/strict";
import { readFileSync } from "node:fs";
import { fileURLToPath } from "node:url";
import { dirname, join } from "node:path";
import {
  loadMaskingManifestFile,
  validateMaskingManifest,
  validateStudyIdentity,
  loadMaskingTaskData,
  maskingScorerSha256,
  validateMaskingRunId,
} from "../lib/masking-manifest.mjs";

function checkedIn() {
  return JSON.parse(readFileSync(join(repoRoot, "evaluation", "masking-task-manifest.json"), "utf8"));
}

function profileResolved() {
  const parsed = JSON.parse(readFileSync(join(repoRoot, "evaluation", "masking-eval-profile.json"), "utf8"));
  const override = parsed.profiles[parsed.profile];
  return {
    name: parsed.profile,
    thresholds: override.thresholds,
    coverage: override.coverage,
    effectiveContextCap: override.effectiveContextCap,
  };
}

const repoRoot = join(dirname(fileURLToPath(import.meta.url)), "..", "..");

describe("masking manifest validation", () => {
  test("study uses pinned low thresholds and identical semantic filter profile", () => {
    const { profile } = loadMaskingManifestFile(repoRoot);
    assert.deepEqual(profile.resolved.thresholds, [0.05, 0.08, 0.12]);
    assert.deepEqual(profile.resolved.coverage, [0.50, 0.75, 0.90]);
    assert.equal(profile.resolved.effectiveContextCap, 131072);
    assert.equal(profile.resolved.filters["pytest"], true);
  });
  test("checked-in masking manifest validates with three repetitions and low thresholds", () => {
    const { manifest, profile } = loadMaskingManifestFile(repoRoot);
    assert.equal(manifest.tasks.length, 8);
    assert.equal(manifest.evaluation.repetitionsPerTask, 3);
    assert.deepEqual(profile.resolved.thresholds, [0.05, 0.08, 0.12]);
    assert.deepEqual(profile.resolved.coverage, [0.50, 0.75, 0.90]);
    assert.equal(profile.resolved.effectiveContextCap, 131072);
    assert.match(profile.sha256, /^[0-9a-f]{64}$/);
  });

  test("rejects a task threshold below the profile's first threshold", () => {
    const belowProfile = checkedIn();
    belowProfile.tasks[0].masking.threshold = 0.0005;
    const result = validateMaskingManifest(belowProfile, { profile: profileResolved() });
    assert.equal(result.ok, false);
    assert.ok(result.errors.some((error) => error.includes("must be exactly 0.05")));
  });

  test("rejects conceptual filter ids", () => {
    const invalid = checkedIn();
    invalid.tasks[0].masking.filterIds = ["not-approved"];
    const result = validateMaskingManifest(invalid, { profile: profileResolved() });
    assert.equal(result.ok, false);
  });

  test("identity gate refuses a non-pinned provider before any reservation", () => {
    const { profile } = loadMaskingManifestFile(repoRoot);
    const check = validateStudyIdentity({ provider: "openai", model: "glm-5.3-flash", profileSha256: profile.sha256 });
    assert.equal(check.ok, false);
    assert.ok(check.problems.some((problem) => problem.includes("provider")));
  });

  test("pins the exact study identity: tools with retrieval, Pi version, thinking, profile file, arms, and three repetitions", () => {
    const manifest = checkedIn();
    assert.ok(manifest.evaluation.tools.includes("condensed_milk_retrieve"), "retrieval tool must be pinned");
    assert.equal(manifest.evaluation.piVersion, "0.84.2");
    assert.equal(manifest.evaluation.thinking, "high");
    assert.equal(manifest.evaluation.profileFile, "masking-eval-profile.json");
    assert.equal(manifest.evaluation.profile, "eval-masking");
    assert.equal(manifest.evaluation.repetitionsPerTask, 3);
    assert.deepEqual(
      manifest.evaluation.arms.map((arm) => arm.name),
      ["upstream", "fork"],
    );
  });

  test("validator rejects drift from the exact study identity pins", () => {
    const resolved = profileResolved();
    const noRetrieval = checkedIn();
    noRetrieval.evaluation.tools = noRetrieval.evaluation.tools.filter((tool) => tool !== "condensed_milk_retrieve");
    assert.ok(validateMaskingManifest(noRetrieval, { profile: resolved }).errors.some((error) => error.includes("condensed_milk_retrieve")));
    const wrongPi = checkedIn();
    wrongPi.evaluation.piVersion = "0.84.1";
    assert.ok(validateMaskingManifest(wrongPi, { profile: resolved }).errors.some((error) => error.includes("piVersion")));
    const wrongThinking = checkedIn();
    wrongThinking.evaluation.thinking = "medium";
    assert.ok(validateMaskingManifest(wrongThinking, { profile: resolved }).errors.some((error) => error.includes("thinking")));
    const wrongProfileFile = checkedIn();
    wrongProfileFile.evaluation.profileFile = "other.json";
    assert.ok(validateMaskingManifest(wrongProfileFile, { profile: resolved }).errors.some((error) => error.includes("profileFile")));
  });

  test("hidden masking task data loads for every task", () => {
    const { manifest } = loadMaskingManifestFile(repoRoot);
    for (const task of manifest.tasks) {
      const data = loadMaskingTaskData(repoRoot, task.id);
      assert.ok(data.assertions.length >= 1, `${task.id} needs assertions`);
      assert.ok(Array.isArray(data.solution.files), `${task.id} needs solution files`);
      assert.match(maskingScorerSha256(repoRoot, task.id), /^[0-9a-f]{64}$/);
    }
  });

  test("run-id validation rejects traversal, control characters, and bad lengths", () => {
    const bad = ["", "../escape", "a/b", "a\\b", "a\nb", "a\u0000b", "-leading", ".hidden", "x".repeat(129)];
    for (const value of bad) {
      const check = validateMaskingRunId(value);
      assert.equal(check.ok, false, `expected rejection for ${JSON.stringify(value)}`);
    }
    const good = ["a", "A9", "run-01", "masking.x_y-z", "x".repeat(128)];
    for (const value of good) {
      assert.equal(validateMaskingRunId(value).ok, true, `expected acceptance for ${JSON.stringify(value)}`);
    }
  });
});
