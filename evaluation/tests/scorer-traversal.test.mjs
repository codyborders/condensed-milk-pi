/**
 * Hidden external scorer traversal tests.
 *
 * Scope:
 * - an intermediate directory component that is a symlink must never be
 *   traversed by hidden file assertions, even when the final component
 *   is a regular file inside the linked directory;
 * - normal in-tree reads through real directories keep scoring;
 * - the rejection never leaks the outside file contents.
 */

import { test, describe } from "node:test";
import assert from "node:assert/strict";
import { fileURLToPath } from "node:url";
import { dirname, join } from "node:path";
import { mkdirSync, mkdtempSync, rmSync, symlinkSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { generateFixture } from "../lib/fixtures.mjs";
import { scoreWorktree } from "../lib/scorer.mjs";
import { loadManifestFile } from "../lib/manifest.mjs";

const repoRoot = join(dirname(fileURLToPath(import.meta.url)), "..", "..");
const manifest = loadManifestFile(join(repoRoot, "evaluation", "task-manifest.json"));

const OUTSIDE_SENTINEL = "OUTSIDE-SECRET-CONTENTS-7d31";

describe("scorer intermediate component traversal", () => {
  test("intermediate directory symlink is rejected for every file assertion kind", () => {
    const dir = mkdtempSync(join(tmpdir(), "cm-scorer-traversal-mid-"));
    try {
      const task = manifest.tasks[0];
      const worktree = join(dir, "worktree");
      generateFixture({ repoRoot, task, outDir: worktree });
      const outsideDir = join(dir, "outside-dir");
      mkdirSync(outsideDir);
      writeFileSync(join(outsideDir, "secret.txt"), `${OUTSIDE_SENTINEL}\n`, "utf8");
      symlinkSync(outsideDir, join(worktree, "reports"));

      const escaped = scoreWorktree({
        repoRoot,
        worktree,
        taskId: task.id,
        assertions: [
          { id: "mid-link-read", kind: "fileContains", path: "reports/secret.txt", all: [OUTSIDE_SENTINEL] },
          { id: "mid-link-exists", kind: "fileExists", path: "reports/secret.txt" },
          { id: "mid-link-equals", kind: "fileEquals", path: "reports/secret.txt", equals: "x" },
          { id: "mid-link-count", kind: "fileOccurrences", path: "reports/secret.txt", needle: "OUTSIDE", min: 1 },
        ],
      });
      assert.equal(escaped.status, "scorer-error", JSON.stringify(escaped));
      const serialized = JSON.stringify(escaped);
      assert.ok(!serialized.includes(OUTSIDE_SENTINEL), "no outside contents in scorer output");
      for (const check of escaped.checks) {
        assert.equal(check.passed, false, `${check.id} must not pass through the symlinked directory`);
        assert.ok(check.infraError, `${check.id} must be an infra error`);
      }
    } finally {
      rmSync(dir, { recursive: true, force: true });
    }
  });
});
