/**
 * Fixture-cache integrity tests (public boundary).
 *
 * Scope:
 * - publication writes one canonical integrity record at
 *   .git/integrity.json inside each cached task entry;
 * - every cache reuse re-verifies the record: non-.git content
 *   mutations, Git required-state mutations, record tampering, and
 *   missing records all refuse before any reservation path exists;
 * - pristine warm reuse passes;
 * - the fixture-generation command repairs an invalid entry through one
 *   fresh atomic publication;
 * - empty-cache and warm-cache publication are equal across all 20
 *   tasks (identical record digests and tree digests).
 *
 * Every test uses its own external temporary cache root through
 * CM_EVAL_FIXTURES_CACHE so no shared repository state is touched.
 */

import { test, describe } from "node:test";
import assert from "node:assert/strict";
import { fileURLToPath } from "node:url";
import { dirname, join } from "node:path";
import { existsSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { spawnSync } from "node:child_process";
import { publishFixtureCache, sealIntegrityRecord, verifyFixtureCacheEntry } from "../lib/cache.mjs";
import { loadManifestFile } from "../lib/manifest.mjs";

const repoRoot = join(dirname(fileURLToPath(import.meta.url)), "..", "..");
const manifest = loadManifestFile(join(repoRoot, "evaluation", "task-manifest.json"));
const cli = join(repoRoot, "evaluation", "runner", "cli.mjs");

function taskById(id) {
  return manifest.tasks.find((task) => task.id === id);
}

function tempDir() {
  return mkdtempSync(join(tmpdir(), "cm-eval-cache-int-"));
}

function git(cwd, argv) {
  const result = spawnSync("git", argv, {
    cwd,
    encoding: "utf8",
    env: {
      PATH: process.env.PATH ?? "/usr/bin:/bin",
      GIT_CONFIG_GLOBAL: "/dev/null",
      GIT_CONFIG_NOSYSTEM: "1",
      HOME: cwd,
    },
  });
  if (result.status !== 0) {
    throw new Error(`git ${argv.join(" ")} failed: ${result.stderr}`);
  }
  return result.stdout.trim();
}

/** Publish one task into an isolated cache root, then run one dry-run arm. */
function runDryArm({ dir, runId, taskId, arm }) {
  const cacheRoot = join(dir, "cache");
  const runsDir = join(dir, "runs");
  const env = { ...process.env, CM_EVAL_FIXTURES_CACHE: cacheRoot };
  const prepare = spawnSync(process.execPath, [cli, "prepare", "--runs-dir", runsDir, "--run-id", runId], {
    encoding: "utf8",
    env,
  });
  assert.equal(prepare.status, 0, prepare.stderr);
  return spawnSync(
    process.execPath,
    [cli, "dry-run", "--runs-dir", runsDir, "--run-id", runId, "--task", taskId, "--arm", arm],
    { encoding: "utf8", env, timeout: 180_000 },
  );
}

function journalOf(dir, runId) {
  return readFileSync(join(dir, "runs", runId, "journal.jsonl"), "utf8");
}

describe("fixture cache integrity", () => {
  test("pristine warm reuse verifies and the dry-run succeeds", () => {
    const dir = tempDir();
    try {
      const cacheRoot = join(dir, "cache");
      publishFixtureCache({ repoRoot, task: taskById("task-01"), cacheRoot });
      const check = verifyFixtureCacheEntry({ task: taskById("task-01"), entryDir: join(cacheRoot, "task-01") });
      assert.equal(check.ok, true, JSON.stringify(check.errors));
      const dry = runDryArm({ dir, runId: "cache-warm", taskId: "task-01", arm: "upstream" });
      assert.equal(dry.status, 0, dry.stderr.slice(0, 400));
      const attemptDir = join(dir, "runs", "cache-warm", "attempts", "task-01", "upstream", "attempt-001");
      assert.ok(existsSync(join(attemptDir, "result.json")), "warm reuse must execute the attempt");
    } finally {
      rmSync(dir, { recursive: true, force: true });
    }
  });

  test("non-.git content mutation refuses before any reservation path or journal entry", () => {
    const dir = tempDir();
    try {
      const cacheRoot = join(dir, "cache");
      publishFixtureCache({ repoRoot, task: taskById("task-01"), cacheRoot });
      const mutated = join(cacheRoot, "task-01", "stats.py");
      const original = readFileSync(mutated, "utf8");
      writeFileSync(mutated, `${original}# tampered\n`, "utf8");

      const dry = runDryArm({ dir, runId: "cache-mut", taskId: "task-01", arm: "upstream" });
      assert.equal(dry.status, 4, "mutated content must refuse with the fixture-refused exit");
      assert.ok((dry.stderr || "").includes("fixture"), `stderr must explain: ${(dry.stderr || "").slice(0, 300)}`);
      assert.ok((dry.stderr || "").includes("integrity mismatch"));
      assert.equal(
        existsSync(join(dir, "runs", "cache-mut", "attempts", "task-01", "upstream", "attempt-001")),
        false,
        "refusal must precede the reservation directory",
      );
      const journal = journalOf(dir, "cache-mut");
      assert.ok(journal.includes("fixture-refused"), "refusal must be journalled");
      assert.equal(journal.includes("attempt-reserved"), false, "no reservation may be journalled");
    } finally {
      rmSync(dir, { recursive: true, force: true });
    }
  });

  test("git required-state mutation (moved HEAD) refuses before any reservation path", () => {
    const dir = tempDir();
    try {
      const cacheRoot = join(dir, "cache");
      publishFixtureCache({ repoRoot, task: taskById("task-09"), cacheRoot });
      git(join(cacheRoot, "task-09"), ["commit", "--allow-empty", "-q", "-m", "state tamper"]);

      const dry = runDryArm({ dir, runId: "cache-gitmut", taskId: "task-09", arm: "upstream" });
      assert.equal(dry.status, 4, "moved HEAD must refuse");
      assert.ok((dry.stderr || "").includes("HEAD moved"), (dry.stderr || "").slice(0, 300));
      assert.equal(
        existsSync(join(dir, "runs", "cache-gitmut", "attempts", "task-09", "upstream", "attempt-001")),
        false,
        "refusal must precede the reservation directory",
      );
      assert.equal(journalOf(dir, "cache-gitmut").includes("attempt-reserved"), false);
    } finally {
      rmSync(dir, { recursive: true, force: true });
    }
  });

  test("git index mutation of a declared merge state refuses on reuse", () => {
    const dir = tempDir();
    try {
      const cacheRoot = join(dir, "cache");
      publishFixtureCache({ repoRoot, task: taskById("task-10"), cacheRoot });
      git(join(cacheRoot, "task-10"), ["add", "src/merge-driver.js"]);

      const check = verifyFixtureCacheEntry({ task: taskById("task-10"), entryDir: join(cacheRoot, "task-10") });
      assert.equal(check.ok, false, "resolved merge index must refuse");
      assert.ok(
        check.errors.some((error) => error.includes("src/merge-driver.js")),
        `errors must name the conflict path: ${JSON.stringify(check.errors)}`,
      );
      const dry = runDryArm({ dir, runId: "cache-idxmut", taskId: "task-10", arm: "upstream" });
      assert.equal(dry.status, 4);
      assert.equal(journalOf(dir, "cache-idxmut").includes("attempt-reserved"), false);
    } finally {
      rmSync(dir, { recursive: true, force: true });
    }
  });

  test("integrity-record mutation refuses on reuse before any reservation path", () => {
    const dir = tempDir();
    try {
      const cacheRoot = join(dir, "cache");
      publishFixtureCache({ repoRoot, task: taskById("task-01"), cacheRoot });
      const recordPath = join(cacheRoot, "task-01", ".git", "integrity.json");
      const stored = JSON.parse(readFileSync(recordPath, "utf8"));
      stored.postconditions.errors = ["tampered record detail"];
      const resealed = sealIntegrityRecord(stored);
      writeFileSync(recordPath, `${JSON.stringify(resealed, null, 2)}\n`, "utf8");

      const check = verifyFixtureCacheEntry({ task: taskById("task-01"), entryDir: join(cacheRoot, "task-01") });
      assert.equal(check.ok, false, "self-sealed record tampering must refuse");
      assert.ok(check.errors.some((error) => error.includes("canonical record digest")), JSON.stringify(check.errors));
      const dry = runDryArm({ dir, runId: "cache-recmut", taskId: "task-01", arm: "upstream" });
      assert.equal(dry.status, 4);
      assert.equal(journalOf(dir, "cache-recmut").includes("attempt-reserved"), false);
    } finally {
      rmSync(dir, { recursive: true, force: true });
    }
  });

  test("a missing integrity record refuses warm reuse before any reservation path", () => {
    const dir = tempDir();
    try {
      const cacheRoot = join(dir, "cache");
      publishFixtureCache({ repoRoot, task: taskById("task-01"), cacheRoot });
      rmSync(join(cacheRoot, "task-01", ".git", "integrity.json"));

      const dry = runDryArm({ dir, runId: "cache-norec", taskId: "task-01", arm: "upstream" });
      assert.equal(dry.status, 4, "missing record must refuse");
      assert.ok((dry.stderr || "").includes("integrity record is missing"), (dry.stderr || "").slice(0, 300));
      assert.equal(
        existsSync(join(dir, "runs", "cache-norec", "attempts", "task-01", "upstream", "attempt-001")),
        false,
        "refusal must precede the reservation directory",
      );
      assert.equal(journalOf(dir, "cache-norec").includes("attempt-reserved"), false);
    } finally {
      rmSync(dir, { recursive: true, force: true });
    }
  });

  test("the fixtures command repairs an invalid entry through fresh publication", () => {
    const dir = tempDir();
    try {
      const cacheRoot = join(dir, "cache");
      publishFixtureCache({ repoRoot, task: taskById("task-01"), cacheRoot });
      const mutated = join(cacheRoot, "task-01", "stats.py");
      writeFileSync(mutated, `${readFileSync(mutated, "utf8")}# tampered\n`, "utf8");

      const fixtures = spawnSync(process.execPath, [cli, "fixtures"], {
        encoding: "utf8",
        env: { ...process.env, CM_EVAL_FIXTURES_CACHE: cacheRoot },
        timeout: 300_000,
      });
      assert.equal(fixtures.status, 0, fixtures.stderr.slice(0, 400));
      const after = verifyFixtureCacheEntry({ task: taskById("task-01"), entryDir: join(cacheRoot, "task-01") });
      assert.equal(after.ok, true, JSON.stringify(after.errors));
      assert.equal(readFileSync(mutated, "utf8").includes("# tampered"), false, "tampered bytes must be gone");
    } finally {
      rmSync(dir, { recursive: true, force: true });
    }
  });

  test("empty-cache and warm-cache publication are equal across all 20 tasks", () => {
    const dir = tempDir();
    try {
      const emptyRoot = join(dir, "empty");
      const warmRoot = join(dir, "warm");
      const secondEmptyRoot = join(dir, "empty2");
      const publishAll = (cacheRoot) =>
        spawnSync(process.execPath, [cli, "fixtures"], {
          encoding: "utf8",
          env: { ...process.env, CM_EVAL_FIXTURES_CACHE: cacheRoot },
          timeout: 600_000,
        });
      assert.equal(publishAll(emptyRoot).status, 0);
      assert.equal(publishAll(warmRoot).status, 0);
      assert.equal(publishAll(warmRoot).status, 0, "warm second pass must succeed");
      assert.equal(publishAll(secondEmptyRoot).status, 0);

      assert.equal(manifest.tasks.length, 20);
      for (const task of manifest.tasks) {
        const recordOf = (cacheRoot) =>
          JSON.parse(readFileSync(join(cacheRoot, task.id, ".git", "integrity.json"), "utf8"));
        const empty = recordOf(emptyRoot);
        const warm = recordOf(warmRoot);
        const secondEmpty = recordOf(secondEmptyRoot);
        assert.equal(empty.recordSha256, warm.recordSha256, `${task.id}: empty vs warm record digest`);
        assert.equal(empty.recordSha256, secondEmpty.recordSha256, `${task.id}: empty vs second empty root`);
        assert.equal(empty.contentSha256, warm.contentSha256, `${task.id}: empty vs warm tree digest`);
        const check = verifyFixtureCacheEntry({ task, entryDir: join(warmRoot, task.id) });
        assert.equal(check.ok, true, `${task.id} warm entry must verify: ${JSON.stringify(check.errors)}`);
      }
    } finally {
      rmSync(dir, { recursive: true, force: true });
    }
  });
});
