/**
 * Real multi-task planning tests (public boundary:
 * evaluation/runner/cli.mjs run --plan-only -> real.mjs).
 *
 * --plan-only validates and prints the whole run plan (ordered
 * tasks/arms, commits, prompt hashes, fixture hashes, model, profile,
 * Pi version) without --confirm-paid, without credentials, without
 * spawning, and without creating attempts.
 */

import { test, describe } from "node:test";
import assert from "node:assert/strict";
import { fileURLToPath } from "node:url";
import { dirname, join } from "node:path";
import { existsSync, mkdtempSync, readFileSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { spawnSync } from "node:child_process";
import { hashTree, gitStateHash } from "../lib/fixtures.mjs";
import { buildAttemptPrompt, sha256Text } from "../runner/prompt.mjs";
import { loadManifestFile } from "../lib/manifest.mjs";
import { readJson } from "./real-multi.test.mjs";

const repoRoot = join(dirname(fileURLToPath(import.meta.url)), "..", "..");
const cli = join(repoRoot, "evaluation", "runner", "cli.mjs");
const manifest = loadManifestFile(join(repoRoot, "evaluation", "task-manifest.json"));
const ARM_COMMITS = Object.fromEntries(manifest.evaluation.arms.map((arm) => [arm.name, arm.commit]));

function planCli(args) {
  return spawnSync(process.execPath, [cli, ...args], { cwd: repoRoot, encoding: "utf8", timeout: 240_000 });
}

describe("real multi-task planning (--plan-only)", () => {
  test("--all plans all 20 task pairs without --confirm-paid, without spawning, and without creating attempts", () => {
    const runsDir = mkdtempSync(join(tmpdir(), "cm-multi-plan-"));
    const runId = "multi-plan-01";
    try {
      const prepare = planCli(["prepare", "--runs-dir", runsDir, "--run-id", runId, "--mode", "real"]);
      assert.equal(prepare.status, 0, `prepare failed: ${prepare.stderr}`);
      const runDir = join(runsDir, runId);
      const run = readJson(join(runDir, "run.json"));
      const journalBefore = readFileSync(join(runDir, "journal.jsonl"), "utf8");

      const planned = planCli(["run", "--runs-dir", runsDir, "--run-id", runId, "--all", "--plan-only"]);
      assert.equal(planned.status, 0, `plan-only failed: ${planned.stderr.slice(0, 500)}`);
      assert.equal(existsSync(join(runDir, "attempts")), false, "plan-only must not create attempts");
      assert.equal(
        readFileSync(join(runDir, "journal.jsonl"), "utf8"),
        journalBefore,
        "plan-only must not journal anything",
      );

      const plan = JSON.parse(planned.stdout.trim().split("\n").pop());
      assert.equal(plan.runId, runId);
      assert.equal(plan.planOnly, true);
      assert.equal(plan.model, manifest.evaluation.model);
      assert.equal(plan.profile, manifest.evaluation.profile);
      assert.equal(plan.piVersion, manifest.evaluation.piVersion);
      assert.deepEqual(plan.armCommits, ARM_COMMITS);
      assert.equal(plan.tasks.length, 20, "plan must cover all 20 task pairs");
      for (const entry of plan.tasks) {
        const task = manifest.tasks.find((candidate) => candidate.id === entry.taskId);
        assert.ok(task, `planned task ${entry.taskId} must exist in the manifest`);
        assert.deepEqual(
          entry.arms.map((arm) => arm.arm),
          run.armOrder[entry.taskId],
          `${entry.taskId} arms must follow the persisted order`,
        );
        for (const arm of entry.arms) {
          assert.equal(arm.commit, ARM_COMMITS[arm.arm], `${entry.taskId}/${arm.arm} commit must match the manifest`);
        }
        assert.equal(entry.promptSha256, sha256Text(buildAttemptPrompt(task.prompt)));
        const fixtureDir = join(repoRoot, "evaluation", "cache", "fixtures", entry.taskId);
        assert.equal(entry.fixture.contentSha256, hashTree(fixtureDir), `${entry.taskId} fixture content hash`);
        assert.equal(entry.fixture.gitStateSha256, gitStateHash(fixtureDir), `${entry.taskId} fixture git-state hash`);
      }
      const orderedIds = plan.tasks.map((entry) => entry.taskId);
      assert.deepEqual(orderedIds, [...orderedIds].sort(), "tasks must be planned in manifest order");
    } finally {
      rmSync(runsDir, { recursive: true, force: true });
    }
  });
});
