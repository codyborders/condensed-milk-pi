/**
 * Real run --timeout-ms validation tests
 * (public boundary: evaluation/runner/cli.mjs run -> real.mjs).
 *
 * --timeout-ms must be a positive finite integer. Anything else must
 * refuse before any attempt slot is reserved, without touching the
 * credential source or the provider. Offline and fake-only.
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

describe("real run --timeout-ms validation", () => {
  test("non-positive, non-finite, and non-integer values refuse before any reservation", () => {
    const runsDir = mkdtempSync(join(tmpdir(), "cm-timeout-guard-"));
    const runId = "timeout-guard-01";
    try {
      assert.equal(runCli(["prepare", "--runs-dir", runsDir, "--run-id", runId, "--mode", "real"]).status, 0);
      for (const bad of ["0", "-1000", "abc", "500.5", "1e3", "9007199254740993", " 5", ""]) {
        const refused = runCli([
          "run", "--runs-dir", runsDir, "--run-id", runId, "--task", "task-01",
          "--confirm-paid", "--timeout-ms", bad,
        ]);
        assert.notEqual(refused.status, 0, `--timeout-ms ${JSON.stringify(bad)} must refuse`);
        assert.match(
          refused.stderr,
          /--timeout-ms must be a positive finite integer/,
          `refusal must name the flag for ${JSON.stringify(bad)}: ${refused.stderr.slice(0, 200)}`,
        );
        assert.equal(
          existsSync(join(runsDir, runId, "attempts")),
          false,
          "refusal must happen before any attempt directory exists",
        );
      }
    } finally {
      rmSync(runsDir, { recursive: true, force: true });
    }
  });
});
