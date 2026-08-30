/**
 * Provider-study holdout access ledger (grown test-first).
 *
 * Every read of holdout task data during a holdout phase run is
 * appended to a ledger under the run root before any decryption. The
 * development phase refuses holdout tasks outright, so holdout
 * material is only ever touched through a ledgered holdout command
 * that carries --holdout-key-source. The dry-run executes real
 * fixture worktrees and hidden scorers from the decrypted bundle.
 */

import { test } from "node:test";
import assert from "node:assert/strict";
import { existsSync, mkdirSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from "node:fs";
import { join } from "node:path";
import { tmpdir } from "node:os";
import { fileURLToPath } from "node:url";
import { providerStudyDryRun } from "../runner/study.mjs";
import { providerStudyHoldoutLedgerPath } from "../runner/ledger.mjs";
import { providerStudySealHoldout } from "../runner/seal.mjs";
import { ensureHoldoutKeyFile } from "../runner/holdout.mjs";

const repoRoot = join(fileURLToPath(import.meta.url), "..", "..", "..", "..");

const COVERAGE = [
  "noisy-tests",
  "typescript-build-failures",
  "git-status-large-diffs",
  "repeated-reads",
  "search",
  "repetitive-logs",
  "successful-failed-commands",
  "long-masking-pressure",
  "exact-warnings-paths",
  "archive-recovery",
  "multi-step-implementation",
];

function privateTasks() {
  return COVERAGE.filter((_, index) => index < 8).map((tag, index) => ({
    id: `holdout-task-0${index + 1}`,
    title: `sandbox ${tag}`,
    coverage: index < 3 ? [tag, COVERAGE[8 + index]] : [tag],
    prompt: `sandbox hidden prompt for ${tag}`,
    fixture: {
      files: [{ path: "context/a.txt", content: `sandbox fixture for ${tag}\n` }],
      generate: [],
      mutations: [],
      untracked: [],
      git: {
        author: { name: "Eval Fixture", email: "fixture@example.invalid" },
        startDate: "2026-02-01T00:00:00Z",
        commits: [{ message: "chore: import sandbox fixture", paths: ["all"] }],
        post: [],
      },
    },
    scorer: {
      schemaVersion: 1,
      assertions: [{ id: "x", kind: "fileOccurrences", path: "out.txt", needle: "done", min: 1, max: 1 }],
    },
    solution: { schemaVersion: 1, files: [{ path: "out.txt", content: "done\n" }], commands: [] },
  }));
}

/** One sealed sandbox repository with its external key, outside the repo. */
function buildSandbox(prefix) {
  const work = mkdtempSync(join(tmpdir(), prefix));
  const repoRoot = join(work, "repo");
  mkdirSync(join(repoRoot, "evaluation", "provider-study"), { recursive: true });
  mkdirSync(join(work, "external"), { recursive: true });
  const keyPath = join(work, "external", "holdout.env");
  const privatePath = join(work, "external", "holdout-private.json");
  writeFileSync(privatePath, `${JSON.stringify({
    schemaVersion: 1,
    study: "provider-study",
    phase: "holdout",
    evaluation: {
      provider: "z-ai",
      model: "glm-5.3-flash",
      thinking: "high",
      piVersion: "0.84.2",
      tools: ["read", "bash", "edit", "write", "grep", "find", "ls", "condensed_milk_retrieve"],
      timeoutMsPerAttempt: 3600000,
      repetitionsPreallocated: 5,
      conditionalRepetitions: [6, 7, 8, 9, 10],
      noPaidRetry: true,
      armSet: "baseline-four",
      seed: "sandbox-holdout",
    },
    tasks: privateTasks(),
  }, null, 2)}\n`, "utf8");
  ensureHoldoutKeyFile(keyPath);
  const runsRoot = join(work, "runs");
  mkdirSync(runsRoot, { recursive: true });
  return { work, repoRoot, runsRoot, keyPath, privatePath };
}

test("holdout dry-run runs the holdout phase under its own root and records ledger entries", async () => {
  const sandbox = buildSandbox("provider-study-holdout-dry-");
  process.env.CM_PROVIDER_STUDY_FIXTURES = join(sandbox.work, "fixtures");
  try {
    await providerStudySealHoldout({ repoRoot: sandbox.repoRoot, keySourcePath: sandbox.keyPath, privateTasksPath: sandbox.privatePath });
    // Holdout material without a key source refuses before any holdout byte is read.
    await assert.rejects(
      () => providerStudyDryRun({ repoRoot: sandbox.repoRoot, runsRoot: sandbox.runsRoot, phase: "holdout", taskIds: ["holdout-task-08"] }),
      /--holdout-key-source/,
    );
    const result = await providerStudyDryRun({
      repoRoot: sandbox.repoRoot,
      runsRoot: sandbox.runsRoot,
      phase: "holdout",
      taskIds: ["holdout-task-08"],
      keySourcePath: sandbox.keyPath,
    });
    assert.equal(result.executed, 20);
    const ledgerPath = providerStudyHoldoutLedgerPath(sandbox.runsRoot);
    assert.ok(existsSync(ledgerPath), "the holdout access ledger must exist after a holdout run");
    const lines = readFileSync(ledgerPath, "utf8").trim().split("\n").map((line) => JSON.parse(line));
    assert.ok(lines.length >= 1);
    assert.equal(lines[0].phase, "holdout");
    assert.equal(lines[0].command, "dry-run");
    assert.ok(lines[0].taskIds.includes("holdout-task-08"));
    const attemptDir = join(sandbox.runsRoot, "holdout", "attempts", "holdout-task-08", "none", "attempt-001");
    const result1 = JSON.parse(readFileSync(join(attemptDir, "result.json"), "utf8"));
    assert.equal(result1.phase, "holdout");
    assert.equal(result1.deterministicResult, true, "the decrypted hidden scorer passes on the applied hidden solution");
    // A wrong key refuses through the authenticated decryption path.
    const wrongKeyPath = join(sandbox.work, "external", "wrong.env");
    ensureHoldoutKeyFile(wrongKeyPath);
    await assert.rejects(
      () => providerStudyDryRun({ repoRoot: sandbox.repoRoot, runsRoot: sandbox.runsRoot, phase: "holdout", taskIds: ["holdout-task-08"], keySourcePath: wrongKeyPath }),
      /authenticated|decrypt/i,
    );
    // A tampered frozen hash refuses before any task material is used.
    const manifestPath = join(sandbox.repoRoot, "evaluation", "provider-study", "holdout-manifest.json");
    const originalManifest = readFileSync(manifestPath, "utf8");
    const tampered = JSON.parse(originalManifest);
    tampered.tasks[7].scorerSha256 = "0".repeat(64);
    writeFileSync(manifestPath, `${JSON.stringify(tampered, null, 2)}\n`, "utf8");
    await assert.rejects(
      () => providerStudyDryRun({ repoRoot: sandbox.repoRoot, runsRoot: sandbox.runsRoot, phase: "holdout", taskIds: ["holdout-task-08"], keySourcePath: sandbox.keyPath }),
      /scorer.*hash|hash.*scorer/i,
    );
    writeFileSync(manifestPath, originalManifest, "utf8");
    // The development phase refuses holdout tasks before any fixture read.
    await assert.rejects(
      () => providerStudyDryRun({ repoRoot: sandbox.repoRoot, runsRoot: sandbox.runsRoot, phase: "development", taskIds: ["holdout-task-08"] }),
      /does not belong to the development phase/,
    );
  } finally {
    delete process.env.CM_PROVIDER_STUDY_FIXTURES;
    rmSync(sandbox.work, { recursive: true, force: true });
  }
});
