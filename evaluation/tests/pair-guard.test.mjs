import { test, describe } from "node:test";
import assert from "node:assert/strict";
import { fileURLToPath } from "node:url";
import { dirname, join } from "node:path";
import { existsSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { spawnSync } from "node:child_process";
import { publishFixtureCache } from "../lib/cache.mjs";
import { loadManifestFile } from "../lib/manifest.mjs";

const repoRoot = join(dirname(fileURLToPath(import.meta.url)), "..", "..");
const cli = join(repoRoot, "evaluation", "runner", "cli.mjs");
const manifest = loadManifestFile(join(repoRoot, "evaluation", "task-manifest.json"));

function runCli(args, cacheRoot, extra = {}) {
  return spawnSync(process.execPath, [cli, ...args], {
    cwd: repoRoot,
    encoding: "utf8",
    timeout: 180_000,
    ...extra,
    env: { ...process.env, ...(extra.env ?? {}), CM_EVAL_FIXTURES_CACHE: cacheRoot },
  });
}

describe("pair fixture-before guard", () => {
  test("arms of one pair must start from identical fixture bytes", () => {
    const work = mkdtempSync(join(tmpdir(), "cm-eval-pair-guard-"));
    const runsDir = join(work, "runs");
    const cacheRoot = join(work, "cache");
    const runDir = join(runsDir, "run-pair-01");
    try {
      const task = manifest.tasks.find((entry) => entry.id === "task-09");
      publishFixtureCache({ repoRoot, task, cacheRoot });
      assert.equal(runCli(["prepare", "--runs-dir", runsDir, "--run-id", "run-pair-01"], cacheRoot).status, 0);
      const first = runCli(["dry-run", "--runs-dir", runsDir, "--run-id", "run-pair-01", "--task", "task-09", "--arm", "upstream"], cacheRoot);
      assert.equal(first.status, 0, `first arm must run: ${first.stderr.slice(0, 300)}`);
      const firstAttempt = join(runDir, "attempts", "task-09", "upstream", "attempt-001");
      const beforePath = join(firstAttempt, "fixture-before.json");
      const before = JSON.parse(readFileSync(beforePath, "utf8"));
      assert.equal(typeof before.contentSha256, "string");
      assert.equal(typeof before.gitStateSha256, "string");

      // Diverge the recorded starting bytes of the first arm while the
      // cache itself stays valid: the pair guard must refuse the second
      // arm before its reservation exists.
      writeFileSync(beforePath, `${JSON.stringify({ ...before, contentSha256: "0".repeat(64) }, null, 2)}\n`, "utf8");
      const second = runCli(["dry-run", "--runs-dir", runsDir, "--run-id", "run-pair-01", "--task", "task-09", "--arm", "fork"], cacheRoot);
      assert.notEqual(second.status, 0, "diverged fixture must refuse the pair");
      assert.ok((second.stderr || "").includes("pair"), `stderr must name the pair refusal: ${(second.stderr || "").slice(0, 300)}`);
      assert.equal(
        existsSync(join(runDir, "attempts", "task-09", "fork", "attempt-001")),
        false,
        "pair refusal must happen before reservation of the second arm",
      );
    } finally {
      rmSync(work, { recursive: true, force: true });
    }
  });
});
