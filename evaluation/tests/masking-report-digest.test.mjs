/** Red probe: report must fail early on a manifest or profile digest mismatch. */
import { test } from "node:test";
import assert from "node:assert/strict";
import { mkdtempSync, rmSync, readFileSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { maskingPrepare, maskingDryRun, maskingReport } from "../runner/masking.mjs";

test("a changed manifest digest fails the report early", async () => {
  const runsDir = mkdtempSync(join(tmpdir(), "cm-red-report-"));
  try {
    maskingPrepare({ repoRoot: process.cwd(), runsDir, runId: "r1", mode: "dry-run" });
    await maskingDryRun({ repoRoot: process.cwd(), runsDir, runId: "r1" });
    const runPath = join(runsDir, "r1", "run.json");
    const run = JSON.parse(readFileSync(runPath, "utf8"));
    run.manifestSha256 = "0".repeat(64);
    writeFileSync(runPath, JSON.stringify(run, null, 2));
    let refused = null;
    try {
      maskingReport({ repoRoot: process.cwd(), runsDir, runId: "r1" });
    } catch (error) {
      refused = error;
    }
    assert.ok(refused, "a changed manifest digest must fail the report early");
    assert.match(refused.message, /manifest/i);
  } finally {
    rmSync(runsDir, { recursive: true, force: true });
  }
});
