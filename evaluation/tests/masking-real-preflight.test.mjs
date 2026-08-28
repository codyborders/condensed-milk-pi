/** Masking real-run preflight tests. */
import { test } from "node:test";
import assert from "node:assert/strict";
import { mkdtempSync, readFileSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { maskingPrepare, maskingRealRun } from "../runner/masking.mjs";

test("prepared manifest and profile pins refuse drift before credential preflight", async () => {
  const runsDir = mkdtempSync(join(tmpdir(), "cm-masking-input-pins-"));
  try {
    for (const [runId, field] of [["manifest-drift", "manifestSha256"], ["profile-drift", "profileSha256"]]) {
      const prepared = maskingPrepare({ repoRoot: process.cwd(), runsDir, runId, mode: "real" });
      const runPath = join(prepared.runDir, "run.json");
      const run = JSON.parse(readFileSync(runPath, "utf8"));
      run[field] = "0".repeat(64);
      writeFileSync(runPath, `${JSON.stringify(run, null, 2)}\n`, "utf8");
      await assert.rejects(
        () => maskingRealRun({
          repoRoot: process.cwd(),
          runsDir,
          runId,
          flags: { "--credential-source": join(runsDir, "missing.json") },
        }),
        new RegExp(`${field === "manifestSha256" ? "manifest" : "profile"} bytes differ`),
      );
      assert.equal(readFileSync(runPath, "utf8").includes("piRuntime"), false, "input drift must refuse before runtime preflight");
    }
  } finally {
    rmSync(runsDir, { recursive: true, force: true });
  }
});

test("maskingRealRun surfaces the shared preflight refusal for a missing credential", async () => {
  const runsDir = mkdtempSync(join(tmpdir(), "cm-red-a-"));
  try {
    maskingPrepare({ repoRoot: process.cwd(), runsDir, runId: "real-a", mode: "real" });
    await assert.rejects(
      () =>
        maskingRealRun({
          repoRoot: process.cwd(),
          runsDir,
          runId: "real-a",
          flags: {
            "--confirm-paid": true,
            "--credential-source": join(runsDir, "missing.json"),
            "--cache-dir": join(runsDir, "cache"),
          },
        }),
      /preflight refused: .*credential/,
    );
  } finally {
    rmSync(runsDir, { recursive: true, force: true });
  }
});
