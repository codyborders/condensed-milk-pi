/* Archive benchmark contract tests. */
import test from "node:test";
import assert from "node:assert/strict";
import { spawnSync } from "node:child_process";
import { existsSync, readFileSync } from "node:fs";
import { dirname, join } from "node:path";
import { fileURLToPath } from "node:url";

const repoRoot = join(dirname(fileURLToPath(import.meta.url)), "..");
const script = join(repoRoot, "benchmarks", "archive-context.mjs");

function quickReport() {
  return spawnSync(process.execPath, ["--import", "tsx", script, "--json"], {
    cwd: repoRoot,
    encoding: "utf8",
    env: { ...process.env, ARCHIVE_BENCH_QUICK: "1" },
  });
}

test("archive benchmark quick mode passes gates", () => {
  assert.ok(existsSync(script));
  const run = quickReport();
  assert.equal(run.status, 0, `${run.stdout}\n${run.stderr}`);
  assert.match(run.stdout, /all gates passed/);
});

test("quick report covers required archive contracts and pass schema", () => {
  const run = quickReport();
  assert.equal(run.status, 0, `${run.stdout}\n${run.stderr}`);
  const report = JSON.parse(run.stdout.trim().split("\n").at(-1));
  assert.equal(report.schemaVersion, 2);
  assert.equal(report.measuredIterations, 1);
  assert.deepEqual(report.progressiveCandidateCounts, [100, 200, 300, 400, 500]);
  const names = report.scenarios.map((scenario) => scenario.name);
  assert.deepEqual(names, [
    "steady-state", "progressive-disabled", "progressive-capacity-above", "progressive-capacity-below",
    "progressive-entry-pressure", "progressive-aggregate-pressure", "progressive-ttl-expiry", "progressive-recreation",
  ]);
  const pass = report.scenarios.find((scenario) => scenario.name === "progressive-capacity-above").passes[4];
  for (const field of [
    "candidates", "existingLiveReferences", "newlyAdmittedReferences", "evictions", "expirations",
    "maskedSurvivors", "visibleNonSurvivors", "entryWrites", "entryRenames", "indexWrites", "indexRenames",
    "entryWriteFileSync", "entryRenameSync", "indexWriteFileSync", "indexRenameSync", "verificationReads", "verificationStats", "retrievalCount", "oldReferenceAliasCount", "configuredStorageTotals",
    "liveStorageTotals", "medianRuntimeMs", "p95RuntimeMs", "failures",
  ]) assert.ok(Object.hasOwn(pass, field), `missing pass field ${field}`);
  assert.deepEqual(report.failures, []);
  assert.deepEqual(report.gates.steadyStateRepeatedRewriteFailures, []);

  const scenario = (name) => report.scenarios.find((item) => item.name === name);
  const steady = scenario("steady-state");
  assert.deepEqual(steady.passes.filter((_, index) => index > 0).map((item) => [item.entryWrites, item.entryRenames, item.indexWrites, item.indexRenames]),
    [[0, 0, 0, 0], [0, 0, 0, 0], [0, 0, 0, 0], [0, 0, 0, 0]]);
  for (const pass of scenario("progressive-disabled").passes) {
    assert.equal(pass.maskedSurvivors, 0);
    assert.equal(pass.archiveFilesystemWork, 0);
  }
  for (const pass of scenario("progressive-capacity-above").passes) {
    assert.equal(pass.maskedSurvivors, pass.candidates);
    assert.ok(pass.newlyAdmittedReferences > 0);
    assert.equal(pass.oldReferenceAliasCount, 0);
    assert.equal(pass.retrievalCount, pass.maskedSurvivors + pass.evictions + pass.expirations);
  }
  for (const name of ["progressive-capacity-below", "progressive-entry-pressure", "progressive-aggregate-pressure"]) {
    const item = scenario(name);
    for (const pass of item.passes) {
      assert.ok(pass.liveStorageTotals.entries <= pass.configuredStorageTotals.maxEntries);
      assert.ok(pass.liveStorageTotals.bytes <= pass.configuredStorageTotals.maxAggregateBytes);
      assert.equal(pass.visibleNonSurvivors, pass.candidates - pass.maskedSurvivors);
    }
  }
  assert.ok(scenario("progressive-ttl-expiry").passes.filter((_, index) => index > 0).some((pass) => pass.expirations > 0));
  assert.ok(scenario("progressive-recreation").passes.filter((_, index) => index > 0).every((pass) => pass.verificationReads > 0 && pass.verificationStats > 0));
});

test("checked-in progressive result passes the full archive contract", () => {
  const report = JSON.parse(readFileSync(join(repoRoot, "benchmarks/archive-results.json"), "utf8"));
  assert.equal(report.schemaVersion, 2);
  assert.equal(report.measuredIterations, 20);
  assert.deepEqual(report.progressiveCandidateCounts, [100, 200, 300, 400, 500]);
  assert.equal(report.scenarios.length, 8);
  assert.deepEqual(report.failures, []);
  assert.deepEqual(report.gates.steadyStateRepeatedRewriteFailures, []);
  const steady = report.scenarios.find((scenario) => scenario.name === "steady-state");
  for (const pass of steady.passes.filter((_, index) => index > 0)) {
    assert.deepEqual([pass.entryWrites, pass.entryRenames, pass.indexWrites, pass.indexRenames], [0, 0, 0, 0]);
    assert.ok(pass.p95RuntimeMs < report.steadyStateP95BudgetMs);
  }
  const disabled = report.scenarios.find((scenario) => scenario.name === "progressive-disabled");
  for (const pass of disabled.passes) {
    assert.equal(pass.maskedSurvivors, 0);
    assert.equal(pass.archiveFilesystemWork, 0);
  }
  for (const scenario of report.scenarios) {
    for (const pass of scenario.passes) assert.deepEqual(pass.failures, []);
  }
});
