/**
 * Symlink containment slice of the final repository collector
 * (evaluation/runner/collect.mjs).
 *
 * External symlinks are recorded, never followed, and never hashed.
 * A broken symlink (target missing) is its own classification — it is
 * neither inside nor outside, and must never be read through. No
 * artifact may contain the external target's bytes.
 */

import { test, describe } from "node:test";
import assert from "node:assert/strict";
import { fileURLToPath } from "node:url";
import { dirname, join } from "node:path";
import { mkdirSync, mkdtempSync, readFileSync, readdirSync, rmSync, symlinkSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { collectFinalState } from "../runner/collect.mjs";
import { prepareWorktree } from "./collector.test.mjs";

const repoRoot = join(dirname(fileURLToPath(import.meta.url)), "..", "..");

describe("collector symlink containment", () => {
  test("external and broken symlinks are recorded and never followed", async () => {
    const root = mkdtempSync(join(tmpdir(), "cm-eval-collect-symlink-"));
    const outDir = join(root, "final-state");
    try {
      const worktree = prepareWorktree(root);
      const outsideDir = join(root, "outside");
      mkdirSync(outsideDir, { recursive: true });
      writeFileSync(join(outsideDir, "secret.txt"), "outside-secret-payload\n", "utf8");
      symlinkSync(join(outsideDir, "secret.txt"), join(worktree, "ext-link.txt"));
      symlinkSync(join(worktree, "missing-target.txt"), join(worktree, "broken-link.txt"));

      const result = await collectFinalState({ worktree, outDir });
      assert.equal(result.status, "collected", `errors: ${JSON.stringify(result.errors)}`);

      const external = result.untracked.find((entry) => entry.path === "ext-link.txt");
      assert.ok(external, "external symlink must be listed");
      assert.equal(external.kind, "symlink-external");
      assert.equal(external.sha256, null, "external symlink must never be hashed");
      assert.equal(external.skipReason, "outside-worktree");

      const broken = result.untracked.find((entry) => entry.path === "broken-link.txt");
      assert.ok(broken, "broken symlink must be listed");
      assert.equal(broken.kind, "symlink-broken", "a missing target is neither inside nor outside");
      assert.equal(broken.sha256, null, "broken symlink must never be hashed");

      for (const name of readdirSync(outDir)) {
        const bytes = readFileSync(join(outDir, name));
        assert.ok(!bytes.includes("outside-secret-payload"), `artifact ${name} leaked external target bytes`);
      }
      const hashed = result.untracked.filter((entry) => entry.sha256 !== null);
      for (const entry of hashed) {
        assert.ok(!entry.path.includes(".."), `collected path escaped the worktree: ${entry.path}`);
      }
    } finally {
      rmSync(root, { recursive: true, force: true });
    }
  });
});

void repoRoot;
