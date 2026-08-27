/**
 * Artifact-hash completeness slice of the final repository collector
 * (evaluation/runner/collect.mjs).
 *
 * Every artifact must carry a SHA-256, including empty ones (a clean
 * tree produces a zero-byte unstaged patch, whose hash is the
 * well-known empty-content digest).
 */

import { test, describe } from "node:test";
import assert from "node:assert/strict";
import { fileURLToPath } from "node:url";
import { dirname, join } from "node:path";
import { mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { createHash } from "node:crypto";
import { collectFinalState } from "../runner/collect.mjs";
import { prepareWorktree } from "./collector.test.mjs";

const repoRoot = join(dirname(fileURLToPath(import.meta.url)), "..", "..");
const EMPTY_SHA256 = createHash("sha256").update("").digest("hex");

describe("collector artifact hash completeness", () => {
  test("empty artifacts still record the empty-content SHA-256", async () => {
    const root = mkdtempSync(join(tmpdir(), "cm-eval-collect-empty-"));
    const outDir = join(root, "final-state");
    try {
      // Commit every pending change: no staged, unstaged, or untracked
      // entries remain, so the diff artifacts are empty.
      const worktree = prepareWorktree(root);
      const { spawnSync } = await import("node:child_process");
      const env = {
        PATH: process.env.PATH ?? "/usr/bin:/bin",
        GIT_CONFIG_GLOBAL: "/dev/null",
        GIT_CONFIG_NOSYSTEM: "1",
        GIT_AUTHOR_NAME: "Collector Test",
        GIT_AUTHOR_EMAIL: "collector@example.invalid",
        GIT_COMMITTER_NAME: "Collector Test",
        GIT_COMMITTER_EMAIL: "collector@example.invalid",
      };
      for (const argv of [["add", "-A", "."], ["commit", "-q", "-m", "settle"]]) {
        const step = spawnSync("git", argv, { cwd: worktree, encoding: "utf8", env });
        assert.equal(step.status, 0, `git ${argv.join(" ")} failed: ${step.stderr}`);
      }
      const result = await collectFinalState({ worktree, outDir });
      assert.equal(result.status, "collected", `errors: ${JSON.stringify(result.errors)}`);
      for (const artifact of result.artifacts) {
        assert.match(artifact.sha256, /^[0-9a-f]{64}$/, `artifact ${artifact.name} must always carry a sha256`);
      }
      const unstaged = result.artifacts.find((entry) => entry.name === "unstaged.patch");
      assert.ok(unstaged.bytes === 0, "clean worktree must produce an empty unstaged patch");
      assert.equal(unstaged.sha256, EMPTY_SHA256, "empty artifact must hash to the empty-content digest");
    } finally {
      rmSync(root, { recursive: true, force: true });
    }
  });
});

void repoRoot;
