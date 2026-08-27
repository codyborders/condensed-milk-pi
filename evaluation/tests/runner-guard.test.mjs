import { test, describe } from "node:test";
import assert from "node:assert/strict";
import { fileURLToPath } from "node:url";
import { dirname, join } from "node:path";
import { mkdtempSync, existsSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { spawnSync } from "node:child_process";
import { publishFixtureCache } from "../lib/cache.mjs";
import { loadManifestFile } from "../lib/manifest.mjs";

const repoRoot = join(dirname(fileURLToPath(import.meta.url)), "..", "..");
const cli = join(repoRoot, "evaluation", "runner", "cli.mjs");
const manifest = loadManifestFile(join(repoRoot, "evaluation", "task-manifest.json"));

function runCli(args, cacheRoot) {
  return spawnSync(process.execPath, [cli, ...args], {
    cwd: repoRoot,
    encoding: "utf8",
    timeout: 120_000,
    env: { ...process.env, CM_EVAL_FIXTURES_CACHE: cacheRoot },
  });
}

describe("runner fixture guard", () => {
  test("altered fixture cache entry refuses dry-run before any attempt is created", () => {
    const workDir = mkdtempSync(join(tmpdir(), "cm-eval-runner-guard-"));
    const runsDir = join(workDir, "runs");
    const cacheRoot = join(workDir, "cache");
    const runDir = join(runsDir, "run-guard-01");
    const task = manifest.tasks.find((entry) => entry.id === "task-10");
    const fixtureDir = publishFixtureCache({ repoRoot, task, cacheRoot });
    const mergeHead = join(fixtureDir, ".git", "MERGE_HEAD");
    try {
      assert.ok(existsSync(mergeHead), "isolated fixture must contain MERGE_HEAD");
      assert.equal(runCli(["prepare", "--runs-dir", runsDir, "--run-id", "run-guard-01"], cacheRoot).status, 0);
      rmSync(mergeHead);
      const dry = runCli(
        ["dry-run", "--runs-dir", runsDir, "--run-id", "run-guard-01", "--task", "task-10", "--arm", "upstream"],
        cacheRoot,
      );
      assert.notEqual(dry.status, 0, "altered fixture must be refused");
      assert.ok((dry.stderr || "").includes("fixture"), `stderr must explain: ${(dry.stderr || "").slice(0, 300)}`);
      assert.equal(existsSync(join(runDir, "attempts", "task-10", "upstream", "attempt-001")), false, "refusal must precede reservation");
    } finally {
      rmSync(workDir, { recursive: true, force: true });
    }
  });
});
