/**
 * Real-mode resume guard tests (public boundary: evaluation/runner/cli.mjs).
 *
 * Fake-only and offline: a real-mode run with no reserved attempts must
 * resume by doing nothing. Real resume never reserves or respawns a
 * paid attempt; a reserved non-terminal attempt is abandoned in place.
 */

import { test, describe } from "node:test";
import assert from "node:assert/strict";
import { fileURLToPath } from "node:url";
import { dirname, join } from "node:path";
import { existsSync, mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { spawnSync } from "node:child_process";

const repoRoot = join(dirname(fileURLToPath(import.meta.url)), "..", "..");
const cli = join(repoRoot, "evaluation", "runner", "cli.mjs");

function runCli(args) {
  return spawnSync(process.execPath, [cli, ...args], {
    cwd: repoRoot,
    encoding: "utf8",
    timeout: 60_000,
  });
}

describe("real resume guard", () => {
  test("real-mode resume never reserves or respawns paid attempts", () => {
    const runsDir = mkdtempSync(join(tmpdir(), "cm-real-resume-guard-"));
    const runId = "real-resume-guard-01";
    try {
      assert.equal(runCli(["prepare", "--runs-dir", runsDir, "--run-id", runId, "--mode", "real"]).status, 0);
      const resumed = runCli(["resume", "--runs-dir", runsDir, "--run-id", runId]);
      assert.equal(resumed.status, 0, `resume failed: ${resumed.stderr.slice(0, 400)}`);
      const summary = JSON.parse(resumed.stdout.trim().split("\n").pop());
      assert.equal(summary.executed, 0, "no attempt may be executed by a real resume");
      assert.equal(summary.abandonedReserved, 0, "nothing was reserved, so nothing is abandoned");
      assert.equal(
        existsSync(join(runsDir, runId, "attempts")),
        false,
        "real resume must not create or claim any attempt slot",
      );
    } finally {
      rmSync(runsDir, { recursive: true, force: true });
    }
  });
});
