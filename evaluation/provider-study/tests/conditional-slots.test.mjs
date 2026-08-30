/**
 * Conditional repetitions 6-10 visibility (grown test-first).
 *
 * Judge export, judge run/import, reports, complete blocks, and
 * statistics must include conditional reps 6-10 whenever those slots
 * exist. One shared function enumerates base plus conditional planned
 * slots; no consumer may walk only the preallocated blocks.
 */

import { test } from "node:test";
import assert from "node:assert/strict";
import { mkdirSync, readFileSync, rmSync, writeFileSync } from "node:fs";
import { join } from "node:path";
import { tmpdir } from "node:os";
import { fileURLToPath } from "node:url";
import { providerStudyDryRun } from "../runner/study.mjs";
import { providerStudyJudgeExport } from "../runner/judge.mjs";
import { providerStudyReport } from "../runner/report.mjs";
import { providerStudySchedule } from "../runner/schedule.mjs";
import { providerStudyCli } from "../runner/cli.mjs";
import { providerStudyPublishCompletion } from "../runner/reserve.mjs";

const repoRoot = join(fileURLToPath(import.meta.url), "..", "..", "..", "..");
const resultsRoot = join(repoRoot, "evaluation", "results", "provider-study");

function freshRunsRoot() {
  const dir = join(tmpdir(), `provider-study-cond-${process.pid}-${Date.now()}-${Math.floor(Math.random() * 1e6)}`);
  mkdirSync(dir, { recursive: true });
  return dir;
}

/** Fabricate terminal conditional results for one task after a base dry-run. */
function fabricateConditional(runsRoot, taskId) {
  const schedule = providerStudySchedule(repoRoot, "development");
  const task = schedule.tasks.find((entry) => entry.taskId === taskId);
  for (const block of task.conditionalBlocks) {
    for (const arm of block.arms) {
      const attemptDir = join(runsRoot, "development", "attempts", taskId, arm, `attempt-${String(block.rep).padStart(3, "0")}`);
      mkdirSync(attemptDir, { recursive: true });
      writeFileSync(
        join(attemptDir, "result.json"),
        `${JSON.stringify({
          schemaVersion: 1,
          study: "provider-study",
          phase: "development",
          taskId,
          arm,
          rep: block.rep,
          conditional: true,
          status: "completed",
          deterministicResult: true,
          usage: { input: 1000, output: 10, cacheRead: null, cacheWrite: null },
          totalProviderTokens: 1010,
          proxyRequestCount: 2,
          proxyFailedRequestCount: 0,
          proxyRejectedCount: 0,
          assistantCompletions: 2,
        }, null, 2)}\n`,
        "utf8",
      );
      providerStudyPublishCompletion(attemptDir);
    }
  }
}

test("judge export, report, and status include conditional reps 6-10 whenever those slots exist", async () => {
  const runsRoot = freshRunsRoot();
  const label = `cond-${Date.now()}`;
  try {
    await providerStudyDryRun({ repoRoot, runsRoot, phase: "development", taskIds: ["task-01"] });
    const schedule = providerStudySchedule(repoRoot, "development");
    for (const task of schedule.tasks) {
      fabricateConditional(runsRoot, task.taskId);
    }

    const exported = await providerStudyJudgeExport({ repoRoot, runsRoot, phase: "development" });
    const mapping = JSON.parse(readFileSync(exported.mappingPath, "utf8"));
    const conditionalEntries = mapping.entries.filter((entry) => entry.rep >= 6);
    assert.equal(conditionalEntries.length, 240, "every conditional slot that exists exports a judge case");
    const caseIds = new Set(
      readFileSync(exported.casesPath, "utf8").trim().split("\n").map((line) => JSON.parse(line).caseId),
    );
    for (const entry of conditionalEntries.filter((entry) => entry.taskId === "task-01")) {
      assert.ok(caseIds.has(entry.caseId), `conditional case ${entry.taskId}/${entry.arm}/${entry.rep} exported`);
    }

    const report = providerStudyReport({ repoRoot, runsRoot, phase: "development", label });
    const body = JSON.parse(readFileSync(report.jsonPath, "utf8"));
    const conditionalRows = body.rows.filter((row) => row.rep >= 6);
    assert.equal(conditionalRows.length, 240, "reports include conditional rows");
    assert.equal(conditionalRows.every((row) => row.conditional === true), true);
    assert.equal(body.statistics.completeBlocks, 65, "conditional reps form matched complete blocks");
    assert.equal(body.statistics.primary.n, 65, "statistics pair conditional repetitions too");
    assert.equal(body.statistics.primaryConclusion.conclusive, false, "an includes-zero interval is not conclusive");
    assert.equal(body.statistics.fiveToTen.extended, true, "the report shows the extension ran");
    assert.equal(body.statistics.fiveToTen.afterTen, "inconclusive", "after ten reps the report says inconclusive without more calls");

    const status = await providerStudyCli(["status", "--runs-root", runsRoot], { repoRoot });
    const statusBody = JSON.parse(status.stdout);
    assert.equal(statusBody.development.completedSlots, 260, "status counts conditional slots that exist");
  } finally {
    rmSync(join(resultsRoot, `development-${label}.json`), { force: true });
    rmSync(join(resultsRoot, `development-${label}.md`), { force: true });
    rmSync(runsRoot, { recursive: true, force: true });
  }
});
