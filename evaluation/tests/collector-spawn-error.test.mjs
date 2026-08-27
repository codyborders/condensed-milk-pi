/**
 * Spawn-error slice of the final repository collector
 * (evaluation/runner/collect.mjs).
 *
 * A nonexistent git binary must resolve as exactly one collection
 * error per command — no double-close of artifact fds and no uncaught
 * exception when both the error and close events fire.
 */

import { test, describe } from "node:test";
import assert from "node:assert/strict";
import { fileURLToPath } from "node:url";
import { dirname, join } from "node:path";
import { mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { collectFinalState } from "../runner/collect.mjs";
import { prepareWorktree } from "./collector.test.mjs";

const repoRoot = join(dirname(fileURLToPath(import.meta.url)), "..", "..");

describe("collector spawn-error classification", () => {
  test("nonexistent git binary yields one collection error per command without crashing", async () => {
    const root = mkdtempSync(join(tmpdir(), "cm-eval-collect-spawnerr-"));
    const outDir = join(root, "final-state");
    try {
      const worktree = prepareWorktree(root);
      const result = await collectFinalState({
        worktree,
        outDir,
        gitPath: join(root, "definitely-missing-git"),
      });
      assert.equal(result.status, "error");
      assert.equal(result.errors.length, 4, "exactly one error per git command");
      for (const error of result.errors) {
        assert.equal(error.reason, "spawn-error", `unexpected reason: ${JSON.stringify(error)}`);
        assert.ok(typeof error.detail === "string" && error.detail.length > 0);
        assert.equal(error.command.startsWith("git "), true, "errors must name the git command");
      }
      for (const artifact of result.artifacts) {
        assert.equal(artifact.ok, false);
        assert.match(artifact.sha256, /^[0-9a-f]{64}$/, "even empty artifacts must carry a hash");
      }
      assert.deepEqual(result.untracked, []);
    } finally {
      rmSync(root, { recursive: true, force: true });
    }
  });
});

void repoRoot;
