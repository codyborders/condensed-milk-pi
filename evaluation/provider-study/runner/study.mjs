/**
 * Four-arm provider study: dry-run execution (growing test-first).
 *
 * The free dry-run walks the persisted plan and fills one immutable
 * slot per (task, arm, rep). Each claimed slot records its isolated
 * environment (home, sessions, agent, tmp, cwd, tools, extensions),
 * the clean fixture digests it started from, and one terminal result.
 * Completed slots are skipped on re-run and never invoked again.
 */

import { cpSync, existsSync, mkdirSync, writeFileSync } from "node:fs";
import { createHash } from "node:crypto";
import { homedir } from "node:os";
import { join } from "node:path";
import { loadProviderStudyManifestFile } from "./manifest.mjs";
import { providerStudySchedule } from "./schedule.mjs";
import { withHoldoutTasks } from "./holdout.mjs";
import { PROVIDER_STUDY_ARM_NAMES, PROVIDER_STUDY_TOOLS_ARGV, providerStudyArmExtensions, providerStudyArmConfig } from "./arms.mjs";
import { providerStudyPublishCompletion, providerStudyReserve } from "./reserve.mjs";
import { fixturesCacheRoot, publishFixtureCache } from "../../lib/cache.mjs";
import { gitStateHash, hashTree, applySolution } from "../../lib/fixtures.mjs";
import { scoreWorktree } from "../../lib/scorer.mjs";
import { loadProviderStudyTaskData } from "./manifest.mjs";
import { normalizeProviderUsage, providerTotalTokens } from "./metrics.mjs";

/** Resolve the fixture cache directory for one task in one phase. */
function fixtureDirFor(repoRoot, phase, task) {
  const cacheRoot = phase === "development"
    ? fixturesCacheRoot(repoRoot)
    : providerStudyFixtureCacheRoot(repoRoot);
  const entry = join(cacheRoot, task.id);
  if (existsSync(join(entry, ".git"))) return entry;
  return publishFixtureCache({ repoRoot, task, cacheRoot });
}

/** Holdout fixture cache root: external by default, separate from the general cache. */
export function providerStudyFixtureCacheRoot(repoRoot, { cacheDir = null } = {}) {
  if (typeof cacheDir === "string" && cacheDir.trim().length > 0) return cacheDir;
  const override = process.env.CM_PROVIDER_STUDY_FIXTURES;
  if (typeof override === "string" && override.trim().length > 0) return override;
  const base = process.env.XDG_CACHE_HOME
    ?? (process.platform === "darwin" ? join(homedir(), "Library", "Caches") : join(homedir(), ".cache"));
  return join(base, "condensed-milk-eval", "provider-study-fixtures");
}

/** External default runs root: private runs never live inside the repo. */
export function providerStudyRunsRoot() {
  const override = process.env.CM_PROVIDER_STUDY_RUNS;
  if (typeof override === "string" && override.trim().length > 0) return override;
  const base = process.env.XDG_CACHE_HOME
    ?? (process.platform === "darwin" ? join(homedir(), "Library", "Caches") : join(homedir(), ".cache"));
  return join(base, "condensed-milk-eval", "provider-study-runs");
}

/** Deterministic fake metrics per (task, arm, rep). */
function fakeMetricsFor(taskId, arm, rep) {
  const armIndex = PROVIDER_STUDY_ARM_NAMES.indexOf(arm);
  const seedHash = createHash("sha256").update(`${taskId}:${arm}:${rep}`).digest();
  const base = 1200 + seedHash[0] * 4;
  const usage = normalizeProviderUsage({
    input: base + rep * 10 + armIndex,
    output: 300 + (seedHash[1] % 50) + rep * 5,
    cacheRead: 200 + armIndex * 30,
    cacheWrite: 40 + rep,
  });
  const remediated = arm.startsWith("remediated");
  const modelRequests = 6 + (seedHash[2] % 3);
  return {
    usage,
    totalProviderTokens: providerTotalTokens(usage),
    peakContextTokens: base * 4 + rep * 100,
    modelRequests,
    assistantCompletions: modelRequests,
    proxyRequestCount: modelRequests,
    proxyStatusCounts: { "200": modelRequests },
    proxyFailedRequestCount: 0,
    proxyRejectedCount: 0,
    providerTrafficAnomaly: false,
    wallTimeMs: 5000 + seedHash[3] * 10 + rep * 100,
    firstEventLatencyMs: 40 + (seedHash[13] % 20),
    toolCalls: 12 + (seedHash[4] % 5),
    shellReruns: remediated ? seedHash[5] % 2 : 2 + (seedHash[5] % 2),
    fileRereads: remediated ? seedHash[6] % 3 : 3 + (seedHash[6] % 3),
    testReruns: 1 + (seedHash[7] % 3),
    buildReruns: seedHash[8] % 2,
    compressionEvents: remediated ? 4 + (seedHash[9] % 4) : 0,
    historicalMaskEvents: remediated ? 3 + (seedHash[10] % 3) : 0,
    archiveReferences: arm === "remediated-archive" ? 2 + (seedHash[11] % 3) : 0,
    retrievalCalls: arm === "remediated-archive" ? 1 + (seedHash[12] % 2) : 0,
    retrievalFailures: 0,
  };
}

/**
 * Execute the free deterministic dry-run for one phase. Completed slots
 * are skipped; every claimed slot receives exactly one terminal result.
 */
export async function providerStudyDryRun({
  repoRoot,
  runsRoot,
  phase,
  taskIds = null,
  keySourcePath = null,
  privateTasks = null,
}) {
  if (phase === "development" && keySourcePath !== null) {
    throw new Error("development dry-run refuses --holdout-key-source");
  }
  if (phase === "development" && taskIds?.some((id) => /^holdout-task-/.test(id))) {
    throw new Error("holdout task does not belong to the development phase");
  }
  const loaded = loadProviderStudyManifestFile(repoRoot, { phase });
  if (phase === "holdout" && privateTasks === null) {
    return withHoldoutTasks({
      repoRoot,
      runsRoot,
      command: "dry-run",
      keySourcePath,
      taskIds: taskIds ?? loaded.tasks.map((task) => task.id),
      fn: ({ tasks }) => providerStudyDryRun({
        repoRoot,
        runsRoot,
        phase,
        taskIds,
        keySourcePath,
        privateTasks: tasks,
      }),
    });
  }
  const schedule = providerStudySchedule(repoRoot, phase);
  const manifestTasks = privateTasks === null
    ? loaded.tasks
    : loaded.tasks.map((task) => ({ ...privateTasks.get(task.id), coverage: task.coverage }));
  if (taskIds !== null) {
    for (const id of taskIds) {
      if (!manifestTasks.some((task) => task.id === id)) {
        throw new Error(`task ${id} does not belong to the ${phase} phase; refusing`);
      }
    }
  }
  const selected = taskIds === null ? manifestTasks : manifestTasks.filter((task) => taskIds.includes(task.id));
  const scheduleByTask = new Map(schedule.tasks.map((task) => [task.taskId, task]));
  const runId = `dry-${phase}`;
  let executed = 0;
  let skipped = 0;
  for (const task of selected) {
    const taskSchedule = scheduleByTask.get(task.id);
    const fixtureDir = fixtureDirFor(repoRoot, phase, task);
    const taskData = privateTasks === null
      ? loadProviderStudyTaskData(repoRoot, phase, task.id)
      : { assertions: task.scorer.assertions, solution: task.solution };
    for (const block of taskSchedule.blocks) {
      for (const arm of block.arms) {
        const claim = providerStudyReserve({
          runDir: runsRoot,
          runId,
          phase,
          taskId: task.id,
          arm,
          rep: block.rep,
          pins: {},
        });
        if (!claim.claimed) {
          skipped += 1;
          continue;
        }
        const attemptDir = claim.attemptDir;
        const worktree = join(attemptDir, "worktree");
        cpSync(fixtureDir, worktree, { recursive: true, dot: true });
        const home = join(attemptDir, "home");
        const sessions = join(attemptDir, "sessions");
        mkdirSync(join(home, ".config"), { recursive: true });
        mkdirSync(sessions, { recursive: true });
        mkdirSync(join(attemptDir, "agent"), { recursive: true });
        mkdirSync(join(attemptDir, "tmp"), { recursive: true });
        writeFileSync(
          join(home, ".config", "condensed-milk.json"),
          providerStudyArmConfig(repoRoot, arm).bytes,
          "utf8",
        );
        writeFileSync(
          join(attemptDir, "environment.json"),
          `${JSON.stringify({
            schemaVersion: 1,
            home,
            sessions,
            agent: join(attemptDir, "agent"),
            tmp: join(attemptDir, "tmp"),
            cwd: worktree,
            tools: PROVIDER_STUDY_TOOLS_ARGV,
            extensions: providerStudyArmExtensions(arm, { armIndexDir: join(attemptDir, "arm-index") }),
          }, null, 2)}\n`,
          "utf8",
        );
        writeFileSync(
          join(attemptDir, "fixture-before.json"),
          `${JSON.stringify({
            taskId: task.id,
            arm,
            rep: block.rep,
            contentSha256: hashTree(worktree),
            gitStateSha256: gitStateHash(worktree),
          }, null, 2)}\n`,
          "utf8",
        );
        applySolution({ worktree, solution: taskData.solution, taskId: task.id });
        const scorerResult = scoreWorktree({ repoRoot, worktree, taskId: task.id, assertions: taskData.assertions });
        writeFileSync(join(attemptDir, "scorer.json"), `${JSON.stringify(scorerResult, null, 2)}\n`, "utf8");
        const resultPath = join(attemptDir, "result.json");
        if (existsSync(resultPath)) {
          skipped += 1;
          continue;
        }
        writeFileSync(
          resultPath,
          `${JSON.stringify({
            schemaVersion: 1,
            study: "provider-study",
            phase,
            taskId: task.id,
            arm,
            rep: block.rep,
            status: "completed",
            deterministicResult: scorerResult.status === "passed",
            scorer: {
              status: scorerResult.status,
              passedCount: scorerResult.passedCount,
              totalCount: scorerResult.totalCount,
              error: scorerResult.error,
            },
            ...fakeMetricsFor(task.id, arm, block.rep),
            qualityScore: null,
            qualityScoreSource: "judge-pending",
            ...fakeMetricsFor(task.id, arm, block.rep),
          }, null, 2)}\n`,
          "utf8",
        );
        providerStudyPublishCompletion(attemptDir);
        executed += 1;
      }
    }
  }
  return { executed, skipped, phase, runId };
}
