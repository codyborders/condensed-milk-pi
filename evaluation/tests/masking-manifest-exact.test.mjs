/** Red probe: manifest validator must pin the exact tool order and arm roles. */
import { test } from "node:test";
import assert from "node:assert/strict";
import { readFileSync } from "node:fs";
import { fileURLToPath } from "node:url";
import { dirname, join } from "node:path";
import { validateMaskingManifest } from "../lib/masking-manifest.mjs";

const repoRoot = join(dirname(fileURLToPath(import.meta.url)), "..", "..");

function checkedIn() {
  return JSON.parse(readFileSync(join(repoRoot, "evaluation", "masking-task-manifest.json"), "utf8"));
}

function profileResolved() {
  const parsed = JSON.parse(readFileSync(join(repoRoot, "evaluation", "masking-eval-profile.json"), "utf8"));
  const override = parsed.profiles[parsed.profile];
  return { name: parsed.profile, thresholds: override.thresholds, coverage: override.coverage };
}

test("reordered tools or swapped arm roles must invalidate the manifest", () => {
  const reordered = checkedIn();
  reordered.evaluation.tools = [...reordered.evaluation.tools].reverse();
  const result = validateMaskingManifest(reordered, { profile: profileResolved() });
  assert.ok(
    result.errors.some((error) => error.includes("exact approved ordered list")),
    `a reordered tool list must invalidate, got: ${result.errors.join("|")}`,
  );
  const swappedRoles = checkedIn();
  swappedRoles.evaluation.arms = [
    { name: "upstream", role: "treatment", commit: swappedRoles.evaluation.arms[0].commit },
    { name: "fork", role: "baseline", commit: swappedRoles.evaluation.arms[1].commit },
  ];
  const swapped = validateMaskingManifest(swappedRoles, { profile: profileResolved() });
  assert.ok(swapped.errors.some((error) => error.includes("upstream/baseline")), "swapped roles must invalidate");
});
