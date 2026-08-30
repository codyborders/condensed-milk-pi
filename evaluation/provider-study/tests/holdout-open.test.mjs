/**
 * Holdout bundle opening (grown test-first).
 *
 * Runner holdout commands open the encrypted bundle through
 * withHoldoutTasks: the explicit --holdout-key-source path is
 * mandatory, the external ledger is appended before any decryption,
 * decrypted bytes land only in a private temporary directory that is
 * removed afterwards, and every decrypted task must match its public
 * hash. Tests use a temporary key and sandbox fixtures, never the
 * real key.
 */

import { test } from "node:test";
import assert from "node:assert/strict";
import { existsSync, mkdirSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import {
  generateHoldoutKey,
  writeHoldoutKeyFile,
  encryptHoldoutBundle,
  holdoutBundleEnvelopeSha256,
} from "../runner/holdout.mjs";
import * as holdoutModule from "../runner/holdout.mjs";

const holdoutTaskSha256 = holdoutModule.holdoutTaskSha256;
const holdoutObjectSha256 = holdoutModule.holdoutObjectSha256;
const withHoldoutTasks = holdoutModule.withHoldoutTasks;

function publicTask(task, coverage) {
  return {
    id: task.id,
    coverage,
    taskSha256: holdoutTaskSha256(task),
    scorerSha256: holdoutObjectSha256(task.scorer),
    solutionSha256: holdoutObjectSha256(task.solution),
    fixtureSha256: holdoutObjectSha256(task.fixture),
  };
}

test("withHoldoutTasks appends the holdout ledger before any decryption runs", async () => {
  assert.equal(typeof withHoldoutTasks, "function", "the holdout open boundary must exist");
  assert.equal(typeof holdoutTaskSha256, "function", "the public per-task hash boundary must exist");
  const work = mkdtempSync(join(tmpdir(), "cm-ps-holdout-open-"));
  try {
    const repoRoot = join(work, "repo", "evaluation", "provider-study");
    mkdirSync(repoRoot, { recursive: true });
    const key = generateHoldoutKey();
    const keyPath = join(work, "holdout.env");
    writeHoldoutKeyFile(keyPath, key);
    const tags = [
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
    const privateTasks = tags.filter((_, index) => index < 8).map((tag, index) => ({
      id: `holdout-task-0${index + 1}`,
      prompt: `hidden prompt for ${tag}`,
      fixture: { files: [{ path: "a.txt", content: "a" }] },
      scorer: { assertions: [{ id: "x", kind: "fileOccurrences", path: "a.txt", needle: "a", min: 1, max: 1 }] },
      solution: { files: [{ path: "a.txt", content: "a" }] },
    }));
    const coverageFor = (index) => (index < 3 ? [tags[index], tags[8 + index]] : [tags[index]]);
    const envelope = encryptHoldoutBundle({ plainText: JSON.stringify({ schemaVersion: 1, tasks: privateTasks }), keyHex: key });
    writeFileSync(join(repoRoot, "holdout.enc"), `${JSON.stringify(envelope, null, 2)}\n`, "utf8");
    writeFileSync(
      join(repoRoot, "holdout-manifest.json"),
      `${JSON.stringify({
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
          seed: "sandbox-holdout",
        },
        bundle: { algorithm: "aes-256-gcm", authenticated: true, bundleSha256: holdoutBundleEnvelopeSha256(envelope) },
        tasks: privateTasks.map((task, index) => publicTask(task, coverageFor(index))),
      }, null, 2)}\n`,
      "utf8",
    );
    const runsRoot = join(work, "runs");
    mkdirSync(runsRoot, { recursive: true });
    const ledgerPath = join(runsRoot, "holdout-access-ledger.jsonl");
    let ledgerExistedDuringCommand = false;
    await withHoldoutTasks({
      repoRoot: join(work, "repo"),
      runsRoot,
      command: "dry-run",
      keySourcePath: keyPath,
      taskIds: ["holdout-task-01"],
      fn: async () => {
        ledgerExistedDuringCommand = existsSync(ledgerPath);
      },
    });
    assert.equal(ledgerExistedDuringCommand, true, "the ledger entry lands before the command body runs");
    const entry = JSON.parse(readFileSync(ledgerPath, "utf8").trim().split("\n")[0]);
    assert.equal(entry.command, "dry-run");
    assert.deepEqual(entry.taskIds, ["holdout-task-01"]);
  } finally {
    rmSync(work, { recursive: true, force: true });
  }
});

test("withHoldoutTasks decrypts verified tasks into a private temporary directory and removes it afterwards", async () => {
  const work = mkdtempSync(join(tmpdir(), "cm-ps-holdout-decrypt-"));
  try {
    const repoRoot = join(work, "repo", "evaluation", "provider-study");
    mkdirSync(repoRoot, { recursive: true });
    const key = generateHoldoutKey();
    const keyPath = join(work, "holdout.env");
    writeHoldoutKeyFile(keyPath, key);
    const tags = [
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
    const privateTasks = tags.filter((_, index) => index < 8).map((tag, index) => ({
      id: `holdout-task-0${index + 1}`,
      prompt: `hidden prompt for ${tag}`,
      fixture: { files: [{ path: "a.txt", content: "a" }] },
      scorer: { assertions: [{ id: "x", kind: "fileOccurrences", path: "a.txt", needle: "a", min: 1, max: 1 }] },
      solution: { files: [{ path: "a.txt", content: "a" }] },
    }));
    const coverageFor = (index) => (index < 3 ? [tags[index], tags[8 + index]] : [tags[index]]);
    const envelope = encryptHoldoutBundle({ plainText: JSON.stringify({ schemaVersion: 1, tasks: privateTasks }), keyHex: key });
    writeFileSync(join(repoRoot, "holdout.enc"), `${JSON.stringify(envelope, null, 2)}\n`, "utf8");
    writeFileSync(
      join(repoRoot, "holdout-manifest.json"),
      `${JSON.stringify({
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
          seed: "sandbox-holdout",
        },
        bundle: { algorithm: "aes-256-gcm", authenticated: true, bundleSha256: holdoutBundleEnvelopeSha256(envelope) },
        tasks: privateTasks.map((task, index) => publicTask(task, coverageFor(index))),
      }, null, 2)}\n`,
      "utf8",
    );
    const runsRoot = join(work, "runs");
    mkdirSync(runsRoot, { recursive: true });
    let observedPrivateDir = null;
    await withHoldoutTasks({
      repoRoot: join(work, "repo"),
      runsRoot,
      command: "dry-run",
      keySourcePath: keyPath,
      taskIds: [],
      fn: async ({ tasks, privateDir }) => {
        assert.equal(tasks.get("holdout-task-01").prompt, "hidden prompt for noisy-tests", "verified decrypted tasks reach the command");
        assert.equal(existsSync(join(privateDir, "holdout-private.json")), true, "decryption lands in the private temporary directory");
        observedPrivateDir = privateDir;
      },
    });
    assert.equal(existsSync(observedPrivateDir), false, "the decrypted bytes are cleaned after the command");
  } finally {
    rmSync(work, { recursive: true, force: true });
  }
});
