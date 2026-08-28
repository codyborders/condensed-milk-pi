/**
 * Masking-focused paired study runner.
 *
 * Separate from the 20-task evaluation runner: its own run layout,
 * three repetitions per task, persisted randomized arm order and
 * repetition order, an isolated low-threshold study profile whose
 * exact bytes both arms share, and masking-specific release gates.
 *
 * Run layout under <runs-dir>/<run-id>/:
 *   run.json       static metadata: persisted armOrder, repetitionOrder,
 *                  manifest/profile digests, study identity pins
 *   journal.jsonl  append-only event log (fsync per event)
 *   snapshot.json  atomic state snapshot
 *   attempts/<taskId>/<arm>/attempt-00R/  immutable per-repetition dirs
 *
 * Paid execution is explicit only (masking-run with --confirm-paid) and
 * always sequential. Real-run retries are unsupported.
 */

import { createHash } from "node:crypto";
import { createRequire } from "node:module";
import { existsSync, cpSync, mkdirSync, readFileSync, writeFileSync, renameSync } from "node:fs";
import { join } from "node:path";
import {
  loadMaskingManifestFile,
  validateStudyIdentity,
  loadMaskingTaskData,
  maskingScorerSha256,
  validateMaskingRunId,
} from "../lib/masking-manifest.mjs";
import { sha256Text, buildAttemptPrompt } from "./prompt.mjs";
import { appendJournal, writeSnapshot } from "./state.mjs";
import { fixturesCacheRoot, publishFixtureCache } from "../lib/cache.mjs";
import { applySolution, hashTree, gitStateHash } from "../lib/fixtures.mjs";
import { scoreWorktree } from "../lib/scorer.mjs";
import { pairedBootstrapInterval, pairedTInterval } from "./masking-stats.mjs";

export const MASKING_STUDY_NAME = "masking";
export const MASKING_ARMS = ["upstream", "fork"];

/** Deterministic arm order per (runId, taskId): seeded bit decides order. */
export function maskingArmOrderFor(runId, taskId) {
  const hash = createHash("sha256").update(`masking:${runId}:${taskId}`).digest();
  return hash[0] % 2 === 0 ? ["upstream", "fork"] : ["fork", "upstream"];
}

/**
 * Deterministic repetition order per (runId, taskId): seeded shuffle of
 * [1..repetitions] so repetition order is fixed before any execution,
 * independent of wall-clock time.
 */
export function maskingRepetitionOrderFor(runId, taskId, repetitions) {
  const hash = createHash("sha256").update(`masking-reps:${runId}:${taskId}`).digest();
  let state = ((hash[0] << 24) | (hash[1] << 16) | (hash[2] << 8) | hash[3]) >>> 0;
  const random = () => {
    state = (state + 0x6d2b79f5) >>> 0;
    let t = state;
    t = Math.imul(t ^ (t >>> 15), t | 1);
    t ^= t + Math.imul(t ^ (t >>> 7), t | 61);
    return ((t ^ (t >>> 14)) >>> 0) / 4294967296;
  };
  const reps = Array.from({ length: repetitions }, (_, index) => index + 1);
  for (let index = reps.length - 1; index > 0; index -= 1) {
    const swap = Math.floor(random() * (index + 1));
    [reps[index], reps[swap]] = [reps[swap], reps[index]];
  }
  return reps;
}

/**
 * Create a masking run and persist randomized arm order and repetition
 * order before any attempt exists. The study identity (provider,
 * model, profile bytes digest) is validated first: a mismatch refuses
 * before anything is written.
 */
export function maskingPrepare({ repoRoot, runsDir, runId, mode = "dry-run" }) {
  const runIdCheck = validateMaskingRunId(runId);
  if (!runIdCheck.ok) {
    throw new Error(`masking prepare: run id refused: ${runIdCheck.problems.join("; ")}`);
  }
  if (mode !== "dry-run" && mode !== "real") {
    throw new Error(`masking prepare: mode must be dry-run or real (got ${JSON.stringify(mode)})`);
  }
  const { manifest, profile } = loadMaskingManifestFile(repoRoot);
  const identity = validateStudyIdentity({
    provider: manifest.evaluation.provider,
    model: manifest.evaluation.model,
    profileSha256: profile.sha256,
  });
  if (!identity.ok) {
    throw new Error(`masking prepare: study identity refused: ${identity.problems.join("; ")}`);
  }
  const runDir = join(runsDir, runId);
  if (existsSync(runDir)) {
    throw new Error(`masking run ${runId} already exists at ${runDir}`);
  }
  mkdirSync(runDir, { recursive: true });
  // Fake runs persist deterministic per-arm implementation digests so
  // fake validity exercises the same pin shape as real runs.
  const armImplementationSha256 = mode === "dry-run"
    ? {
        upstream: createHash("sha256").update("masking-fake-implementation:upstream").digest("hex"),
        fork: createHash("sha256").update("masking-fake-implementation:fork").digest("hex"),
      }
    : {};
  const armOrder = {};
  const repetitionOrder = {};
  for (const task of manifest.tasks) {
    armOrder[task.id] = maskingArmOrderFor(runId, task.id);
    repetitionOrder[task.id] = maskingRepetitionOrderFor(runId, task.id, manifest.evaluation.repetitionsPerTask);
  }
  const run = {
    schemaVersion: 1,
    study: MASKING_STUDY_NAME,
    runId,
    mode,
    repoRoot,
    createdAt: new Date().toISOString(),
    manifestSha256: createHash("sha256")
      .update(readFileSync(join(repoRoot, "evaluation", "masking-task-manifest.json")))
      .digest("hex"),
    profileSha256: profile.sha256,
    provider: manifest.evaluation.provider,
    model: manifest.evaluation.model,
    repetitionsPerTask: manifest.evaluation.repetitionsPerTask,
    armImplementationSha256,
    armOrder,
    repetitionOrder,
  };
  writeFileSync(join(runDir, "run.json"), `${JSON.stringify(run, null, 2)}\n`, "utf8");
  const state = { runId, mode, study: MASKING_STUDY_NAME, seq: 0, attempts: {}, selection: {} };
  appendJournal(runDir, { type: "run-created", runId, mode, study: MASKING_STUDY_NAME });
  appendJournal(runDir, { type: "arm-order-persisted", armOrder });
  appendJournal(runDir, { type: "repetition-order-persisted", repetitionOrder });
  writeSnapshot(runDir, state);
  return { ...run, runDir, state };
}

/** Deterministic fake per-arm implementation digests (dry-run shape). */
function fakeArmImplementationSha256(arm) {
  return createHash("sha256").update(`masking-fake-implementation:${arm}`).digest("hex");
}

/** Deterministic fake observer digests per task (marker-derived). */
const fakeObserverDigestCache = new Map();
function fakeObserverDigests(repoRoot, taskId) {
  if (!fakeObserverDigestCache.has(taskId)) {
    throw new Error(`fakeObserverDigests: no cached digests for ${taskId}`);
  }
  return fakeObserverDigestCache.get(taskId);
}

/** Regenerate the expected observer digests for one task at report time. */
const reportObserverDigestCache = new Map();
function expectedObserverDigestsFor(repoRoot, runDir, taskId, assertions) {
  const cacheKey = `${runDir}:${taskId}`;
  if (!reportObserverDigestCache.has(cacheKey)) {
    const { generateMaskingObservers, diagnosticMarkersFromAssertions } = nodeRequire("./masking-observer.mjs");
    const staged = generateMaskingObservers({
      attemptDir: join(runDir, ".observer-staging-report", taskId),
      diagnosticMarkers: diagnosticMarkersFromAssertions(assertions),
    });
    reportObserverDigestCache.set(cacheKey, {
      observerSha256: staged.observerSha256,
      observerWrapperSha256: staged.observerWrapperSha256,
    });
  }
  return reportObserverDigestCache.get(cacheKey);
}

/** Shared run-id gate: every masking path join goes through this. */
function requireSafeRunId(where, runId) {
  const check = validateMaskingRunId(runId);
  if (!check.ok) {
    throw new Error(`${where}: run id refused: ${check.problems.join("; ")}`);
  }
}

/** Load the persisted masking run metadata (run id validated first). */
export function loadMaskingRun(runDir, runId = null) {
  if (runId !== null) {
    const check = validateMaskingRunId(runId);
    if (!check.ok) {
      throw new Error(`masking run id refused: ${check.problems.join("; ")}`);
    }
  }
  const run = JSON.parse(readFileSync(join(runDir, "run.json"), "utf8"));
  if (run.study !== MASKING_STUDY_NAME) {
    throw new Error(`run at ${runDir} is not a masking study run`);
  }
  return run;
}

/** Validate persisted task schedules before any execution or report path uses them. */
export function validateMaskingRunOrders(run, manifest) {
  const expectedTaskIds = manifest.tasks.map((task) => task.id).sort();
  for (const [field, expectedValues] of [
    ["armOrder", ["fork", "upstream"]],
    ["repetitionOrder", [1, 2, 3]],
  ]) {
    const schedule = run?.[field];
    if (schedule === null || typeof schedule !== "object" || Array.isArray(schedule)) {
      throw new Error(`masking run ${field} must be an object`);
    }
    if (JSON.stringify(Object.keys(schedule).sort()) !== JSON.stringify(expectedTaskIds)) {
      throw new Error(`masking run ${field} task keys do not match the manifest`);
    }
    for (const taskId of expectedTaskIds) {
      const values = schedule[taskId];
      if (!Array.isArray(values) || values.length !== expectedValues.length) {
        throw new Error(`masking run ${field}.${taskId} is not a complete permutation`);
      }
      const sorted = [...values].sort(typeof expectedValues[0] === "number" ? (left, right) => left - right : undefined);
      if (JSON.stringify(sorted) !== JSON.stringify(expectedValues)) {
        throw new Error(`masking run ${field}.${taskId} is not an exact permutation`);
      }
    }
  }
  return true;
}

/**
 * Deterministic fake masking instrumentation for one attempt. Fake runs
 * use deterministic fixture knowledge (the task's masking kind drives a
 * fixed tool-result script), so every field has exact values without
 * provider calls. Semantic-filter savings and historical-masking
 * savings are separate ledgers that never overlap.
 */
function fakeInstrumentationFor({ task, arm, rep }) {
  const kind = task.masking.kind;
  const rawResultBytes = 2400 + rep * 100;
  const semanticSaved = arm === "fork" ? 400 : 0;
  const visibleAfterSemantic = rawResultBytes - semanticSaved;
  const historicalMaskedBytes = arm === "fork" ? Math.floor(visibleAfterSemantic * 0.5) : Math.floor(visibleAfterSemantic * 0.2);
  const instrumentation = {
    schemaVersion: 1,
    source: "fake-ledger",
    taskId: task.id,
    arm,
    repetition: rep,
    activatedFilterIds: [...task.masking.filterIds],
    originalBytes: rawResultBytes,
    visibleBytes: visibleAfterSemantic - historicalMaskedBytes,
    removedBytes: semanticSaved + historicalMaskedBytes,
    archivedBytes: arm === "fork" ? historicalMaskedBytes : 0,
    estimatedTokensSavedSemantic: Math.floor(semanticSaved / 4),
    estimatedTokensSavedHistorical: Math.floor(historicalMaskedBytes / 4),
    historicalMaskEvents: arm === "fork" ? 3 : 1,
    semanticTransforms: task.masking.filterIds.length > 0 ? 1 : 0,
    archiveReferences: arm === "fork" ? 2 : 0,
    retrievalCalls: 0,
    returnedBytes: 0,
    reruns: arm === "upstream" && kind === "diagnostic-recovery" ? 1 : 0,
    rereads: 0,
    usage: { input: 1000 + rep * 10, output: 300 + rep * 5, cacheRead: null, cacheWrite: null },
    cost: null,
    wallTimeMs: 500 + rep,
    firstEventLatencyMs: 42,
    correctness: null,
    recoveryResult: "none",
    diagnosticPresent: kind === "diagnostic-recovery",
    secretIncidents: 0,
    nonTextOrderingIncidents: 0,
    digests: { provider: sha256Text("z-ai"), model: sha256Text("glm-5.3-flash"), profile: null, runtime: null },
  };
  if (kind === "diagnostic-recovery") {
    if (arm === "fork") {
      instrumentation.retrievalCalls = 1;
      instrumentation.returnedBytes = 96;
      instrumentation.recoveryResult = "archive";
      instrumentation.archiveReferences = 3;
    } else {
      instrumentation.recoveryResult = "rerun";
    }
  }
  return instrumentation;
}

/**
 * Deterministic fake masking dry-run: per task, in the persisted
 * repetition order, per arm in the persisted arm order, create one
 * attempt directory with a fresh fixture worktree, isolated home, exact
 * instrumentation, a fake receipt, and identity pins. Completed
 * attempts are skipped, never duplicated (resume behavior).
 */
export async function maskingDryRun({ repoRoot, runsDir, runId }) {
  requireSafeRunId("masking dry-run", runId);
  const runDir = join(runsDir, runId);
  const run = loadMaskingRun(runDir, runId);
  if (run.mode !== "dry-run") {
    throw new Error(`masking dry-run refused: run ${runId} has mode ${run.mode}`);
  }
  const { manifest, profile } = loadMaskingManifestFile(repoRoot);
  validateMaskingRunOrders(run, manifest);
  const identity = validateStudyIdentity({
    provider: manifest.evaluation.provider,
    model: manifest.evaluation.model,
    profileSha256: profile.sha256,
  });
  if (!identity.ok) {
    throw new Error(`masking dry-run refused: ${identity.problems.join("; ")}`);
  }
  let executed = 0;
  for (const task of manifest.tasks) {
    for (const rep of run.repetitionOrder[task.id]) {
      for (const arm of run.armOrder[task.id]) {
        const attemptDir = join(runDir, "attempts", task.id, arm, `attempt-${String(rep).padStart(3, "0")}`);
        if (existsSync(join(attemptDir, "result.json"))) {
          continue;
        }
        mkdirSync(attemptDir, { recursive: true });
        const cacheRoot = fixturesCacheRoot(repoRoot);
        let fixtureDir = join(cacheRoot, task.id);
        if (!existsSync(join(fixtureDir, ".git"))) {
          fixtureDir = publishFixtureCache({ repoRoot, task, cacheRoot });
        }
        const worktree = join(attemptDir, "worktree");
        cpSync(fixtureDir, worktree, { recursive: true, dot: true });
        const home = join(attemptDir, "home");
        mkdirSync(join(home, ".config"), { recursive: true });
        writeFileSync(join(home, ".config", "condensed-milk.json"), profile.bytes, "utf8");
        const { assertions, solution } = loadMaskingTaskData(repoRoot, task.id);
        // Deterministic fake observer digests per task marker config so
        // fake pins exercise the exact real observer pin shape.
        if (!fakeObserverDigestCache.has(task.id)) {
          const { generateMaskingObservers, diagnosticMarkersFromAssertions } = await import("./masking-observer.mjs");
          const stagedFake = generateMaskingObservers({
            attemptDir: join(runDir, ".observer-staging-fake", task.id),
            diagnosticMarkers: diagnosticMarkersFromAssertions(assertions),
          });
          fakeObserverDigestCache.set(task.id, {
            observerSha256: stagedFake.observerSha256,
            observerWrapperSha256: stagedFake.observerWrapperSha256,
          });
        }
        applySolution({ worktree, solution, taskId: task.id });
        // Fake correctness comes from the actual hidden scorer over the
        // solved worktree, never from the generator.
        const scorerResult = scoreWorktree({ repoRoot, worktree, taskId: task.id, assertions });
        writeFileSync(join(attemptDir, "scorer.json"), `${JSON.stringify(scorerResult, null, 2)}\n`, "utf8");
        const fixtureBefore = { contentSha256: hashTree(worktree), gitStateSha256: gitStateHash(worktree) };
        writeFileSync(join(attemptDir, "fixture-before.json"), `${JSON.stringify({ taskId: task.id, arm, rep, ...fixtureBefore }, null, 2)}\n`, "utf8");
        const instrumentation = fakeInstrumentationFor({ task, arm, rep });
        instrumentation.correctness = scorerResult.status === "passed" ? true : scorerResult.status === "failed" ? false : null;
        instrumentation.digests.profile = profile.sha256;
        writeFileSync(join(attemptDir, "instrumentation.json"), `${JSON.stringify(instrumentation, null, 2)}\n`, "utf8");
        writeFileSync(
          join(attemptDir, "provider-invocation.json"),
          `${JSON.stringify({ schemaVersion: 1, runId, taskId: task.id, arm, attempt: rep, fake: true, reservedAt: "1970-01-01T00:00:00.000Z" }, null, 2)}\n`,
          "utf8",
        );
        writeFileSync(
          join(attemptDir, "pinned.json"),
          `${JSON.stringify({
            schemaVersion: 1,
            taskId: task.id,
            arm,
            rep,
            promptSha256: sha256Text(buildAttemptPrompt(task.prompt)),
            scorerSha256: maskingScorerSha256(repoRoot, task.id),
            profileSha256: profile.sha256,
            provider: manifest.evaluation.provider,
            model: manifest.evaluation.model,
            thinking: manifest.evaluation.thinking,
            piVersion: manifest.evaluation.piVersion,
            armCommit: arm === "upstream" ? manifest.evaluation.arms[0].commit : manifest.evaluation.arms[1].commit,
            implementationSha256: run.armImplementationSha256[arm],
            fixtureContentSha256: fixtureBefore.contentSha256,
            fixtureGitStateSha256: fixtureBefore.gitStateSha256,
            observerSha256: fakeObserverDigests(repoRoot, task.id).observerSha256,
            observerWrapperSha256: fakeObserverDigests(repoRoot, task.id).observerWrapperSha256,
            study: MASKING_STUDY_NAME,
            piRuntime: null,
          }, null, 2)}\n`,
          "utf8",
        );
        writeFileSync(
          join(attemptDir, "result.json"),
          `${JSON.stringify({
            schemaVersion: 1,
            study: MASKING_STUDY_NAME,
            runId,
            taskId: task.id,
            arm,
            rep,
            status: "completed",
            usage: instrumentation.usage,
            cost: null,
            scorer: {
              status: scorerResult.status,
              passedCount: scorerResult.passedCount,
              totalCount: scorerResult.totalCount,
              error: scorerResult.error,
            },
          }, null, 2)}\n`,
          "utf8",
        );
        executed += 1;
      }
    }
  }
  return { runId, executed };
}

/** Approved public row fields: metrics, ids, and outcomes only. */
const MASKING_ROW_FIELDS = Object.freeze([
  "taskId", "arm", "rep", "status", "correctness",
  "historicalMaskEvents", "semanticTransforms", "recoveryResult",
  "originalBytes", "visibleBytes", "removedBytes", "archivedBytes",
  "estimatedTokensSavedSemantic", "estimatedTokensSavedHistorical",
  "usageInput", "usageOutput", "usageCacheRead", "usageCacheWrite",
  "wallTimeMs", "firstEventLatencyMs",
  "retrievalCalls", "reruns", "rereads", "returnedBytes",
  "diagnosticPresent", "cost", "secretIncidents", "nonTextOrderingIncidents",
]);
const MASKING_ROW_ENUMS = Object.freeze({
  arm: new Set(["upstream", "fork"]),
  status: new Set(["completed", "failed", "timeout", "interrupted", "collection-error"]),
  recoveryResult: new Set(["none", "archive", "rerun", "reread", "missing"]),
});

/**
 * Sanitize one metric row to the approved public shape. Only metric
 * values, ids, and outcomes survive; anything else (paths,
 * transcripts, provider strings, digests) is dropped, never inferred.
 * `null` stays `null`.
 */
export function sanitizeMaskingRow(row) {
  const out = {};
  for (const field of MASKING_ROW_FIELDS) {
    if (!Object.prototype.hasOwnProperty.call(row, field)) continue;
    const value = row[field];
    if (field === "taskId") {
      if (typeof value === "string" && /^masking-task-\d{2}$/.test(value)) out.taskId = value;
      continue;
    }
    if (MASKING_ROW_ENUMS[field]) {
      if (typeof value === "string" && MASKING_ROW_ENUMS[field].has(value)) out[field] = value;
      continue;
    }
    if (field === "diagnosticPresent" || field === "correctness") {
      if (typeof value === "boolean" || value === null) out[field] = value;
      continue;
    }
    if (value === null) {
      out[field] = null;
      continue;
    }
    // Numeric fields accept only finite nonnegative numbers. Anything
    // else (NaN, Infinity, negatives, strings) is dropped, never coerced.
    if (typeof value === "number" && Number.isFinite(value) && value >= 0) {
      out[field] = value;
    }
  }
  return out;
}

function readJsonOrNull(path) {
  if (!existsSync(path)) return null;
  try {
    const parsed = JSON.parse(readFileSync(path, "utf8"));
    return parsed && typeof parsed === "object" && !Array.isArray(parsed) ? parsed : null;
  } catch {
    return null;
  }
}

/** Flat metric row for one attempt (pre-sanitization). */
function metricRowFor({ taskId, arm, rep, result, instrumentation }) {
  return {
    taskId,
    arm,
    rep,
    status: result?.status ?? "unknown",
    correctness: instrumentation?.correctness ?? null,
    historicalMaskEvents: instrumentation?.historicalMaskEvents ?? 0,
    semanticTransforms: instrumentation?.semanticTransforms ?? 0,
    activatedFilterCount: Array.isArray(instrumentation?.activatedFilterIds) ? instrumentation.activatedFilterIds.length : 0,
    activatedFilterIds: Array.isArray(instrumentation?.activatedFilterIds) ? instrumentation.activatedFilterIds : [],
    originalBytes: instrumentation?.originalBytes ?? null,
    visibleBytes: instrumentation?.visibleBytes ?? null,
    removedBytes: instrumentation?.removedBytes ?? null,
    archivedBytes: instrumentation?.archivedBytes ?? null,
    estimatedTokensSavedSemantic: instrumentation?.estimatedTokensSavedSemantic ?? null,
    estimatedTokensSavedHistorical: instrumentation?.estimatedTokensSavedHistorical ?? null,
    archiveReferences: instrumentation?.archiveReferences ?? 0,
    retrievalCalls: instrumentation?.retrievalCalls ?? 0,
    returnedBytes: instrumentation?.returnedBytes ?? 0,
    reruns: instrumentation?.reruns ?? 0,
    rereads: instrumentation?.rereads ?? 0,
    usageInput: instrumentation?.usage?.input ?? null,
    usageOutput: instrumentation?.usage?.output ?? null,
    usageCacheRead: instrumentation?.usage?.cacheRead ?? null,
    usageCacheWrite: instrumentation?.usage?.cacheWrite ?? null,
    cost: instrumentation?.cost ?? null,
    wallTimeMs: instrumentation?.wallTimeMs ?? null,
    firstEventLatencyMs: instrumentation?.firstEventLatencyMs ?? null,
    recoveryResult: instrumentation?.recoveryResult ?? "none",
    diagnosticPresent: instrumentation?.diagnosticPresent ?? false,
    secretIncidents: instrumentation?.secretIncidents ?? null,
    nonTextOrderingIncidents: instrumentation?.nonTextOrderingIncidents ?? null,
  };
}

const MASKING_PIN_FIELDS = Object.freeze([
  "profileSha256", "promptSha256", "scorerSha256", "provider", "model",
  "fixtureContentSha256", "fixtureGitStateSha256",
  "observerSha256", "observerWrapperSha256", "study", "thinking", "piVersion",
]);
const PAIRED_METRICS = Object.freeze([
  "estimatedTokensSavedSemantic",
  "estimatedTokensSavedHistorical",
  "usageInput",
  "usageOutput",
  "wallTimeMs",
  "firstEventLatencyMs",
  "retrievalCalls",
  "reruns",
  "rereads",
]);

/** Shared receipt validation for one real-mode arm. */
function realReceiptValidity({ runDir, runId, attempt, taskId, arm, rep, manifest }) {
  const receiptLib = nodeRequire("./receipt.mjs");
  return receiptLib.validateSelectedAttemptReceipt({
    runDir,
    attemptDir: attempt.dir,
    runId,
    taskId,
    arm,
    attempt: rep,
    manifest,
    expected: {
      study: MASKING_STUDY_NAME,
      profileSha256: attempt.pinned.profileSha256,
      fixtureContentSha256: attempt.pinned.fixtureContentSha256,
      fixtureGitStateSha256: attempt.pinned.fixtureGitStateSha256,
      implementationSha256: attempt.pinned.implementationSha256,
      observerSha256: attempt.pinned.observerSha256,
      observerWrapperSha256: attempt.pinned.observerWrapperSha256,
    },
  });
}

let nodeRequireCache = null;
function nodeRequire(path) {
  if (nodeRequireCache === null) {
    nodeRequireCache = createRequire(import.meta.url);
  }
  return nodeRequireCache(path);
}

function difference(forkValue, upstreamValue) {
  return typeof forkValue === "number" && typeof upstreamValue === "number" ? forkValue - upstreamValue : null;
}

function sha256Bytes(buffer) {
  return createHash("sha256").update(buffer).digest("hex");
}

/**
 * Repetition-group validity: a (task, rep) pair is valid only when both
 * arms exist, completed, hold a fake receipt, and match on task,
 * scorer, fixture, provider, model, profile, runtime, and arm commit
 * pins. Any difference or missing record invalidates the pair; invalid
 * pairs never feed metrics.
 */
function pairValidity({ runDir, runId, taskId, rep, manifest, run, expectedObservers = null, repoRoot = null }) {
  const chosen = {};
  for (const arm of MASKING_ARMS) {
    const dir = join(runDir, "attempts", taskId, arm, `attempt-${String(rep).padStart(3, "0")}`);
    const result = readJsonOrNull(join(dir, "result.json"));
    const instrumentation = readJsonOrNull(join(dir, "instrumentation.json"));
    const pinned = readJsonOrNull(join(dir, "pinned.json"));
    const fixtureBefore = readJsonOrNull(join(dir, "fixture-before.json"));
    if (!result || !instrumentation || !pinned || !fixtureBefore) return { kind: "incomplete" };
    chosen[arm] = { dir, result, instrumentation, pinned, fixtureBefore };
  }
  for (const arm of MASKING_ARMS) {
    if (chosen[arm].result.status !== "completed") return { kind: "invalid", chosen };
    const receipt = readJsonOrNull(join(chosen[arm].dir, "provider-invocation.json"));
    if (!receipt) return { kind: "invalid", chosen };
    if (run?.mode === "real") {
      // Real runs validate each arm receipt through the shared receipt
      // validator with the study identity fields.
      const check = realReceiptValidity({ runDir, runId, attempt: chosen[arm], taskId, arm, rep, manifest });
      if (!check.ok) {
        appendJournal(runDir, { type: "pair-receipt-refused", taskId, arm, attempt: rep, reason: check.reason, study: MASKING_STUDY_NAME });
        return { kind: "invalid", chosen };
      }
    } else {
      // Dry runs accept only fake receipts.
      if (receipt.fake !== true) return { kind: "invalid", chosen };
    }
    // Each arm must match its own manifest commit; the arms never match
    // each other on armCommit by design (upstream pin vs fork pin).
    const manifestCommit = manifest.evaluation.arms.find((entry) => entry.name === arm)?.commit ?? null;
    if (chosen[arm].pinned.armCommit !== manifestCommit) return { kind: "invalid", chosen };
    // Scorer pins authenticate against the current masking scorer
    // bytes, not merely against the other arm.
    const expectedScorer = repoRoot ? maskingScorerSha256(repoRoot, taskId) : null;
    if (expectedScorer !== null && chosen[arm].pinned.scorerSha256 !== expectedScorer) {
      return { kind: "invalid", chosen };
    }
    // Profile authenticates against the run pin.
    if (chosen[arm].pinned.profileSha256 !== run?.profileSha256) return { kind: "invalid", chosen };
    // Manifest-constant identity pins.
    const expectedTask = manifest.tasks.find((entry) => entry.id === taskId) ?? null;
    if (!expectedTask) return { kind: "invalid", chosen };
    if (chosen[arm].pinned.provider !== manifest.evaluation.provider) return { kind: "invalid", chosen };
    if (chosen[arm].pinned.model !== manifest.evaluation.model) return { kind: "invalid", chosen };
    if (chosen[arm].pinned.thinking !== manifest.evaluation.thinking) return { kind: "invalid", chosen };
    if (chosen[arm].pinned.piVersion !== manifest.evaluation.piVersion) return { kind: "invalid", chosen };
    if (chosen[arm].pinned.study !== MASKING_STUDY_NAME) return { kind: "invalid", chosen };
    // Prompt authenticates against the combined prompt bytes.
    if (chosen[arm].pinned.promptSha256 !== sha256Text(buildAttemptPrompt(expectedTask.prompt))) {
      return { kind: "invalid", chosen };
    }
    // Fixture digests authenticate against this attempt's fixture-before.json.
    const before = chosen[arm].fixtureBefore;
    if (
      chosen[arm].pinned.fixtureContentSha256 !== before?.contentSha256 ||
      chosen[arm].pinned.fixtureGitStateSha256 !== before?.gitStateSha256
    ) {
      return { kind: "invalid", chosen };
    }
    if (chosen[arm].pinned.taskId !== taskId) return { kind: "invalid", chosen };
    if (chosen[arm].pinned.rep !== rep) return { kind: "invalid", chosen };
    // Each arm pins its own implementation digest against the run's
    // persisted arm digest. Arms are never compared to each other.
    const runArmDigest = run?.armImplementationSha256?.[arm];
    if (typeof runArmDigest !== "string" || !/^[0-9a-f]{64}$/.test(runArmDigest)) {
      return { kind: "invalid", chosen };
    }
    if (chosen[arm].pinned.implementationSha256 !== runArmDigest) {
      return { kind: "invalid", chosen };
    }
    // Observer digests must match the bytes regenerated from the
    // task's diagnostic marker configuration.
    if (
      expectedObservers &&
      (chosen[arm].pinned.observerSha256 !== expectedObservers.observerSha256 ||
        chosen[arm].pinned.observerWrapperSha256 !== expectedObservers.observerWrapperSha256)
    ) {
      return { kind: "invalid", chosen };
    }
  }
  // Runtime digests compare by value (both null, or equal 64-hex
  // digests), never by object identity.
  const runtimeDigest = (pin) =>
    pin?.piRuntime === null || pin?.piRuntime === undefined
      ? null
      : typeof pin?.piRuntime?.digest === "string" && /^[0-9a-f]{64}$/.test(pin.piRuntime.digest)
        ? pin.piRuntime.digest
        : "malformed";
  if (runtimeDigest(chosen.upstream.pinned) !== runtimeDigest(chosen.fork.pinned)) {
    return { kind: "invalid", chosen };
  }
  for (const field of MASKING_PIN_FIELDS) {
    if (chosen.upstream.pinned[field] !== chosen.fork.pinned[field]) return { kind: "invalid", chosen };
  }
  return { kind: "valid", chosen };
}

/**
 * Build the masking study report: gate evaluation over every attempt,
 * sanitized public rows, per-task and aggregate paired differences with
 * deterministic confidence intervals, and a public artifact index. A
 * failing gate makes the whole report non-passing.
 */
export function maskingReport({ repoRoot, runsDir, runId }) {
  requireSafeRunId("masking report", runId);
  const { manifest, profile } = loadMaskingManifestFile(repoRoot);
  const runDir = join(runsDir, runId);
  const run = loadMaskingRun(runDir, runId);
  validateMaskingRunOrders(run, manifest);
  // Fail early when the study inputs moved under the run: the current
  // manifest bytes and profile bytes must match the run's pins.
  const currentManifestSha256 = createHash("sha256")
    .update(readFileSync(join(repoRoot, "evaluation", "masking-task-manifest.json")))
    .digest("hex");
  if (run.manifestSha256 !== currentManifestSha256) {
    throw new Error(
      `masking report refused: current masking manifest digest ${currentManifestSha256} differs from the run pin ${run.manifestSha256}`,
    );
  }
  if (run.profileSha256 !== profile.sha256) {
    throw new Error(
      `masking report refused: current profile digest ${profile.sha256} differs from the run pin ${run.profileSha256}`,
    );
  }
  const rows = [];
  const taskReports = [];
  const aggregateDiffs = Object.fromEntries(PAIRED_METRICS.map((metric) => [metric, []]));
  let pairsValid = 0;
  let pairsInvalid = 0;
  let pairsIncomplete = 0;
  for (const task of manifest.tasks) {
    // Regenerate the expected observer bytes from this task's marker
    // configuration; pairs must pin exactly these digests.
    const { assertions: taskAssertions } = loadMaskingTaskData(repoRoot, task.id);
    const expectedObservers = expectedObserverDigestsFor(repoRoot, runDir, task.id, taskAssertions);
    for (const arm of MASKING_ARMS) {
      for (const rep of run.repetitionOrder[task.id]) {
        const dir = join(runDir, "attempts", task.id, arm, `attempt-${String(rep).padStart(3, "0")}`);
        rows.push(metricRowFor({
          taskId: task.id,
          arm,
          rep,
          result: readJsonOrNull(join(dir, "result.json")),
          instrumentation: readJsonOrNull(join(dir, "instrumentation.json")),
        }));
      }
    }
    const diffs = Object.fromEntries(PAIRED_METRICS.map((metric) => [metric, []]));
    for (const rep of run.repetitionOrder[task.id]) {
      const pair = pairValidity({ runDir, runId, taskId: task.id, rep, manifest, run, expectedObservers, repoRoot });
      if (pair.kind === "incomplete") {
        pairsIncomplete += 1;
        continue;
      }
      if (pair.kind === "invalid") {
        pairsInvalid += 1;
        continue;
      }
      pairsValid += 1;
      for (const metric of PAIRED_METRICS) {
        const delta = difference(
          metricRowFor({ taskId: task.id, arm: "fork", rep, result: pair.chosen.fork.result, instrumentation: pair.chosen.fork.instrumentation })[metric],
          metricRowFor({ taskId: task.id, arm: "upstream", rep, result: pair.chosen.upstream.result, instrumentation: pair.chosen.upstream.instrumentation })[metric],
        );
        if (delta !== null) {
          diffs[metric].push(delta);
          aggregateDiffs[metric].push(delta);
        }
      }
    }
    const intervals = {};
    for (const metric of PAIRED_METRICS) {
      intervals[metric] = {
        pairedBootstrap: pairedBootstrapInterval(diffs[metric], 0.95, { iterations: 2000, seed: `masking:${task.id}` }),
        pairedT: pairedTInterval(diffs[metric], 0.95),
        n: diffs[metric].length,
      };
    }
    taskReports.push({ taskId: task.id, requiresArchiveRecovery: task.masking.requiresArchiveRecovery, intervals });
  }
  const aggregate = {};
  for (const metric of PAIRED_METRICS) {
    aggregate[metric] = {
      ...pairedBootstrapInterval(aggregateDiffs[metric], 0.95, { iterations: 2000, seed: `masking:${runId}` }),
      pairedT: pairedTInterval(aggregateDiffs[metric], 0.95),
    };
  }
  const forkRows = rows.filter((row) => row.arm === "fork");
  const expectedPairs = manifest.tasks.length * manifest.evaluation.repetitionsPerTask;
  const pairsComplete = pairsValid === expectedPairs && pairsInvalid === 0 && pairsIncomplete === 0;
  const gates = {
    pairs: {
      pass: pairsComplete,
      detail: `exactly ${expectedPairs} valid pairs with zero invalid and zero incomplete; gates use valid pairs only`,
    },
    activation: {
      pass: rows.every((row) => row.historicalMaskEvents >= 1),
      detail: "every attempt in both arms activates historical context masking; semantic filter activation remains descriptive",
    },
    correctness: {
      pass: manifest.tasks.every((task) => {
        const relevant = rows.filter((row) => row.taskId === task.id);
        if (relevant.some((row) => row.correctness === null)) return false;
        const forkScore = relevant.filter((row) => row.arm === "fork" && row.correctness === true).length;
        const upstreamScore = relevant.filter((row) => row.arm === "upstream" && row.correctness === true).length;
        return forkScore >= upstreamScore;
      }),
      detail: "fork correctness is at least upstream correctness for every task; null correctness fails",
    },
    diagnostics: {
      pass: manifest.tasks
        .filter((task) => task.masking.requiresArchiveRecovery)
        .every((task) => rows.filter((row) => row.taskId === task.id).every((row) => row.diagnosticPresent === true)),
      detail: "no required diagnostic is missing",
    },
    recoverability: {
      pass: manifest.tasks
        .filter((task) => task.masking.requiresArchiveRecovery)
        .every((task) =>
          rows
            .filter((row) => row.taskId === task.id && row.arm === "fork")
            .every((row) =>
              row.archivedBytes > 0 && row.archiveReferences > 0 && row.retrievalCalls > 0 &&
              row.returnedBytes > 0 && row.recoveryResult === "archive",
            ),
        ),
      detail: "every required fork recovery attempt shows archived bytes, archive references, a retrieval call, returned bytes, and recoveryResult archive",
    },
    secrets: { pass: rows.every((row) => row.secretIncidents === 0), detail: "no configured privacy sentinel incident; a missing sentinel field stays null and fails" },
    ordering: { pass: rows.every((row) => row.nonTextOrderingIncidents === 0), detail: "no non-text ordering incident; a missing ordering field stays null and fails" },
  };
  gates.correctness.pass = gates.correctness.pass && pairsComplete;
  gates.diagnostics.pass = gates.diagnostics.pass && pairsComplete;
  gates.recoverability.pass = gates.recoverability.pass && pairsComplete;
  const passing = Object.values(gates).every((gate) => gate.pass);
  const sanitizedRows = rows.map((row) => sanitizeMaskingRow(row));
  const summary = {
    schemaVersion: 1,
    study: MASKING_STUDY_NAME,
    runId,
    mode: run.mode,
    passing,
    rows: rows.length,
    pairs: { valid: pairsValid, invalid: pairsInvalid, incomplete: pairsIncomplete },
    gates,
    intervalMethod: "paired-bootstrap-percentile (deterministic, seeded) with paired-t alternative",
  };
  writeFileSync(join(runDir, "masking-summary.json"), `${JSON.stringify(summary, null, 2)}\n`, "utf8");
  writeFileSync(join(runDir, "masking-rows.json"), `${JSON.stringify(sanitizedRows, null, 2)}\n`, "utf8");
  writeFileSync(join(runDir, "masking-pairs.json"), `${JSON.stringify({ schemaVersion: 1, runId, metrics: PAIRED_METRICS, tasks: taskReports, aggregate }, null, 2)}\n`, "utf8");
  const markdown = [
    `# Masking study run ${runId}`,
    "",
    `- Mode: ${run.mode}`,
    `- passing: ${passing}`,
    `- Rows: ${rows.length}`,
    `- Pairs (valid / invalid / incomplete): ${pairsValid} / ${pairsInvalid} / ${pairsIncomplete}`,
    "",
    "| gate | pass | detail |",
    "| --- | --- | --- |",
    ...Object.entries(gates).map(([name, gate]) => `| ${name} | ${gate.pass} | ${gate.detail} |`),
    "",
    "| taskId | requiresArchiveRecovery | n |",
    "| --- | --- | --- |",
    ...taskReports.map((report) => `| ${report.taskId} | ${report.requiresArchiveRecovery} | ${report.intervals.estimatedTokensSavedHistorical.n} |`),
  ].join("\n");
  writeFileSync(join(runDir, "masking-summary.md"), `${markdown}\n`, "utf8");
  const artifacts = ["masking-summary.json", "masking-rows.json", "masking-pairs.json", "masking-summary.md"]
    .map((file) => {
      const path = join(runDir, file);
      if (!existsSync(path)) return null;
      const body = readFileSync(path);
      return { file, bytes: body.length, sha256: sha256Bytes(body) };
    })
    .filter(Boolean);
  writeFileSync(join(runDir, "artifact-index.json"), `${JSON.stringify({ schemaVersion: 1, runId, artifacts }, null, 2)}\n`, "utf8");
  return { passing, gates, rows: rows.length, pairs: summary.pairs };
}

/**
 * Read-only masking plan: validates the study identity and prints the
 * persisted execution plan (tasks, arms, repetitions, commits, profile
 * digest). No lock, no attempts, no credentials.
 */
export function maskingPlanRun({ repoRoot, runsDir, runId }) {
  requireSafeRunId("masking plan", runId);
  const runDir = join(runsDir, runId);
  const run = loadMaskingRun(runDir, runId);
  const { manifest, profile } = loadMaskingManifestFile(repoRoot);
  validateMaskingRunOrders(run, manifest);
  const identity = validateStudyIdentity({
    provider: manifest.evaluation.provider,
    model: manifest.evaluation.model,
    profileSha256: profile.sha256,
  });
  if (!identity.ok) {
    throw new Error(`masking plan refused: ${identity.problems.join("; ")}`);
  }
  return {
    schemaVersion: 1,
    runId,
    mode: run.mode,
    planOnly: true,
    provider: manifest.evaluation.provider,
    model: manifest.evaluation.model,
    profileSha256: profile.sha256,
    repetitionsPerTask: manifest.evaluation.repetitionsPerTask,
    armCommits: Object.fromEntries(manifest.evaluation.arms.map((arm) => [arm.name, arm.commit])),
    tasks: manifest.tasks.map((task) => ({
      taskId: task.id,
      kind: task.masking.kind,
      threshold: task.masking.threshold,
      requiresArchiveRecovery: task.masking.requiresArchiveRecovery,
      armOrder: run.armOrder[task.id],
      repetitionOrder: run.repetitionOrder[task.id],
    })),
  };
}

/**
 * Paid masking execution through the shared real-run controls: lock
 * acquired by the CLI, full preflight (paid flags, timeout, credential,
 * arm worktrees, runtime, runtime pin, node engine, observer ordering),
 * then sequential immutable reservations with paid receipts and
 * observers. A stopped run reports its reason; a crash between
 * reservation and completion leaves an abandoned slot for masking-abandon
 * and a new run id. No real retry exists.
 */
export async function maskingRealRun({ repoRoot, runsDir, runId, flags = {} }) {
  requireSafeRunId("masking real run", runId);
  const runDir = join(runsDir, runId);
  const run = loadMaskingRun(runDir, runId);
  if (run.mode !== "real") {
    throw new Error(`masking real run refused: run ${runId} has mode ${run.mode}; prepare with mode real`);
  }
  if (run.invalid === true) {
    throw new Error(`masking real run refused: run ${runId} is invalid after an abandoned slot; prepare a new run id`);
  }
  const { manifest, profile } = loadMaskingManifestFile(repoRoot);
  validateMaskingRunOrders(run, manifest);
  const currentManifestSha256 = createHash("sha256")
    .update(readFileSync(join(repoRoot, "evaluation", "masking-task-manifest.json")))
    .digest("hex");
  if (run.manifestSha256 !== currentManifestSha256) {
    throw new Error("masking real run refused: current manifest bytes differ from the prepared run pin");
  }
  if (run.profileSha256 !== profile.sha256) {
    throw new Error("masking real run refused: current profile bytes differ from the prepared run pin");
  }
  const preflight = await runPaidPreflightForMasking({ repoRoot, runDir, flags });
  if (!preflight.ok) {
    throw new Error(`masking real run preflight refused: ${preflight.error}`);
  }
  return executeMaskingSlots({ repoRoot, runId, runDir, run, preflight });
}

async function runPaidPreflightForMasking({ repoRoot, runDir, flags }) {
  const { manifest } = loadMaskingManifestFile(repoRoot);
  const { runPaidPreflight } = await import("./real.mjs");
  const { observerOrderingVerifier } = await import("./masking-observer.mjs");
  return runPaidPreflight({
    flags,
    manifest,
    repoRoot,
    runDir,
    implementationPolicy: "masking-safe",
    verifyObserverOrdering: observerOrderingVerifier(),
  });
}

/**
 * Atomically persist per-arm implementation digests in run.json after
 * preflight and before any reservation. Existing values must match
 * exactly on resume. Missing or malformed digests refuse.
 */
function persistArmImplementationSha256({ runDir, armInfos }) {
  const runPath = join(runDir, "run.json");
  const run = JSON.parse(readFileSync(runPath, "utf8"));
  const digests = {};
  for (const arm of MASKING_ARMS) {
    const digest = armInfos?.[arm]?.implementationSha256 ?? null;
    if (typeof digest !== "string" || !/^[0-9a-f]{64}$/.test(digest)) {
      throw new Error(`arm ${arm} implementation digest is missing or malformed; refusing before reservation`);
    }
    digests[arm] = digest;
  }
  const existing = run.armImplementationSha256 ?? null;
  const hasExisting = existing !== null && existing.upstream !== undefined && existing.fork !== undefined;
  if (hasExisting && (existing.upstream !== digests.upstream || existing.fork !== digests.fork)) {
    throw new Error("run.json arm implementation digests changed since the first reservation; refusing resume");
  }
  if (!hasExisting) {
    const tempPath = `${runPath}.tmp`;
    writeFileSync(tempPath, `${JSON.stringify({ ...run, armImplementationSha256: digests }, null, 2)}\n`, "utf8");
    renameSync(tempPath, runPath);
  }
  return digests;
}

/**
 * Sequential slot execution: manifest task order, persisted repetition
 * order, then persisted arm order. Repetition maps directly to the
 * attempt number. Terminal or reserved slots skip without invocation.
 */
async function executeMaskingSlots({ repoRoot, runId, runDir, run, preflight }) {
  const { manifest, profile } = loadMaskingManifestFile(repoRoot);
  const { executeRealAttempt } = await import("./real-attempt.mjs");
  const { reserveAttemptPrimitive } = await import("./cli.mjs");
  const {
    generateMaskingObservers,
    maskingObserverStudyObservers,
    diagnosticMarkersFromAssertions,
  } = await import("./masking-observer.mjs");
  const { timeoutMs, credentialSourcePath, armInfos, pi } = preflight;
  // After preflight and strictly before any reservation: persist each
  // arm's implementation digest in run.json. A resume requires the
  // exact same digests; a missing or malformed digest refuses.
  const armImplementationSha256 = persistArmImplementationSha256({ runDir, armInfos });
  run = { ...run, armImplementationSha256 };
  const cacheRoot = fixturesCacheRoot(repoRoot);
  let executed = 0;
  let stoppedReason = null;
  outer: for (const task of manifest.tasks) {
    for (const rep of run.repetitionOrder[task.id]) {
      for (const arm of run.armOrder[task.id]) {
        const attemptDir = join(runDir, "attempts", task.id, arm, `attempt-${String(rep).padStart(3, "0")}`);
        if (existsSync(join(attemptDir, "result.json"))) continue;
        if (existsSync(join(attemptDir, "provider-invocation.json"))) {
          // A receipt without a terminal result is an abandoned paid
          // slot. Stop immediately; never silently skip it and never
          // re-invoke or allocate an alternate attempt number.
          stoppedReason = `abandoned reserved slot ${task.id}/${arm}/${rep} has a receipt without a terminal result; use masking-abandon and a new run id`;
          break outer;
        }
        let fixtureDir = join(cacheRoot, task.id);
        if (!existsSync(join(fixtureDir, ".git"))) {
          fixtureDir = publishFixtureCache({ repoRoot, task, cacheRoot });
        }
        const fixtureIdentity = { contentSha256: hashTree(fixtureDir), gitStateSha256: gitStateHash(fixtureDir) };
        const { assertions } = loadMaskingTaskData(repoRoot, task.id);
        const markers = diagnosticMarkersFromAssertions(assertions);
        const staging = join(runDir, ".observer-staging", task.id, arm, String(rep));
        const staged = generateMaskingObservers({ attemptDir: staging, diagnosticMarkers: markers });
        const observerSha256 = staged.observerSha256;
        const observerWrapperSha256 = staged.observerWrapperSha256;
        const armCommitEntry = manifest.evaluation.arms.find((entry) => entry.name === arm);
        const pins = {
          taskId: task.id,
          rep,
          promptSha256: sha256Text(buildAttemptPrompt(task.prompt)),
          scorerSha256: maskingScorerSha256(repoRoot, task.id),
          profileSha256: profile.sha256,
          provider: manifest.evaluation.provider,
          model: manifest.evaluation.model,
          thinking: manifest.evaluation.thinking,
          piVersion: manifest.evaluation.piVersion,
          armCommit: armCommitEntry.commit,
          implementationSha256: armInfos[arm]?.implementationSha256 ?? null,
          fixtureContentSha256: fixtureIdentity.contentSha256,
          fixtureGitStateSha256: fixtureIdentity.gitStateSha256,
          observerSha256,
          observerWrapperSha256,
          study: MASKING_STUDY_NAME,
        };
        const claim = reserveAttemptPrimitive({
          runDir,
          runId,
          taskId: task.id,
          arm,
          attempt: rep,
          fixtureDir,
          fixtureIdentity,
          pins,
          paidIdentity: {
            fake: false,
            provider: manifest.evaluation.provider,
            model: manifest.evaluation.model,
            armCommit: armCommitEntry.commit,
            implementationSha256: armInfos[arm]?.implementationSha256 ?? null,
            piRuntime: pi.runtimeManifest,
            study: MASKING_STUDY_NAME,
            profileSha256: profile.sha256,
            fixtureContentSha256: fixtureIdentity.contentSha256,
            fixtureGitStateSha256: fixtureIdentity.gitStateSha256,
            observerSha256,
            observerWrapperSha256,
          },
        });
        if (!claim.claimed) continue;
        const study = {
          profileBytes: profile.bytes,
          profileSha256: profile.sha256,
          scorerSha256: pins.scorerSha256,
          extraPins: { study: MASKING_STUDY_NAME, profileSha256: profile.sha256, observerSha256 },
          observers: maskingObserverStudyObservers({ diagnosticMarkers: markers }),
          scoreWorktree: ({ repoRoot: root, worktree, taskId }) =>
            scoreWorktree({ repoRoot: root, worktree, taskId, assertions }),
        };
        let outcome;
        try {
          outcome = await executeRealAttempt({
            repoRoot,
            manifest,
            task,
            arm,
            armInfo: armInfos[arm],
            attemptDir: claim.attemptDir,
            fixtureDir,
            credentialSourcePath,
            piCliPath: pi.cliPath,
            timeoutMs,
            identity: { runId, attempt: rep, study: MASKING_STUDY_NAME },
            study,
          });
        } catch (error) {
          if (!existsSync(join(claim.attemptDir, "result.json"))) {
            writeFileSync(
              join(claim.attemptDir, "result.json"),
              `${JSON.stringify({
                schemaVersion: 1,
                study: MASKING_STUDY_NAME,
                runId,
                taskId: task.id,
                arm,
                rep,
                status: "infrastructure-error",
                failures: [String(error.message)],
              }, null, 2)}\n`,
              "utf8",
            );
          }
          appendJournal(runDir, { type: "attempt-finished", taskId: task.id, arm, attempt: rep, status: "infrastructure-error", study: MASKING_STUDY_NAME });
          stoppedReason = `infrastructure or observer error on ${task.id}/${arm}/${rep}: ${error.message}`;
          break outer;
        }
        mergeAuthoritativeInstrumentation({
          attemptDir: claim.attemptDir,
          task,
          arm,
          rep,
          outcome,
          pins: { ...pins, observerWrapperSha256 },
          runtimeDigest: pi.runtimeManifest?.digest ?? null,
        });
        appendJournal(runDir, { type: "attempt-finished", taskId: task.id, arm, attempt: rep, status: outcome.status, study: MASKING_STUDY_NAME });
        executed += 1;
        const stopStatuses = new Set(["collection-error", "timeout", "interrupted"]);
        if (stopStatuses.has(outcome.status) || outcome.scorer?.error) {
          stoppedReason = `stop after ${task.id}/${arm}/${rep}: status ${outcome.status}${outcome.scorer?.error ? ` scorer error: ${outcome.scorer.error}` : ""}`;
          break outer;
        }
      }
    }
  }
  return { runId, executed, stoppedReason };
}

/** Merge authoritative execution fields into instrumentation.json. */
function mergeAuthoritativeInstrumentation({ attemptDir, task, arm, rep, outcome, pins, runtimeDigest }) {
  const instrumentationPath = join(attemptDir, "instrumentation.json");
  let instrumentation = {};
  if (existsSync(instrumentationPath)) {
    try {
      instrumentation = JSON.parse(readFileSync(instrumentationPath, "utf8"));
    } catch (error) {
      throw new Error(`instrumentation parse failure stops later slots: ${error.message}`);
    }
  }
  // Missing observer fields are fatal: never default them to zero.
  if (
    instrumentation.semanticTransforms === undefined ||
    instrumentation.historicalMaskEvents === undefined ||
    instrumentation.originalBytes === undefined ||
    instrumentation.visibleBytes === undefined
  ) {
    throw new Error("observer instrumentation is missing required metric fields; refusing to default them");
  }
  const scorerStatus = outcome.scorer?.status;
  // Filters activate only when the observer confirmed semantic
  // transforms in this attempt, regardless of arm.
  const activatedFilterIds = instrumentation.semanticTransforms > 0 ? [...task.masking.filterIds] : [];
  const merged = {
    ...instrumentation,
    taskId: task.id,
    arm,
    repetition: rep,
    activatedFilterIds,
    usage: {
      input: outcome.usage?.input ?? null,
      output: outcome.usage?.output ?? null,
      cacheRead: outcome.usage?.cacheRead ?? null,
      cacheWrite: outcome.usage?.cacheWrite ?? null,
    },
    providerCost: null,
    wallTimeMs: outcome.durationMs ?? null,
    firstEventLatencyMs: outcome.firstEventLatencyMs ?? null,
    correctness: scorerStatus === "passed" ? true : scorerStatus === "failed" ? false : null,
    status: outcome.status,
    digests: {
      profile: pins?.profileSha256 ?? null,
      observer: pins?.observerSha256 ?? null,
      observerWrapper: pins?.observerWrapperSha256 ?? null,
      runtime: runtimeDigest ?? null,
    },
  };
  writeFileSync(instrumentationPath, `${JSON.stringify(merged, null, 2)}\n`, "utf8");
}
