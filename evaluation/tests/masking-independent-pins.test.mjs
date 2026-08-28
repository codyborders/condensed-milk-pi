/** Red probe: cross-arm-equal but independently wrong scorer digest must invalidate. */
import { test } from "node:test";
import assert from "node:assert/strict";
import { mkdtempSync, rmSync, readFileSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { maskingPrepare, maskingDryRun, maskingReport } from "../runner/masking.mjs";

test("an independently wrong scorer digest invalidates even when cross-arm equal", async () => {
  const runsDir = mkdtempSync(join(tmpdir(), "cm-red-indep-"));
  try {
    maskingPrepare({ repoRoot: process.cwd(), runsDir, runId: "r1", mode: "dry-run" });
    await maskingDryRun({ repoRoot: process.cwd(), runsDir, runId: "r1" });
    for (const arm of ["upstream", "fork"]) {
      const pinnedPath = join(runsDir, "r1", "attempts", "masking-task-01", arm, "attempt-001", "pinned.json");
      const pinned = JSON.parse(readFileSync(pinnedPath, "utf8"));
      pinned.scorerSha256 = "9".repeat(64);
      writeFileSync(pinnedPath, JSON.stringify(pinned, null, 2));
    }
    const report = maskingReport({ repoRoot: process.cwd(), runsDir, runId: "r1" });
    assert.equal(report.pairs.invalid, 1, "an independently wrong scorer digest must invalidate even when cross-arm equal");
  } finally {
    rmSync(runsDir, { recursive: true, force: true });
  }
});
