/**
 * Benchmark contract: the archive-enabled context benchmark must exist
 * and pass its gates in quick mode.
 */
import test from "node:test";
import assert from "node:assert/strict";
import { spawnSync } from "node:child_process";
import { existsSync, readFileSync } from "node:fs";
import { dirname, join } from "node:path";
import { fileURLToPath } from "node:url";

const repoRoot = join(dirname(fileURLToPath(import.meta.url)), "..");
const script = join(repoRoot, "benchmarks", "archive-context.mjs");

test("archive benchmark script exists and passes its gates in quick mode", () => {
  assert.ok(existsSync(script), "benchmarks/archive-context.mjs must exist");
  const run = spawnSync(process.execPath, ["--import", "tsx", script], {
    cwd: repoRoot,
    encoding: "utf8",
    env: { ...process.env, ARCHIVE_BENCH_QUICK: "1" },
  });
  assert.equal(run.status, 0, `benchmark gates failed:\n${run.stdout}\n${run.stderr}`);
  assert.match(run.stdout, /all gates passed/);
});

test("checked-in archive benchmark covers exact passes and passes release gates", () => {
  const report = JSON.parse(readFileSync(join(repoRoot, "benchmarks", "archive-results.json"), "utf8"));
  const before = JSON.parse(readFileSync(join(repoRoot, "benchmarks", "archive-before-results.json"), "utf8"));
  const upstream = JSON.parse(readFileSync(join(repoRoot, "benchmarks", "archive-upstream-baseline.json"), "utf8"));
  assert.equal(before.sourceCommit, "8d004bf97f5142d869aebcedf05ae7d7be4e1d30");
  assert.equal(before.implementation, "per-entry synchronous archive store");
  assert.deepEqual([...new Set(before.measurements.map((item) => item.candidates))], [100, 300]);
  assert.equal(upstream.sourceCommit, "71f9e396951c42687f0c3456727b2b5c8c625da1");
  assert.deepEqual(upstream.measurements.map((item) => item.candidates), [100, 300, 1000, 10000]);
  assert.deepEqual([...new Set(report.measurements.map((item) => item.candidates))], [100, 300, 1000, 10000]);
  assert.equal(report.measurements.length, 16, "four counts, two archive modes, and two capacity modes");
  assert.ok(report.measuredIterations >= 20, "p95 uses enough samples to exclude one timing outlier");
  assert.match(report.baselineSource, /archive-upstream-baseline\.json.*upstream/i);
  assert.deepEqual(report.failures, [], "checked-in run passes every release gate");

  for (const measurement of report.measurements) {
    assert.equal(measurement.baseline.count, measurement.candidates, "upstream ratio uses the exact candidate count");
    assert.deepEqual(Object.keys(measurement.ratiosVsUpstream), ["1", "2", "5"]);
    assert.equal(measurement.passTimingsMs["1"].samples, report.measuredIterations, "first-pass samples are not pooled");
    assert.equal(measurement.passTimingsMs["2"].samples, report.measuredIterations, "second-pass samples are not pooled");
    assert.equal(measurement.passTimingsMs["5"].samples, report.measuredIterations, "fifth-pass samples are not pooled");
    assert.ok(measurement.repeatedP95Ms < report.gate.repeatedP95BudgetMs, "repeated p95 stays below budget");
    assert.equal(measurement.operationCounts.repeatedPassDelta.entryWriteFileSync, 0);
    assert.equal(measurement.operationCounts.repeatedPassDelta.entryRenameSync, 0);
    assert.equal(measurement.operationCounts.repeatedPassDelta.indexWriteFileSync, 0);
    assert.equal(measurement.operationCounts.repeatedPassDelta.indexRenameSync, 0);
    if (measurement.archive === "enabled" && measurement.capacityMode === "above") {
      assert.equal(measurement.survivors, measurement.candidates, "above-capacity mode retains every candidate");
    }
    if (measurement.archive === "disabled") {
      assert.equal(measurement.survivors, 0, "disabled batches fail open with zero survivors");
    }
  }
});
