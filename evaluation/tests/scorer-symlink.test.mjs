/**
 * Hidden external scorer symlink tests.
 *
 * Scope:
 * - hidden file assertions must never read through symlinks, whether
 *   the link is the final component or an intermediate directory;
 * - a symlink escape is a scorer error that leaks no outside content;
 * - missing paths stay normal failed assertions and in-tree regular
 *   files keep scoring normally.
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

const OUTSIDE_SENTINEL = "OUTSIDE-SECRET-CONTENTS-9f2c";

function makeWorktree(dir) {
  const task = manifest.tasks[0];
  const worktree = join(dir, "worktree");
  generateFixture({ repoRoot, task, outDir: worktree });
  return worktree;
}

describe("scorer symlink handling", () => {
  test("final-component symlink pointing outside is a scorer error without content leak", () => {
    const dir = mkdtempSync(join(tmpdir(), "cm-scorer-sym-final-"));
    try {
      const worktree = makeWorktree(dir);
      const outside = join(dir, "outside.txt");
      writeFileSync(outside, `${OUTSIDE_SENTINEL}\n`, "utf8");
      symlinkSync(outside, join(worktree, "leaked.txt"));

      const escaped = scoreWorktree({
        repoRoot,
        worktree,
        taskId: manifest.tasks[0].id,
        assertions: [
          { id: "final-link-read", kind: "fileContains", path: "leaked.txt", all: [OUTSIDE_SENTINEL] },
          { id: "final-link-exists", kind: "fileExists", path: "leaked.txt" },
        ],
      });
      assert.equal(escaped.status, "scorer-error", JSON.stringify(escaped));
      const serialized = JSON.stringify(escaped);
      assert.ok(!serialized.includes(OUTSIDE_SENTINEL), "no outside file contents in scorer output");
      assert.ok(
        typeof escaped.error === "string" && /symlink|escapes/.test(escaped.error),
        `error must name the symlink rejection: ${escaped.error}`,
      );
    } finally {
      rmSync(dir, { recursive: true, force: true });
    }
  });
});
