/**
 * Scorer git-helper infrastructure error tests.
 *
 * Scope:
 * - git helper spawn errors and nonzero exits surface as scorer-error,
 *   never as a silent pass or task failure.
 */

import { test, describe } from "node:test";
import assert from "node:assert/strict";
import { fileURLToPath } from "node:url";
import { dirname, join } from "node:path";
import { mkdtempSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { scoreWorktree } from "../lib/scorer.mjs";

const repoRoot = join(dirname(fileURLToPath(import.meta.url)), "..", "..");

describe("scorer git helper infrastructure errors", () => {
  test("a failed git status command is a scorer error, not a silent pass", () => {
    const notARepo = mkdtempSync(join(tmpdir(), "cm-eval-scorer-git-"));
    try {
      writeFileSync(join(notARepo, "README.md"), "x\n", "utf8");
      const failed = scoreWorktree({
        repoRoot,
        worktree: notARepo,
        taskId: "task-01",
        assertions: [{ id: "status", kind: "gitStatus", expect: [] }],
      });
      assert.equal(
        failed.status,
        "scorer-error",
        `failed git command must be scorer-error, not a silent pass, got ${failed.status}`,
      );
      assert.ok(typeof failed.error === "string" && failed.error.length > 0);
    } finally {
      rmSync(notARepo, { recursive: true, force: true });
    }
  });
});
