import { test } from "node:test";
import assert from "node:assert/strict";
import { compareReports, renderMarkdown } from "./compare-context-hook.mjs";

function report(overrides = {}) {
  return {
    nodeVersion: "v25.0.0",
    platform: { name: "darwin", release: "1", arch: "arm64" },
    cpu: { model: "test-cpu", logicalCores: 4 },
    harnessSha256: "harness",
    measurements: [{
      messageCount: 100,
      bashDensity: 0.25,
      cwdDistribution: "single",
      input: { inputHash: "input" },
      medianMs: 2,
      p95Ms: 4,
      masksPerRun: 3,
      budgetPassed: true,
      repeatedOutputHashesMatch: true,
      outputHashCount: 1,
      outputHash: "output",
    }],
    ...overrides,
  };
}

function budgetedReport(measurementOverrides = {}) {
  return report({ measurements: [{ ...report().measurements[0], p95BudgetMs: 25, ...measurementOverrides }] });
}

test("comparison reports deltas, ratios, masks, output equality, and budgets", () => {
  const result = compareReports(
    budgetedReport(),
    budgetedReport({ medianMs: 3, p95Ms: 6, masksPerRun: 5, outputHash: "fork-output" }),
  );
  const caseResult = result.cases[0];
  assert.deepEqual(caseResult.timing, {
    medianDeltaMs: 1,
    p95DeltaMs: 2,
    medianRatio: 1.5,
    p95Ratio: 1.5,
  });
  assert.equal(caseResult.maskCountDifference, 2);
  assert.equal(caseResult.outputHashEqual, false);
  assert.deepEqual(caseResult.budgetStatus, { upstream: true, fork: true, passed: true });
  assert.equal(result.aggregates.byMessageCount[0].messageCount, 100);
  assert.equal(result.aggregates.total.caseCount, 1);
  assert.match(renderMarkdown(result), /Context-hook benchmark comparison/);
});

test("budgets are recomputed from p95Ms and p95BudgetMs and tampering is rejected", () => {
  const consistent = compareReports(budgetedReport(), budgetedReport({ p95Ms: 24 }));
  assert.equal(consistent.cases[0].upstream.p95BudgetMs, 25, "sanitized cases retain the budget");
  assert.equal(consistent.cases[0].fork.p95BudgetMs, 25, "sanitized cases retain the budget");
  assert.equal(consistent.cases[0].budgetStatus.passed, true);
  const overBudget = compareReports(budgetedReport({ p95Ms: 26, budgetPassed: false }), budgetedReport());
  assert.equal(overBudget.cases[0].upstream.budgetPassed, false, "an over-budget p95 recomputes to failed");
  assert.equal(overBudget.allBudgetsPassed, false);

  const tamperedFlag = budgetedReport({ p95Ms: 30, budgetPassed: true });
  assert.throws(() => compareReports(tamperedFlag, budgetedReport()), /inconsistent budgetPassed/i);
  const tamperedUnder = budgetedReport({ p95Ms: 4, budgetPassed: false });
  assert.throws(() => compareReports(budgetedReport(), tamperedUnder), /inconsistent budgetPassed/i);
  assert.throws(
    () => compareReports(budgetedReport(), budgetedReport({ p95BudgetMs: 50 })),
    /p95BudgetMs mismatch/i,
  );
  assert.throws(
    () => compareReports(budgetedReport(), budgetedReport({ p95BudgetMs: undefined })),
    /missing p95BudgetMs/i,
  );
});
