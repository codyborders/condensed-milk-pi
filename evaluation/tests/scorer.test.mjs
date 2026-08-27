/**
 * Hidden external scorer tests.
 *
 * Scope:
 * - the scorer inspects final worktrees only (never assistant prose) and
 *   emits strict JSON: a passing solved worktree, a failing unsolved one,
 *   and a distinct scorer-error status for invalid scorer inputs.
 */

import { test, describe } from "node:test";
import assert from "node:assert/strict";
import { fileURLToPath } from "node:url";
import { dirname, join } from "node:path";
import { mkdtempSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { spawnSync } from "node:child_process";
import { generateFixture, applySolution } from "../lib/fixtures.mjs";
import { scoreWorktree, scorerDefinitionSha256 } from "../lib/scorer.mjs";
import { loadManifestFile, loadTaskData } from "../lib/manifest.mjs";

const repoRoot = join(dirname(fileURLToPath(import.meta.url)), "..", "..");
const manifest = loadManifestFile(join(repoRoot, "evaluation", "task-manifest.json"));

function taskById(id) {
  return manifest.tasks.find((task) => task.id === id);
}

describe("hidden external scorer", () => {
  test("unsolved worktree fails and solved worktree passes", () => {
    const dir = mkdtempSync(join(tmpdir(), "cm-eval-scorer-"));
    try {
      const task = taskById("task-01");
      const worktree = join(dir, "worktree");
      generateFixture({ repoRoot, task, outDir: worktree });

      const before = scoreWorktree({ repoRoot, worktree, taskId: task.id });
      assert.equal(before.status, "failed");
      assert.equal(before.totalCount, 2);
      assert.equal(before.passedCount, 0);

      const { solution } = loadTaskData(repoRoot, task.id);
      applySolution({ worktree, solution });
      const after = scoreWorktree({ repoRoot, worktree, taskId: task.id });
      assert.equal(after.status, "passed", JSON.stringify(after.checks));
      assert.equal(after.passedCount, after.totalCount);
    } finally {
      rmSync(dir, { recursive: true, force: true });
    }
  });

  test("CLI emits strict JSON and distinguishes scorer errors from task failure", () => {
    const dir = mkdtempSync(join(tmpdir(), "cm-eval-scorer-cli-"));
    try {
      const task = taskById("task-01");
      const worktree = join(dir, "worktree");
      generateFixture({ repoRoot, task, outDir: worktree });
      const { solution } = loadTaskData(repoRoot, task.id);
      applySolution({ worktree, solution });

      const cli = spawnSync(
        process.execPath,
        [join(repoRoot, "evaluation", "lib", "scorer.mjs"), "--worktree", worktree, "--task", "task-01"],
        { encoding: "utf8" },
      );
      assert.equal(cli.status, 0, `CLI must exit 0 when scoring ran: ${cli.stderr}`);
      const parsed = JSON.parse(cli.stdout);
      assert.equal(parsed.status, "passed");
      assert.equal(parsed.taskId, "task-01");
      assert.equal(parsed.error, null);
      assert.ok(Array.isArray(parsed.checks) && parsed.checks.length === 2);

      const broken = join(dir, "broken-assertions.json");
      writeFileSync(broken, "{ not json", "utf8");
      const errored = spawnSync(
        process.execPath,
        [
          join(repoRoot, "evaluation", "lib", "scorer.mjs"),
          "--worktree", worktree,
          "--task", "task-01",
          "--assertions", broken,
        ],
        { encoding: "utf8" },
      );
      assert.equal(errored.status, 2, "invalid scorer input must exit 2");
      const errorParsed = JSON.parse(errored.stdout);
      assert.equal(errorParsed.status, "scorer-error");
      assert.ok(typeof errorParsed.error === "string" && errorParsed.error.length > 0);
    } finally {
      rmSync(dir, { recursive: true, force: true });
    }
  });

  test("every reference solution passes its hidden scorer", () => {
    const dir = mkdtempSync(join(tmpdir(), "cm-eval-scorer-all-"));
    try {
      for (const task of manifest.tasks) {
        const worktree = join(dir, task.id);
        generateFixture({ repoRoot, task, outDir: worktree });
        const { solution } = loadTaskData(repoRoot, task.id);
        applySolution({ worktree, solution, taskId: task.id });
        const result = scoreWorktree({ repoRoot, worktree, taskId: task.id });
        assert.equal(
          result.status,
          "passed",
          `${task.id} reference solution must pass: ${JSON.stringify(result.checks?.filter((check) => !check.passed) ?? result.error)}`,
        );
      }
    } finally {
      rmSync(dir, { recursive: true, force: true });
    }
  });

  test("gitLogStartsWith accepts merge subjects and rejects other prefixes", () => {
    const dir = mkdtempSync(join(tmpdir(), "cm-eval-scorer-git-prefix-"));
    try {
      const task = taskById("task-10");
      const worktree = join(dir, "worktree");
      generateFixture({ repoRoot, task, outDir: worktree });
      const { solution } = loadTaskData(repoRoot, task.id);
      applySolution({ worktree, solution, taskId: task.id });
      const assertion = { id: "merge-prefix", kind: "gitLogStartsWith", prefix: "merge:" };
      const valid = scoreWorktree({ repoRoot, worktree, taskId: task.id, assertions: [assertion] });
      assert.equal(valid.status, "passed", JSON.stringify(valid));
      spawnSync("git", ["commit", "--amend", "-m", "merge: combine filter helpers with details"], { cwd: worktree });
      const knownValid = scoreWorktree({ repoRoot, worktree, taskId: task.id, assertions: [assertion] });
      assert.equal(knownValid.status, "passed", JSON.stringify(knownValid));
      spawnSync("git", ["commit", "--amend", "-m", "fix: combine filter helpers"], { cwd: worktree });
      const invalid = scoreWorktree({ repoRoot, worktree, taskId: task.id, assertions: [assertion] });
      assert.equal(invalid.status, "failed");
      assert.equal(invalid.checks[0].actual, "fix: combine filter helpers");
      assert.equal(scorerDefinitionSha256(repoRoot, task.id).length, 64);
    } finally {
      rmSync(dir, { recursive: true, force: true });
    }
  });

  test("command assertions keep stdout and stderr expectations separate", () => {
    const dir = mkdtempSync(join(tmpdir(), "cm-eval-scorer-streams-"));
    try {
      const result = scoreWorktree({
        repoRoot,
        worktree: dir,
        taskId: "stream-test",
        assertions: [{
          id: "streams",
          kind: "command",
          argv: ["node", "-e", "process.stdout.write('out'); process.stderr.write('err')"],
          stdoutContains: ["out", "missing-out"],
          stderrContains: ["err", "missing-err"],
        }],
      });
      assert.equal(result.status, "failed");
      assert.deepEqual(result.checks[0].missingStdout, ["missing-out"]);
      assert.deepEqual(result.checks[0].missingStderr, ["missing-err"]);
    } finally {
      rmSync(dir, { recursive: true, force: true });
    }
  });

  test("task-05 scorer ignores ambient @types contamination above fixture", () => {
    const dir = mkdtempSync(join(tmpdir(), "cm-eval-scorer-types-"));
    try {
      const task = taskById("task-05");
      const worktree = join(dir, "fixture");
      generateFixture({ repoRoot, task, outDir: worktree });
      const { solution } = loadTaskData(repoRoot, task.id);
      applySolution({ worktree, solution });
      generateFixture({
        repoRoot,
        task: {
          id: "ambient-types",
          fixture: {
            files: [{ path: "index.d.ts", content: "declare var name: number;\n" }],
            generate: [],
            mutations: [],
            untracked: [],
            git: {
              author: { name: "Eval Fixture", email: "fixture@example.invalid" },
              startDate: "2026-01-01T00:00:00Z",
              commits: [{ message: "chore: add ambient type", paths: ["all"] }],
              post: [],
            },
          },
        },
        outDir: join(dir, "node_modules", "@types", "ambient"),
      });
      const contaminated = scoreWorktree({ repoRoot, worktree, taskId: task.id });
      assert.equal(contaminated.status, "passed", JSON.stringify(contaminated.checks));
    } finally {
      rmSync(dir, { recursive: true, force: true });
    }
  });

  test("command spawn errors are scorer-errors, not task failures", () => {
    const dir = mkdtempSync(join(tmpdir(), "cm-eval-scorer-err-"));
    try {
      const task = manifest.tasks[0];
      const worktree = join(dir, "worktree");
      generateFixture({ repoRoot, task, outDir: worktree });
      const spawnError = scoreWorktree({
        repoRoot,
        worktree,
        taskId: task.id,
        assertions: [
          { id: "missing-binary", kind: "command", argv: ["definitely-not-a-real-binary-xyz"], expectExit: 0 },
        ],
      });
      assert.equal(spawnError.status, "scorer-error", `spawn error must be scorer-error, got ${spawnError.status}`);
      assert.ok(typeof spawnError.error === "string" && spawnError.error.length > 0);
    } finally {
      rmSync(dir, { recursive: true, force: true });
    }
  });

  test("assertion paths escaping the worktree are scorer errors", () => {
    const dir = mkdtempSync(join(tmpdir(), "cm-eval-scorer-escape-"));
    try {
      const task = manifest.tasks[0];
      const worktree = join(dir, "worktree");
      generateFixture({ repoRoot, task, outDir: worktree });
      writeFileSync(join(dir, "escape.txt"), "SENTINEL-OUTSIDE\n", "utf8");
      const escaped = scoreWorktree({
        repoRoot,
        worktree,
        taskId: task.id,
        assertions: [
          { id: "escape-read", kind: "fileContains", path: "../escape.txt", all: ["SENTINEL-OUTSIDE"] },
          { id: "escape-exists", kind: "fileExists", path: "../escape.txt" },
          { id: "absolute-read", kind: "fileContains", path: join(dir, "escape.txt"), all: ["SENTINEL"] },
        ],
      });
      assert.equal(escaped.status, "scorer-error", `path escape must be scorer-error, got ${escaped.status}`);
      assert.ok(
        typeof escaped.error === "string" && escaped.error.includes("escapes"),
        `error must name the escape: ${escaped.error}`,
      );
    } finally {
      rmSync(dir, { recursive: true, force: true });
    }
  });
});
