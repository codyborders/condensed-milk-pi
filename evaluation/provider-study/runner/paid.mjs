/**
 * Provider-study real paid execution (growing test-first).
 *
 * Paid roots live outside the source repository. The credential path
 * arrives only as the --credential-source flag and is never persisted.
 */

import { appendFileSync, copyFileSync, existsSync, mkdirSync, readFileSync, writeFileSync } from "node:fs";
import { dirname, isAbsolute, join, relative, resolve } from "node:path";
import { loadProviderStudyManifestFile, loadProviderStudyTaskData, PROVIDER_STUDY_PINS } from "./manifest.mjs";
import { providerStudySchedule, providerStudyPlanHash, providerStudyPlanBytes } from "./schedule.mjs";
import {
  PROVIDER_STUDY_ARMS,
  PROVIDER_STUDY_ARM_NAMES,
  providerStudyArm,
  providerStudyArmIdentitySha256,
  providerStudyArmConfig,
  NEUTRAL_RETRIEVAL_EXTENSION,
  stableJson,
} from "./arms.mjs";
import {
  providerStudyPublishCompletion,
  providerStudyReadCompletedResult,
  providerStudyReserve,
  providerStudySlotPath,
} from "./reserve.mjs";
import { providerStudyCanonicalFreezeIdentity, providerStudyFreezeMatches } from "./freeze.mjs";
import { providerStudyRunsRoot, providerStudyFixtureCacheRoot } from "./study.mjs";
import { withHoldoutTasks } from "./holdout.mjs";
import { normalizeProviderUsage, providerTotalTokens, proxyRequestAccounting, providerTrafficAnomaly } from "./metrics.mjs";
import { primaryInterval, fiveToTenRequired } from "./stats.mjs";
import { providerStudyObserverStudyObservers } from "./observer.mjs";
import { providerStudyDependenciesSha256, providerStudyDependencySpecs } from "./dependencies.mjs";
import { fixturesCacheRoot, publishFixtureCache } from "../../lib/cache.mjs";
import { scoreWorktree } from "../../lib/scorer.mjs";
import { buildAttemptPrompt, sha256Text } from "../../runner/prompt.mjs";
import { observerOrderingVerifier } from "../../runner/masking-observer.mjs";

/** Terminal rows for every preallocated slot in one phase. */
function terminalRows(repoRoot, runsRoot, phase) {
  const schedule = providerStudySchedule(repoRoot, phase);
  const rows = [];
  let missing = 0;
  for (const task of schedule.tasks) {
    for (const block of task.blocks) {
      for (const arm of block.arms) {
        const attemptDir = providerStudySlotPath(runsRoot, phase, task.taskId, arm, block.rep);
        const result = providerStudyReadCompletedResult(attemptDir);
        if (result === null) {
          missing += 1;
          continue;
        }
        rows.push({
          taskId: task.taskId,
          arm,
          rep: block.rep,
          status: typeof result?.status === "string" ? result.status : "unknown",
          success: result?.deterministicResult === true,
          totalProviderTokens: providerTotalTokens(result?.usage),
          providerTrafficAnomaly: result?.providerTrafficAnomaly === true,
          proxyFailedRequestCount: typeof result?.proxyFailedRequestCount === "number" ? result.proxyFailedRequestCount : null,
          proxyRejectedCount: typeof result?.proxyRejectedCount === "number" ? result.proxyRejectedCount : null,
        });
      }
    }
  }
  return { rows, missing };
}

/**
 * Five-to-ten gate: conditional repetitions 6-10 run for every task
 * and arm only after the primary interval over the complete
 * preallocated repetitions is inconclusive (its interval includes
 * zero).
 */
export function providerStudyConditionalGate(repoRoot, runsRoot, phase) {
  const { rows, missing } = terminalRows(repoRoot, runsRoot, phase);
  const primary = primaryInterval(rows, {
    treatment: "remediated-defaults",
    baseline: "upstream",
    seed: `provider-study:${phase}`,
    arms: PROVIDER_STUDY_ARM_NAMES,
  });
  return { complete: missing === 0, missing, required: missing === 0 && fiveToTenRequired(primary), primary };
}

/** Phase tasks with their full prompt text, in manifest order. */
export function providerStudyPhaseTasks(repoRoot, phase, privateTasks = null) {
  const loaded = loadProviderStudyManifestFile(repoRoot, { phase });
  if (phase === "holdout") {
    if (!(privateTasks instanceof Map)) throw new Error("holdout task prompts require the decrypted private bundle");
    return loaded.tasks.map((task) => {
      const privateTask = privateTasks.get(task.id);
      if (typeof privateTask?.prompt !== "string" || privateTask.prompt.length === 0) {
        throw new Error(`decrypted holdout task ${task.id} has no prompt; refusing`);
      }
      return privateTask;
    });
  }
  const general = JSON.parse(readFileSync(join(repoRoot, "evaluation", "task-manifest.json"), "utf8"));
  const byId = new Map(general.tasks.map((task) => [task.id, task]));
  return loaded.tasks.map((task) => {
    const prompt = byId.get(task.id)?.prompt;
    if (typeof prompt !== "string" || prompt.length === 0) {
      throw new Error(`general task ${task.id} has no prompt; refusing`);
    }
    return { id: task.id, prompt };
  });
}

/** Resolve the fixture cache directory for one task in one phase. */
function fixtureDirFor(repoRoot, phase, task, privateDir = null) {
  const cacheRoot = phase === "development"
    ? fixturesCacheRoot(repoRoot)
    : join(privateDir, "fixtures");
  const entry = join(cacheRoot, task.id);
  if (existsSync(join(entry, ".git"))) return entry;
  return publishFixtureCache({ repoRoot, task, cacheRoot });
}

function providerStudyTaskData(repoRoot, phase, task) {
  if (phase === "development") return loadProviderStudyTaskData(repoRoot, phase, task.id);
  return {
    assertions: task.scorer.assertions,
    solution: task.solution,
    scorerSha256: task.scorerSha256,
  };
}

/** Verify the persisted phase lock and run metadata before anything paid. */
function verifyPhaseLock(repoRoot, runsRoot, phase) {
  const lockPath = join(runsRoot, phase, "phase-lock.json");
  if (!existsSync(lockPath)) {
    throw new Error(`no phase lock at ${lockPath}; run prepare --phase ${phase} before any paid execution`);
  }
  const lock = JSON.parse(readFileSync(lockPath, "utf8"));
  if (lock.study !== "provider-study" || lock.phase !== phase) {
    throw new Error(`phase lock at ${lockPath} is not a provider-study ${phase} lock; refusing`);
  }
  const freezeIdentity = providerStudyCanonicalFreezeIdentity(repoRoot);
  if (stableJson(lock.freezeIdentity) !== stableJson(freezeIdentity)) {
    throw new Error(`the persisted ${phase} lock freeze identity differs from the canonical freeze; refusing`);
  }
  if (`${stableJson(lock.plan)}\n` !== providerStudyPlanBytes(repoRoot, phase)) {
    throw new Error(`the persisted ${phase} plan no longer matches the frozen schedule; refusing before any reservation`);
  }
  const runPath = join(runsRoot, phase, "run.json");
  if (!existsSync(runPath)) {
    throw new Error(`no run metadata at ${runPath}; prepare must create it before paid execution`);
  }
  const run = JSON.parse(readFileSync(runPath, "utf8"));
  if (stableJson(run.freezeIdentity) !== stableJson(freezeIdentity)) {
    throw new Error(`run metadata freeze identity differs from the canonical freeze; refusing`);
  }
  if (run.planSha256 !== providerStudyPlanHash(repoRoot, phase)) {
    throw new Error(`run metadata plan hash differs from the current ${phase} plan; refusing`);
  }
  return { lock, run, freezeIdentity };
}

/**
 * The shared preflight over a provider-study manifest adapter: the
 * exact arm worktrees at the pinned commits are verified before any
 * reservation, the Pi runtime is resolved and pinned, and the observer
 * ordering is verified against the exact runtime.
 */
async function runProviderStudyPreflight({ repoRoot, root, phase, flags, loaded }) {
  const { runPaidPreflight } = await import("../../runner/real.mjs");
  // The paid preflight itself compares the current evaluator commit and
  // evaluator source digest with the frozen values, before any arm
  // worktree, runtime, or reservation work begins.
  const freezeCheck = providerStudyFreezeMatchesPath(repoRoot, flags);
  if (!freezeCheck.ok) {
    return { ok: false, error: `paid preflight refused: ${freezeCheck.problems.join("; ")}`, code: 4 };
  }
  const commitArms = PROVIDER_STUDY_ARMS
    .filter((arm) => arm.kind === "commit")
    .map((arm) => ({ name: arm.name, commit: arm.commit }));
  const adapter = {
    schemaVersion: 1,
    study: "provider-study",
    phase,
    evaluation: {
      provider: loaded.manifest.evaluation.provider,
      model: loaded.manifest.evaluation.model,
      thinking: loaded.manifest.evaluation.thinking,
      piVersion: loaded.manifest.evaluation.piVersion,
      timeoutMsPerAttempt: loaded.manifest.evaluation.timeoutMsPerAttempt,
      arms: commitArms,
    },
  };
  return runPaidPreflight({
    flags,
    manifest: adapter,
    repoRoot,
    runDir: join(root, phase),
    armNames: commitArms.map((arm) => arm.name),
    implementationPolicy: "masking-safe",
    verifyObserverOrdering: observerOrderingVerifier(),
  });
}

/**
 * Stage the arm's neutral retrieval stub inside the attempt tree so the
 * child never sees a source-repository path. The staged bytes must
 * hash-match the checked-in stub the arm identity binds.
 */
function stageNeutralStub({ attemptDir }) {
  const staged = join(attemptDir, "arm-index", "neutral-retrieval.mjs");
  mkdirSync(dirname(staged), { recursive: true });
  const bytes = readFileSync(NEUTRAL_RETRIEVAL_EXTENSION, "utf8");
  copyFileSync(NEUTRAL_RETRIEVAL_EXTENSION, staged);
  return { path: staged, sha256: sha256Text(bytes) };
}

/**
 * The ordered extension list for one arm inside one attempt: remediated
 * arms load their pinned implementation copy, upstream adds the neutral
 * stub on top, none loads only the neutral stub. Every path lives
 * inside the attempt tree.
 */
function studyExtensionPaths({ arm, attemptDir, stagedNeutral }) {
  const armDef = providerStudyArm(arm);
  const paths = [];
  if (armDef.kind === "commit") {
    paths.push(join(attemptDir, "arm-runtime", "index.ts"));
  }
  if (arm === "none" || arm === "upstream") {
    paths.push(stagedNeutral.path);
  }
  return paths;
}

/**
 * Provider/session usage for one attempt: every assistant message_end
 * usage object is merged verbatim — numeric fields (known or unknown)
 * sum, non-numeric fields are preserved as first seen, and the total
 * sums every provider-reported token category.
 */
export function providerUsageFromSession(attemptDir) {
  const stdoutPath = join(attemptDir, "pi-stdout.jsonl");
  const events = [];
  if (existsSync(stdoutPath)) {
    for (const line of readFileSync(stdoutPath, "utf8").split("\n")) {
      if (line.trim().length === 0) continue;
      try {
        events.push(JSON.parse(line));
      } catch {
        // malformed lines were already counted by the attempt result
      }
    }
  }
  const messageEnds = events.filter(
    (event) => event?.type === "message_end" && event?.message?.role === "assistant" && event?.message?.usage !== undefined,
  );
  const merged = {};
  let peakContextTokens = null;
  let sawContext = false;
  for (const event of messageEnds) {
    const usage = event.message.usage;
    if (usage === null || typeof usage !== "object" || Array.isArray(usage)) continue;
    for (const [key, value] of Object.entries(usage)) {
      if (typeof value === "number" && Number.isFinite(value) && value >= 0) {
        merged[key] = (typeof merged[key] === "number" ? merged[key] : 0) + value;
      } else if (merged[key] === undefined) {
        merged[key] = value;
      }
    }
    let context = 0;
    for (const key of ["input", "cacheRead", "cacheWrite"]) {
      const value = usage[key];
      if (typeof value === "number" && Number.isFinite(value) && value >= 0) context += value;
    }
    if (!sawContext || context > peakContextTokens) {
      peakContextTokens = context;
      sawContext = true;
    }
  }
  const usage = normalizeProviderUsage(merged);
  return {
    usage,
    totalProviderTokens: providerTotalTokens(usage),
    peakContextTokens: sawContext ? peakContextTokens : null,
    assistantCompletions: messageEnds.length,
  };
}

/**
 * Proxy-authoritative request accounting for one attempt, read from
 * the persisted proxy.json. The proxy observed every provider request,
 * so its counts override any session-derived count.
 */
export function providerProxyAccounting(attemptDir) {
  const proxyPath = join(attemptDir, "proxy.json");
  let proxy = null;
  if (existsSync(proxyPath)) {
    try {
      proxy = JSON.parse(readFileSync(proxyPath, "utf8"));
    } catch {
      proxy = null;
    }
  }
  return proxyRequestAccounting(proxy);
}

/**
 * Merge provider/session usage and observer instrumentation into the
 * terminal result row. Failures stay separate from metrics; the
 * deterministic result comes from the hidden scorer.
 */
export function mergeProviderStudyResult({ attemptDir, phase, taskId, arm, rep, conditional }) {
  const resultPath = join(attemptDir, "result.json");
  const result = JSON.parse(readFileSync(resultPath, "utf8"));
  const scorer = JSON.parse(readFileSync(join(attemptDir, "scorer.json"), "utf8"));
  let instrumentation = null;
  const instrumentationPath = join(attemptDir, "instrumentation.json");
  if (existsSync(instrumentationPath)) {
    instrumentation = JSON.parse(readFileSync(instrumentationPath, "utf8"));
  }
  const session = providerUsageFromSession(attemptDir);
  const accounting = providerProxyAccounting(attemptDir);
  const traffic = providerTrafficAnomaly({
    proxyRequestCount: accounting.proxyRequestCount,
    assistantCompletions: session.assistantCompletions,
  });
  const metric = (field) =>
    typeof instrumentation?.[field] === "number" && Number.isFinite(instrumentation[field])
      ? instrumentation[field]
      : 0;
  const row = {
    ...result,
    study: "provider-study",
    phase,
    taskId,
    arm,
    rep,
    conditional: conditional === true,
    deterministicResult: scorer.status === "passed",
    scorer: {
      status: scorer.status,
      passedCount: scorer.passedCount,
      totalCount: scorer.totalCount,
      error: scorer.error,
    },
    usage: session.usage,
    totalProviderTokens: session.totalProviderTokens,
    peakContextTokens: session.peakContextTokens,
    modelRequests: accounting.proxyRequestCount,
    assistantCompletions: session.assistantCompletions,
    ...accounting,
    providerTrafficAnomaly: traffic.anomaly,
    providerTrafficAnomalyReason: traffic.reason,
    wallTimeMs: typeof result.durationMs === "number" ? result.durationMs : null,
    firstEventLatencyMs: typeof result.firstEventLatencyMs === "number" ? result.firstEventLatencyMs : null,
    toolCalls: metric("toolCalls"),
    shellReruns: metric("shellReruns"),
    fileRereads: metric("fileRereads"),
    testReruns: metric("testReruns"),
    buildReruns: metric("buildReruns"),
    compressionEvents: metric("compressionEvents"),
    historicalMaskEvents: metric("historicalMaskEvents"),
    archiveReferences: metric("archiveReferences"),
    retrievalCalls: metric("retrievalCalls"),
    retrievalFailures: metric("retrievalFailures"),
    qualityScore: null,
    qualityScoreSource: "judge-pending",
  };
  writeFileSync(resultPath, `${JSON.stringify(row, null, 2)}\n`, "utf8");
  providerStudyPublishCompletion(attemptDir);
  return row;
}

const STOP_STATUSES = new Set(["collection-error", "timeout", "interrupted"]);

/**
 * Execute one reserved slot end to end through the shared real-attempt
 * machinery with the provider-study study configuration.
 */
async function executeProviderStudySlot({
  repoRoot,
  phase,
  task,
  arm,
  claim,
  armInfos,
  pi,
  timeoutMs,
  credentialSourcePath,
  loaded,
  conditional,
  planSha256,
  runId,
  privateDir = null,
}) {
  const { executeRealAttempt } = await import("../../runner/real-attempt.mjs");
  const attemptDir = claim.attemptDir;
  const armDef = providerStudyArm(arm);
  const config = providerStudyArmConfig(repoRoot, arm);
  const fixtureDir = fixtureDirFor(repoRoot, phase, task, privateDir);
  const taskData = providerStudyTaskData(repoRoot, phase, task);
  const stagedNeutral = stageNeutralStub({ attemptDir });
  const extensionPaths = studyExtensionPaths({ arm, attemptDir, stagedNeutral });
  const armInfo = armDef.kind === "commit"
    ? armInfos[arm]
    : { commit: null, path: null, tracked: [], implementationSha256: null };
  const study = {
    profileBytes: config.bytes,
    profileSha256: config.sha256,
    scorerSha256: taskData.scorerSha256,
    extensionPaths,
    implementationOutsideWorktree: true,
    implementationDependencies: armDef.kind === "commit" ? providerStudyDependencySpecs(repoRoot) : [],
    observers: providerStudyObserverStudyObservers(),
    scoreWorktree: ({ repoRoot: root, worktree, taskId }) =>
      scoreWorktree({ repoRoot: root, worktree, taskId, assertions: taskData.assertions }),
    extraPins: {
      study: "provider-study",
      phase,
      armIdentitySha256: providerStudyArmIdentitySha256(repoRoot, arm),
      planSha256,
      conditional: conditional === true,
      neutralStubSha256: stagedNeutral.sha256,
      noPaidRetry: true,
      runtimeDependenciesSha256: providerStudyDependenciesSha256(repoRoot),
    },
  };
  let outcome;
  try {
    outcome = await executeRealAttempt({
      repoRoot,
      manifest: loaded.manifest,
      task: { id: task.id, prompt: task.prompt },
      arm,
      armInfo,
      attemptDir,
      fixtureDir,
      credentialSourcePath,
      piCliPath: pi.cliPath,
      timeoutMs,
      identity: { runId, rep: claim.rep, study: "provider-study", phase },
      study,
    });
  } catch (error) {
    const resultPath = join(attemptDir, "result.json");
    if (!existsSync(resultPath)) {
      writeFileSync(
        resultPath,
        `${JSON.stringify({
          schemaVersion: 1,
          study: "provider-study",
          phase,
          taskId: task.id,
          arm,
          rep: claim.rep,
          conditional: conditional === true,
          status: "infrastructure-error",
          failures: ["infrastructure error"],
        }, null, 2)}\n`,
        "utf8",
      );
    }
    return { error: String(error?.message ?? error), stopStatus: null };
  }
  try {
    mergeProviderStudyResult({ attemptDir, phase, taskId: task.id, arm, rep: claim.rep, conditional });
  } catch (error) {
    return { error: `metric extraction failed: ${String(error?.message ?? error)}`, stopStatus: null };
  }
  if (STOP_STATUSES.has(outcome.status)) {
    return { error: null, stopStatus: outcome.status };
  }
  if (outcome.scorer?.error) {
    return { error: null, stopStatus: `scorer-error:${outcome.scorer.error}` };
  }
  return { error: null, stopStatus: null };
}

/**
 * Paid roots must live outside the source repository: private run trees
 * never sit beside the evaluated code.
 */
export function providerStudyRejectInsideRepo(runsRoot, repoRoot) {
  const rel = relative(resolve(repoRoot), resolve(runsRoot));
  if (rel === "" || (!rel.startsWith("..") && !isAbsolute(rel))) {
    throw new Error(`paid runs root must live outside this repository (got ${runsRoot}); refusing before any reservation`);
  }
}

/**
 * Resolve and validate the paid runs root before any reservation. The
 * confirm flag and the external-root rule are enforced first so a
 * refusal never spends a paid call.
 */
export function providerStudyResolvePaidRoot({ repoRoot, runsRoot = null, flags = {} }) {
  if (flags["--confirm-paid"] !== true) {
    throw new Error("provider-study paid execution needs --confirm-paid; refusing before any reservation");
  }
  const root = runsRoot ?? (typeof flags["--runs-root"] === "string" ? flags["--runs-root"] : providerStudyRunsRoot());
  providerStudyRejectInsideRepo(root, repoRoot);
  return join(root);
}

export function providerStudyFreezeMatchesPath(repoRoot, flags = {}) {
  const canonicalPath = join(repoRoot, "evaluation", "provider-study", "freeze-lock.json");
  const canonical = existsSync(canonicalPath) ? JSON.parse(readFileSync(canonicalPath, "utf8")) : null;
  if (canonical === null) return { ok: false, problems: ["canonical freeze lock is missing"] };
  const suppliedPath = typeof flags["--freeze-lock"] === "string" ? flags["--freeze-lock"] : null;
  if (suppliedPath !== null) {
    const supplied = existsSync(suppliedPath) ? JSON.parse(readFileSync(suppliedPath, "utf8")) : null;
    if (supplied === null || stableJson(supplied.digests) !== stableJson(canonical.digests)) {
      return { ok: false, problems: ["supplied freeze lock differs from the canonical freeze lock"] };
    }
  }
  return providerStudyFreezeMatches(repoRoot, { lock: canonical.digests });
}

/** Paid run entry: gates first, then executes reserved slots. */
export async function providerStudyPaidRun({
  repoRoot,
  runsRoot = null,
  phase,
  flags = {},
  privateTasks = null,
  privateDir = null,
}) {
  const root = providerStudyResolvePaidRoot({ repoRoot, runsRoot, flags });
  if (flags["--timeout-ms"] !== undefined) {
    throw new Error("provider-study paid execution refuses --timeout-ms because the attempt timeout is frozen");
  }
  const freeze = providerStudyFreezeMatchesPath(repoRoot, flags);
  if (!freeze.ok) {
    throw new Error(`paid execution refused: ${freeze.problems.join("; ")}`);
  }
  const { run, freezeIdentity } = verifyPhaseLock(repoRoot, root, phase);
  const runId = run.runId;
  const loaded = loadProviderStudyManifestFile(repoRoot, { phase });
  const schedule = providerStudySchedule(repoRoot, phase);
  const requested = flags["--task"] === undefined ? null : [].concat(flags["--task"]);
  if (phase === "development" && flags["--holdout-key-source"] !== undefined) {
    throw new Error("development paid run refuses --holdout-key-source");
  }
  if (phase === "holdout" && privateTasks === null) {
    const publicTaskIds = loaded.tasks.map((task) => task.id);
    const selectedTaskIds = requested ?? publicTaskIds;
    for (const id of selectedTaskIds) {
      if (!publicTaskIds.includes(id)) throw new Error(`task ${id} does not belong to the holdout phase; refusing`);
    }
    return withHoldoutTasks({
      repoRoot,
      runsRoot: root,
      command: "run",
      keySourcePath: flags["--holdout-key-source"],
      taskIds: selectedTaskIds,
      fn: ({ tasks, privateDir: openedDir }) => providerStudyPaidRun({
        repoRoot,
        runsRoot: root,
        phase,
        flags,
        privateTasks: tasks,
        privateDir: openedDir,
      }),
    });
  }
  const tasks = providerStudyPhaseTasks(repoRoot, phase, privateTasks);
  if (requested !== null) {
    for (const id of requested) {
      if (!tasks.some((task) => task.id === id)) {
        throw new Error(`task ${id} does not belong to the ${phase} phase; refusing`);
      }
    }
  }
  const selected = requested === null ? tasks : tasks.filter((task) => requested.includes(task.id));
  const summary = {
    study: "provider-study",
    phase,
    runId,
    executed: 0,
    skipped: 0,
    stoppedReason: null,
    conditional: { required: false, executed: 0, refused: null },
  };
  const preflight = await runProviderStudyPreflight({ repoRoot, root, phase, flags, loaded });
  if (!preflight.ok) {
    throw new Error(preflight.error);
  }
  const { armInfos, pi, timeoutMs, credentialSourcePath } = preflight;
  const planSha256 = providerStudyPlanHash(repoRoot, phase);

  const executeSlotList = async (blocksOf, conditional) => {
    for (const task of selected) {
      const taskSchedule = schedule.tasks.find((entry) => entry.taskId === task.id);
      for (const block of blocksOf(taskSchedule)) {
        for (const arm of block.arms) {
          const pins = {
            taskId: task.id,
            rep: block.rep,
            study: "provider-study",
            phase,
            conditional: conditional === true,
            planSha256,
            armIdentitySha256: providerStudyArmIdentitySha256(repoRoot, arm),
            profileSha256: providerStudyArmConfig(repoRoot, arm).sha256,
            provider: PROVIDER_STUDY_PINS.provider,
            model: PROVIDER_STUDY_PINS.model,
            thinking: PROVIDER_STUDY_PINS.thinking,
            piVersion: PROVIDER_STUDY_PINS.piVersion,
            noPaidRetry: true,
            timeoutMsPerAttempt: PROVIDER_STUDY_PINS.timeoutMsPerAttempt,
            ...freezeIdentity,
            promptSha256: sha256Text(buildAttemptPrompt(task.prompt)),
            scorerSha256: providerStudyTaskData(repoRoot, phase, task).scorerSha256,
          };
          const claim = providerStudyReserve({ runDir: root, runId, phase, taskId: task.id, arm, rep: block.rep, pins });
          if (!claim.claimed) {
            if (claim.reason === "completed") {
              summary.skipped += 1;
              continue;
            }
            summary.stoppedReason = `abandoned or occupied slot ${task.id}/${arm}/${block.rep} (${claim.reason}); no paid retry exists; prepare a new run root`;
            return summary;
          }
          const executed = await executeProviderStudySlot({
            repoRoot,
            phase,
            task,
            arm,
            claim: { ...claim, rep: block.rep },
            armInfos,
            pi,
            timeoutMs,
            credentialSourcePath,
            loaded,
            conditional,
            planSha256,
            runId,
            privateDir,
          });
          if (executed.error !== null) {
            summary.stoppedReason = `infrastructure failure on ${task.id}/${arm}/${block.rep}: ${executed.error}; stopping later slots`;
            return summary;
          }
          summary.executed += 1;
          if (conditional) summary.conditional.executed += 1;
          if (executed.stopStatus !== null) {
            summary.stoppedReason = `stop after ${task.id}/${arm}/${block.rep}: status ${executed.stopStatus}`;
            return summary;
          }
        }
      }
    }
    return null;
  };

  const preallocatedStop = await executeSlotList((taskSchedule) => taskSchedule.blocks, false);
  if (preallocatedStop !== null) return preallocatedStop;

  if (flags["--conditional"] === true) {
    const gate = providerStudyConditionalGate(repoRoot, root, phase);
    if (!gate.complete) {
      summary.conditional.refused = `primary repetitions are not complete (${gate.missing} slots without a terminal result)`;
      return summary;
    }
    summary.conditional.required = gate.required;
    if (!gate.required) {
      summary.conditional.refused = "primary interval is conclusive; repetitions 6-10 stay unrun";
      return summary;
    }
    const conditionalStop = await executeSlotList((taskSchedule) => taskSchedule.conditionalBlocks, true);
    if (conditionalStop !== null) return conditionalStop;
  }
  return summary;
}
