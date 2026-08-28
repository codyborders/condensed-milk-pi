/**
 * Abandoned-slot handling tests: a receipt without a terminal result
 * stops maskingRealRun immediately, and the locked masking-abandon
 * command marks the slot abandoned, invalidates the run, and never
 * creates another attempt or provider call.
 */

import { test, describe } from "node:test";
import assert from "node:assert/strict";
import { mkdtempSync, mkdirSync, rmSync, writeFileSync, readFileSync, readdirSync, existsSync } from "node:fs";
import { tmpdir } from "node:os";
import { join, dirname } from "node:path";
import { fileURLToPath } from "node:url";
import { spawnSync } from "node:child_process";
import { maskingPrepare, maskingRealRun } from "../runner/masking.mjs";
import { writeCredentialSource } from "./real-attempt-fakes.mjs";
import { makeFakeMaskingRuntime } from "./masking-real.test.mjs";

const repoRoot = join(dirname(fileURLToPath(import.meta.url)), "..", "..");
const cli = join(repoRoot, "evaluation", "runner", "cli.mjs");

function runCli(args) {
  return spawnSync(process.execPath, [cli, ...args], { cwd: repoRoot, encoding: "utf8" });
}

function reserveOnlySlot(runDir, runId, taskId, arm, rep) {
  const attemptDir = join(runDir, "attempts", taskId, arm, `attempt-${String(rep).padStart(3, "0")}`);
  mkdirSync(attemptDir, { recursive: true });
  writeFileSync(
    join(attemptDir, "provider-invocation.json"),
    `${JSON.stringify({ schemaVersion: 1, runId, taskId, arm, attempt: rep, fake: false })}\n`,
    "utf8",
  );
  return attemptDir;
}

describe("masking abandoned slots", () => {
  test("a reserved slot without a terminal result stops the run before any invocation", { timeout: 120_000 }, async () => {
    const work = mkdtempSync(join(tmpdir(), "cm-abandon-"));
    try {
      const runsDir = join(work, "runs");
      const cacheDir = join(work, "cache");
      maskingPrepare({ repoRoot, runsDir, runId: "abandon-01", mode: "real" });
      reserveOnlySlot(join(runsDir, "abandon-01"), "abandon-01", "masking-task-01", "fork", 1);
      const credentialSource = join(work, "models.json");
      writeCredentialSource(credentialSource, "http://127.0.0.1:1");
      const outcome = await maskingRealRun({
        repoRoot,
        runsDir,
        runId: "abandon-01",
        flags: {
          "--confirm-paid": true,
          "--credential-source": credentialSource,
          "--cache-dir": cacheDir,
          "--pi-runtime": makeFakeMaskingRuntime(cacheDir),
        },
      });
      assert.ok(outcome.stoppedReason, "an abandoned reserved slot must stop the run");
      assert.match(outcome.stoppedReason, /abandoned|reserved/i);
      // Exactly the slots before the abandoned one in persisted order
      // may have executed; nothing at or after it runs.
      const run = JSON.parse(readFileSync(join(runsDir, "abandon-01", "run.json"), "utf8"));
      const { manifest } = await import("../lib/masking-manifest.mjs").then((m) => ({ manifest: m.loadMaskingManifestFile(repoRoot).manifest }));
      let expectedBefore = 0;
      outer: for (const task of manifest.tasks) {
        for (const rep of run.repetitionOrder[task.id]) {
          for (const arm of run.armOrder[task.id]) {
            if (task.id === "masking-task-01" && arm === "fork" && rep === 1) break outer;
            expectedBefore += 1;
          }
        }
      }
      assert.equal(outcome.executed, expectedBefore, "only slots before the abandoned one may execute");
      const abandonedDir = join(runsDir, "abandon-01", "attempts", "masking-task-01", "fork", "attempt-001");
      assert.equal(existsSync(join(abandonedDir, "result.json")), false, "the abandoned slot stays terminal-free until masking-abandon");
      assert.equal(readdirSync(join(runsDir, "abandon-01", "attempts", "masking-task-01", "fork")).includes("attempt-004"), false, "no alternate attempt number may be created");
    } finally {
      rmSync(work, { recursive: true, force: true });
    }
  });

  test("masking-abandon marks the slot abandoned, invalidates the run, and blocks paid resume", { timeout: 60_000 }, async () => {
    const work = mkdtempSync(join(tmpdir(), "cm-abandon-cmd-"));
    try {
      const runsDir = join(work, "runs");
      maskingPrepare({ repoRoot, runsDir, runId: "abandon-02", mode: "real" });
      const runDir = join(runsDir, "abandon-02");
      const attemptDir = reserveOnlySlot(runDir, "abandon-02", "masking-task-02", "upstream", 2);
      const { spawnSync } = await import("node:child_process");
      const runCli = (args) => spawnSync(process.execPath, [join(repoRoot, "evaluation", "runner", "cli.mjs"), ...args], { cwd: repoRoot, encoding: "utf8" });
      const missing = runCli(["masking-abandon", "--runs-dir", runsDir, "--run-id", "abandon-02", "--task", "masking-task-02", "--arm", "upstream", "--attempt", "2"]);
      assert.notEqual(missing.status, 0, "a reason is required");
      const done = runCli([
        "masking-abandon", "--runs-dir", runsDir, "--run-id", "abandon-02",
        "--task", "masking-task-02", "--arm", "upstream", "--attempt", "2", "--reason", "crash after reservation",
      ]);
      assert.equal(done.status, 0, done.stderr);
      const result = JSON.parse(readFileSync(join(attemptDir, "result.json"), "utf8"));
      assert.equal(result.status, "abandoned");
      assert.equal(result.reason, "crash after reservation");
      const run = JSON.parse(readFileSync(join(runDir, "run.json"), "utf8"));
      assert.equal(run.invalid, true, "the whole run must be invalid");
      const again = runCli([
        "masking-abandon", "--runs-dir", runsDir, "--run-id", "abandon-02",
        "--task", "masking-task-02", "--arm", "upstream", "--attempt", "2", "--reason", "again",
      ]);
      assert.notEqual(again.status, 0, "a terminal slot cannot be abandoned twice");
      assert.equal(readdirSync(join(runDir, "attempts", "masking-task-02", "upstream")).includes("attempt-004"), false, "no alternate attempt number");
      const credentialSource = join(work, "models.json");
      writeCredentialSource(credentialSource, "http://127.0.0.1:1");
      await assert.rejects(
        () => maskingRealRun({
          repoRoot,
          runsDir,
          runId: "abandon-02",
          flags: { "--confirm-paid": true, "--credential-source": credentialSource, "--cache-dir": join(work, "cache") },
        }),
        /invalid after an abandoned slot/,
      );
    } finally {
      rmSync(work, { recursive: true, force: true });
    }
  });
});
