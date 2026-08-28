/** Persisted masking schedule validation tests. */
import { test } from "node:test";
import assert from "node:assert/strict";
import { loadMaskingManifestFile } from "../lib/masking-manifest.mjs";
import { maskingPrepare, validateMaskingRunOrders } from "../runner/masking.mjs";
import { dirname, join } from "node:path";
import { fileURLToPath } from "node:url";
import { mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";

const repoRoot = join(dirname(fileURLToPath(import.meta.url)), "..", "..");
const { manifest } = loadMaskingManifestFile(repoRoot);

test("persisted repetition order must be an exact three-value permutation", () => {
  const runsDir = mkdtempSync(join(tmpdir(), "cm-masking-order-"));
  try {
    const prepared = maskingPrepare({ repoRoot, runsDir, runId: "bad-repetitions" });
    prepared.repetitionOrder[manifest.tasks[0].id] = [1, 1, 3];
    assert.throws(
      () => validateMaskingRunOrders(prepared, manifest),
      /repetitionOrder.*exact permutation/,
    );
  } finally {
    rmSync(runsDir, { recursive: true, force: true });
  }
});

test("persisted arm order rejects omissions and injected path values", () => {
  const runsDir = mkdtempSync(join(tmpdir(), "cm-masking-order-"));
  try {
    const prepared = maskingPrepare({ repoRoot, runsDir, runId: "bad-arms" });
    prepared.armOrder[manifest.tasks[0].id] = ["fork", "../upstream"];
    assert.throws(
      () => validateMaskingRunOrders(prepared, manifest),
      /armOrder.*exact permutation/,
    );
  } finally {
    rmSync(runsDir, { recursive: true, force: true });
  }
});
