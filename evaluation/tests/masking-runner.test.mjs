/**
 * Masking study runner tests.
 *
 * Slice 1: prepare persists randomized arm order and repetition order
 * before any attempt exists.
 */

import { test, describe } from "node:test";
import assert from "node:assert/strict";
import { mkdtempSync, rmSync, readFileSync, existsSync, writeFileSync, readdirSync } from "node:fs";
import { tmpdir } from "node:os";
import { join, dirname } from "node:path";
import { fileURLToPath } from "node:url";
import { maskingPrepare, maskingDryRun, maskingReport, maskingRealRun } from "../runner/masking.mjs";

const repoRoot = join(dirname(fileURLToPath(import.meta.url)), "..", "..");

describe("masking runner prepare", () => {
  test("persists arm order and repetition order before execution", () => {
    const runsDir = mkdtempSync(join(tmpdir(), "cm-masking-"));
    try {
      maskingPrepare({ repoRoot, runsDir, runId: "masking-run-01", mode: "dry-run" });
      const runDir = join(runsDir, "masking-run-01");
      const persisted = JSON.parse(readFileSync(join(runDir, "run.json"), "utf8"));
      assert.equal(persisted.study, "masking");
      assert.equal(persisted.mode, "dry-run");
      assert.equal(Object.keys(persisted.armOrder).length, 8);
      assert.equal(Object.keys(persisted.repetitionOrder).length, 8);
      for (const [taskId, order] of Object.entries(persisted.armOrder)) {
        assert.deepEqual([...order].sort(), ["fork", "upstream"], `${taskId} needs both arms`);
      }
      for (const [taskId, reps] of Object.entries(persisted.repetitionOrder)) {
        assert.deepEqual([...reps].sort(), [1, 2, 3], `${taskId} needs three repetitions`);
      }
      assert.match(persisted.profileSha256, /^[0-9a-f]{64}$/);
      assert.equal(persisted.provider, "z-ai");
      assert.equal(persisted.model, "glm-5.3-flash");
      assert.equal(existsSync(join(runDir, "attempts")), false, "no attempts may exist at prepare time");
      const journal = readFileSync(join(runDir, "journal.jsonl"), "utf8").trim().split("\n");
      assert.ok(journal.some((line) => JSON.parse(line).type === "arm-order-persisted"));
      assert.ok(journal.some((line) => JSON.parse(line).type === "repetition-order-persisted"));
    } finally {
      rmSync(runsDir, { recursive: true, force: true });
    }
  });

  test("dry-run executes three repetitions per task and arm with fresh isolation", async () => {
    const runsDir = mkdtempSync(join(tmpdir(), "cm-masking-dry-"));
    try {
      maskingPrepare({ repoRoot, runsDir, runId: "masking-dry-01", mode: "dry-run" });
      const outcome = await maskingDryRun({ repoRoot, runsDir, runId: "masking-dry-01" });
      assert.equal(outcome.executed, 48, "8 tasks x 2 arms x 3 repetitions");
      const runDir = join(runsDir, "masking-dry-01");
      for (const number of [1, 2, 3, 4, 5, 6, 7, 8]) {
        const taskId = `masking-task-${String(number).padStart(2, "0")}`;
        for (const arm of ["upstream", "fork"]) {
          for (const rep of [1, 2, 3]) {
            const attemptDir = join(runDir, "attempts", taskId, arm, `attempt-${String(rep).padStart(3, "0")}`);
            assert.ok(existsSync(join(attemptDir, "result.json")), `${taskId}/${arm}/${rep} needs a result`);
            assert.ok(existsSync(join(attemptDir, "instrumentation.json")), `${taskId}/${arm}/${rep} needs instrumentation`);
            assert.ok(existsSync(join(attemptDir, "worktree")), `${taskId}/${arm}/${rep} needs a fresh worktree`);
            assert.ok(existsSync(join(attemptDir, "home")), `${taskId}/${arm}/${rep} needs a fresh home`);
            const result = JSON.parse(readFileSync(join(attemptDir, "result.json"), "utf8"));
            assert.equal(result.status, "completed");
            assert.equal(result.rep, rep);
            const instrumentation = JSON.parse(readFileSync(join(attemptDir, "instrumentation.json"), "utf8"));
            assert.equal(instrumentation.repetition, rep);
            assert.equal(instrumentation.arm, arm);
          }
        }
      }
    } finally {
      rmSync(runsDir, { recursive: true, force: true });
    }
  });

  test("fake attempts carry separated savings ledgers, recovery results, receipts, and pins", async () => {
    const runsDir = mkdtempSync(join(tmpdir(), "cm-masking-inst-"));
    try {
      maskingPrepare({ repoRoot, runsDir, runId: "masking-inst-01", mode: "dry-run" });
      await maskingDryRun({ repoRoot, runsDir, runId: "masking-inst-01" });
      const runDir = join(runsDir, "masking-inst-01");
      const base = join(runDir, "attempts", "masking-task-08");
      const forkInstrumentation = JSON.parse(readFileSync(join(base, "fork", "attempt-001", "instrumentation.json"), "utf8"));
      assert.equal(forkInstrumentation.recoveryResult, "archive");
      assert.equal(forkInstrumentation.retrievalCalls, 1);
      assert.ok(forkInstrumentation.returnedBytes > 0);
      assert.ok(forkInstrumentation.estimatedTokensSavedSemantic > 0);
      assert.ok(forkInstrumentation.estimatedTokensSavedHistorical > 0);
      assert.equal(forkInstrumentation.cost, null, "fake provider metrics must stay null");
      assert.equal(forkInstrumentation.usage.cacheRead, null, "missing cache metrics stay null");
      const upstreamInstrumentation = JSON.parse(readFileSync(join(base, "upstream", "attempt-001", "instrumentation.json"), "utf8"));
      assert.equal(upstreamInstrumentation.recoveryResult, "rerun");
      assert.equal(upstreamInstrumentation.reruns, 1);
      const forkAttempt = join(base, "fork", "attempt-001");
      const receipt = JSON.parse(readFileSync(join(forkAttempt, "provider-invocation.json"), "utf8"));
      assert.equal(receipt.fake, true);
      const pinned = JSON.parse(readFileSync(join(forkAttempt, "pinned.json"), "utf8"));
      assert.equal(pinned.armCommit, "fca546506e3c6b26401155a780052646a65dee38");
      assert.match(pinned.profileSha256, /^[0-9a-f]{64}$/);
      const solved = readFileSync(join(forkAttempt, "worktree", "ROOTCAUSE.md"), "utf8");
      assert.ok(solved.includes("E-7721"), "worktree must be a fresh fixture copy with the reference solution applied");
      const plainTask = JSON.parse(readFileSync(join(runDir, "attempts", "masking-task-01", "fork", "attempt-002", "instrumentation.json"), "utf8"));
      assert.equal(plainTask.recoveryResult, "none");
    } finally {
      rmSync(runsDir, { recursive: true, force: true });
    }
  });

  test("report enforces gates, emits sanitized rows, intervals, and an artifact index", async () => {
    const runsDir = mkdtempSync(join(tmpdir(), "cm-masking-report-"));
    try {
      maskingPrepare({ repoRoot, runsDir, runId: "masking-report-01", mode: "dry-run" });
      await maskingDryRun({ repoRoot, runsDir, runId: "masking-report-01" });
      const report = maskingReport({ repoRoot, runsDir, runId: "masking-report-01" });
      assert.equal(report.passing, true, `gates must pass: ${JSON.stringify(report.gates)}`);
      assert.equal(report.gates.activation.pass, true);
      assert.equal(report.gates.correctness.pass, true);
      assert.equal(report.gates.diagnostics.pass, true);
      assert.equal(report.gates.recoverability.pass, true);
      assert.equal(report.gates.secrets.pass, true);
      assert.equal(report.gates.ordering.pass, true);
      const runDir = join(runsDir, "masking-report-01");
      const summary = JSON.parse(readFileSync(join(runDir, "masking-summary.json"), "utf8"));
      assert.equal(summary.rows, 48);
      assert.equal(summary.pairs.valid, 24);
      const rows = JSON.parse(readFileSync(join(runDir, "masking-rows.json"), "utf8"));
      assert.equal(rows.length, 48);
      const row = rows[0];
      assert.deepEqual(
        Object.keys(row).sort(),
        [
          "archivedBytes", "arm", "correctness", "cost", "diagnosticPresent",
          "estimatedTokensSavedHistorical", "estimatedTokensSavedSemantic", "firstEventLatencyMs",
          "historicalMaskEvents", "nonTextOrderingIncidents", "originalBytes", "recoveryResult",
          "removedBytes", "rep", "rereads", "reruns", "retrievalCalls", "returnedBytes",
          "secretIncidents", "semanticTransforms", "status", "taskId", "usageCacheRead",
          "usageCacheWrite", "usageInput", "usageOutput", "visibleBytes", "wallTimeMs",
        ].sort(),
        "sanitized row keys must be the expanded approved allowlist",
      );
      const pairs = JSON.parse(readFileSync(join(runDir, "masking-pairs.json"), "utf8"));
      assert.equal(pairs.aggregate.estimatedTokensSavedHistorical.method, "paired-bootstrap-percentile");
      assert.ok(typeof pairs.aggregate.estimatedTokensSavedHistorical.low === "number");
      assert.equal(pairs.aggregate.estimatedTokensSavedHistorical.n, 24);
      const index = JSON.parse(readFileSync(join(runDir, "artifact-index.json"), "utf8"));
      assert.ok(index.artifacts.length >= 1);
      const body = readFileSync(join(runDir, "masking-rows.json"), "utf8");
      assert.equal(body.includes("worktree"), false, "sanitized rows must not contain paths");
      assert.equal(body.includes("glm-5.3-flash"), false, "sanitized rows must not contain model ids");
      const markdown = readFileSync(join(runDir, "masking-summary.md"), "utf8");
      assert.ok(markdown.includes("# Masking study run"));
      assert.ok(markdown.includes("passing: true"));
    } finally {
      rmSync(runsDir, { recursive: true, force: true });
    }
  });

  test("an activation gate failure makes the report non-passing", async () => {
    const runsDir = mkdtempSync(join(tmpdir(), "cm-masking-activation-"));
    try {
      maskingPrepare({ repoRoot, runsDir, runId: "masking-activation-01", mode: "dry-run" });
      await maskingDryRun({ repoRoot, runsDir, runId: "masking-activation-01" });
      const flatAttempt = join(runsDir, "masking-activation-01", "attempts", "masking-task-01", "fork", "attempt-002");
      const flat = JSON.parse(readFileSync(join(flatAttempt, "instrumentation.json"), "utf8"));
      flat.historicalMaskEvents = 0;
      writeFileSync(join(flatAttempt, "instrumentation.json"), `${JSON.stringify(flat, null, 2)}\n`, "utf8");
      const failed = maskingReport({ repoRoot, runsDir, runId: "masking-activation-01" });
      assert.equal(failed.gates.activation.pass, false);
      assert.equal(failed.passing, false);
    } finally {
      rmSync(runsDir, { recursive: true, force: true });
    }
  });

  test("missing secret or ordering fields are null and fail their gates", async () => {
    const runsDir = mkdtempSync(join(tmpdir(), "cm-masking-nulls-"));
    try {
      maskingPrepare({ repoRoot, runsDir, runId: "masking-nulls-01", mode: "dry-run" });
      await maskingDryRun({ repoRoot, runsDir, runId: "masking-nulls-01" });
      const attemptDir = join(runsDir, "masking-nulls-01", "attempts", "masking-task-01", "upstream", "attempt-001");
      const instrumentation = JSON.parse(readFileSync(join(attemptDir, "instrumentation.json"), "utf8"));
      delete instrumentation.secretIncidents;
      delete instrumentation.nonTextOrderingIncidents;
      writeFileSync(join(attemptDir, "instrumentation.json"), `${JSON.stringify(instrumentation, null, 2)}\n`, "utf8");
      const report = maskingReport({ repoRoot, runsDir, runId: "masking-nulls-01" });
      const row = JSON.parse(readFileSync(join(runsDir, "masking-nulls-01", "masking-rows.json"), "utf8")).find((entry) => entry.arm === "upstream" && entry.rep === 1 && entry.taskId === "masking-task-01");
      assert.equal(row.secretIncidents, null, "missing sentinel fields stay null in public rows");
      assert.equal(report.gates.secrets.pass, false, "a missing sentinel field must fail the privacy gate");
      assert.equal(report.gates.ordering.pass, false, "a missing ordering field must fail the ordering gate");
      assert.equal(report.passing, false);
    } finally {
      rmSync(runsDir, { recursive: true, force: true });
    }
  });

  test("fake pins carry per-arm implementation digests and observer digests matching the run", async () => {
    const runsDir = mkdtempSync(join(tmpdir(), "cm-masking-fakepins-"));
    try {
      maskingPrepare({ repoRoot, runsDir, runId: "masking-fakepins-01", mode: "dry-run" });
      await maskingDryRun({ repoRoot, runsDir, runId: "masking-fakepins-01" });
      const runDir = join(runsDir, "masking-fakepins-01");
      const run = JSON.parse(readFileSync(join(runDir, "run.json"), "utf8"));
      for (const arm of ["upstream", "fork"]) {
        const pinned = JSON.parse(readFileSync(join(runDir, "attempts", "masking-task-01", arm, "attempt-001", "pinned.json"), "utf8"));
        assert.equal(pinned.implementationSha256, run.armImplementationSha256[arm], "fake pins must match the run digest per arm");
        assert.match(pinned.observerSha256, /^[0-9a-f]{64}$/);
        assert.match(pinned.observerWrapperSha256, /^[0-9a-f]{64}$/);
      }
    } finally {
      rmSync(runsDir, { recursive: true, force: true });
    }
  });

  test("a vacuous recovery gate fails when archived bytes or references are zero", async () => {
    const runsDir = mkdtempSync(join(tmpdir(), "cm-masking-vacuous-"));
    try {
      maskingPrepare({ repoRoot, runsDir, runId: "masking-vacuous-01", mode: "dry-run" });
      await maskingDryRun({ repoRoot, runsDir, runId: "masking-vacuous-01" });
      const attemptDir = join(runsDir, "masking-vacuous-01", "attempts", "masking-task-08", "fork", "attempt-001");
      const instrumentation = JSON.parse(readFileSync(join(attemptDir, "instrumentation.json"), "utf8"));
      instrumentation.archivedBytes = 0;
      instrumentation.archiveReferences = 0;
      writeFileSync(join(attemptDir, "instrumentation.json"), `${JSON.stringify(instrumentation, null, 2)}\n`, "utf8");
      const failed = maskingReport({ repoRoot, runsDir, runId: "masking-vacuous-01" });
      assert.equal(failed.gates.recoverability.pass, false, "a required recovery attempt with zero archive evidence must fail");
      assert.equal(failed.passing, false);
    } finally {
      rmSync(runsDir, { recursive: true, force: true });
    }
  });

  test("a recovery gate failure makes the report non-passing", async () => {
    const runsDir = mkdtempSync(join(tmpdir(), "cm-masking-recovery-"));
    try {
      maskingPrepare({ repoRoot, runsDir, runId: "masking-recovery-01", mode: "dry-run" });
      await maskingDryRun({ repoRoot, runsDir, runId: "masking-recovery-01" });
      const recoveryAttempt = join(runsDir, "masking-recovery-01", "attempts", "masking-task-08", "fork", "attempt-001");
      const recovery = JSON.parse(readFileSync(join(recoveryAttempt, "instrumentation.json"), "utf8"));
      recovery.retrievalCalls = 0;
      recovery.returnedBytes = 0;
      writeFileSync(join(recoveryAttempt, "instrumentation.json"), `${JSON.stringify(recovery, null, 2)}\n`, "utf8");
      const failed = maskingReport({ repoRoot, runsDir, runId: "masking-recovery-01" });
      assert.equal(failed.gates.recoverability.pass, false);
      assert.equal(failed.passing, false);
    } finally {
      rmSync(runsDir, { recursive: true, force: true });
    }
  });

  test("paid masking execution refuses before any reservation instead of bypassing real controls", async () => {
    const runsDir = mkdtempSync(join(tmpdir(), "cm-masking-paid-"));
    try {
      maskingPrepare({ repoRoot, runsDir, runId: "masking-paid-01", mode: "real" });
      let refused = null;
      try {
        await maskingRealRun({ repoRoot, runsDir, runId: "masking-paid-01", flags: { "--confirm-paid": true } });
      } catch (error) {
        refused = error;
      }
      assert.ok(refused, "real masking execution must refuse");
      assert.match(refused.message, /preflight refused|mode /i);
      assert.equal(existsSync(join(runsDir, "masking-paid-01", "attempts")), false, "refusal must happen before any reservation");
    } finally {
      rmSync(runsDir, { recursive: true, force: true });
    }
  });

  test("activation must hold in both arms and passing requires exactly 24 valid pairs", async () => {
    const runsDir = mkdtempSync(join(tmpdir(), "cm-masking-botharms-"));
    try {
      maskingPrepare({ repoRoot, runsDir, runId: "masking-botharms-01", mode: "dry-run" });
      await maskingDryRun({ repoRoot, runsDir, runId: "masking-botharms-01" });
      const runDir = join(runsDir, "masking-botharms-01");
      const upstreamAttempt = join(runDir, "attempts", "masking-task-01", "upstream", "attempt-001");
      const upstream = JSON.parse(readFileSync(join(upstreamAttempt, "instrumentation.json"), "utf8"));
      upstream.historicalMaskEvents = 0;
      upstream.semanticTransforms = 0;
      upstream.activatedFilterIds = [];
      writeFileSync(join(upstreamAttempt, "instrumentation.json"), `${JSON.stringify(upstream, null, 2)}\n`, "utf8");
      let failed = maskingReport({ repoRoot, runsDir, runId: "masking-botharms-01" });
      assert.equal(failed.gates.activation.pass, false, "upstream activation failure must fail the gate");
      assert.equal(failed.passing, false);
      upstream.historicalMaskEvents = 1;
      upstream.semanticTransforms = 0;
      upstream.activatedFilterIds = [];
      writeFileSync(join(upstreamAttempt, "instrumentation.json"), `${JSON.stringify(upstream, null, 2)}\n`, "utf8");
      failed = maskingReport({ repoRoot, runsDir, runId: "masking-botharms-01" });
      assert.equal(failed.gates.activation.pass, true);
      // One missing attempt makes the pair set incomplete: not passing.
      rmSync(join(runDir, "attempts", "masking-task-02", "fork", "attempt-003", "result.json"), { force: true });
      failed = maskingReport({ repoRoot, runsDir, runId: "masking-botharms-01" });
      assert.equal(failed.pairs.valid, 23);
      assert.equal(failed.pairs.incomplete, 1);
      assert.equal(failed.passing, false, "passing requires all 24 pairs valid");
    } finally {
      rmSync(runsDir, { recursive: true, force: true });
    }
  });

  test("sanitized rows carry the full approved set and reject bad values", async () => {
    const { sanitizeMaskingRow } = await import("../runner/masking.mjs");
    const bad = sanitizeMaskingRow({
      taskId: "masking-task-01",
      arm: "fork",
      rep: -1,
      status: "completed",
      historicalMaskEvents: -3,
      usageInput: Number.NaN,
      usageOutput: Number.POSITIVE_INFINITY,
      wallTimeMs: "fast",
      recoveryResult: "teleported",
      cost: "cheap",
      commandText: "grep secret /etc/passwd",
      prompt: "leak",
      provider: "z-ai",
      worktree: "/tmp/x",
      digest: "0".repeat(64),
    });
    assert.equal(bad.taskId, "masking-task-01");
    assert.equal(bad.arm, "fork");
    assert.equal(bad.status, "completed");
    assert.equal(bad.rep, undefined, "negative rep must be dropped");
    assert.equal(bad.historicalMaskEvents, undefined, "negative counts must be dropped");
    assert.equal(bad.usageInput, undefined, "NaN must be dropped");
    assert.equal(bad.usageOutput, undefined, "Infinity must be dropped");
    assert.equal(bad.wallTimeMs, undefined, "non-numeric wall time must be dropped");
    assert.equal(bad.recoveryResult, undefined, "undefined enum values must be dropped");
    assert.equal(bad.cost, undefined, "non-null non-numeric cost must be dropped");
    assert.equal(bad.commandText, undefined);
    assert.equal(bad.prompt, undefined);
    assert.equal(bad.provider, undefined);
    assert.equal(bad.worktree, undefined);
    assert.equal(bad.digest, undefined);
    const runsDir = mkdtempSync(join(tmpdir(), "cm-masking-rows-"));
    try {
      maskingPrepare({ repoRoot, runsDir, runId: "masking-rows-01", mode: "dry-run" });
      await maskingDryRun({ repoRoot, runsDir, runId: "masking-rows-01" });
      maskingReport({ repoRoot, runsDir, runId: "masking-rows-01" });
      const rows = JSON.parse(readFileSync(join(runsDir, "masking-rows-01", "masking-rows.json"), "utf8"));
      const row = rows[0];
      for (const field of [
        "semanticTransforms", "originalBytes", "visibleBytes", "removedBytes", "archivedBytes",
        "estimatedTokensSavedSemantic", "estimatedTokensSavedHistorical", "usageInput", "usageOutput",
        "usageCacheRead", "usageCacheWrite", "wallTimeMs", "firstEventLatencyMs", "retrievalCalls",
        "reruns", "rereads", "correctness", "recoveryResult", "secretIncidents", "nonTextOrderingIncidents",
        "historicalMaskEvents",
      ]) {
        assert.ok(Object.prototype.hasOwnProperty.call(row, field), `row missing ${field}`);
      }
    } finally {
      rmSync(runsDir, { recursive: true, force: true });
    }
  });

  test("tampered profile, scorer, and runtime pins invalidate pairs; rows stay consistent with the summary", async () => {
    const runsDir = mkdtempSync(join(tmpdir(), "cm-masking-pins-"));
    try {
      maskingPrepare({ repoRoot, runsDir, runId: "masking-pins-01", mode: "dry-run" });
      await maskingDryRun({ repoRoot, runsDir, runId: "masking-pins-01" });
      const runDir = join(runsDir, "masking-pins-01");
      const pinnedPath = join(runDir, "attempts", "masking-task-02", "fork", "attempt-001", "pinned.json");
      const pinned = JSON.parse(readFileSync(pinnedPath, "utf8"));
      pinned.profileSha256 = "1".repeat(64);
      writeFileSync(pinnedPath, `${JSON.stringify(pinned, null, 2)}\n`, "utf8");
      let failed = maskingReport({ repoRoot, runsDir, runId: "masking-pins-01" });
      assert.equal(failed.pairs.invalid, 1);
      assert.equal(failed.passing, false);
      pinned.profileSha256 = JSON.parse(readFileSync(join(runDir, "attempts", "masking-task-02", "upstream", "attempt-001", "pinned.json"), "utf8")).profileSha256;
      pinned.scorerSha256 = "2".repeat(64);
      writeFileSync(pinnedPath, `${JSON.stringify(pinned, null, 2)}\n`, "utf8");
      failed = maskingReport({ repoRoot, runsDir, runId: "masking-pins-01" });
      assert.equal(failed.pairs.invalid, 1);
      pinned.scorerSha256 = null;
      pinned.piRuntime = { digest: "3".repeat(64) };
      writeFileSync(pinnedPath, `${JSON.stringify(pinned, null, 2)}\n`, "utf8");
      failed = maskingReport({ repoRoot, runsDir, runId: "masking-pins-01" });
      assert.equal(failed.pairs.invalid, 1, "runtime digest mismatch must invalidate by value");
      // Consistency: sanitized rows and summary agree after regeneration.
      const summary = JSON.parse(readFileSync(join(runDir, "masking-summary.json"), "utf8"));
      const rows = JSON.parse(readFileSync(join(runDir, "masking-rows.json"), "utf8"));
      assert.equal(rows.length, summary.rows);
      assert.equal(rows.filter((row) => row.arm === "fork").length, 24);
      const pairs = JSON.parse(readFileSync(join(runDir, "masking-pairs.json"), "utf8"));
      assert.equal(pairs.aggregate.estimatedTokensSavedHistorical.n, summary.pairs.valid);
    } finally {
      rmSync(runsDir, { recursive: true, force: true });
    }
  });

  test("independently wrong pins that stay cross-arm equal all invalidate", async () => {
    const runsDir = mkdtempSync(join(tmpdir(), "cm-masking-independent-"));
    try {
      maskingPrepare({ repoRoot, runsDir, runId: "masking-independent-01", mode: "dry-run" });
      await maskingDryRun({ repoRoot, runsDir, runId: "masking-independent-01" });
      const runDir = join(runsDir, "masking-independent-01");
      const { maskingScorerSha256: scorerOf } = await import("../lib/masking-manifest.mjs");
      const promptLib = await import("../runner/prompt.mjs");
      const manifest = JSON.parse(readFileSync(join(repoRoot, "evaluation", "masking-task-manifest.json"), "utf8"));
      const setBothArms = (mutate) => {
        for (const arm of ["upstream", "fork"]) {
          const pinnedPath = join(runDir, "attempts", "masking-task-01", arm, "attempt-001", "pinned.json");
          const pinned = JSON.parse(readFileSync(pinnedPath, "utf8"));
          mutate(pinned);
          writeFileSync(pinnedPath, `${JSON.stringify(pinned, null, 2)}\n`, "utf8");
        }
      };
      const expectInvalid = (label) => {
        const report = maskingReport({ repoRoot, runsDir, runId: "masking-independent-01" });
        assert.equal(report.pairs.invalid, 1, `${label} must invalidate independently`);
      };
      setBothArms((pinned) => {
        pinned.scorerSha256 = "9".repeat(64);
      });
      expectInvalid("scorer digest vs maskingScorerSha256");
      setBothArms((pinned) => {
        pinned.scorerSha256 = scorerOf(repoRoot, "masking-task-01");
        pinned.profileSha256 = "8".repeat(64);
      });
      expectInvalid("profile digest vs run pin");
      setBothArms((pinned) => {
        pinned.profileSha256 = JSON.parse(readFileSync(join(runDir, "run.json"), "utf8")).profileSha256;
        pinned.promptSha256 = promptLib.sha256Text(promptLib.sha256Text("x"));
      });
      expectInvalid("prompt hash vs buildAttemptPrompt");
      setBothArms((pinned) => {
        pinned.promptSha256 = promptLib.sha256Text(promptLib.buildAttemptPrompt(manifest.tasks[0].prompt));
        pinned.provider = "other";
      });
      expectInvalid("provider vs manifest");
      setBothArms((pinned) => {
        pinned.provider = manifest.evaluation.provider;
        pinned.thinking = "medium";
      });
      expectInvalid("thinking vs manifest");
      setBothArms((pinned) => {
        pinned.thinking = manifest.evaluation.thinking;
        pinned.study = "other";
      });
      expectInvalid("study vs manifest constant");
      // Fixture digests must authenticate against fixture-before.json.
      for (const arm of ["upstream", "fork"]) {
        const attemptDir = join(runDir, "attempts", "masking-task-01", arm, "attempt-001");
        const record = JSON.parse(readFileSync(join(attemptDir, "pinned.json"), "utf8"));
        record.fixtureContentSha256 = "7".repeat(64);
        record.fixtureGitStateSha256 = "7".repeat(64);
        writeFileSync(join(attemptDir, "pinned.json"), `${JSON.stringify(record, null, 2)}\n`, "utf8");
      }
      expectInvalid("fixture digests vs fixture-before.json");
    } finally {
      rmSync(runsDir, { recursive: true, force: true });
    }
  });

  test("tampered implementation or observer pins invalidate the pair", async () => {
    const runsDir = mkdtempSync(join(tmpdir(), "cm-masking-impltamper-"));
    try {
      maskingPrepare({ repoRoot, runsDir, runId: "masking-impltamper-01", mode: "dry-run" });
      await maskingDryRun({ repoRoot, runsDir, runId: "masking-impltamper-01" });
      const runDir = join(runsDir, "masking-impltamper-01");
      const pinnedPath = join(runDir, "attempts", "masking-task-01", "fork", "attempt-001", "pinned.json");
      const pinned = JSON.parse(readFileSync(pinnedPath, "utf8"));
      pinned.implementationSha256 = "0".repeat(64);
      writeFileSync(pinnedPath, `${JSON.stringify(pinned, null, 2)}\n`, "utf8");
      let report = maskingReport({ repoRoot, runsDir, runId: "masking-impltamper-01" });
      assert.equal(report.pairs.invalid, 1, "an implementation digest that misses the run pin must invalidate");
      pinned.implementationSha256 = JSON.parse(readFileSync(join(runDir, "run.json"), "utf8")).armImplementationSha256.fork;
      pinned.observerSha256 = "1".repeat(64);
      writeFileSync(pinnedPath, `${JSON.stringify(pinned, null, 2)}\n`, "utf8");
      report = maskingReport({ repoRoot, runsDir, runId: "masking-impltamper-01" });
      assert.equal(report.pairs.invalid, 1, "an observer digest that misses the regenerated bytes must invalidate");
      pinned.observerSha256 = null;
      pinned.observerWrapperSha256 = "2".repeat(64);
      writeFileSync(pinnedPath, `${JSON.stringify(pinned, null, 2)}\n`, "utf8");
      report = maskingReport({ repoRoot, runsDir, runId: "masking-impltamper-01" });
      assert.equal(report.pairs.invalid, 1, "a wrapper digest that misses the regenerated bytes must invalidate");
    } finally {
      rmSync(runsDir, { recursive: true, force: true });
    }
  });

  test("a tampered fixture pin invalidates the pair and fails the report", async () => {
    const runsDir = mkdtempSync(join(tmpdir(), "cm-masking-tamper-"));
    try {
      maskingPrepare({ repoRoot, runsDir, runId: "masking-tamper-01", mode: "dry-run" });
      await maskingDryRun({ repoRoot, runsDir, runId: "masking-tamper-01" });
      const pinnedPath = join(
        runsDir, "masking-tamper-01", "attempts", "masking-task-03", "fork", "attempt-002", "pinned.json",
      );
      const pinned = JSON.parse(readFileSync(pinnedPath, "utf8"));
      assert.match(pinned.fixtureContentSha256, /^[0-9a-f]{64}$/);
      pinned.fixtureContentSha256 = "0".repeat(64);
      writeFileSync(pinnedPath, `${JSON.stringify(pinned, null, 2)}\n`, "utf8");
      const failed = maskingReport({ repoRoot, runsDir, runId: "masking-tamper-01" });
      assert.equal(failed.pairs.invalid, 1);
      assert.equal(failed.pairs.valid, 23);
      assert.equal(failed.passing, false);
    } finally {
      rmSync(runsDir, { recursive: true, force: true });
    }
  });

  test("fake correctness comes from the hidden scorer and null correctness fails gates", async () => {
    const runsDir = mkdtempSync(join(tmpdir(), "cm-masking-scorer-"));
    try {
      maskingPrepare({ repoRoot, runsDir, runId: "masking-scorer-01", mode: "dry-run" });
      await maskingDryRun({ repoRoot, runsDir, runId: "masking-scorer-01" });
      const dir = join(runsDir, "masking-scorer-01", "attempts", "masking-task-01", "fork", "attempt-001");
      const scorer = JSON.parse(readFileSync(join(dir, "scorer.json"), "utf8"));
      assert.equal(scorer.status, "passed");
      const instrumentation = JSON.parse(readFileSync(join(dir, "instrumentation.json"), "utf8"));
      assert.equal(instrumentation.correctness, true);
      instrumentation.correctness = null;
      writeFileSync(join(dir, "instrumentation.json"), `${JSON.stringify(instrumentation, null, 2)}\n`, "utf8");
      const failed = maskingReport({ repoRoot, runsDir, runId: "masking-scorer-01" });
      assert.equal(failed.gates.correctness.pass, false);
      assert.equal(failed.passing, false);
    } finally {
      rmSync(runsDir, { recursive: true, force: true });
    }
  });

  test("re-running the dry-run resumes without duplicating attempts", async () => {
    const runsDir = mkdtempSync(join(tmpdir(), "cm-masking-resume-"));
    try {
      maskingPrepare({ repoRoot, runsDir, runId: "masking-resume-01", mode: "dry-run" });
      const first = await maskingDryRun({ repoRoot, runsDir, runId: "masking-resume-01" });
      assert.equal(first.executed, 48);
      const second = await maskingDryRun({ repoRoot, runsDir, runId: "masking-resume-01" });
      assert.equal(second.executed, 0, "completed attempts must be skipped, not duplicated");
      const runDir = join(runsDir, "masking-resume-01");
      let attemptDirs = 0;
      for (const number of [1, 8]) {
        const taskId = `masking-task-${String(number).padStart(2, "0")}`;
        for (const arm of ["upstream", "fork"]) {
          attemptDirs += readdirSync(join(runDir, "attempts", taskId, arm)).length;
        }
      }
      assert.equal(attemptDirs, 12, "exactly three attempts per arm, no duplicates");
    } finally {
      rmSync(runsDir, { recursive: true, force: true });
    }
  });
});
