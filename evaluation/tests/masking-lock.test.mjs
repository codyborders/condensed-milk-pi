/**
 * Masking paid-run lock tests (P0): cmdMaskingRun holds the shared run
 * lock for the whole paid run, honors --recover-lock, and a second
 * owner cannot run concurrently.
 */

import { test, describe } from "node:test";
import assert from "node:assert/strict";
import { mkdtempSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join, dirname } from "node:path";
import { fileURLToPath } from "node:url";
import { spawnSync } from "node:child_process";
import { maskingPrepare } from "../runner/masking.mjs";
import { acquireRunLock, releaseRunLock } from "../runner/state.mjs";
import { startFakeUpstream, writeCredentialSource } from "./real-attempt-fakes.mjs";
import { makeFakeMaskingRuntime } from "./masking-real.test.mjs";
import { mkdtempSync as mkdtemp, rmSync as rmdir } from "node:fs";

const repoRoot = join(dirname(fileURLToPath(import.meta.url)), "..", "..");
const cli = join(repoRoot, "evaluation", "runner", "cli.mjs");

function runCli(args) {
  return spawnSync(process.execPath, [cli, ...args], { cwd: repoRoot, encoding: "utf8" });
}

function prepareRealRun(runsDir, runId) {
  return maskingPrepare({ repoRoot, runsDir, runId, mode: "real" }).runDir;
}

describe("masking run lock", () => {
  test("a second owner is refused while the lock is held and --recover-lock clears a stale lock", () => {
    const runsDir = mkdtempSync(join(tmpdir(), "cm-masking-lock-"));
    const runDir = prepareRealRun(runsDir, "masking-lock-01");
    acquireRunLock(runDir, {});
    try {
      const second = runCli([
        "masking-run", "--runs-dir", runsDir, "--run-id", "masking-lock-01", "--confirm-paid",
      ]);
      assert.notEqual(second.status, 0, "a concurrent owner must fail");
      assert.match(second.stderr, /lock/i, "the refusal must name the lock");
    } finally {
      releaseRunLock(runDir);
    }
    const staleLockPath = join(runDir, "run.lock");
    writeFileSync(staleLockPath, "stale\n", "utf8");
    const recovered = runCli([
      "masking-run", "--runs-dir", runsDir, "--run-id", "masking-lock-01",
      "--confirm-paid", "--recover-lock",
    ]);
    assert.match(recovered.stderr, /preflight refused: .*credential/, "after recovery the shared preflight refusal applies");
    rmSync(runsDir, { recursive: true, force: true });
  });

  test("a successful paid masking run prints structured JSON and exits 0", { timeout: 300_000 }, async () => {
    const work = mkdtemp(join(tmpdir(), "cm-masking-exit-"));
    const upstream = await startFakeUpstream();
    try {
      const runsDir = join(work, "runs");
      const cacheDir = join(work, "cache");
      const credentialSource = join(work, "models.json");
      writeCredentialSource(credentialSource, `http://127.0.0.1:${upstream.port}`);
      const fakeRuntime = makeFakeMaskingRuntime(cacheDir);
      const prepare = runCli(["masking-prepare", "--runs-dir", runsDir, "--run-id", "exit-01", "--mode", "real"]);
      assert.equal(prepare.status, 0);
      const paid = runCli([
        "masking-run", "--runs-dir", runsDir, "--run-id", "exit-01",
        "--confirm-paid", "--credential-source", credentialSource,
        "--cache-dir", cacheDir, "--pi-runtime", fakeRuntime,
      ]);
      assert.equal(paid.status, 0, `paid run must exit 0: ${paid.stderr.slice(0, 400)}`);
      const outcome = JSON.parse(paid.stdout.trim().split("\n").pop());
      assert.equal(outcome.executed, 48);
      assert.equal(outcome.stoppedReason, null);
      assert.equal(typeof paid.status, "number");
    } finally {
      await upstream.close();
      rmdir(work, { recursive: true, force: true });
    }
  });
});
