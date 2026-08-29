/**
 * Holdout bundle sealing (grown test-first).
 *
 * Sealing turns one external private definitions document plus one
 * external key into the two tracked artifacts: the authenticated
 * encrypted bundle (holdout.enc) and the public holdout manifest
 * carrying only ids, coverage, frozen hashes, the ciphertext digest,
 * and non-sensitive execution metadata. No plaintext and no key ever
 * land inside the repository, and the seal result never echoes either.
 */

import { test } from "node:test";
import assert from "node:assert/strict";
import { existsSync, mkdirSync, mkdtempSync, readFileSync, readdirSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { providerStudySealHoldout } from "../runner/seal.mjs";
import { ensureHoldoutKeyFile, readHoldoutKey, withHoldoutTasks } from "../runner/holdout.mjs";
import { loadProviderStudyManifestFile } from "../runner/manifest.mjs";

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

function privateDocument(tasks) {
  return {
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
    tasks,
  };
}

test("seal writes the encrypted bundle and public manifest and never tracks plaintext or the key", async () => {
  const work = mkdtempSync(join(tmpdir(), "cm-ps-seal-"));
  try {
    const repoRoot = join(work, "repo");
    mkdirSync(join(repoRoot, "evaluation", "provider-study"), { recursive: true });
    const keyPath = join(work, "holdout.env");
    const privatePath = join(work, "holdout-private.json");
    writeFileSync(privatePath, `${JSON.stringify(privateDocument(privateTasks()), null, 2)}\n`, "utf8");
    ensureHoldoutKeyFile(keyPath);
    const sealed = await providerStudySealHoldout({ repoRoot, keySourcePath: keyPath, privateTasksPath: privatePath });
    assert.equal(sealed.keyGenerated, false, "a pre-ensured key entry is reused, never replaced");
    assert.equal(existsSync(sealed.bundlePath), true);
    assert.equal(existsSync(sealed.manifestPath), true);
    await assert.rejects(
      () => providerStudySealHoldout({ repoRoot, keySourcePath: keyPath, privateTasksPath: privatePath }),
      /refusing to overwrite|already exists/,
    );
    assert.match(sealed.bundleSha256, /^[0-9a-f]{64}$/);
    assert.equal(sealed.tasks.length, 8);
    assert.equal(JSON.stringify(sealed).includes("sandbox hidden prompt"), false, "the seal result never carries plaintext");
    assert.equal(JSON.stringify(sealed).includes(readHoldoutKey({ keySourcePath: keyPath })), false, "the seal result never carries the key");
    const loaded = loadProviderStudyManifestFile(repoRoot, { phase: "holdout" });
    assert.equal(loaded.tasks.length, 8);
    assert.equal(loaded.tasks[0].prompt, undefined, "the public manifest carries no prompt");
    assert.equal(loaded.tasks[0].fixture, undefined, "the public manifest carries no fixture");
    assert.match(loaded.tasks[0].taskSha256, /^[0-9a-f]{64}$/);
    assert.match(loaded.tasks[0].scorerSha256, /^[0-9a-f]{64}$/);
    assert.match(loaded.tasks[0].solutionSha256, /^[0-9a-f]{64}$/);
    assert.match(loaded.tasks[0].fixtureSha256, /^[0-9a-f]{64}$/);
    // No plaintext anywhere inside the sandbox repository tree.
    const needles = ["sandbox hidden prompt", "sandbox noisy-tests", "chore: import sandbox fixture"];
    const hits = [];
    const walk = (dir) => {
      for (const entry of readdirSync(dir, { withFileTypes: true })) {
        const path = join(dir, entry.name);
        if (entry.isDirectory()) {
          walk(path);
          continue;
        }
        const text = readFileSync(path, "utf8");
        for (const needle of needles) {
          if (text.includes(needle)) hits.push(`${path}:${needle}`);
        }
      }
    };
    walk(repoRoot);
    assert.deepEqual(hits, [], "no holdout plaintext may be tracked inside the repository");
    // The sealed bundle opens through the ledgered path with the same key.
    const runsRoot = join(work, "runs");
    mkdirSync(runsRoot, { recursive: true });
    await withHoldoutTasks({
      repoRoot,
      runsRoot,
      command: "dry-run",
      keySourcePath: keyPath,
      taskIds: ["holdout-task-01"],
      fn: async ({ tasks }) => {
        assert.equal(tasks.get("holdout-task-01").prompt, "sandbox hidden prompt for noisy-tests");
      },
    });
  } finally {
    rmSync(work, { recursive: true, force: true });
  }
});
