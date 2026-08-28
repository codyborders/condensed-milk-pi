/** Red probe: masking-abandon must refuse an unknown task id without creating paths. */
import { test } from "node:test";
import assert from "node:assert/strict";
import { mkdtempSync, rmSync, mkdirSync, writeFileSync, existsSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { spawnSync } from "node:child_process";

test("masking-abandon refuses an unknown task id before any path join", () => {
  const work = mkdtempSync(join(tmpdir(), "cm-red-abandon-"));
  try {
    const runDir = join(work, "runs", "a1");
    mkdirSync(join(runDir, "attempts", "masking-task-02", "upstream", "attempt-002"), { recursive: true });
    writeFileSync(
      join(runDir, "run.json"),
      JSON.stringify({ schemaVersion: 1, study: "masking", runId: "a1", mode: "real", armOrder: {}, repetitionOrder: {} }),
    );
    writeFileSync(
      join(runDir, "attempts", "masking-task-02", "upstream", "attempt-002", "provider-invocation.json"),
      JSON.stringify({ runId: "a1", taskId: "masking-task-02", arm: "upstream", attempt: 2, fake: false }),
    );
    const out = spawnSync(
      process.execPath,
      [
        "evaluation/runner/cli.mjs", "masking-abandon",
        "--runs-dir", join(work, "runs"), "--run-id", "a1",
        "--task", "masking-task-99", "--arm", "upstream", "--attempt", "2", "--reason", "r",
      ],
      { cwd: process.cwd(), encoding: "utf8" },
    );
    assert.notEqual(out.status, 0, "an unknown task id must refuse");
    assert.equal(existsSync(join(runDir, "attempts", "masking-task-99")), false, "no directory may be created");
  } finally {
    rmSync(work, { recursive: true, force: true });
  }
});
