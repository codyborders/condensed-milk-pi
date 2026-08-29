/**
 * Provider-study statistics (grown test-first).
 *
 * Matched complete blocks only: a block enters analysis only when all
 * four arms completed. The five-to-ten rule extends repetitions 6-10
 * across every task and arm when the primary default-vs-upstream
 * interval includes zero.
 */

import { test } from "node:test";
import assert from "node:assert/strict";
import { completeBlocks, primaryInterval, fiveToTenRequired, primaryConclusion } from "../runner/stats.mjs";

const ARMS = ["none", "upstream", "remediated-defaults", "remediated-archive"];

function attempt(taskId, rep, arm, { status = "completed", success = true, tokens = 1000 } = {}) {
  return { taskId, rep, arm, status, success, totalProviderTokens: tokens };
}

test("complete blocks reject incomplete, failed, and unsuccessful slots", () => {
  const rows = [
    attempt("t1", 1, "none"),
    attempt("t1", 1, "upstream"),
    attempt("t1", 1, "remediated-defaults"),
    attempt("t1", 1, "remediated-archive"),
    attempt("t1", 2, "none"),
    attempt("t1", 2, "upstream"),
    attempt("t1", 2, "remediated-defaults"),
    attempt("t2", 1, "none", { status: "failed" }),
    attempt("t2", 1, "upstream"),
    attempt("t2", 1, "remediated-defaults"),
    attempt("t2", 1, "remediated-archive"),
  ];
  const blocks = completeBlocks(rows, ARMS);
  assert.equal(blocks.length, 1);
  assert.equal(blocks[0].taskId, "t1");
  assert.equal(blocks[0].rep, 1);
});

test("primary interval is success-only total provider tokens with a seeded bootstrap", () => {
  const rows = [];
  for (const rep of [1, 2, 3, 4, 5]) {
    rows.push(attempt("t1", rep, "upstream", { tokens: 1000 }));
    rows.push(attempt("t1", rep, "remediated-defaults", { tokens: 900 }));
    rows.push(attempt("t1", rep, "none", { tokens: 1100 }));
    rows.push(attempt("t1", rep, "remediated-archive", { tokens: 850 }));
    rows.push(attempt("t2", rep, "upstream", { status: "failed", success: false, tokens: 999999 }));
    rows.push(attempt("t2", rep, "remediated-defaults", { tokens: 800 }));
    rows.push(attempt("t2", rep, "none", { tokens: 1200 }));
    rows.push(attempt("t2", rep, "remediated-archive", { tokens: 700 }));
  }
  const result = primaryInterval(rows, { treatment: "remediated-defaults", baseline: "upstream", seed: "provider-study:test" });
  assert.equal(result.metric, "totalProviderTokensSuccessOnly");
  assert.equal(result.n, 5);
  assert.equal(result.meanPairedChange, -100);
  const again = primaryInterval(rows, { treatment: "remediated-defaults", baseline: "upstream", seed: "provider-study:test" });
  assert.deepEqual(again.bootstrap95, result.bootstrap95);
  assert.equal(typeof result.pairedT95.low, "number");
});

test("primary interval carries a seeded task-clustered bootstrap over per-task deltas", () => {
  const rows = [];
  for (const rep of [1, 2, 3]) {
    for (const arm of ARMS) {
      rows.push(attempt("t1", rep, arm, { tokens: arm === "upstream" ? 1000 : 900 }));
      rows.push(attempt("t2", rep, arm, { tokens: arm === "upstream" ? 1200 : 1000 }));
    }
  }
  const clustered = primaryInterval(rows, {
    treatment: "remediated-defaults",
    baseline: "upstream",
    seed: "provider-study:cluster-check",
  }).taskClustered;
  assert.equal(clustered.method, "task-clustered-bootstrap");
  assert.equal(clustered.taskCount, 2);
  assert.equal(typeof clustered.low, "number");
  assert.ok(clustered.low <= clustered.high);
});

test("five-to-ten rule uses the task-clustered interval when repetitions look conclusive", () => {
  assert.equal(fiveToTenRequired({ bootstrap95: { low: -100, high: 50 } }), true);
  assert.equal(fiveToTenRequired({ bootstrap95: { low: -100, high: -50 } }), false);
  assert.equal(
    fiveToTenRequired({
      bootstrap95: { low: -100, high: -50 },
      taskClustered: { low: -120, high: 20 },
    }),
    true,
    "a flat interval cannot suppress extension when the task-clustered interval includes zero",
  );
});

test("a missing, null, invalid, incomplete, or unusable primary interval requires repetitions 6-10", () => {
  assert.equal(fiveToTenRequired(null), true, "a missing primary interval is never conclusive");
  assert.equal(fiveToTenRequired({}), true, "missing bootstrap bounds are never conclusive");
  assert.equal(fiveToTenRequired({ bootstrap95: null }), true, "null bootstrap bounds are never conclusive");
  assert.equal(fiveToTenRequired({ bootstrap95: { low: null, high: 50 } }), true, "incomplete bounds are never conclusive");
  assert.equal(fiveToTenRequired({ bootstrap95: { low: Number.NaN, high: 50 } }), true, "non-finite bounds are never conclusive");
  assert.equal(fiveToTenRequired({ bootstrap95: { low: "low", high: 50 } }), true, "non-numeric bounds are never conclusive");
  assert.equal(fiveToTenRequired({ bootstrap95: { low: 50, high: -50 } }), true, "an inverted unusable interval is never conclusive");
});

test("only a finite interval entirely above or below zero is conclusive", () => {
  assert.deepEqual(
    primaryConclusion({ bootstrap95: { low: -100, high: -50 } }),
    { conclusive: true, unusable: false, direction: "treatment-lower", reason: null },
  );
  assert.deepEqual(
    primaryConclusion({ bootstrap95: { low: 60, high: 120 } }),
    { conclusive: true, unusable: false, direction: "treatment-higher", reason: null },
  );
  const zero = primaryConclusion({ bootstrap95: { low: -10, high: 10 } });
  assert.equal(zero.conclusive, false);
  assert.equal(zero.unusable, false);
  const unusable = primaryConclusion({ bootstrap95: { low: null, high: null } });
  assert.equal(unusable.conclusive, false);
  assert.equal(unusable.unusable, true);
  const failedOnly = primaryInterval(
    [
      attempt("t1", 1, "upstream", { status: "failed", success: false, tokens: 5 }),
      attempt("t1", 1, "remediated-defaults", { status: "failed", success: false, tokens: 5 }),
      attempt("t1", 1, "none"),
      attempt("t1", 1, "remediated-archive"),
    ],
    { treatment: "remediated-defaults", baseline: "upstream", seed: "s" },
  );
  assert.equal(failedOnly.n, 0, "failed tasks never produce savings pairs");
  assert.equal(primaryConclusion(failedOnly).conclusive, false, "failed tasks are never conclusive savings");
  assert.equal(fiveToTenRequired(failedOnly), true, "an all-failure primary interval requires repetitions 6-10");
});
