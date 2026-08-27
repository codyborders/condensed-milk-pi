/**
 * Final repository collector tests (evaluation/runner/collect.mjs).
 *
 * Contract under test:
 * - records porcelain v2, binary staged patch, binary unstaged patch,
 *   ls-files index, and SHA-256 for untracked regular files
 * - never follows symlinks outside the worktree
 * - every resolved collected path stays under the worktree
 * - git spawn error, timeout, signal, or nonzero exit is a collection
 *   error, distinct from task/scorer failure
 */

import { test, describe } from "node:test";
import assert from "node:assert/strict";
import { fileURLToPath } from "node:url";
import { dirname, join } from "node:path";
import { mkdirSync, mkdtempSync, readFileSync, readdirSync, rmSync, statSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { spawnSync } from "node:child_process";
import { createHash } from "node:crypto";
import { collectFinalState } from "../runner/collect.mjs";

const GIT_ENV = {
  PATH: process.env.PATH ?? "/usr/bin:/bin",
  GIT_CONFIG_GLOBAL: "/dev/null",
  GIT_CONFIG_NOSYSTEM: "1",
  GIT_AUTHOR_NAME: "Collector Test",
  GIT_AUTHOR_EMAIL: "collector@example.invalid",
  GIT_COMMITTER_NAME: "Collector Test",
  GIT_COMMITTER_EMAIL: "collector@example.invalid",
};

function runGit(cwd, argv) {
  const result = spawnSync("git", argv, { cwd, encoding: "utf8", env: GIT_ENV });
  assert.equal(result.status, 0, `git ${argv.join(" ")} failed: ${result.stderr}`);
  return result.stdout;
}

/**
 * Prepare a worktree with a base commit, a staged text change, a
 * staged binary file, an unstaged text change, and untracked files.
 */
export function prepareWorktree(root) {
  const worktree = join(root, "worktree");
  mkdirSync(worktree, { recursive: true });
  writeFileSync(join(worktree, "file-a.txt"), "base line one\nbase line two\n", "utf8");
  writeFileSync(join(worktree, "file-b.txt"), "untouched\n", "utf8");
  runGit(worktree, ["init", "-q", "-b", "master"]);
  runGit(worktree, ["add", "-A", "."]);
  runGit(worktree, ["commit", "-q", "-m", "base"]);
  writeFileSync(join(worktree, "file-a.txt"), "base line one\nstaged change\n", "utf8");
  runGit(worktree, ["add", "file-a.txt"]);
  writeFileSync(join(worktree, "image.bin"), Buffer.concat([Buffer.from([0x00, 0x01, 0x02, 0x00]), Buffer.from("binpayload")]));
  runGit(worktree, ["add", "image.bin"]);
  writeFileSync(join(worktree, "file-b.txt"), "untouched\nunstaged edit\n", "utf8");
  mkdirSync(join(worktree, "notes"), { recursive: true });
  writeFileSync(join(worktree, "notes", "keep.txt"), "untracked payload\n", "utf8");
  writeFileSync(join(worktree, "scratch.txt"), "also untracked\n", "utf8");
  return worktree;
}

function sha256Of(path) {
  return createHash("sha256").update(readFileSync(path)).digest("hex");
}

function artifactByName(result, name) {
  return result.artifacts.find((entry) => entry.name === name);
}

describe("final repository collector", () => {
  test("collects porcelain v2, binary patches, ls-files, and untracked hashes", async () => {
    const root = mkdtempSync(join(tmpdir(), "cm-eval-collect-"));
    const outDir = join(root, "final-state");
    try {
      const worktree = prepareWorktree(root);
      const result = await collectFinalState({ worktree, outDir });
      assert.equal(result.status, "collected", `errors: ${JSON.stringify(result.errors)}`);
      assert.deepEqual(result.errors, []);

      const porcelain = artifactByName(result, "porcelain-v2");
      assert.ok(porcelain, "porcelain-v2 artifact must exist");
      assert.match(porcelain.sha256, /^[0-9a-f]{64}$/);
      const porcelainText = readFileSync(join(outDir, "porcelain-v2.txt"), "utf8");
      assert.ok(porcelainText.includes("1 .M "), `staged entry missing:\n${porcelainText}`);
      assert.ok(porcelainText.includes("? notes/keep.txt"), `untracked listing missing:\n${porcelainText}`);
      assert.ok(porcelainText.includes("? scratch.txt"), "untracked listing missing");

      const staged = artifactByName(result, "staged.patch");
      const stagedText = readFileSync(join(outDir, "staged.patch"), "latin1");
      assert.ok(stagedText.includes("diff --git"), "staged patch must be a git diff");
      assert.ok(stagedText.includes("GIT binary patch"), "staged patch must encode binary changes");
      assert.match(staged.sha256, /^[0-9a-f]{64}$/);

      const unstaged = artifactByName(result, "unstaged.patch");
      const unstagedText = readFileSync(join(outDir, "unstaged.patch"), "utf8");
      assert.ok(unstagedText.includes("diff --git"), "unstaged patch must be a git diff");
      assert.ok(unstagedText.includes("+unstaged edit"), "unstaged patch must contain the edit");

      const lsFiles = artifactByName(result, "ls-files");
      const lsFilesText = readFileSync(join(outDir, "ls-files.txt"), "utf8");
      assert.ok(lsFilesText.includes("100644"), "ls-files must record index modes");
      assert.ok(lsFilesText.includes("file-a.txt"), "ls-files must list tracked files");

      const untracked = result.untracked.filter((entry) => entry.path === "notes/keep.txt");
      assert.equal(untracked.length, 1, "untracked keep.txt must be collected exactly once");
      assert.equal(untracked[0].kind, "file");
      assert.equal(untracked[0].sha256, sha256Of(join(worktree, "notes", "keep.txt")));
      const scratch = result.untracked.find((entry) => entry.path === "scratch.txt");
      assert.equal(scratch.sha256, sha256Of(join(worktree, "scratch.txt")));
      for (const entry of result.untracked) {
        assert.match(entry.sha256, /^[0-9a-f]{64}$/, `untracked ${entry.path} needs a sha256`);
      }
      assert.ok(readdirSync(outDir).length >= 4, "artifact files must be written to outDir");
      for (const artifact of result.artifacts) {
        assert.ok(statSync(join(outDir, artifact.file)).isFile(), `artifact ${artifact.name} file must exist`);
        assert.ok(artifact.bytes > 0, `artifact ${artifact.name} must be nonempty`);
      }
    } finally {
      rmSync(root, { recursive: true, force: true });
    }
  });
});
