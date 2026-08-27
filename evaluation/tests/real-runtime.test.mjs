/**
 * Runtime preparation tests (boundary: evaluation/runner/real-runtime.mjs).
 *
 * Fake-only and offline: arm worktrees come from the local git object
 * database at the pinned manifest commits; the Pi runtime is copied from
 * the pinned node_modules. No provider is contacted.
 */

import { test, describe } from "node:test";
import assert from "node:assert/strict";
import { fileURLToPath } from "node:url";
import { dirname, join } from "node:path";
import { appendFileSync, existsSync, mkdirSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { spawnSync } from "node:child_process";
import { loadManifestFile } from "../lib/manifest.mjs";

const repoRoot = join(dirname(fileURLToPath(import.meta.url)), "..", "..");
const manifest = loadManifestFile(join(repoRoot, "evaluation", "task-manifest.json"));

function pruneWorktrees() {
  spawnSync("git", ["-C", repoRoot, "worktree", "prune"]);
}

describe("real runtime preparation", () => {
  test("materializes detached arm worktrees at the exact manifest commits", { timeout: 60_000 }, async () => {
    const work = mkdtempSync(join(tmpdir(), "cm-runtime-arms-"));
    try {
      const { verifyArmWorktree } = await import(join(repoRoot, "evaluation", "runner", "real-runtime.mjs"));
      for (const arm of manifest.evaluation.arms) {
        const info = verifyArmWorktree({ repoRoot, arm, cacheRoot: work });
        assert.equal(info.commit, arm.commit);
        assert.equal(
          spawnSync("git", ["-C", info.path, "rev-parse", "HEAD"], { encoding: "utf8" }).stdout.trim(),
          arm.commit,
          `${arm.name} worktree HEAD must be the pinned commit`,
        );
        assert.equal(
          spawnSync("git", ["-C", info.path, "symbolic-ref", "-q", "HEAD"]).status,
          1,
          `${arm.name} worktree must be detached`,
        );
        assert.ok(!info.path.startsWith(repoRoot), "arm worktrees must live outside the source repository");
        const expectedIndexTs = spawnSync("git", ["-C", repoRoot, "show", `${arm.commit}:index.ts`], { encoding: "utf8" }).stdout;
        assert.equal(
          readFileSync(join(info.path, "index.ts"), "utf8"),
          expectedIndexTs,
          "index.ts must match the pinned commit",
        );
        assert.ok(Array.isArray(info.tracked) && info.tracked.includes("index.ts"));
        const serialized = JSON.stringify(info);
        assert.ok(!serialized.includes("evaluation/scorers"), "metadata must not contain scorer paths");
        assert.ok(!serialized.includes("evaluation/cache"), "metadata must not contain fixture cache paths");
        for (const path of info.tracked) {
          assert.ok(!path.startsWith("evaluation/scorers/"), `scorer file ${path} must not be tracked`);
          assert.ok(!path.startsWith("evaluation/cache/"), `fixture file ${path} must not be tracked`);
        }
      }
    } finally {
      pruneWorktrees();
      rmSync(work, { recursive: true, force: true });
    }
  });

  test("refuses a wrong arm root that is not a git worktree", { timeout: 60_000 }, async () => {
    const arm = manifest.evaluation.arms[0];
    const wrong = mkdtempSync(join(tmpdir(), "cm-runtime-wrong-"));
    try {
      const { verifyArmWorktree, armWorktreePath } = await import(join(repoRoot, "evaluation", "runner", "real-runtime.mjs"));
      const wrongRoot = armWorktreePath({ cacheRoot: wrong, arm });
      mkdirSync(wrongRoot, { recursive: true });
      writeFileSync(join(wrongRoot, "index.ts"), "not a git worktree\n", "utf8");
      assert.throws(
        () => verifyArmWorktree({ repoRoot, arm, cacheRoot: wrong }),
        (error) => {
          assert.match(error.message, /not a git worktree/);
          assert.ok(!error.message.includes(repoRoot), "refusal text must not leak the source repository path");
          return true;
        },
        "a pre-existing non-worktree root must be refused",
      );
    } finally {
      pruneWorktrees();
      rmSync(wrong, { recursive: true, force: true });
    }
  });

  test("refuses a dirty arm worktree before returning it", { timeout: 60_000 }, async () => {
    const arm = manifest.evaluation.arms[0];
    const dirty = mkdtempSync(join(tmpdir(), "cm-runtime-dirty-"));
    try {
      const { verifyArmWorktree } = await import(join(repoRoot, "evaluation", "runner", "real-runtime.mjs"));
      const info = verifyArmWorktree({ repoRoot, arm, cacheRoot: dirty });
      appendFileSync(join(info.path, "index.ts"), "// dirt\n", "utf8");
      assert.throws(
        () => verifyArmWorktree({ repoRoot, arm, cacheRoot: dirty }),
        (error) => {
          assert.match(error.message, /not tracked-clean/);
          assert.ok(!error.message.includes(repoRoot), "refusal text must not leak the source repository path");
          return true;
        },
        "a dirty worktree must be refused",
      );
      spawnSync("git", ["-C", info.path, "checkout", "--", "index.ts"]);
      writeFileSync(join(info.path, "stray-untracked.txt"), "junk\n", "utf8");
      assert.throws(
        () => verifyArmWorktree({ repoRoot, arm, cacheRoot: dirty }),
        /not tracked-clean/,
        "an untracked file must also refuse the worktree",
      );
    } finally {
      pruneWorktrees();
      rmSync(dirty, { recursive: true, force: true });
    }
  });

  test("materializes a reusable isolated pi runtime pinned to the manifest version", { timeout: 120_000 }, async () => {
    const work = mkdtempSync(join(tmpdir(), "cm-runtime-pi-"));
    try {
      const { materializePiRuntime } = await import(join(repoRoot, "evaluation", "runner", "real-runtime.mjs"));
      const { cliPath: cli, runtimeManifest } = materializePiRuntime({ repoRoot, manifest, cacheRoot: work });
      assert.equal(
        cli,
        join(work, "pi", `pi-coding-agent-${manifest.evaluation.piVersion}`, "dist", "cli.js"),
        "the runtime must be materialized under the cache root",
      );
      assert.ok(runtimeManifest && runtimeManifest.schemaVersion === 1 && /^[0-9a-f]{64}$/.test(runtimeManifest.digest), "the materialized runtime carries its manifest digest");
      assert.ok(!cli.startsWith(repoRoot), "the pi runtime must live outside the source repository");
      assert.ok(!cli.includes("evaluation/scorers"), "runtime path must not contain scorer paths");
      assert.ok(!cli.includes("evaluation/cache"), "runtime path must not contain fixture paths");
      const pkg = JSON.parse(readFileSync(join(dirname(dirname(cli)), "package.json"), "utf8"));
      assert.equal(pkg.version, manifest.evaluation.piVersion);
      assert.equal(pkg.version, "0.84.2", "the pinned version is exactly 0.84.2");
      const version = spawnSync(process.execPath, [cli, "--version"], { encoding: "utf8", timeout: 60_000 });
      assert.equal(version.status, 0, `the copied runtime must run: ${version.stderr.slice(0, 200)}`);
      assert.equal(version.stdout.trim(), manifest.evaluation.piVersion, "the runtime must report exactly the pinned version");
      const again = materializePiRuntime({ repoRoot, manifest, cacheRoot: work });
      assert.equal(again.cliPath, cli, "a second call reuses the materialized runtime");
    } finally {
      rmSync(work, { recursive: true, force: true });
    }
  });

  test("a mutated cached runtime is refused on reuse", { timeout: 300_000 }, async () => {
    const work = mkdtempSync(join(tmpdir(), "cm-runtime-pin-"));
    try {
      const { materializePiRuntime } = await import(join(repoRoot, "evaluation", "runner", "real-runtime.mjs"));
      const first = materializePiRuntime({ repoRoot, manifest, cacheRoot: work });
      const runtimeRoot = join(work, "pi", `pi-coding-agent-${manifest.evaluation.piVersion}`);
      assert.ok(existsSync(join(runtimeRoot, "dist", "cli.js")), "the cached runtime exists");
      appendFileSync(join(runtimeRoot, "dist", "cli.js"), "// tampered\n", "utf8");
      assert.throws(
        () => materializePiRuntime({ repoRoot, manifest, cacheRoot: work }),
        (error) => /digest/.test(error.message) && !error.message.includes(repoRoot),
        "a mutated dist/cli.js must be refused on cache reuse",
      );
    } finally {
      rmSync(work, { recursive: true, force: true });
    }
  });
});
