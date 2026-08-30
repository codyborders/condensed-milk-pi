/**
 * Provider-study statistics (growing test-first).
 *
 * Matched complete blocks only: a block enters analysis only when all
 * four arms completed. Incomplete blocks are rejected outright.
 */

/** Blocks where every arm completed; incomplete blocks are rejected. */
export function completeBlocks(rows, arms) {
  const armSet = new Set(arms);
  const byKey = new Map();
  for (const row of rows) {
    if (!armSet.has(row.arm)) continue;
    if (row.status !== "completed") continue;
    const key = `${row.taskId}::${row.rep}`;
    if (!byKey.has(key)) byKey.set(key, new Map());
    byKey.get(key).set(row.arm, row);
  }
  const blocks = [];
  for (const [key, armRows] of byKey) {
    if (armRows.size !== armSet.size) continue;
    const [taskId, rep] = key.split("::");
    blocks.push({ taskId, rep: Number(rep), arms: Object.fromEntries(armRows) });
  }
  blocks.sort((left, right) =>
    left.taskId === right.taskId ? left.rep - right.rep : left.taskId.localeCompare(right.taskId),
  );
  return blocks;
}

import { pairedBootstrapInterval, pairedTInterval } from "../../runner/masking-stats.mjs";

function numeric(value) {
  return typeof value === "number" && Number.isFinite(value) ? value : null;
}

function accountingUsable(row) {
  if (row?.providerTrafficAnomaly === true) return false;
  if (typeof row?.proxyFailedRequestCount === "number" && row.proxyFailedRequestCount > 0) return false;
  if (typeof row?.proxyRejectedCount === "number" && row.proxyRejectedCount > 0) return false;
  return numeric(row?.totalProviderTokens) !== null;
}

/**
 * Primary comparison: paired treatment-minus-baseline differences of
 * success-only total provider tokens over complete blocks. Both arms
 * of a pair must be successful; failed attempts never count as
 * savings.
 */
export function primaryInterval(rows, { treatment, baseline, seed, arms = null }) {
  const armList = arms ?? [...new Set(rows.map((row) => row.arm))];
  const blocks = completeBlocks(rows, armList);
  const differences = [];
  let successTreatment = 0;
  let successBaseline = 0;
  const perTask = new Map();
  for (const block of blocks) {
    const treatmentRow = block.arms[treatment];
    const baselineRow = block.arms[baseline];
    if (treatmentRow?.success === true) successTreatment += 1;
    if (baselineRow?.success === true) successBaseline += 1;
    if (treatmentRow?.success !== true || baselineRow?.success !== true) continue;
    if (!accountingUsable(treatmentRow) || !accountingUsable(baselineRow)) continue;
    const treatmentTokens = numeric(treatmentRow.totalProviderTokens);
    const baselineTokens = numeric(baselineRow.totalProviderTokens);
    if (treatmentTokens === null || baselineTokens === null) continue;
    differences.push(treatmentTokens - baselineTokens);
    if (!perTask.has(block.taskId)) perTask.set(block.taskId, []);
    perTask.get(block.taskId).push(treatmentTokens - baselineTokens);
  }
  const mean = differences.length > 0 ? differences.reduce((sum, value) => sum + value, 0) / differences.length : null;
  const sorted = [...differences].sort((left, right) => left - right);
  const median = sorted.length === 0
    ? null
    : sorted.length % 2 === 1
      ? sorted[(sorted.length - 1) / 2]
      : (sorted[sorted.length / 2 - 1] + sorted[sorted.length / 2]) / 2;
  return {
    metric: "totalProviderTokensSuccessOnly",
    treatment,
    baseline,
    n: differences.length,
    meanPairedChange: mean,
    medianPairedChange: median,
    bootstrap95: pairedBootstrapInterval(differences, 0.95, { iterations: 2000, seed: `${seed}:${treatment}-vs-${baseline}` }),
    pairedT95: pairedTInterval(differences, 0.95),
    successes: { [treatment]: successTreatment, [baseline]: successBaseline },
    taskClustered: clusteredBootstrap(perTask, 0.95, `${seed}:clustered`),
  };
}

/** Task-clustered bootstrap: resample whole tasks with a seeded PRNG. */
function clusteredBootstrap(perTask, level, seed) {
  const tasks = [...perTask.keys()];
  if (tasks.length === 0) {
    return { method: "task-clustered-bootstrap", seed, taskCount: 0, n: 0, low: null, high: null, level };
  }
  const random = seededRandom(seed);
  const means = [];
  for (let iteration = 0; iteration < 2000; iteration += 1) {
    const pooled = [];
    for (let pick = 0; pick < tasks.length; pick += 1) {
      pooled.push(...perTask.get(tasks[Math.floor(random() * tasks.length)]));
    }
    if (pooled.length > 0) means.push(pooled.reduce((sum, value) => sum + value, 0) / pooled.length);
  }
  means.sort((left, right) => left - right);
  return {
    method: "task-clustered-bootstrap",
    seed,
    taskCount: tasks.length,
    n: means.length,
    low: means[Math.floor((means.length * (1 - level)) / 2)] ?? null,
    high: means[Math.floor((means.length * (1 + level) / 2)) - 1] ?? null,
    level,
  };
}

function seededRandom(seedText) {
  let hash = 2166136261;
  for (let index = 0; index < seedText.length; index += 1) {
    hash ^= seedText.charCodeAt(index);
    hash = Math.imul(hash, 16777619);
  }
  let state = hash >>> 0;
  return function random() {
    state = (state + 0x6d2b79f5) >>> 0;
    let t = state;
    t = Math.imul(t ^ (t >>> 15), t | 1);
    t ^= t + Math.imul(t ^ (t >>> 7), t | 61);
    return ((t ^ (t >>> 14)) >>> 0) / 4294967296;
  };
}

/**
 * Five-to-ten rule: repetitions 6-10 must run for every task and arm
 * unless the primary default-vs-upstream interval is conclusively
 * away from zero. A missing, null, invalid, incomplete, or otherwise
 * unusable interval is never conclusive, so it also requires
 * repetitions 6-10 — the gate fails toward more data, never toward a
 * silent conclusion.
 */
export function fiveToTenRequired(primary) {
  const conclusion = primaryConclusion(primary);
  return !conclusion.conclusive;
}

/**
 * Primary-interval conclusion. Only a finite interval that lies
 * entirely above or entirely below zero is conclusive; an interval
 * that includes zero is inconclusive, and missing, null, invalid,
 * incomplete, non-finite, or inverted bounds are unusable. Failed
 * tasks never enter the differences, so an all-failure primary is
 * unusable rather than conclusive savings.
 */
export function primaryConclusion(primary) {
  const bounds = primary?.taskClustered ?? primary?.bootstrap95 ?? primary;
  const low = bounds?.low;
  const high = bounds?.high;
  if (
    typeof low !== "number" || typeof high !== "number"
    || !Number.isFinite(low) || !Number.isFinite(high)
  ) {
    return {
      conclusive: false,
      unusable: true,
      direction: null,
      reason: "the primary interval is missing, null, invalid, incomplete, or otherwise unusable",
    };
  }
  if (low > high) {
    return {
      conclusive: false,
      unusable: true,
      direction: null,
      reason: "the primary interval bounds are inverted",
    };
  }
  if (low > 0) {
    return { conclusive: true, unusable: false, direction: "treatment-higher", reason: null };
  }
  if (high < 0) {
    return { conclusive: true, unusable: false, direction: "treatment-lower", reason: null };
  }
  return { conclusive: false, unusable: false, direction: null, reason: "the primary interval includes zero" };
}
