/**
 * Real-run retry integrity tests (public boundary: evaluation/runner/cli.mjs).
 *
 * Two contracts:
 * - `retry` on run.mode real is unsupported: it must refuse before any
 *   attempt reservation even with --allow-new-paid-attempt, leave
 *   run.json, the journal, the snapshot, and every attempt directory
 *   byte-identical, and never route the real run into the fake attempt
 *   path (no provider call, no execution artifacts). Dry-run retry
 *   behavior stays untouched.
 * - `select` and `report` validate the durable provider-invocation
 *   receipt of each selected attempt: real runs need a paid receipt
 *   (fake:false) with matching identity (runId/taskId/arm/attempt),
 *   expected provider/model/armCommit, and, when runtime pinning exists
 *   anywhere, a piRuntime digest matching pinned.json plus run.json;
 *   legacy real runs without any runtime digest allow an absent
 *   piRuntime; fake runs need fake:true. Missing, malformed, or
 *   mismatched receipts are invalid.
 *
 * Every fixture here is synthetic. No provider call is ever made.
 */

import { test, describe } from "node:test";
import assert from "node:assert/strict";
import { fileURLToPath } from "node:url";
import { dirname, join } from "node:path";
import {
  existsSync,
  mkdirSync,
  mkdtempSync,
  readFileSync,
  readdirSync,
  rmSync,
  statSync,
  writeFileSync,
} from "node:fs";
import { tmpdir } from "node:os";
import { spawnSync } from "node:child_process";
import { createHash } from "node:crypto";
import { loadManifestFile } from "../lib/manifest.mjs";
import { scorerDefinitionSha256 } from "../lib/scorer.mjs";
import { buildAttemptPrompt, sha256Text } from "../runner/prompt.mjs";

const repoRoot = join(dirname(fileURLToPath(import.meta.url)), "..", "..");
const cli = join(repoRoot, "evaluation", "runner", "cli.mjs");
const manifest = loadManifestFile(join(repoRoot, "evaluation", "task-manifest.json"));
const TASK_ID = "task-01";
const ARM_COMMITS = Object.fromEntries(manifest.evaluation.arms.map((arm) => [arm.name, arm.commit]));
const RUNTIME_PIN = { schemaVersion: 1, algorithm: "sha256", entryCount: 7, digest: `1f${"0".repeat(62)}` };
const OTHER_RUNTIME_PIN = { ...RUNTIME_PIN, digest: `ab${"0".repeat(62)}` };

function runCli(args, extra = {}) {
  return spawnSync(process.execPath, [cli, ...args], {
    cwd: repoRoot,
    encoding: "utf8",
    timeout: 120_000,
    ...extra,
  });
}

function writeJson(path, value) {
  mkdirSync(dirname(path), { recursive: true });
  writeFileSync(path, `${JSON.stringify(value, null, 2)}\n`, "utf8");
}

function attemptDirOf(runDir, taskId, arm, attempt) {
  return join(runDir, "attempts", taskId, arm, `attempt-${String(attempt).padStart(3, "0")}`);
}

function prepareRun(runsDir, runId, mode, { runtimePin = null } = {}) {
  const prepared = runCli(["prepare", "--runs-dir", runsDir, "--run-id", runId, "--mode", mode]);
  assert.equal(prepared.status, 0, `prepare failed: ${prepared.stderr}`);
  if (runtimePin) {
    const runPath = join(runsDir, runId, "run.json");
    writeJson(runPath, { ...JSON.parse(readFileSync(runPath, "utf8")), piRuntime: runtimePin });
  }
}

/**
 * Craft one synthetic terminal attempt with manifest-matching pins.
 * `receipt` undefined writes the default paid receipt for the run shape;
 * null writes none.
 */
function craftAttempt({ runDir, runId, taskId = TASK_ID, arm, attempt = 1, receipt, runtimePin = null, armCommit = null }) {
  const task = manifest.tasks.find((entry) => entry.id === taskId);
  const effectiveCommit = armCommit ?? ARM_COMMITS[arm];
  const attemptDir = attemptDirOf(runDir, taskId, arm, attempt);
  writeJson(join(attemptDir, "result.json"), {
    schemaVersion: 1,
    runId,
    taskId,
    arm,
    attempt,
    status: "completed",
    durationMs: 12,
    usage: { input: 4, output: 2, cacheRead: null, cacheWrite: null },
    scorer: { status: "passed", passedCount: 2, totalCount: 2 },
    collection: { status: "collected", errors: [], artifacts: [] },
    failures: [],
  });
  writeJson(join(attemptDir, "fixture-before.json"), { contentSha256: "fixture-content", gitStateSha256: "fixture-git" });
  writeJson(join(attemptDir, "pinned.json"), {
    schemaVersion: 1,
    taskId,
    arm,
    attempt,
    promptSha256: sha256Text(buildAttemptPrompt(task.prompt)),
    scorerSha256: scorerDefinitionSha256(repoRoot, taskId),
    provider: manifest.evaluation.provider,
    model: manifest.evaluation.model,
    thinking: manifest.evaluation.thinking,
    piVersion: manifest.evaluation.piVersion,
    armCommit: effectiveCommit,
    ...(runtimePin ? { piRuntime: runtimePin } : {}),
  });
  if (receipt !== null) {
    writeJson(
      join(attemptDir, "provider-invocation.json"),
      receipt ?? paidReceipt({ runId, taskId, arm, attempt, armCommit: effectiveCommit, runtimePin }),
    );
  }
  return attemptDir;
}

/** A paid receipt exactly as a real reservation would pin it. */
function paidReceipt({ runId, taskId = TASK_ID, arm, attempt = 1, armCommit, runtimePin = null, piRuntime = undefined, fake = false }) {
  return {
    schemaVersion: 1,
    runId,
    taskId,
    arm,
    attempt,
    fake,
    ...(fake ? {} : {
      armCommit,
      model: manifest.evaluation.model,
      provider: manifest.evaluation.provider,
      ...(piRuntime !== undefined ? { piRuntime } : runtimePin ? { piRuntime: runtimePin } : {}),
    }),
    reservedAt: "1970-01-01T00:00:00.000Z",
  };
}

/** Persist a slot selection directly in the run snapshot (as select would). */
function setSelection(runDir, entries) {
  const snapshotPath = join(runDir, "snapshot.json");
  const snapshot = JSON.parse(readFileSync(snapshotPath, "utf8"));
  writeJson(snapshotPath, { ...snapshot, selection: { ...(snapshot.selection ?? {}), ...entries } });
}

/** Byte-level tree fingerprint: relative path plus content SHA-256. */
function snapshotTree(root) {
  const entries = [];
  const walk = (dir, prefix) => {
    for (const name of readdirSync(dir).sort()) {
      const path = join(dir, name);
      const relative = prefix ? `${prefix}/${name}` : name;
      if (statSync(path).isDirectory()) walk(path, relative);
      else entries.push(`${relative}:${createHash("sha256").update(readFileSync(path)).digest("hex")}`);
    }
  };
  walk(root, "");
  return entries;
}

function reportPairs(runsDir, runId) {
  const report = runCli(["report", "--runs-dir", runsDir, "--run-id", runId]);
  assert.equal(report.status, 0, `report failed: ${report.stderr.slice(0, 300)}`);
  return JSON.parse(readFileSync(join(runsDir, runId, "summary.json"), "utf8")).pairs;
}

describe("real-run retry refusal", () => {
  test("retry refuses on run.mode real before attempt reservation even with --allow-new-paid-attempt", () => {
    const runsDir = mkdtempSync(join(tmpdir(), "cm-eval-real-retry-"));
    const runId = "real-retry-01";
    const runDir = join(runsDir, runId);
    try {
      prepareRun(runsDir, runId, "real");
      craftAttempt({ runDir, runId, arm: "upstream" });
      const before = snapshotTree(runDir);

      const retry = runCli([
        "retry", "--runs-dir", runsDir, "--run-id", runId,
        "--task", TASK_ID, "--arm", "upstream", "--allow-new-paid-attempt",
      ]);

      assert.notEqual(retry.status, 0, "retry on a real run must refuse");
      assert.match(retry.stderr, /real/, `refusal must name the real mode: ${retry.stderr.slice(0, 300)}`);
      assert.match(retry.stderr, /unsupported/, `refusal must say real retries are unsupported: ${retry.stderr.slice(0, 300)}`);
      assert.equal(retry.stdout.trim(), "", "a refused retry must not print an executed-outcome line");
      assert.deepEqual(snapshotTree(runDir), before, "run.json, journal, snapshot, and attempt directories must stay byte-identical");
      assert.equal(existsSync(attemptDirOf(runDir, TASK_ID, "upstream", 2)), false, "no attempt may be reserved");
      assert.equal(existsSync(join(runDir, "lock.d")), false, "no run lock may be left behind");
    } finally {
      rmSync(runsDir, { recursive: true, force: true });
    }
  });

  test("retry keeps creating the next immutable fake attempt for dry-run runs", () => {
    const runsDir = mkdtempSync(join(tmpdir(), "cm-eval-real-retry-"));
    const runId = "fake-retry-01";
    const runDir = join(runsDir, runId);
    try {
      prepareRun(runsDir, runId, "dry-run");
      assert.equal(
        runCli(["dry-run", "--runs-dir", runsDir, "--run-id", runId, "--task", TASK_ID, "--arm", "upstream"]).status,
        0,
      );
      const retry = runCli([
        "retry", "--runs-dir", runsDir, "--run-id", runId,
        "--task", TASK_ID, "--arm", "upstream", "--allow-new-paid-attempt",
      ]);
      assert.equal(retry.status, 0, `dry-run retry must keep working: ${retry.stderr.slice(0, 300)}`);
      const result = JSON.parse(readFileSync(join(attemptDirOf(runDir, TASK_ID, "upstream", 2), "result.json"), "utf8"));
      assert.equal(result.status, "completed", "the retry attempt must execute the fake path");
      const receipt = JSON.parse(readFileSync(join(attemptDirOf(runDir, TASK_ID, "upstream", 2), "provider-invocation.json"), "utf8"));
      assert.equal(receipt.fake, true, "dry-run retry attempts stay fake receipts");
    } finally {
      rmSync(runsDir, { recursive: true, force: true });
    }
  });
});

describe("select receipt validation", () => {
  test("select refuses a synthetic fake attempt selected into a real run", () => {
    const runsDir = mkdtempSync(join(tmpdir(), "cm-eval-select-receipt-"));
    const runId = "real-select-fake-01";
    const runDir = join(runsDir, runId);
    try {
      prepareRun(runsDir, runId, "real");
      craftAttempt({
        runDir,
        runId,
        arm: "upstream",
        receipt: paidReceipt({ runId, arm: "upstream", armCommit: ARM_COMMITS.upstream, fake: true }),
      });
      const select = runCli(["select", "--runs-dir", runsDir, "--run-id", runId, "--task", TASK_ID, "--arm", "upstream", "--attempt", "1"]);
      assert.notEqual(select.status, 0, "selecting a fake receipt into a real run must refuse");
      assert.match(select.stderr, /receipt/, `refusal must name the receipt: ${select.stderr.slice(0, 300)}`);
      const snapshot = JSON.parse(readFileSync(join(runDir, "snapshot.json"), "utf8"));
      assert.equal(snapshot.selection?.[`${TASK_ID}:upstream`], undefined, "the refusal must not record a selection");
    } finally {
      rmSync(runsDir, { recursive: true, force: true });
    }
  });

  test("select refuses missing, malformed, and mismatched real receipts", () => {
    const runsDir = mkdtempSync(join(tmpdir(), "cm-eval-select-receipt-"));
    const runId = "real-select-bad-01";
    const runDir = join(runsDir, runId);
    try {
      prepareRun(runsDir, runId, "real", { runtimePin: RUNTIME_PIN });
      const missingDir = craftAttempt({ runDir, runId, arm: "upstream", attempt: 1, receipt: null, runtimePin: RUNTIME_PIN });
      const missing = runCli(["select", "--runs-dir", runsDir, "--run-id", runId, "--task", TASK_ID, "--arm", "upstream", "--attempt", "1"]);
      assert.notEqual(missing.status, 0, "a missing receipt must refuse selection");
      assert.match(missing.stderr, /receipt/, `missing receipt: ${missing.stderr.slice(0, 300)}`);

      const malformedDir = craftAttempt({ runDir, runId, arm: "upstream", attempt: 2, runtimePin: RUNTIME_PIN });
      writeFileSync(join(malformedDir, "provider-invocation.json"), "{not json", "utf8");
      const malformed = runCli(["select", "--runs-dir", runsDir, "--run-id", runId, "--task", TASK_ID, "--arm", "upstream", "--attempt", "2"]);
      assert.notEqual(malformed.status, 0, "a malformed receipt must refuse selection");
      assert.match(malformed.stderr, /receipt/, `malformed receipt: ${malformed.stderr.slice(0, 300)}`);

      craftAttempt({
        runDir,
        runId,
        arm: "fork",
        attempt: 1,
        runtimePin: RUNTIME_PIN,
        receipt: paidReceipt({ runId, arm: "fork", attempt: 1, armCommit: "deadbeef", runtimePin: RUNTIME_PIN }),
      });
      const commit = runCli(["select", "--runs-dir", runsDir, "--run-id", runId, "--task", TASK_ID, "--arm", "fork", "--attempt", "1"]);
      assert.notEqual(commit.status, 0, "a receipt armCommit mismatching the manifest must refuse");

      craftAttempt({
        runDir,
        runId,
        arm: "fork",
        attempt: 2,
        runtimePin: RUNTIME_PIN,
        receipt: paidReceipt({ runId, arm: "fork", attempt: 2, armCommit: ARM_COMMITS.fork, runtimePin: OTHER_RUNTIME_PIN }),
      });
      const digest = runCli(["select", "--runs-dir", runsDir, "--run-id", runId, "--task", TASK_ID, "--arm", "fork", "--attempt", "2"]);
      assert.notEqual(digest.status, 0, "a receipt runtime digest differing from run.json must refuse");

      craftAttempt({
        runDir,
        runId,
        arm: "fork",
        attempt: 3,
        runtimePin: RUNTIME_PIN,
        receipt: paidReceipt({ runId: "another-run", arm: "fork", attempt: 3, armCommit: ARM_COMMITS.fork, runtimePin: RUNTIME_PIN }),
      });
      const runIdCase = runCli(["select", "--runs-dir", runsDir, "--run-id", runId, "--task", TASK_ID, "--arm", "fork", "--attempt", "3"]);
      assert.notEqual(runIdCase.status, 0, "a receipt from another run must refuse");

      const snapshot = JSON.parse(readFileSync(join(runDir, "snapshot.json"), "utf8"));
      assert.equal(Object.keys(snapshot.selection ?? {}).length, 0, "no refusal may record a selection");
      void missingDir;
    } finally {
      rmSync(runsDir, { recursive: true, force: true });
    }
  });

  test("select accepts paid receipts, including legacy real receipts without a runtime digest", () => {
    const runsDir = mkdtempSync(join(tmpdir(), "cm-eval-select-receipt-"));
    try {
      const pinnedId = "real-select-ok-01";
      prepareRun(runsDir, pinnedId, "real", { runtimePin: RUNTIME_PIN });
      craftAttempt({ runDir: join(runsDir, pinnedId), runId: pinnedId, arm: "upstream", runtimePin: RUNTIME_PIN });
      const pinned = runCli(["select", "--runs-dir", runsDir, "--run-id", pinnedId, "--task", TASK_ID, "--arm", "upstream", "--attempt", "1"]);
      assert.equal(pinned.status, 0, `a matching paid receipt must select: ${pinned.stderr.slice(0, 300)}`);
      const snapshot = JSON.parse(readFileSync(join(runsDir, pinnedId, "snapshot.json"), "utf8"));
      assert.equal(snapshot.selection[`${TASK_ID}:upstream`], 1);

      const legacyId = "real-select-legacy-01";
      prepareRun(runsDir, legacyId, "real");
      craftAttempt({ runDir: join(runsDir, legacyId), runId: legacyId, arm: "upstream" });
      const legacy = runCli(["select", "--runs-dir", runsDir, "--run-id", legacyId, "--task", TASK_ID, "--arm", "upstream", "--attempt", "1"]);
      assert.equal(legacy.status, 0, `a legacy paid receipt without piRuntime must select: ${legacy.stderr.slice(0, 300)}`);
    } finally {
      rmSync(runsDir, { recursive: true, force: true });
    }
  });

  test("select on dry-run runs still accepts fake receipts and refuses damaged ones", () => {
    const runsDir = mkdtempSync(join(tmpdir(), "cm-eval-select-receipt-"));
    const runId = "fake-select-01";
    const runDir = join(runsDir, runId);
    try {
      prepareRun(runsDir, runId, "dry-run");
      craftAttempt({
        runDir,
        runId,
        arm: "upstream",
        receipt: paidReceipt({ runId, arm: "upstream", armCommit: ARM_COMMITS.upstream, fake: true }),
      });
      const select = runCli(["select", "--runs-dir", runsDir, "--run-id", runId, "--task", TASK_ID, "--arm", "upstream", "--attempt", "1"]);
      assert.equal(select.status, 0, `a fake receipt must stay selectable in a dry-run run: ${select.stderr.slice(0, 300)}`);

      const noReceiptDir = craftAttempt({ runDir, runId, arm: "fork", receipt: null });
      const noReceipt = runCli(["select", "--runs-dir", runsDir, "--run-id", runId, "--task", TASK_ID, "--arm", "fork", "--attempt", "1"]);
      assert.notEqual(noReceipt.status, 0, "a missing receipt must refuse selection even in a dry-run run");
      void noReceiptDir;
    } finally {
      rmSync(runsDir, { recursive: true, force: true });
    }
  });
});

describe("report receipt validation", () => {
  test("a real pair selected from synthetic fake attempts is invalid", () => {
    const runsDir = mkdtempSync(join(tmpdir(), "cm-eval-report-receipt-"));
    const runId = "real-report-fake-01";
    const runDir = join(runsDir, runId);
    try {
      prepareRun(runsDir, runId, "real");
      for (const arm of ["upstream", "fork"]) {
        craftAttempt({
          runDir,
          runId,
          arm,
          receipt: paidReceipt({ runId, arm, armCommit: ARM_COMMITS[arm], fake: true }),
        });
      }
      setSelection(runDir, { [`${TASK_ID}:upstream`]: 1, [`${TASK_ID}:fork`]: 1 });
      const pairs = reportPairs(runsDir, runId);
      assert.equal(pairs.valid, 0, "fake attempts must never form a valid real pair");
      assert.equal(pairs.invalid, 1, "the contaminated pair must be counted invalid");
    } finally {
      rmSync(runsDir, { recursive: true, force: true });
    }
  });

  test("real pairs with matching paid receipts stay valid, including legacy receipts without piRuntime", () => {
    const runsDir = mkdtempSync(join(tmpdir(), "cm-eval-report-receipt-"));
    try {
      const pinnedId = "real-report-ok-01";
      prepareRun(runsDir, pinnedId, "real", { runtimePin: RUNTIME_PIN });
      for (const arm of ["upstream", "fork"]) {
        craftAttempt({ runDir: join(runsDir, pinnedId), runId: pinnedId, arm, runtimePin: RUNTIME_PIN });
      }
      setSelection(join(runsDir, pinnedId), { [`${TASK_ID}:upstream`]: 1, [`${TASK_ID}:fork`]: 1 });
      assert.equal(reportPairs(runsDir, pinnedId).valid, 1, "matching paid receipts with runtime pins must stay valid");

      const legacyId = "real-report-legacy-01";
      prepareRun(runsDir, legacyId, "real");
      for (const arm of ["upstream", "fork"]) {
        craftAttempt({ runDir: join(runsDir, legacyId), runId: legacyId, arm });
      }
      setSelection(join(runsDir, legacyId), { [`${TASK_ID}:upstream`]: 1, [`${TASK_ID}:fork`]: 1 });
      assert.equal(reportPairs(runsDir, legacyId).valid, 1, "legacy real receipts without any runtime digest must stay valid");
    } finally {
      rmSync(runsDir, { recursive: true, force: true });
    }
  });

  test("missing, malformed, and mismatched receipts invalidate real pairs", () => {
    const runsDir = mkdtempSync(join(tmpdir(), "cm-eval-report-receipt-"));
    try {
      const caseRun = (runId, mutate) => {
        prepareRun(runsDir, runId, "real", { runtimePin: RUNTIME_PIN });
        const runDir = join(runsDir, runId);
        const dirs = {};
        for (const arm of ["upstream", "fork"]) {
          dirs[arm] = craftAttempt({ runDir, runId, arm, runtimePin: RUNTIME_PIN });
        }
        mutate(runDir, dirs);
        setSelection(runDir, { [`${TASK_ID}:upstream`]: 1, [`${TASK_ID}:fork`]: 1 });
        return reportPairs(runsDir, runId);
      };

      const missing = caseRun("real-report-missing-01", (runDir, dirs) => {
        rmSync(join(dirs.upstream, "provider-invocation.json"));
      });
      assert.equal(missing.valid, 0, "a missing receipt must invalidate the pair");
      assert.equal(missing.invalid, 1);

      const malformed = caseRun("real-report-malformed-01", (runDir, dirs) => {
        writeFileSync(join(dirs.upstream, "provider-invocation.json"), "{not json", "utf8");
      });
      assert.equal(malformed.valid, 0, "a malformed receipt must invalidate the pair");
      assert.equal(malformed.invalid, 1);

      const wrongCommit = caseRun("real-report-commit-01", (runDir, dirs) => {
        writeJson(
          join(dirs.upstream, "provider-invocation.json"),
          paidReceipt({ runId: "real-report-commit-01", arm: "upstream", armCommit: "deadbeef", runtimePin: RUNTIME_PIN }),
        );
      });
      assert.equal(wrongCommit.valid, 0, "a receipt armCommit mismatching the manifest must invalidate the pair");
      assert.equal(wrongCommit.invalid, 1);

      const wrongRunId = caseRun("real-report-runid-01", (runDir, dirs) => {
        writeJson(
          join(dirs.upstream, "provider-invocation.json"),
          paidReceipt({ runId: "some-other-run", arm: "upstream", armCommit: ARM_COMMITS.upstream, runtimePin: RUNTIME_PIN }),
        );
      });
      assert.equal(wrongRunId.valid, 0, "a receipt from another run must invalidate the pair");
      assert.equal(wrongRunId.invalid, 1);

      const wrongAttempt = caseRun("real-report-attempt-01", (runDir, dirs) => {
        writeJson(
          join(dirs.upstream, "provider-invocation.json"),
          paidReceipt({ runId: "real-report-attempt-01", arm: "upstream", attempt: 2, armCommit: ARM_COMMITS.upstream, runtimePin: RUNTIME_PIN }),
        );
      });
      assert.equal(wrongAttempt.valid, 0, "a receipt for a different attempt number must invalidate the pair");
      assert.equal(wrongAttempt.invalid, 1);

      const wrongDigest = caseRun("real-report-digest-01", (runDir, dirs) => {
        writeJson(
          join(dirs.upstream, "provider-invocation.json"),
          paidReceipt({ runId: "real-report-digest-01", arm: "upstream", armCommit: ARM_COMMITS.upstream, runtimePin: OTHER_RUNTIME_PIN }),
        );
      });
      assert.equal(wrongDigest.valid, 0, "a receipt runtime digest differing from run.json must invalidate the pair");
      assert.equal(wrongDigest.invalid, 1);

      const noRuntimeInReceipt = caseRun("real-report-nopin-01", (runDir, dirs) => {
        writeJson(
          join(dirs.upstream, "provider-invocation.json"),
          paidReceipt({ runId: "real-report-nopin-01", arm: "upstream", armCommit: ARM_COMMITS.upstream, runtimePin: null }),
        );
      });
      assert.equal(noRuntimeInReceipt.valid, 0, "a receipt missing the piRuntime digest while run.json pins one must invalidate the pair");
      assert.equal(noRuntimeInReceipt.invalid, 1);
    } finally {
      rmSync(runsDir, { recursive: true, force: true });
    }
  });

  test("fake-run pairs require fake receipts; a paid receipt in a fake run is invalid", () => {
    const runsDir = mkdtempSync(join(tmpdir(), "cm-eval-report-receipt-"));
    try {
      const fakeId = "fake-report-01";
      prepareRun(runsDir, fakeId, "dry-run");
      const runDir = join(runsDir, fakeId);
      for (const arm of ["upstream", "fork"]) {
        craftAttempt({
          runDir,
          runId: fakeId,
          arm,
          receipt: paidReceipt({ runId: fakeId, arm, armCommit: ARM_COMMITS[arm], fake: true }),
        });
      }
      setSelection(runDir, { [`${TASK_ID}:upstream`]: 1, [`${TASK_ID}:fork`]: 1 });
      assert.equal(reportPairs(runsDir, fakeId).valid, 1, "fake receipts must keep a dry-run pair valid");

      writeJson(
        join(attemptDirOf(runDir, TASK_ID, "upstream", 1), "provider-invocation.json"),
        paidReceipt({ runId: fakeId, arm: "upstream", armCommit: ARM_COMMITS.upstream, fake: false }),
      );
      const pairs = reportPairs(runsDir, fakeId);
      assert.equal(pairs.valid, 0, "a non-fake receipt in a dry-run pair must invalidate it");
      assert.equal(pairs.invalid, 1);
    } finally {
      rmSync(runsDir, { recursive: true, force: true });
    }
  });

  test("malformed runtime pins fail receipt validation and pair checks", () => {
    const runsDir = mkdtempSync(join(tmpdir(), "cm-eval-report-pin-"));
    try {
      // A valid non-hex-free base digest for well-formed pins.
      const validPin = RUNTIME_PIN;
      const malformedPins = [
        { label: "empty object", pin: {} },
        { label: "empty digest", pin: { ...validPin, digest: "" } },
        { label: "non-string digest", pin: { ...validPin, digest: 42 } },
        { label: "wrong-length digest", pin: { ...validPin, digest: validPin.digest.slice(0, 63) } },
        { label: "non-hex digest", pin: { ...validPin, digest: "z".repeat(64) } },
      ];
      // 1. A malformed pin inside the receipt fails select and the report pair.
      let index = 0;
      for (const item of malformedPins) {
        const runId = `pin-receipt-${index}`;
        index += 1;
        prepareRun(runsDir, runId, "real", { runtimePin: validPin });
        craftAttempt({
          runDir: join(runsDir, runId),
          runId,
          arm: "upstream",
          runtimePin: validPin,
          receipt: paidReceipt({ runId, arm: "upstream", armCommit: ARM_COMMITS.upstream, piRuntime: item.pin }),
        });
        const select = runCli(["select", "--runs-dir", runsDir, "--run-id", runId, "--task", TASK_ID, "--arm", "upstream", "--attempt", "1"]);
        assert.notEqual(select.status, 0, `a malformed receipt piRuntime (${item.label}) must refuse selection`);
      }
      // 2. A malformed pin in run.json fails select and the report pair even
      //    when the receipt and pinned.json are well formed.
      const malformedRunId = "pin-run-malformed-01";
      prepareRun(runsDir, malformedRunId, "real");
      for (const arm of ["upstream", "fork"]) {
        craftAttempt({ runDir: join(runsDir, malformedRunId), runId: malformedRunId, arm });
      }
      const malformedRunPath = join(runsDir, malformedRunId, "run.json");
      writeJson(malformedRunPath, { ...JSON.parse(readFileSync(malformedRunPath, "utf8")), piRuntime: {} });
      const selectRunPin = runCli(["select", "--runs-dir", runsDir, "--run-id", malformedRunId, "--task", TASK_ID, "--arm", "upstream", "--attempt", "1"]);
      assert.notEqual(selectRunPin.status, 0, "a malformed run.json piRuntime must refuse selection");
      setSelection(join(runsDir, malformedRunId), { [`${TASK_ID}:upstream`]: 1, [`${TASK_ID}:fork`]: 1 });
      const runPinPairs = reportPairs(runsDir, malformedRunId);
      assert.equal(runPinPairs.valid, 0, "a malformed run.json piRuntime must invalidate the pair");
      assert.equal(runPinPairs.invalid, 1);
      // 3. A malformed pin in one arm's pinned.json fails the pair check even
      //    though the receipt is well formed and run.json has no pin (the
      //    pair check must not compare undefined digests as equal).
      const pinnedArmId = "pin-arm-malformed-01";
      prepareRun(runsDir, pinnedArmId, "real");
      for (const arm of ["upstream", "fork"]) {
        craftAttempt({ runDir: join(runsDir, pinnedArmId), runId: pinnedArmId, arm });
      }
      const forkPinnedPath = join(attemptDirOf(join(runsDir, pinnedArmId), TASK_ID, "fork", 1), "pinned.json");
      const forkPinned = JSON.parse(readFileSync(forkPinnedPath, "utf8"));
      forkPinned.piRuntime = { digest: "" };
      writeJson(forkPinnedPath, forkPinned);
      setSelection(join(runsDir, pinnedArmId), { [`${TASK_ID}:upstream`]: 1, [`${TASK_ID}:fork`]: 1 });
      const armPinPairs = reportPairs(runsDir, pinnedArmId);
      assert.equal(armPinPairs.valid, 0, "a malformed pinned.json piRuntime on one arm must invalidate the pair");
      assert.equal(armPinPairs.invalid, 1);

      // 4. Legacy handling applies only when all three runtime pins are absent.
      //    Every partial combination must refuse selection.
      const partialPins = [
        { label: "receipt only", run: null, attempt: null, receipt: validPin },
        { label: "attempt only", run: null, attempt: validPin, receipt: null },
        { label: "run only", run: validPin, attempt: null, receipt: null },
        { label: "receipt and attempt", run: null, attempt: validPin, receipt: validPin },
        { label: "receipt and run", run: validPin, attempt: null, receipt: validPin },
        { label: "attempt and run", run: validPin, attempt: validPin, receipt: null },
      ];
      for (const [partialIndex, item] of partialPins.entries()) {
        const runId = `pin-partial-${partialIndex}`;
        prepareRun(runsDir, runId, "real", { runtimePin: item.run });
        craftAttempt({
          runDir: join(runsDir, runId),
          runId,
          arm: "upstream",
          runtimePin: item.attempt,
          receipt: paidReceipt({
            runId,
            arm: "upstream",
            armCommit: ARM_COMMITS.upstream,
            piRuntime: item.receipt ?? undefined,
          }),
        });
        const partialSelect = runCli(["select", "--runs-dir", runsDir, "--run-id", runId, "--task", TASK_ID, "--arm", "upstream", "--attempt", "1"]);
        assert.notEqual(partialSelect.status, 0, `partial runtime pin (${item.label}) must refuse selection`);
      }
    } finally {
      rmSync(runsDir, { recursive: true, force: true });
    }
  });

  test("real reservations pin the pi runtime digest into the paid receipt", async () => {
    const runsDir = mkdtempSync(join(tmpdir(), "cm-eval-reserve-receipt-"));
    const runId = "real-reserve-01";
    const runDir = join(runsDir, runId);
    try {
      prepareRun(runsDir, runId, "real");
      const { reserveAttempt } = await import(join(repoRoot, "evaluation", "runner", "cli.mjs"));
      const claim = reserveAttempt({
        runDir,
        runId,
        taskId: TASK_ID,
        arm: "upstream",
        attempt: 1,
        real: {
          armCommit: ARM_COMMITS.upstream,
          model: manifest.evaluation.model,
          provider: manifest.evaluation.provider,
          piRuntime: RUNTIME_PIN,
        },
      });
      assert.equal(claim.claimed, true, "the synthetic reservation must claim its slot");
      const receipt = JSON.parse(readFileSync(join(claim.attemptDir, "provider-invocation.json"), "utf8"));
      assert.equal(receipt.fake, false);
      assert.equal(receipt.armCommit, ARM_COMMITS.upstream);
      assert.equal(receipt.model, manifest.evaluation.model);
      assert.equal(receipt.provider, manifest.evaluation.provider);
      assert.deepEqual(receipt.piRuntime, RUNTIME_PIN, "a real reservation must pin the runtime digest in its receipt");
    } finally {
      rmSync(runsDir, { recursive: true, force: true });
    }
  });
});
