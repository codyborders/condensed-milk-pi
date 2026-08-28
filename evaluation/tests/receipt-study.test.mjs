/**
 * Receipt study-extension tests (receipt.mjs).
 *
 * validateSelectedAttemptReceipt accepts an optional `expected` object
 * with study, profile, and fixture identity fields. When `expected` is
 * absent the standard receipt behavior is unchanged.
 */

import { test, describe } from "node:test";
import assert from "node:assert/strict";
import { mkdtempSync, mkdirSync, readFileSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join, dirname } from "node:path";
import { fileURLToPath } from "node:url";
import { validateSelectedAttemptReceipt } from "../runner/receipt.mjs";
import { loadManifestFile } from "../lib/manifest.mjs";

const repoRoot = join(dirname(fileURLToPath(import.meta.url)), "..", "..");
const manifest = loadManifestFile(join(repoRoot, "evaluation", "task-manifest.json"));

function writeAttempt(work, { receiptExtra = {}, pinnedExtra = {} } = {}) {
  const runDir = join(work, "run");
  const attemptDir = join(runDir, "attempts", "masking-task-01", "fork", "attempt-002");
  mkdirSync(attemptDir, { recursive: true });
  writeFileSync(
    join(runDir, "run.json"),
    `${JSON.stringify({ runId: "r1", mode: "real", piRuntime: { digest: "1".repeat(64) } })}\n`,
    "utf8",
  );
  writeFileSync(
    join(attemptDir, "provider-invocation.json"),
    JSON.stringify({
      schemaVersion: 1,
      runId: "r1",
      taskId: "masking-task-01",
      arm: "fork",
      attempt: 2,
      fake: false,
      provider: manifest.evaluation.provider,
      model: manifest.evaluation.model,
      armCommit: manifest.evaluation.arms[1].commit,
      study: "masking",
      profileSha256: "a".repeat(64),
      fixtureContentSha256: "b".repeat(64),
      fixtureGitStateSha256: "c".repeat(64),
      piRuntime: { digest: "1".repeat(64) },
      ...receiptExtra,
    }) + "\n",
    "utf8",
  );
  writeFileSync(
    join(attemptDir, "pinned.json"),
    JSON.stringify({
      schemaVersion: 1,
      piRuntime: { digest: "1".repeat(64) },
      ...pinnedExtra,
    }) + "\n",
    "utf8",
  );
  return { runDir, attemptDir };
}

describe("receipt study extension", () => {
  test("expected study, profile, and fixture fields validate and mismatches refuse", () => {
    const work = mkdtempSync(join(tmpdir(), "cm-receipt-study-"));
    try {
      const { runDir, attemptDir } = writeAttempt(work, {
        pinnedExtra: { profileSha256: "a".repeat(64), fixtureContentSha256: "b".repeat(64), fixtureGitStateSha256: "c".repeat(64), study: "masking" },
      });
      const base = { runDir, attemptDir, runId: "r1", taskId: "masking-task-01", arm: "fork", attempt: 2, manifest };
      const good = validateSelectedAttemptReceipt({
        ...base,
        expected: { study: "masking", profileSha256: "a".repeat(64), fixtureContentSha256: "b".repeat(64), fixtureGitStateSha256: "c".repeat(64) },
      });
      assert.equal(good.ok, true, good.reason);
      const wrongProfile = validateSelectedAttemptReceipt({
        ...base,
        expected: { study: "masking", profileSha256: "d".repeat(64) },
      });
      assert.equal(wrongProfile.ok, false);
      const wrongStudy = validateSelectedAttemptReceipt({
        ...base,
        expected: { study: "other" },
      });
      assert.equal(wrongStudy.ok, false);
      const wrongImplementation = validateSelectedAttemptReceipt({
        ...base,
        expected: { implementationSha256: "e".repeat(64) },
      });
      assert.equal(wrongImplementation.ok, false, "a mismatched implementation digest must invalidate");
      const wrongObserver = validateSelectedAttemptReceipt({
        ...base,
        expected: { observerSha256: "e".repeat(64) },
      });
      assert.equal(wrongObserver.ok, false, "a mismatched observer digest must invalidate");
      // Without `expected`, standard receipt behavior stays unchanged.
      const standard = validateSelectedAttemptReceipt(base);
      assert.equal(standard.ok, true, standard.reason);
    } finally {
      rmSync(work, { recursive: true, force: true });
    }
  });
});
