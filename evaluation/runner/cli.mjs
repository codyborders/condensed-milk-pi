#!/usr/bin/env node
/**
 * Evaluation runner CLI — public boundary.
 *
 * Commands grow test-first. Current stage: validate.
 * All subprocesses use argv arrays; no shell is ever invoked.
 */

import { fileURLToPath, pathToFileURL } from "node:url";
import { dirname, join } from "node:path";
import { homedir } from "node:os";
import {
  closeSync,
  cpSync,
  existsSync,
  fsyncSync,
  mkdirSync,
  openSync,
  readdirSync,
  readFileSync,
  renameSync,
  rmSync,
  writeFileSync,
  writeSync,
} from "node:fs";
import { loadManifestFile, loadTaskData } from "../lib/manifest.mjs";
import { fixturesCacheRoot, publishFixtureCache, verifyFixtureCacheEntry } from "../lib/cache.mjs";
import { createRun, loadRun, loadState, appendJournal, writeSnapshot, claimAttemptSlot } from "./state.mjs";
import { applySolution, hashTree, gitStateHash } from "../lib/fixtures.mjs";
import { scoreWorktree, scorerDefinitionSha256 } from "../lib/scorer.mjs";
import { collectFinalState } from "./collect.mjs";
import { buildAttemptPrompt, sha256Text } from "./prompt.mjs";
import { buildAggregateReports } from "./report.mjs";
import { validateSelectedAttemptReceipt, runtimePinDigest } from "./receipt.mjs";
import { loadMaskingManifestFile, loadMaskingTaskData, validateMaskingRunId } from "../lib/masking-manifest.mjs";
import { maskingPrepare, maskingPlanRun, maskingDryRun, maskingRealRun, maskingReport } from "./masking.mjs";
import { fixturesCacheRoot as maskingFixturesCacheRoot, publishFixtureCache as publishMaskingFixtureCache, verifyFixtureCacheEntry as verifyMaskingFixtureCache } from "../lib/cache.mjs";

export const CLI_USAGE = `usage: cli.mjs <command> [flags]
  validate                          Validate the strict manifest and hidden task data
  prepare [--run-id X] [--mode real]  Create a run and persist arm order
  fixtures                          Regenerate the deterministic fixture cache
  run --run-id X --task <id>|--all [--arm A] --confirm-paid
                                    [--credential-source PATH] [--cache-dir DIR]
                                    [--pi-runtime DIR] [--timeout-ms N]
                                    [--crash-after first|pi-exit]
                                    Execute persisted arms with the real provider
  dry-run --task <id>|--all [--arm A] [--fault F] [--crash-after first]
                                    Execute free fake-Pi attempts (faults: timeout,
                                    nonzero, malformed, missing-usage, interrupted,
                                    scorer-failure)
  resume --run-id X                 Resume an interrupted dry-run without respawning
  retry --run-id X --task T --arm A --allow-new-paid-attempt [--reason R]
                                    Explicitly create the next immutable
                                    attempt. Dry-run runs only: real-run
                                    retries are unsupported and need a new
                                    explicit real-run implementation
  select --run-id X --task T --arm A --attempt N
                                    Validate a terminal attempt and make it the
                                    slot's selected attempt
  report --run-id X|--latest        Write aggregate JSON/Markdown/CSV reports
  masking-validate                  Validate the masking study manifest and profile
  masking-fixtures                  Regenerate the masking study fixture cache
  masking-prepare [--run-id X] [--mode real]
                                    Create a masking run and persist randomized
                                    arm order plus repetition order
  masking-plan --run-id X           Read-only masking plan (no attempts)
  masking-dry-run --run-id X        Execute free deterministic fake masking
                                    attempts (8 tasks x 2 arms x 3 reps)
  masking-run --run-id X --confirm-paid [--credential-source PATH]
                                    [--cache-dir DIR] [--pi-runtime DIR]
                                    [--recover-lock]
                                    Paid masking execution through the shared
                                    real-run controls (lock, preflight,
                                    immutable reservations, observers)
  masking-abandon --run-id X --task T --arm A --attempt N --reason R
                                    Mark one stranded slot and invalidate run
  masking-report --run-id X|--latest
                                    Write masking gate report, sanitized rows,
                                    paired intervals, artifact index`;

const repoRoot = join(dirname(fileURLToPath(import.meta.url)), "..", "..");

export async function cliMain(argv) {
  const command = argv[0];
  const flags = parseFlags(argv.filter((_, index) => index > 0));
  if (command === "validate") {
    return cmdValidate();
  }
  if (command === "prepare") {
    return cmdPrepare(flags);
  }
  if (command === "run") {
    return await cmdRun(flags);
  }
  if (command === "dry-run") {
    return await cmdDryRun(flags);
  }
  if (command === "resume") {
    return await cmdResume(flags);
  }
  if (command === "retry") {
    return await cmdRetry(flags);
  }
  if (command === "select") {
    return await cmdSelect(flags);
  }
  if (command === "report") {
    return cmdReport(flags);
  }
  if (command === "masking-validate") {
    return cmdMaskingValidate();
  }
  if (command === "masking-fixtures") {
    return cmdMaskingFixtures();
  }
  if (command === "masking-prepare") {
    return cmdMaskingPrepare(flags);
  }
  if (command === "masking-plan") {
    return cmdMaskingPlan(flags);
  }
  if (command === "masking-dry-run") {
    return await cmdMaskingDryRun(flags);
  }
  if (command === "masking-run") {
    return await cmdMaskingRun(flags);
  }
  if (command === "masking-abandon") {
    return await cmdMaskingAbandon(flags);
  }
  if (command === "masking-report") {
    return cmdMaskingReport(flags);
  }
  if (command === "fixtures") {
    return cmdFixtures();
  }
  process.stderr.write(`cli: unknown or missing command\n${CLI_USAGE}\n`);
  return 2;
}

function parseFlags(tail) {
  const flags = {};
  const valueFlags = new Set([
    "--runs-dir", "--run-id", "--task", "--arm", "--crash-after", "--fault", "--attempt",
    "--mode", "--credential-source", "--cache-dir", "--pi-runtime", "--timeout-ms", "--reason",
  ]);
  for (let index = 0; index < tail.length; index += 1) {
    const flag = tail[index];
    if (valueFlags.has(flag)) {
      // Repeated value flags (run --task a --task b) collect into an
      // array; a single occurrence stays a plain string.
      if (Object.prototype.hasOwnProperty.call(flags, flag)) {
        flags[flag] = Array.isArray(flags[flag])
          ? [...flags[flag], tail[index + 1]]
          : [flags[flag], tail[index + 1]];
      } else {
        flags[flag] = tail[index + 1];
      }
      index += 1;
    } else {
      flags[flag] = true;
    }
  }
  return flags;
}

function defaultRunsDir() {
  return join(repoRoot, "evaluation", "runs");
}

function cmdPrepare(flags) {
  const runsDir = flags["--runs-dir"] ?? defaultRunsDir();
  const runId = flags["--run-id"] ?? `run-${timestampRunId()}`;
  const mode = flags["--mode"] === "real" ? "real" : "dry-run";
  if (flags["--mode"] !== undefined && mode !== flags["--mode"]) {
    process.stderr.write("cli: --mode must be real or dry-run\n");
    return 2;
  }
  const run = createRun({ repoRoot, manifest: loadManifest(), runsDir, runId, mode });
  process.stdout.write(`${JSON.stringify({ runId, runDir: run.runDir, mode: run.mode })}\n`);
  return 0;
}

/** Real runs default outside the repository, under the user cache. */
function realDefaultRoot() {
  const base = process.env.XDG_CACHE_HOME
    ?? (process.platform === "darwin" ? join(homedir(), "Library", "Caches") : join(homedir(), ".cache"));
  return join(base, "condensed-milk-eval");
}

async function cmdRun(flags) {
  const runsDir = flags["--runs-dir"] ?? join(realDefaultRoot(), "runs");
  const runId = requireRunId(flags);
  const runDir = join(runsDir, runId);
  if (!existsSync(runDir)) {
    process.stderr.write(`cli: unknown run ${runId} under ${runsDir}\n`);
    return 2;
  }
  const run = loadRun(runDir);
  if (run.mode !== "real") {
    process.stderr.write(`cli: run ${runId} has mode ${run.mode}; real execution needs a run prepared with --mode real\n`);
    return 2;
  }
  if (flags["--plan-only"]) {
    // Planning is read-only: no paid gate, no run lock, no attempts.
    const { planRealRun } = await import("./real.mjs");
    return await planRealRun({ flags, runId, runDir, run, repoRoot });
  }
  if (!flags["--confirm-paid"]) {
    process.stderr.write("cli: run makes paid provider calls and needs --confirm-paid; nothing was reserved\n");
    return 2;
  }
  const { acquireRunLock, releaseRunLock } = await import("./state.mjs");
  try {
    acquireRunLock(runDir, { recover: Boolean(flags["--recover-lock"]) });
  } catch (error) {
    process.stderr.write(`cli: ${error.message}\n`);
    return 3;
  }
  try {
    const { runRealArms } = await import("./real.mjs");
    return await runRealArms({ flags, runsDir, runId, runDir, run, repoRoot });
  } finally {
    releaseRunLock(runDir);
  }
}

async function cmdDryRun(flags) {
  const runsDir = flags["--runs-dir"] ?? defaultRunsDir();
  const runId = flags["--run-id"] ?? requireRunId(flags);
  const runDir = join(runsDir, runId);
  const { acquireRunLock, releaseRunLock } = await import("./state.mjs");
  try {
    acquireRunLock(runDir, { recover: Boolean(flags["--recover-lock"]) });
  } catch (error) {
    process.stderr.write(`cli: ${error.message}\n`);
    return 3;
  }
  try {
    return await dryRunLocked(flags, runsDir, runId, runDir);
  } finally {
    releaseRunLock(runDir);
  }
}

async function dryRunLocked(flags, runsDir, runId, runDir) {
  const run = loadRun(runDir);
  const manifest = loadManifest();
  if (!flags["--task"] && !flags["--all"]) {
    process.stderr.write("cli: dry-run needs --task <id> or --all\n");
    return 2;
  }
  const taskIds = flags["--all"]
    ? manifest.tasks.map((task) => task.id)
    : [flags["--task"]];
  const task = manifest.tasks.find((entry) => entry.id === taskIds[0]);
  if (!task) {
    process.stderr.write(`cli: unknown task ${taskIds[0]}\n`);
    return 2;
  }
  const outcomes = [];
  let completedSoFar = 0;
  const crashAfter = flags["--crash-after"];
  for (const taskId of taskIds) {
    const currentTask = manifest.tasks.find((entry) => entry.id === taskId);
    const arms = flags["--arm"] ? [flags["--arm"]] : run.armOrder[currentTask.id];
    for (const arm of arms) {
      const claim = reserveAttempt({
        runDir,
        runId,
        taskId: currentTask.id,
        arm,
        attempt: 1,
        behavior: flags["--fault"],
      });
      if (claim.refused) {
        return claim.exit;
      }
      if (!claim.claimed) {
        continue;
      }
      completedSoFar += 1;
      if (crashAfter === "first" && completedSoFar === 2) {
        const { releaseRunLock } = await import("./state.mjs");
        releaseRunLock(runDir);
        process.exit(70);
      }
      outcomes.push(
        await executeFakeAttempt({
          runDir,
          runId,
          task: currentTask,
          arm,
          attempt: 1,
          attemptDir: claim.attemptDir,
          behavior: flags["--fault"] ?? "success",
        }),
      );
    }
  }
  process.stdout.write(`${JSON.stringify({ runId, executed: outcomes.length })}\n`);
  return 0;
}

async function cmdResume(flags) {
  const runsDir = flags["--runs-dir"] ?? defaultRunsDir();
  const runId = requireRunId(flags);
  const runDir = join(runsDir, runId);
  const { acquireRunLock, releaseRunLock } = await import("./state.mjs");
  try {
    acquireRunLock(runDir, { recover: Boolean(flags["--recover-lock"]) });
  } catch (error) {
    process.stderr.write(`cli: ${error.message}\n`);
    return 3;
  }
  try {
    return await resumeLocked(flags, runsDir, runId, runDir);
  } finally {
    releaseRunLock(runDir);
  }
}

async function resumeLocked(flags, runsDir, runId, runDir) {
  const run = loadRun(runDir);
  const manifest = loadManifest();
  let abandoned = 0;
  let executed = 0;
  for (const task of manifest.tasks) {
    for (const arm of run.armOrder[task.id]) {
      const state = loadState(runDir);
      const existing = state.attempts[`${task.id}:${arm}:1`];
      if (run.mode === "real") {
        // Real resume never reserves or respawns a paid attempt: an
        // un-reserved slot stays empty and a reserved non-terminal
        // attempt is abandoned with its terminal artifacts untouched.
        if (!existing) continue;
        if (TERMINAL_STATUSES.has(existing.status)) continue;
        appendJournal(runDir, { type: "attempt-abandoned", taskId: task.id, arm, attempt: 1 });
        writeSnapshot(runDir, snapshotAfter(runDir, task.id, arm, 1, "abandoned-reserved"));
        abandoned += 1;
        continue;
      }
      if (!existing) {
        const claim = reserveAttempt({ runDir, runId, taskId: task.id, arm, attempt: 1 });
        if (claim.refused) {
          return claim.exit;
        }
        if (!claim.claimed) continue;
        await executeFakeAttempt({
          runDir,
          runId,
          task,
          arm,
          attempt: 1,
          attemptDir: claim.attemptDir,
        });
        executed += 1;
        continue;
      }
      if (existing.status === "completed" || existing.status === "failed" || existing.status === "timeout" || existing.status === "interrupted" || existing.status === "collection-error") {
        continue;
      }
      appendJournal(runDir, { type: "attempt-abandoned", taskId: task.id, arm, attempt: 1 });
      writeSnapshot(runDir, snapshotAfter(runDir, task.id, arm, 1, "abandoned-reserved"));
      abandoned += 1;
    }
  }
  process.stdout.write(`${JSON.stringify({ runId, executed, abandonedReserved: abandoned })}\n`);
  return 0;
}

async function cmdRetry(flags) {
  const runsDir = flags["--runs-dir"] ?? defaultRunsDir();
  const runId = requireRunId(flags);
  const runDir = join(runsDir, runId);
  if (!existsSync(runDir)) {
    process.stderr.write(`cli: unknown run ${runId} under ${runsDir}\n`);
    return 2;
  }
  // Real retries are unsupported: a paid re-attempt needs an explicit
  // real-run retry implementation (credential, runtime, and receipt
  // flow). Refusing here keeps the run bytes untouched and never routes
  // a real run into the fake attempt path, even with the paid flag.
  if (loadRun(runDir).mode === "real") {
    process.stderr.write(
      `cli: retry is unsupported for run ${runId} (mode real); real retries need a new explicit real-run implementation; nothing was reserved\n`,
    );
    return 2;
  }
  if (!flags["--allow-new-paid-attempt"]) {
    process.stderr.write("cli: retry requires --allow-new-paid-attempt\n");
    return 2;
  }
  const { acquireRunLock, releaseRunLock } = await import("./state.mjs");
  try {
    acquireRunLock(runDir, { recover: Boolean(flags["--recover-lock"]) });
  } catch (error) {
    process.stderr.write(`cli: ${error.message}\n`);
    return 3;
  }
  try {
    return await retryLocked(flags, runsDir, runId, runDir);
  } finally {
    releaseRunLock(runDir);
  }
}

async function retryLocked(flags, runsDir, runId, runDir) {
  const manifest = loadManifest();
  const task = manifest.tasks.find((entry) => entry.id === flags["--task"]);
  const arm = flags["--arm"];
  if (!task || !arm) {
    process.stderr.write("cli: retry needs --task <id> and --arm <arm>\n");
    return 2;
  }
  const state = loadState(runDir);
  let highest = 0;
  for (const key of Object.keys(state.attempts)) {
    const parts = key.split(":");
    if (parts[0] === task.id && parts[1] === arm) {
      highest = Math.max(highest, Number(parts[2]));
    }
  }
  const armDir = join(runDir, "attempts", task.id, arm);
  if (existsSync(armDir)) {
    for (const name of readdirSync(armDir)) {
      const match = /^attempt-(\d+)$/.exec(name);
      if (match) highest = Math.max(highest, Number(match[1]));
    }
  }
  if (highest === 0) {
    process.stderr.write("cli: retry needs an existing attempt\n");
    return 2;
  }
  const attempt = highest + 1;
  const claim = reserveAttempt({ runDir, runId, taskId: task.id, arm, attempt, behavior: flags["--fault"] });
  if (claim.refused) {
    return claim.exit;
  }
  if (!claim.claimed) {
    process.stderr.write("cli: attempt slot already claimed by another writer\n");
    return 3;
  }
  const outcome = await executeFakeAttempt({
    runDir,
    runId,
    task,
    arm,
    attempt,
    attemptDir: claim.attemptDir,
    behavior: flags["--fault"] ?? "success",
  });
  process.stdout.write(`${JSON.stringify({ runId, ...outcome })}\n`);
  return 0;
}

const TERMINAL_STATUSES = new Set(["completed", "failed", "timeout", "interrupted", "collection-error"]);

async function cmdSelect(flags) {
  const runsDir = flags["--runs-dir"] ?? defaultRunsDir();
  const runId = flags["--run-id"];
  if (!runId) {
    process.stderr.write("cli: --run-id is required for this command\n");
    return 2;
  }
  const runDir = join(runsDir, runId);
  if (!existsSync(runDir)) {
    process.stderr.write(`cli: unknown run ${runId} under ${runsDir}\n`);
    return 2;
  }
  const manifest = loadManifest();
  const task = manifest.tasks.find((entry) => entry.id === flags["--task"]);
  const arm = flags["--arm"];
  if (!task || (arm !== "upstream" && arm !== "fork")) {
    process.stderr.write("cli: select needs --task <id> and --arm <upstream|fork>\n");
    return 2;
  }
  const attempt = Number(flags["--attempt"]);
  if (!Number.isInteger(attempt) || attempt < 1) {
    process.stderr.write("cli: select needs --attempt <number> of a terminal attempt\n");
    return 2;
  }
  const { acquireRunLock, releaseRunLock } = await import("./state.mjs");
  try {
    acquireRunLock(runDir, { recover: Boolean(flags["--recover-lock"]) });
  } catch (error) {
    process.stderr.write(`cli: ${error.message}\n`);
    return 3;
  }
  try {
    const attemptDir = join(runDir, "attempts", task.id, arm, `attempt-${String(attempt).padStart(3, "0")}`);
    const result = readJsonIfExists(join(attemptDir, "result.json"));
    if (!result || !TERMINAL_STATUSES.has(result.status)) {
      process.stderr.write(
        `cli: ${task.id}/${arm} attempt-${String(attempt).padStart(3, "0")} is not a terminal attempt; selection refused\n`,
      );
      return 4;
    }
    // Receipt gate: a slot may only point at an attempt whose durable
    // provider-invocation receipt proves the right invocation kind for
    // this run (paid and pinned for real runs, fake for dry-run runs).
    const receiptCheck = validateSelectedAttemptReceipt({
      runDir,
      attemptDir,
      runId,
      taskId: task.id,
      arm,
      attempt,
      manifest,
    });
    if (!receiptCheck.ok) {
      process.stderr.write(
        `cli: ${task.id}/${arm} attempt-${String(attempt).padStart(3, "0")} receipt is invalid (${receiptCheck.reason}); selection refused\n`,
      );
      return 4;
    }
    selectAttempt({ runDir, taskId: task.id, arm, attempt, source: "manual" });
    process.stdout.write(`${JSON.stringify({ runId, taskId: task.id, arm, attempt, selected: true })}\n`);
    return 0;
  } finally {
    releaseRunLock(runDir);
  }
}

function cmdReport(flags) {
  const runsDir = flags["--runs-dir"] ?? defaultRunsDir();
  const runId = flags["--run-id"] ?? latestRunId(runsDir);
  if (!runId) {
    process.stderr.write("cli: no runs found under " + runsDir + "\n");
    return 2;
  }
  const runDir = join(runsDir, runId);
  const run = loadRun(runDir);
  const manifest = loadManifest();
  const persistedSelection = loadState(runDir)?.selection ?? {};
  const selection = {};
  const rows = [];
  let executed = 0;
  let attemptsTotal = 0;
  let slotsCompleted = 0;
  let validPairs = 0;
  let incompletePairs = 0;
  let invalidPairs = 0;
  let maxInvocations = 0;
  for (const task of manifest.tasks) {
    let selectedArms = 0;
    for (const arm of ["upstream", "fork"]) {
      const armDir = join(runDir, "attempts", task.id, arm);
      if (!existsSync(armDir)) {
        continue;
      }
      for (const name of readdirSync(armDir)) {
        if (/^attempt-\d+$/.test(name)) attemptsTotal += 1;
        const resultPath = join(armDir, name, "result.json");
        if (!existsSync(resultPath)) continue;
        const result = JSON.parse(readFileSync(resultPath, "utf8"));
        executed += 1;
        const invocationsPath = join(armDir, name, "invocations.jsonl");
        if (existsSync(invocationsPath)) {
          const count = readFileSync(invocationsPath, "utf8").trim().split("\n").filter((line) => line.length > 0).length;
          maxInvocations = Math.max(maxInvocations, count);
        }
        rows.push({
          taskId: task.id,
          arm,
          attempt: result.attempt,
          status: result.status,
          scorerStatus: result.scorer.status,
          scorerSha256: readJsonIfExists(join(armDir, name, "pinned.json"))?.scorerSha256 ?? null,
          passed: result.scorer.passedCount,
          total: result.scorer.totalCount,
          durationMs: result.durationMs,
          usageInput: result.usage.input,
          usageOutput: result.usage.output,
          pairValid: null,
        });
      }
      const persisted = persistedSelection[`${task.id}:${arm}`];
      let selected;
      if (typeof persisted === "number") {
        selected = persisted;
        const chosen = readJsonIfExists(
          join(runDir, "attempts", task.id, arm, `attempt-${String(persisted).padStart(3, "0")}`, "result.json"),
        );
        if (chosen?.status === "completed") slotsCompleted += 1;
      } else {
        selected = selectedAttemptFor({ runDir, task, arm });
        if (typeof selected === "number") slotsCompleted += 1;
      }
      if (selected !== undefined) {
        selection[`${task.id}:${arm}`] = selected;
        selectedArms += 1;
      }
    }
    let pairKind = "incomplete";
    if (selectedArms === 2) {
      pairKind = evaluateSelectedPair({ runDir, runId, task, manifest, selection }).kind;
    }
    const pairValid = pairKind === "valid";
    if (pairKind === "valid") validPairs += 1;
    else if (pairKind === "invalid") invalidPairs += 1;
    else incompletePairs += 1;
    for (const row of rows) {
      if (row.taskId === task.id) row.pairValid = pairValid;
    }
  }
  const summary = {
    schemaVersion: 1,
    runId,
    mode: run.mode,
    slots: { total: manifest.tasks.length * 2, executed, completed: slotsCompleted },
    attempts: { total: attemptsTotal },
    selection,
    pairs: { valid: validPairs, incomplete: incompletePairs, invalid: invalidPairs },
    checks: {
      noDuplicateInvocations: maxInvocations <= 1,
      maxInvocationsPerAttempt: maxInvocations,
    },
  };
  writeFileSync(join(runDir, "summary.json"), `${JSON.stringify(summary, null, 2)}\n`, "utf8");
  const csvLines = ["taskId,arm,attempt,status,scorerStatus,scorerSha256,passed,total,durationMs,usageInput,usageOutput,pairValid"];
  for (const row of rows) {
    csvLines.push(
      [row.taskId, row.arm, row.attempt, row.status, row.scorerStatus, row.scorerSha256, row.passed, row.total, row.durationMs, row.usageInput, row.usageOutput, row.pairValid].join(","),
    );
  }
  writeFileSync(join(runDir, "summary.csv"), `${csvLines.join("\n")}\n`, "utf8");
  const markdown = [
    `# Evaluation run ${runId}`,
    "",
    `- Mode: ${run.mode}`,
    `- Attempts executed: ${executed} of ${manifest.tasks.length * 2}`,
    `- Pairs (valid / incomplete): ${validPairs} / ${incompletePairs}`,
    `- Invalid pairs: ${invalidPairs}`,
    `- Max invocations per attempt: ${maxInvocations}`,
    "",
    "| taskId | arm | attempt | status | scorerStatus | scorerSha256 | pairValid |",
    "| --- | --- | --- | --- | --- | --- | --- |",
    ...rows.map((row) => `| ${row.taskId} | ${row.arm} | ${row.attempt} | ${row.status} | ${row.scorerStatus} | ${row.scorerSha256} | ${row.pairValid} |`),
  ].join("\n");
  writeFileSync(join(runDir, "summary.md"), `${markdown}\n`, "utf8");
  const aggregate = buildAggregateReports({ runDir, runId, run, manifest, selection });
  aggregate.summary.slots.executed = executed;
  aggregate.summary.checks = { noDuplicateInvocations: maxInvocations <= 1, maxInvocationsPerAttempt: maxInvocations };
  writeFileSync(join(runDir, "summary.json"), `${JSON.stringify(aggregate.summary, null, 2)}\n`, "utf8");
  process.stdout.write(`${JSON.stringify(aggregate.summary)}\n`);
  return 0;
}

/**
 * Record the explicit selection for one task-arm slot. Runs under the
 * run lock; journal first (fsync), then the atomic snapshot, so a crash
 * between the two recovers selection from journal replay.
 */
function selectAttempt({ runDir, taskId, arm, attempt, source }) {
  const state = loadState(runDir) ?? { runId: null, mode: null, seq: 0, attempts: {}, selection: {} };
  const selection = state.selection ?? {};
  appendJournal(runDir, { type: "attempt-selected", taskId, arm, attempt, source });
  writeSnapshot(runDir, {
    ...state,
    selection: { ...selection, [`${taskId}:${arm}`]: attempt },
  });
}

/**
 * attempt-001 becomes selected only after its first valid terminal
 * completion (completed runner status, normal scorer completion); a
 * slot that is already selected never changes implicitly.
 */
export function maybeSelectCompletion({ runDir, taskId, arm, attempt, status, scorerStatus }) {
  if (attempt !== 1) return false;
  if (status !== "completed") return false;
  if (scorerStatus !== "passed" && scorerStatus !== "failed") return false;
  const selection = loadState(runDir)?.selection ?? {};
  if (selection[`${taskId}:${arm}`] !== undefined) return false;
  selectAttempt({ runDir, taskId, arm, attempt, source: "auto" });
  return true;
}

function readJsonIfExists(path) {
  if (!existsSync(path)) return null;
  try {
    return JSON.parse(readFileSync(path, "utf8"));
  } catch {
    return null;
  }
}

/**
 * Pair validity uses the selected attempts only. Valid requires both
 * arms selected, completed runner status, normal scorer completion,
 * a valid provider-invocation receipt per arm, equal fixture-before
 * content and git-state hashes, equal prompt/scorer
 * definition and provider/model/thinking/Pi-version pins, and each arm commit
 * matching the manifest. Anything else is invalid; a slot without a
 * usable selection is incomplete.
 */
function evaluateSelectedPair({ runDir, runId, task, manifest, selection }) {
  const chosen = {};
  for (const arm of ["upstream", "fork"]) {
    const attempt = selection[`${task.id}:${arm}`];
    if (typeof attempt !== "number") return { kind: "incomplete" };
    const dir = join(runDir, "attempts", task.id, arm, `attempt-${String(attempt).padStart(3, "0")}`);
    const result = readJsonIfExists(join(dir, "result.json"));
    if (!result) return { kind: "incomplete" };
    chosen[arm] = { dir, result };
  }
  for (const arm of ["upstream", "fork"]) {
    const receiptCheck = validateSelectedAttemptReceipt({
      runDir,
      attemptDir: chosen[arm].dir,
      runId,
      taskId: task.id,
      arm,
      attempt: selection[`${task.id}:${arm}`],
      manifest,
    });
    if (!receiptCheck.ok) return { kind: "invalid" };
    if (chosen[arm].result.status !== "completed") return { kind: "invalid" };
    const scorerStatus = chosen[arm].result.scorer?.status;
    if (scorerStatus !== "passed" && scorerStatus !== "failed") return { kind: "invalid" };
    const before = readJsonIfExists(join(chosen[arm].dir, "fixture-before.json"));
    if (!before || typeof before.contentSha256 !== "string" || typeof before.gitStateSha256 !== "string") {
      return { kind: "invalid" };
    }
    chosen[arm].before = before;
  }
  if (
    chosen.upstream.before.contentSha256 !== chosen.fork.before.contentSha256 ||
    chosen.upstream.before.gitStateSha256 !== chosen.fork.before.gitStateSha256
  ) {
    return { kind: "invalid" };
  }
  const pinned = {};
  for (const arm of ["upstream", "fork"]) {
    pinned[arm] = readJsonIfExists(join(chosen[arm].dir, "pinned.json"));
    if (!pinned[arm]) return { kind: "invalid" };
  }
  for (const field of ["promptSha256", "scorerSha256", "provider", "model", "thinking", "piVersion"]) {
    if (pinned.upstream[field] !== pinned.fork[field]) return { kind: "invalid" };
  }
  // Runtime pin validity mirrors report.mjs: legacy handling applies
  // only when piRuntime is absent everywhere. Any present pin must be a
  // valid object with a 64-hex digest (a present-but-malformed pin is
  // invalid, never compared as undefined); all present pins must agree.
  const runPin = readJsonIfExists(join(runDir, "run.json"))?.piRuntime;
  const upstreamPin = pinned.upstream.piRuntime;
  const forkPin = pinned.fork.piRuntime;
  if (runPin !== undefined || upstreamPin !== undefined || forkPin !== undefined) {
    if (runPin !== undefined && !runtimePinDigest(runPin)) return { kind: "invalid" };
    for (const armPin of [upstreamPin, forkPin]) {
      if (armPin !== undefined && !runtimePinDigest(armPin)) return { kind: "invalid" };
    }
    const upstreamDigest = runtimePinDigest(upstreamPin);
    const forkDigest = runtimePinDigest(forkPin);
    if (!upstreamDigest || !forkDigest) return { kind: "invalid" };
    if (upstreamDigest !== forkDigest) return { kind: "invalid" };
    const runDigest = runtimePinDigest(runPin);
    if (runDigest && runDigest !== upstreamDigest) return { kind: "invalid" };
  }
  for (const arm of ["upstream", "fork"]) {
    const manifestCommit = manifest.evaluation.arms.find((entry) => entry.name === arm)?.commit;
    if (pinned[arm].armCommit !== manifestCommit) return { kind: "invalid" };
  }
  return { kind: "valid" };
}

/**
 * The selected attempt of one slot: attempt-001 once it has a valid
 * terminal completion (completed runner status, normal scorer
 * completion). Later attempts never claim selection implicitly.
 */
function selectedAttemptFor({ runDir, task, arm }) {
  const result = readJsonIfExists(
    join(runDir, "attempts", task.id, arm, "attempt-001", "result.json"),
  );
  if (!result || result.status !== "completed") return undefined;
  const scorerStatus = result.scorer?.status;
  if (scorerStatus !== "passed" && scorerStatus !== "failed") return undefined;
  return 1;
}

function guardTaskFixture({ runDir, taskId }) {
  const manifest = loadManifest();
  const task = manifest.tasks.find((entry) => entry.id === taskId);
  const cacheRoot = fixturesCacheRoot(repoRoot);
  let fixtureDir = join(cacheRoot, taskId);
  if (!existsSync(join(fixtureDir, ".git"))) {
    fixtureDir = publishFixtureCache({ repoRoot, task, cacheRoot });
  }
  const integrity = verifyFixtureCacheEntry({ task, entryDir: fixtureDir });
  if (!integrity.ok) {
    appendJournal(runDir, { type: "fixture-refused", taskId, errors: integrity.errors });
    process.stderr.write(
      `cli: fixture for ${taskId} failed cache integrity validation; refusing:\n` +
        integrity.errors.map((error) => `  - ${error}\n`).join("") +
        "  regenerate with: npm run evaluation:fixtures\n",
    );
    return { ok: false };
  }
  return { ok: true, fixtureDir };
}

function fixtureBeforeOf(fixtureDir) {
  return {
    schemaVersion: 1,
    contentSha256: hashTree(fixtureDir),
    gitStateSha256: gitStateHash(fixtureDir),
  };
}

function otherArmFixtureBefore({ runDir, taskId, arm }) {
  const other = arm === "upstream" ? "fork" : "upstream";
  const armDir = join(runDir, "attempts", taskId, other);
  if (!existsSync(armDir)) return null;
  let best = null;
  let bestNumber = 0;
  for (const name of readdirSync(armDir)) {
    const match = /^attempt-(\d+)$/.exec(name);
    if (!match) continue;
    const beforePath = join(armDir, name, "fixture-before.json");
    if (!existsSync(beforePath)) continue;
    const number = Number(match[1]);
    if (number > bestNumber) {
      bestNumber = number;
      best = JSON.parse(readFileSync(beforePath, "utf8"));
    }
  }
  return best;
}

/**
 * Lower-level immutable reservation primitive. Accepts an explicit
 * fixture directory, a pre-validated fixture identity, explicit pins,
 * a repetition attempt number, and a paid identity. It atomically
 * claims attempt-NNN, journals and snapshots the reservation, writes
 * fixture-before and pinned data, and creates provider-invocation.json
 * with wx. It hardcodes no task path and no fixture cache.
 */
export function reserveAttemptPrimitive({
  runDir,
  runId,
  taskId,
  arm,
  attempt,
  fixtureDir,
  fixtureIdentity,
  pins,
  paidIdentity = null,
  behavior = null,
}) {
  if (!existsSync(fixtureDir)) {
    return { claimed: false, refused: "fixture", exit: 4, attemptDir: null };
  }
  if (
    !fixtureIdentity ||
    typeof fixtureIdentity.contentSha256 !== "string" ||
    typeof fixtureIdentity.gitStateSha256 !== "string"
  ) {
    return { claimed: false, refused: "fixture-identity", exit: 4, attemptDir: null };
  }
  const attemptDir = join(runDir, "attempts", taskId, arm, `attempt-${String(attempt).padStart(3, "0")}`);
  mkdirSync(join(runDir, "attempts", taskId, arm), { recursive: true });
  if (!claimAttemptSlot(attemptDir)) {
    return { claimed: false, attemptDir };
  }
  appendJournal(runDir, { type: "attempt-reserved", taskId, arm, attempt });
  writeFileSync(
    join(attemptDir, "fixture-before.json"),
    `${JSON.stringify({ taskId, arm, attempt, ...fixtureIdentity }, null, 2)}\n`,
    "utf8",
  );
  writeFileSync(
    join(attemptDir, "pinned.json"),
    `${JSON.stringify({
      schemaVersion: 1,
      taskId,
      arm,
      attempt,
      ...pins,
      ...(paidIdentity?.piRuntime && pins.piRuntime === undefined
        ? { piRuntime: paidIdentity.piRuntime }
        : {}),
    }, null, 2)}\n`,
    "utf8",
  );
  const receiptFd = openSync(join(attemptDir, "provider-invocation.json"), "wx");
  try {
    writeSync(receiptFd, `${JSON.stringify({
      schemaVersion: 1,
      runId,
      taskId,
      arm,
      attempt,
      fake: true,
      ...(behavior ? { behavior } : {}),
      // A paid identity overrides the fake marker and pins the paid call,
      // including the executable runtime digest, in the receipt itself.
      ...(paidIdentity ? {
        fake: false,
        armCommit: paidIdentity.armCommit,
        model: paidIdentity.model,
        provider: paidIdentity.provider,
        ...(paidIdentity.piRuntime ? { piRuntime: paidIdentity.piRuntime } : {}),
        ...(paidIdentity.study ? { study: paidIdentity.study } : {}),
        ...(paidIdentity.profileSha256 ? { profileSha256: paidIdentity.profileSha256 } : {}),
        ...(paidIdentity.fixtureContentSha256 ? { fixtureContentSha256: paidIdentity.fixtureContentSha256 } : {}),
        ...(paidIdentity.fixtureGitStateSha256 ? { fixtureGitStateSha256: paidIdentity.fixtureGitStateSha256 } : {}),
        ...(paidIdentity.implementationSha256 ? { implementationSha256: paidIdentity.implementationSha256 } : {}),
        ...(paidIdentity.observerSha256 ? { observerSha256: paidIdentity.observerSha256 } : {}),
        ...(paidIdentity.observerWrapperSha256 ? { observerWrapperSha256: paidIdentity.observerWrapperSha256 } : {}),
      } : {}),
      reservedAt: new Date().toISOString(),
    }, null, 2)}\n`);
    fsyncSync(receiptFd);
  } finally {
    closeSync(receiptFd);
  }
  appendJournal(runDir, { type: "invocation-receipt-written", taskId, arm, attempt });
  writeSnapshot(runDir, snapshotAfter(runDir, taskId, arm, attempt, "reserved"));
  return { claimed: true, attemptDir };
}

export function reserveAttempt({ runDir, runId, taskId, arm, attempt, behavior, real = null }) {
  const guard = guardTaskFixture({ runDir, taskId });
  if (!guard.ok) {
    return { claimed: false, refused: "fixture", exit: 4, attemptDir: null };
  }
  const fixtureBefore = fixtureBeforeOf(guard.fixtureDir);
  const otherBefore = otherArmFixtureBefore({ runDir, taskId, arm });
  if (
    otherBefore !== null &&
    (otherBefore.contentSha256 !== fixtureBefore.contentSha256 ||
      otherBefore.gitStateSha256 !== fixtureBefore.gitStateSha256)
  ) {
    appendJournal(runDir, { type: "pair-refused", taskId, arm, attempt, reason: "fixture-before hash mismatch" });
    process.stderr.write(
      `cli: refusing pair for ${taskId}: arm fixtures diverged before invocation; ` +
        "regenerate the fixture cache before retrying\n",
    );
    return { claimed: false, refused: "pair", exit: 4, attemptDir: null };
  }
  const manifest = loadManifest();
  const task = manifest.tasks.find((entry) => entry.id === taskId);
  const pins = {
    promptSha256: sha256Text(buildAttemptPrompt(task.prompt)),
    scorerSha256: scorerDefinitionSha256(repoRoot, taskId),
    provider: manifest.evaluation.provider,
    model: manifest.evaluation.model,
    thinking: manifest.evaluation.thinking,
    piVersion: manifest.evaluation.piVersion,
    armCommit: manifest.evaluation.arms.find((entry) => entry.name === arm)?.commit ?? null,
    ...(real?.piRuntime ? { piRuntime: real.piRuntime } : {}),
  };
  return reserveAttemptPrimitive({
    runDir,
    runId,
    taskId,
    arm,
    attempt,
    fixtureDir: guard.fixtureDir,
    fixtureIdentity: fixtureBefore,
    pins,
    paidIdentity: real,
    behavior,
  });
}

function latestRunId(runsDir) {
  if (!existsSync(runsDir)) return null;
  const entries = readdirSync(runsDir).sort();
  return entries.length > 0 ? entries[entries.length - 1] : null;
}

function cmdFixtures() {
  const manifest = loadManifest();
  const cacheRoot = fixturesCacheRoot(repoRoot);
  const rows = [];
  for (const task of manifest.tasks) {
    const fixtureDir = join(cacheRoot, task.id);
    if (existsSync(join(fixtureDir, ".git"))) {
      const check = verifyFixtureCacheEntry({ task, entryDir: fixtureDir });
      if (check.ok) {
        rows.push({ taskId: task.id, treeSha256: check.record.contentSha256 });
        continue;
      }
      // Explicit regeneration: an invalid entry is removed and replaced
      // by one fresh atomic publication. A concurrent writer that wins
      // the race leaves an equivalent deterministic entry.
      rmSync(fixtureDir, { recursive: true, force: true });
    }
    const published = publishFixtureCache({ repoRoot, task, cacheRoot });
    const check = verifyFixtureCacheEntry({ task, entryDir: published });
    if (!check.ok) {
      throw new Error(`fixture cache publication failed for ${task.id}: ${check.errors.join("; ")}`);
    }
    rows.push({ taskId: task.id, treeSha256: check.record.contentSha256 });
  }
  process.stdout.write(`fixtures: 20 tasks cached\n${rows.map((row) => JSON.stringify(row)).join("\n")}\n`);
  return 0;
}

function executeFakeAttempt({ runDir, runId, task, arm, attempt, attemptDir, behavior = "success" }) {
  if (["timeout", "nonzero", "malformed", "missing-usage", "interrupted", "scorer-failure", "multi-turn"].includes(behavior)) {
    return executeFaultAttempt({ runDir, runId, task, arm, attempt, attemptDir, behavior });
  }
  return executeSuccessAttempt({ runDir, runId, task, arm, attempt, attemptDir });
}

async function executeSuccessAttempt({ runDir, runId, task, arm, attempt, attemptDir }) {
  const evaluation = loadManifest().evaluation;

  const worktree = join(attemptDir, "worktree");
  const cacheRoot = fixturesCacheRoot(repoRoot);
  let fixtureDir = join(cacheRoot, task.id);
  if (!existsSync(join(fixtureDir, ".git"))) {
    fixtureDir = publishFixtureCache({ repoRoot, task, cacheRoot });
  }
  cpSync(fixtureDir, worktree, { recursive: true, dot: true });
  const sessions = join(attemptDir, "sessions");
  const home = join(attemptDir, "home");
  mkdirSync(sessions, { recursive: true });
  mkdirSync(home, { recursive: true });

  const { solution } = loadTaskData(repoRoot, task.id);
  const usage = { input: 1200, output: 340, cacheRead: null, cacheWrite: 90 };
  const invocation = {
    schemaVersion: 1,
    fake: true,
    runId,
    taskId: task.id,
    arm,
    attempt,
    provider: evaluation.provider,
    model: evaluation.model,
    thinking: evaluation.thinking,
    envKeys: ["PATH", "HOME", "FAKE_PI_SCENARIO", "FAKE_PI_INVOCATIONS"],
  };
  writeFileSync(join(attemptDir, "invocation.json"), `${JSON.stringify(invocation, null, 2)}\n`, "utf8");

  const startedMs = Date.now();
  const message = {
    role: "assistant",
    content: [{ type: "text", text: `done with ${task.id} arm ${arm}` }],
    usage,
  };
  const events = [
    { type: "session", version: 3, id: `${task.id}-${arm}`, timestamp: "1970-01-01T00:00:00.000Z", cwd: worktree },
    { type: "agent_start" },
    { type: "turn_start" },
    { type: "tool_execution_start", toolCallId: "call-0", toolName: "read", args: {} },
    { type: "tool_execution_end", toolCallId: "call-0", toolName: "read", result: {}, isError: false },
    { type: "tool_execution_start", toolCallId: "call-1", toolName: "bash", args: {} },
    { type: "tool_execution_end", toolCallId: "call-1", toolName: "bash", result: {}, isError: false },
    { type: "message_end", message },
    { type: "agent_end", messages: [message] },
  ];
  const stdoutText = events.map((event) => JSON.stringify(event)).join("\n") + "\n";
  writeFileSync(join(attemptDir, "pi-stdout.jsonl"), stdoutText, "utf8");
  writeFileSync(join(attemptDir, "pi-stderr.txt"), "", "utf8");
  writeFileSync(join(attemptDir, "invocations.jsonl"), `${JSON.stringify({ at: "1970-01-01T00:00:00.000Z" })}\n`, "utf8");
  writeFileSync(join(sessions, `session-${task.id}-${arm}.jsonl`), stdoutText, "utf8");

  applySolution({ worktree, solution, taskId: task.id });

  const scorerResult = scoreWorktree({ repoRoot, worktree, taskId: task.id });
  writeFileSync(join(attemptDir, "scorer.json"), `${JSON.stringify(scorerResult, null, 2)}\n`, "utf8");

  // Final repository collection runs after the work settles and before
  // the attempt reaches terminal completion. A collection error is its
  // own terminal status and never auto-selects.
  const collection = await collectFinalState({ worktree, outDir: join(attemptDir, "final-state") });
  writeFileSync(join(attemptDir, "final-state.json"), `${JSON.stringify(collection, null, 2)}\n`, "utf8");
  appendJournal(runDir, { type: "attempt-collected", taskId: task.id, arm, attempt, status: collection.status });
  const status = collection.status === "error" ? "collection-error" : "completed";

  const result = {
    schemaVersion: 1,
    runId,
    taskId: task.id,
    arm,
    attempt,
    status,
    durationMs: Date.now() - startedMs,
    exit: { code: 0, signal: null, timedOut: false },
    usage,
    scorer: {
      status: scorerResult.status,
      passedCount: scorerResult.passedCount,
      totalCount: scorerResult.totalCount,
      error: scorerResult.error,
    },
    collection: {
      status: collection.status,
      errors: collection.errors,
      artifacts: collection.artifacts.map(({ name, file, bytes, sha256 }) => ({ name, file, bytes, sha256 })),
    },
    failures: [],
  };
  writeFileSync(join(attemptDir, "result.json"), `${JSON.stringify(result, null, 2)}\n`, "utf8");
  appendJournal(runDir, { type: "attempt-finished", taskId: task.id, arm, attempt, status });
  writeSnapshot(runDir, snapshotAfter(runDir, task.id, arm, attempt, status));
  maybeSelectCompletion({ runDir, taskId: task.id, arm, attempt, status, scorerStatus: scorerResult.status });
  return { taskId: task.id, arm, status };
}

function timestampRunId() {
  return new Date().toISOString().replace(/[-:.TZ]/g, "").substring(0, 14);
}

function requireRunId(flags) {
  const runId = flags["--run-id"];
  if (!runId) {
    process.stderr.write("cli: --run-id is required for this command\n");
    process.exit(2);
  }
  return runId;
}

export function snapshotAfter(runDir, taskId, arm, attempt, status) {
  const state = loadState(runDir) ?? { runId: null, mode: null, seq: 0, attempts: {} };
  const key = `${taskId}:${arm}:${attempt}`;
  return {
    ...state,
    attempts: { ...state.attempts, [key]: { taskId, arm, attempt, status } },
  };
}

function loadManifest() {
  return loadManifestFile(join(repoRoot, "evaluation", "task-manifest.json"));
}

/** --- Masking study commands (separate study; free path plus explicit
 * paid refusal). All reuse the same flag parser and exit conventions. */

function cmdMaskingValidate() {
  const { manifest } = loadMaskingManifestFile(repoRoot);
  for (const task of manifest.tasks) {
    loadMaskingTaskData(repoRoot, task.id);
  }
  process.stdout.write(
    `masking-validate: ok (schemaVersion ${manifest.schemaVersion}, ${manifest.tasks.length} tasks, ${manifest.evaluation.repetitionsPerTask} repetitions)\n`,
  );
  return 0;
}

function cmdMaskingFixtures() {
  const { manifest } = loadMaskingManifestFile(repoRoot);
  const cacheRoot = maskingFixturesCacheRoot(repoRoot);
  const rows = [];
  for (const task of manifest.tasks) {
    const fixtureDir = join(cacheRoot, task.id);
    if (existsSync(join(fixtureDir, ".git"))) {
      const check = verifyMaskingFixtureCache({ task, entryDir: fixtureDir });
      if (check.ok) {
        rows.push({ taskId: task.id, treeSha256: check.record.contentSha256 });
        continue;
      }
      rmSync(fixtureDir, { recursive: true, force: true });
    }
    const published = publishMaskingFixtureCache({ repoRoot, task, cacheRoot });
    const check = verifyMaskingFixtureCache({ task, entryDir: published });
    if (!check.ok) {
      throw new Error(`masking fixture cache publication failed for ${task.id}: ${check.errors.join("; ")}`);
    }
    rows.push({ taskId: task.id, treeSha256: check.record.contentSha256 });
  }
  process.stdout.write(`masking-fixtures: ${manifest.tasks.length} tasks cached\n${rows.map((row) => JSON.stringify(row)).join("\n")}\n`);
  return 0;
}

function cmdMaskingPrepare(flags) {
  const runsDir = flags["--runs-dir"] ?? join(repoRoot, "evaluation", "masking-runs");
  const runId = flags["--run-id"] ?? `masking-${timestampRunId()}`;
  const mode = flags["--mode"] === "real" ? "real" : "dry-run";
  if (flags["--mode"] !== undefined && mode !== flags["--mode"]) {
    process.stderr.write("cli: --mode must be real or dry-run\n");
    return 2;
  }
  try {
    const run = maskingPrepare({ repoRoot, runsDir, runId, mode });
    process.stdout.write(`${JSON.stringify({ runId, runDir: run.runDir, mode: run.mode })}\n`);
    return 0;
  } catch (error) {
    process.stderr.write(`cli: ${error.message}\n`);
    return 2;
  }
}

function requireMaskingRunDir(flags) {
  const runsDir = flags["--runs-dir"] ?? join(repoRoot, "evaluation", "masking-runs");
  const runId = flags["--run-id"] ?? latestRunId(join(runsDir));
  if (!runId) {
    process.stderr.write(`cli: no masking runs found under ${runsDir}\n`);
    return null;
  }
  const check = validateMaskingRunId(runId);
  if (!check.ok) {
    process.stderr.write(`cli: masking run id refused: ${check.problems.join("; ")}\n`);
    return null;
  }
  return { runsDir, runId, runDir: join(runsDir, runId) };
}

function cmdMaskingPlan(flags) {
  const target = requireMaskingRunDir(flags);
  if (!target) return 2;
  if (!existsSync(target.runDir)) {
    process.stderr.write(`cli: unknown masking run ${target.runId} under ${target.runsDir}\n`);
    return 2;
  }
  try {
    process.stdout.write(`${JSON.stringify(maskingPlanRun({ repoRoot, ...target }))}\n`);
    return 0;
  } catch (error) {
    process.stderr.write(`cli: ${error.message}\n`);
    return 2;
  }
}

async function cmdMaskingDryRun(flags) {
  const target = requireMaskingRunDir(flags);
  if (!target) return 2;
  if (!existsSync(target.runDir)) {
    process.stderr.write(`cli: unknown masking run ${target.runId} under ${target.runsDir}\n`);
    return 2;
  }
  try {
    const outcome = await maskingDryRun({ repoRoot, ...target });
    process.stdout.write(`${JSON.stringify(outcome)}\n`);
    return 0;
  } catch (error) {
    process.stderr.write(`cli: ${error.message}\n`);
    return 3;
  }
}

async function cmdMaskingRun(flags) {
  const target = requireMaskingRunDir(flags);
  if (!target) return 2;
  if (!existsSync(target.runDir)) {
    process.stderr.write(`cli: unknown masking run ${target.runId} under ${target.runsDir}\n`);
    return 2;
  }
  if (!flags["--confirm-paid"]) {
    process.stderr.write("cli: masking-run makes paid provider calls and needs --confirm-paid; nothing was reserved\n");
    return 2;
  }
  // The shared run lock covers the whole paid run; --recover-lock maps
  // straight through. Released in finally so a crash cannot pin it.
  const { acquireRunLock, releaseRunLock } = await import("./state.mjs");
  try {
    acquireRunLock(target.runDir, { recover: Boolean(flags["--recover-lock"]) });
  } catch (error) {
    process.stderr.write(`cli: run lock refused: ${error.message}\n`);
    return 3;
  }
  try {
    const outcome = await maskingRealRun({ repoRoot, ...target, flags });
    // Structured outcome on stdout; the exit code stays numeric. A
    // stopped paid run returns 3, never an object and never 0.
    process.stdout.write(`${JSON.stringify(outcome)}\n`);
    return outcome.stoppedReason === null || outcome.stoppedReason === undefined ? 0 : 3;
  } catch (error) {
    process.stderr.write(`cli: ${error.message}\n`);
    return 2;
  } finally {
    releaseRunLock(target.runDir);
  }
}

/**
 * masking-abandon: locked, explicit acknowledgement that a reserved
 * paid slot will never complete. Requires run id, task, arm, attempt,
 * and reason. Marks the slot abandoned, marks the whole run invalid,
 * and never creates another attempt or provider call. The invalid run
 * cannot resume paid execution; documentation requires a new run id.
 */
async function cmdMaskingAbandon(flags) {
  const target = requireMaskingRunDir(flags);
  if (!target) return 2;
  if (!existsSync(target.runDir)) {
    process.stderr.write(`cli: unknown masking run ${target.runId} under ${target.runsDir}\n`);
    return 2;
  }
  const taskId = flags["--task"];
  const arm = flags["--arm"];
  const attemptRaw = flags["--attempt"];
  const reason = flags["--reason"];
  for (const [name, value] of [["--task", taskId], ["--arm", arm], ["--attempt", attemptRaw], ["--reason", reason]]) {
    if (typeof value !== "string" || value.trim().length === 0) {
      process.stderr.write(`cli: masking-abandon requires ${name}\n`);
      return 2;
    }
  }
  if (!/^[123]$/.test(attemptRaw)) {
    process.stderr.write("cli: --attempt must be 1, 2, or 3\n");
    return 2;
  }
  if (arm !== "upstream" && arm !== "fork") {
    process.stderr.write("cli: --arm must be upstream or fork\n");
    return 2;
  }
  // Validate the task against the masking manifest before any path
  // join. Unknown ids and traversal refuse with no directory created.
  const maskingManifest = loadMaskingManifestFile(repoRoot).manifest;
  if (typeof taskId !== "string" || !/^masking-task-\d{2}$/.test(taskId) || !maskingManifest.tasks.some((task) => task.id === taskId)) {
    process.stderr.write(`cli: task ${JSON.stringify(taskId)} is not in the masking manifest\n`);
    return 2;
  }
  // The reason stays one bounded line.
  if (/[\r\n]/.test(reason) || reason.length > 512) {
    process.stderr.write("cli: --reason must be a single line of at most 512 characters\n");
    return 2;
  }
  const attempt = Number(attemptRaw);
  const { acquireRunLock, releaseRunLock, appendJournal } = await import("./state.mjs");
  try {
    acquireRunLock(target.runDir, { recover: Boolean(flags["--recover-lock"]) });
  } catch (error) {
    process.stderr.write(`cli: run lock refused: ${error.message}\n`);
    return 3;
  }
  try {
    const attemptDir = join(target.runDir, "attempts", taskId, arm, `attempt-${String(attempt).padStart(3, "0")}`);
    const receiptPath = join(attemptDir, "provider-invocation.json");
    if (!existsSync(receiptPath)) {
      process.stderr.write("cli: masking-abandon needs a reserved slot with a receipt\n");
      return 2;
    }
    if (existsSync(join(attemptDir, "result.json"))) {
      process.stderr.write("cli: the slot already has a terminal result; nothing to abandon\n");
      return 2;
    }
    // The receipt must identify this exact slot.
    let receipt;
    try {
      receipt = JSON.parse(readFileSync(receiptPath, "utf8"));
    } catch {
      process.stderr.write("cli: the receipt is not valid JSON; refusing to abandon\n");
      return 2;
    }
    if (
      receipt.taskId !== taskId ||
      receipt.arm !== arm ||
      receipt.attempt !== attempt ||
      receipt.runId !== target.runId ||
      receipt.fake !== false
    ) {
      process.stderr.write("cli: the receipt does not identify this slot; refusing to abandon\n");
      return 2;
    }
    const runPath = join(target.runDir, "run.json");
    const run = JSON.parse(readFileSync(runPath, "utf8"));
    // Invalidate the run first. A crash after this point cannot resume paid execution.
    const runTempPath = `${runPath}.tmp`;
    writeFileSync(runTempPath, `${JSON.stringify({ ...run, invalid: true, invalidReason: reason }, null, 2)}\n`, "utf8");
    renameSync(runTempPath, runPath);
    writeFileSync(
      join(attemptDir, "result.json"),
      `${JSON.stringify({
        schemaVersion: 1,
        study: "masking",
        runId: target.runId,
        taskId,
        arm,
        rep: attempt,
        status: "abandoned",
        reason,
        abandonedAt: new Date().toISOString(),
      }, null, 2)}\n`,
      "utf8",
    );
    appendJournal(target.runDir, { type: "slot-abandoned", taskId, arm, attempt, reason });
    process.stdout.write(`${JSON.stringify({ runId: target.runId, taskId, arm, attempt, status: "abandoned", runInvalid: true })}\n`);
    return 0;
  } finally {
    releaseRunLock(target.runDir);
  }
}

function cmdMaskingReport(flags) {
  const target = requireMaskingRunDir(flags);
  if (!target) return 2;
  if (!existsSync(target.runDir)) {
    process.stderr.write(`cli: unknown masking run ${target.runId} under ${target.runsDir}\n`);
    return 2;
  }
  const report = maskingReport({ repoRoot, ...target });
  process.stdout.write(`${JSON.stringify(report)}\n`);
  return report.passing ? 0 : 6;
}

function cmdValidate() {
  const manifest = loadManifestFile(join(repoRoot, "evaluation", "task-manifest.json"));
  for (const task of manifest.tasks) {
    loadTaskData(repoRoot, task.id);
  }
  process.stdout.write(
    `validate: ok (schemaVersion ${manifest.schemaVersion}, ${manifest.tasks.length} tasks)\n`,
  );
  return 0;
}

if (process.argv[1] && import.meta.url === pathToFileURL(process.argv[1]).href) {
  Promise.resolve(cliMain(process.argv.filter((_, index) => index > 1))).then((code) => process.exit(code));
}

// Timeout fault path (red-driven): spawn fake-pi.mjs in its own process
// group and let the runner own the timeout with SIGTERM then SIGKILL.
export async function executeFaultAttempt({ runDir, runId, task, arm, attempt, attemptDir, behavior }) {
  const { runSubprocess } = await import("./spawn.mjs");
  const worktree = join(attemptDir, "worktree");
  const cacheRoot = fixturesCacheRoot(repoRoot);
  let fixtureDir = join(cacheRoot, task.id);
  if (!existsSync(join(fixtureDir, ".git"))) {
    fixtureDir = publishFixtureCache({ repoRoot, task, cacheRoot });
  }
  cpSync(fixtureDir, worktree, { recursive: true, dot: true });
  const sessions = join(attemptDir, "sessions");
  const home = join(attemptDir, "home");
  mkdirSync(sessions, { recursive: true });
  mkdirSync(home, { recursive: true });
  const { solution } = loadTaskData(repoRoot, task.id);
  const scenarioPath = join(attemptDir, "scenario.json");
  writeFileSync(scenarioPath, `${JSON.stringify({ taskId: task.id, arm, attempt, behavior, solution })}\n`, "utf8");
  const invocationsPath = join(attemptDir, "invocations.jsonl");
  const startedMs = Date.now();
  const outcome = await runSubprocess({
    argv: [process.execPath, join(repoRoot, "evaluation", "runner", "fake-pi.mjs"), "--session-dir", sessions, task.prompt],
    cwd: worktree,
    env: { PATH: process.env.PATH ?? "/usr/bin:/bin", HOME: home, FAKE_PI_SCENARIO: scenarioPath, FAKE_PI_INVOCATIONS: invocationsPath },
    timeoutMs: 5_000,
    stdoutPath: join(attemptDir, "pi-stdout.jsonl"),
    stderrPath: join(attemptDir, "pi-stderr.txt"),
  });
  const stdoutText = readFileSync(join(attemptDir, "pi-stdout.jsonl"), "utf8");
  const lines = stdoutText.split("\n").filter((line) => line.trim().length > 0);
  const malformedLines = [];
  const events = [];
  lines.forEach((line, index) => {
    try {
      events.push(JSON.parse(line));
    } catch {
      malformedLines.push(index + 1);
    }
  });
  const usage = { input: null, output: null, cacheRead: null, cacheWrite: null };
  let sawUsageField = { input: false, output: false, cacheRead: false, cacheWrite: false };
  for (const event of events) {
    if (event?.type === "message_end" && event?.message?.role === "assistant") {
      const source = event.message.usage;
      if (source) {
        for (const field of ["input", "output", "cacheRead", "cacheWrite"]) {
          if (typeof source[field] === "number") {
            sawUsageField[field] = true;
            usage[field] = (usage[field] ?? 0) + source[field];
          }
        }
      }
    }
  }
  for (const field of ["input", "output", "cacheRead", "cacheWrite"]) {
    if (!sawUsageField[field]) usage[field] = null;
  }
  const scorerResult = scoreWorktree({ repoRoot, worktree, taskId: task.id });
  writeFileSync(join(attemptDir, "scorer.json"), `${JSON.stringify(scorerResult, null, 2)}\n`, "utf8");
  // Final repository collection runs before the fault attempt reaches
  // terminal completion; a collection error overrides the fault status.
  const collection = await collectFinalState({ worktree, outDir: join(attemptDir, "final-state") });
  writeFileSync(join(attemptDir, "final-state.json"), `${JSON.stringify(collection, null, 2)}\n`, "utf8");
  appendJournal(runDir, { type: "attempt-collected", taskId: task.id, arm, attempt, status: collection.status });
  const status = collection.status === "error" ? "collection-error" : outcome.timedOut ? "timeout" : outcome.signal ? "interrupted" : outcome.code === 0 ? "completed" : "failed";
  const result = {
    schemaVersion: 1,
    runId,
    taskId: task.id,
    arm,
    attempt,
    status,
    durationMs: Date.now() - startedMs,
    exit: { code: outcome.code, signal: outcome.signal, timedOut: outcome.timedOut, spawnError: outcome.spawnError },
    usage,
    jsonl: { lines: lines.length, malformedLines },
    scorer: { status: scorerResult.status, passedCount: scorerResult.passedCount, totalCount: scorerResult.totalCount, error: scorerResult.error },
    collection: {
      status: collection.status,
      errors: collection.errors,
      artifacts: collection.artifacts.map(({ name, file, bytes, sha256 }) => ({ name, file, bytes, sha256 })),
    },
    failures: [`exit ${outcome.code ?? `signal ${outcome.signal}`}${outcome.timedOut ? " (timeout)" : ""}`],
  };
  writeFileSync(join(attemptDir, "result.json"), `${JSON.stringify(result, null, 2)}\n`, "utf8");
  appendJournal(runDir, { type: "attempt-finished", taskId: task.id, arm, attempt, status });
  writeSnapshot(runDir, snapshotAfter(runDir, task.id, arm, attempt, status));
  return { taskId: task.id, arm, status };
}
