import { test } from "node:test";
import assert from "node:assert/strict";
import { execFileSync, spawnSync } from "node:child_process";
import { mkdtempSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { fileURLToPath } from "node:url";
import { dirname, join } from "node:path";

const directory = dirname(fileURLToPath(import.meta.url));

test("pinned benchmark rejects dirty implementation worktrees", () => {
  const root = mkdtempSync(join(tmpdir(), "cm-benchmark-worktree-"));
  try {
    execFileSync("git", ["init", "-q", root]);
    execFileSync("git", ["-C", root, "config", "user.email", "test@example.invalid"]);
    execFileSync("git", ["-C", root, "config", "user.name", "Test"]);
    writeFileSync(join(root, "tracked.txt"), "clean\n");
    execFileSync("git", ["-C", root, "add", "tracked.txt"]);
    execFileSync("git", ["-C", root, "commit", "-qm", "fixture"]);
    const commit = execFileSync("git", ["-C", root, "rev-parse", "HEAD"], { encoding: "utf8" }).trim();
    writeFileSync(join(root, "untracked.txt"), "dirty\n");
    const result = spawnSync(process.execPath, ["--import", "tsx", join(directory, "context-hook.mjs"), "--implementation-root", root, "--expected-commit", commit], { encoding: "utf8" });
    assert.notEqual(result.status, 0);
    assert.match(result.stderr, /clean Git worktree/);
  } finally {
    rmSync(root, { recursive: true, force: true });
  }
});
