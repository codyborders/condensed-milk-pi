/** Red probe: masking-abandon must refuse a multiline or overlong reason. */
import { test } from "node:test";
import assert from "node:assert/strict";
import { mkdtempSync, rmSync, mkdirSync, writeFileSync, existsSync, readFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { spawnSync } from "node:child_process";

function prepare(work, runId) {
  const runDir = join(work, "runs", runId);
  const attemptDir = join(runDir, "attempts", "masking-task-02", "upstream", "attempt-002");
  mkdirSync(attemptDir, { recursive: true });
  writeFileSync(
    join(runDir, "run.json"),
    JSON.stringify({ schemaVersion: 1, study: "masking", runId, mode: "real", armOrder: {}, repetitionOrder: {} }),
  );
  writeFileSync(
    join(attemptDir, "provider-invocation.json"),
    JSON.stringify({ runId, taskId: "masking-task-02", arm: "upstream", attempt: 2, fake: false }),
  );
  return { runDir, attemptDir };
}

test("masking-abandon refuses a multiline or overlong reason", () => {
  const work = mkdtempSync(join(tmpdir(), "cm-red-abandon-reason-"));
  try {
    const { runDir, attemptDir } = prepare(work, "a1");
    const run = (reason) =>
      spawnSync(
        process.execPath,
        [
          "evaluation/runner/cli.mjs", "masking-abandon",
          "--runs-dir", join(work, "runs"), "--run-id", "a1",
          "--task", "masking-task-02", "--arm", "upstream", "--attempt", "2", "--reason", reason,
        ],
        { cwd: process.cwd(), encoding: "utf8" },
      );
    const multiline = run("line one\nline two");
    assert.notEqual(multiline.status, 0, "a multiline reason must refuse");
    assert.equal(existsSync(join(attemptDir, "result.json")), false, "no terminal result on refusal");
    const overlong = run("x".repeat(513));
    assert.notEqual(overlong.status, 0, "an overlong reason must refuse");
    const bounded = run("crash after reservation");
    assert.equal(bounded.status, 0, "a bounded single-line reason still works");
    const runAfter = JSON.parse(readFileSync(join(runDir, "run.json"), "utf8"));
    assert.equal(runAfter.invalid, true);
  } finally {
    rmSync(work, { recursive: true, force: true });
  }
});
