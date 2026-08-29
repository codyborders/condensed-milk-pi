/**
 * Provider-study sanitized report writer (growing test-first).
 *
 * Rows carry only allowlisted metric fields and ids. Reports are new
 * files under evaluation/results/provider-study; an existing file is
 * never overwritten.
 */

import { existsSync, mkdirSync, readFileSync, writeFileSync } from "node:fs";
import { join } from "node:path";
import { loadProviderStudyManifestFile } from "./manifest.mjs";
import { providerStudySchedule, providerStudyPlannedBlocks, providerStudyPlannedSlots } from "./schedule.mjs";
import { providerStudyReadCompletedResult, providerStudySlotPath } from "./reserve.mjs";
import { completeBlocks, primaryInterval, fiveToTenRequired, primaryConclusion } from "./stats.mjs";

// Report rows walk the shared planned-slot enumeration so conditional
// repetitions 6-10 appear whenever those slots exist.
export const PROVIDER_STUDY_ROW_FIELDS = Object.freeze([
  "taskId",
  "arm",
  "rep",
  "conditional",
  "status",
  "success",
  "deterministicResult",
  "qualityScore",
  "usageInput",
  "usageOutput",
  "usageCacheRead",
  "usageCacheWrite",
  "totalProviderTokens",
  "peakContextTokens",
  "modelRequests",
  "assistantCompletions",
  "proxyRequestCount",
  "proxyStatusCounts",
  "proxyFailedRequestCount",
  "proxyRejectedCount",
  "providerTrafficAnomaly",
  "wallTimeMs",
  "firstEventLatencyMs",
  "toolCalls",
  "shellReruns",
  "fileRereads",
  "testReruns",
  "buildReruns",
  "compressionEvents",
  "historicalMaskEvents",
  "archiveReferences",
  "retrievalCalls",
  "retrievalFailures",
]);

const ARMS = ["none", "upstream", "remediated-defaults", "remediated-archive"];

function readJsonOrNull(path) {
  if (!existsSync(path)) return null;
  try {
    return JSON.parse(readFileSync(path, "utf8"));
  } catch {
    return null;
  }
}

function sanitizedRow(taskId, arm, rep, result, quality) {
  const row = {
    taskId,
    arm,
    rep,
    conditional: result?.conditional === true,
    status: typeof result?.status === "string" ? result.status : "unknown",
    success: result?.deterministicResult === true,
    deterministicResult: result?.deterministicResult === true,
    qualityScore: typeof quality?.qualityScore === "number" ? quality.qualityScore : null,
    usageInput: result?.usage?.input ?? null,
    usageOutput: result?.usage?.output ?? null,
    usageCacheRead: result?.usage?.cacheRead ?? null,
    usageCacheWrite: result?.usage?.cacheWrite ?? null,
    totalProviderTokens: typeof result?.totalProviderTokens === "number" ? result.totalProviderTokens : null,
    peakContextTokens: typeof result?.peakContextTokens === "number" ? result.peakContextTokens : null,
    modelRequests: typeof result?.modelRequests === "number" ? result.modelRequests : null,
    assistantCompletions: typeof result?.assistantCompletions === "number" ? result.assistantCompletions : null,
    proxyRequestCount: typeof result?.proxyRequestCount === "number" ? result.proxyRequestCount : null,
    proxyStatusCounts: result?.proxyStatusCounts !== null && typeof result?.proxyStatusCounts === "object" && !Array.isArray(result?.proxyStatusCounts)
      ? result.proxyStatusCounts
      : {},
    proxyFailedRequestCount: typeof result?.proxyFailedRequestCount === "number" ? result.proxyFailedRequestCount : null,
    proxyRejectedCount: typeof result?.proxyRejectedCount === "number" ? result.proxyRejectedCount : null,
    providerTrafficAnomaly: result?.providerTrafficAnomaly === null ? null : result?.providerTrafficAnomaly === true,
    wallTimeMs: typeof result?.wallTimeMs === "number" ? result.wallTimeMs : null,
    firstEventLatencyMs: typeof result?.firstEventLatencyMs === "number" ? result.firstEventLatencyMs : null,
    toolCalls: typeof result?.toolCalls === "number" ? result.toolCalls : null,
    shellReruns: typeof result?.shellReruns === "number" ? result.shellReruns : null,
    fileRereads: typeof result?.fileRereads === "number" ? result.fileRereads : null,
    testReruns: typeof result?.testReruns === "number" ? result.testReruns : null,
    buildReruns: typeof result?.buildReruns === "number" ? result.buildReruns : null,
    compressionEvents: typeof result?.compressionEvents === "number" ? result.compressionEvents : null,
    historicalMaskEvents: typeof result?.historicalMaskEvents === "number" ? result.historicalMaskEvents : null,
    archiveReferences: typeof result?.archiveReferences === "number" ? result.archiveReferences : null,
    retrievalCalls: typeof result?.retrievalCalls === "number" ? result.retrievalCalls : null,
    retrievalFailures: typeof result?.retrievalFailures === "number" ? result.retrievalFailures : null,
  };
  for (const field of Object.keys(row)) {
    if (!PROVIDER_STUDY_ROW_FIELDS.includes(field)) delete row[field];
  }
  return row;
}

function mean(values) {
  return values.length === 0 ? null : values.reduce((sum, value) => sum + value, 0) / values.length;
}

function median(values) {
  if (values.length === 0) return null;
  const ordered = [...values].sort((left, right) => left - right);
  const middle = Math.floor(ordered.length / 2);
  return ordered.length % 2 === 1 ? ordered[middle] : (ordered[middle - 1] + ordered[middle]) / 2;
}

function metricSummary(rows, field) {
  const values = rows.map((row) => row[field]).filter((value) => typeof value === "number" && Number.isFinite(value));
  return {
    n: values.length,
    sum: values.length === 0 ? null : values.reduce((total, value) => total + value, 0),
    mean: mean(values),
    median: median(values),
  };
}

const SUCCESS_METRICS = [
  "totalProviderTokens",
  "wallTimeMs",
  "toolCalls",
  "shellReruns",
  "fileRereads",
  "testReruns",
  "buildReruns",
  "retrievalCalls",
  "retrievalFailures",
  "proxyRequestCount",
  "proxyFailedRequestCount",
  "qualityScore",
];

function rowGroupSummary(rows) {
  const successful = rows.filter((row) => row.success === true && typeof row.totalProviderTokens === "number");
  const completed = rows.filter((row) => row.status === "completed").length;
  const successMetrics = Object.fromEntries(SUCCESS_METRICS.map((field) => [field, metricSummary(successful, field)]));
  successMetrics.tokenCategories = {
    input: metricSummary(successful, "usageInput"),
    output: metricSummary(successful, "usageOutput"),
    cacheRead: metricSummary(successful, "usageCacheRead"),
    cacheWrite: metricSummary(successful, "usageCacheWrite"),
  };
  const proxyStatusCounts = {};
  for (const row of rows) {
    for (const [status, count] of Object.entries(row.proxyStatusCounts ?? {})) {
      if (typeof count === "number" && Number.isFinite(count)) {
        proxyStatusCounts[status] = (proxyStatusCounts[status] ?? 0) + count;
      }
    }
  }
  return {
    attempts: rows.length,
    completed,
    successes: successful.length,
    failures: rows.length - successful.length,
    successRate: rows.length === 0 ? null : successful.length / rows.length,
    successful: successMetrics,
    proxyStatusCounts,
  };
}

function reportSummaries(rows, taskIds) {
  const byArm = Object.fromEntries(ARMS.map((arm) => [arm, rowGroupSummary(rows.filter((row) => row.arm === arm))]));
  const byTask = Object.fromEntries(taskIds.map((taskId) => [taskId, {
    arms: Object.fromEntries(ARMS.map((arm) => [arm, rowGroupSummary(rows.filter((row) => row.taskId === taskId && row.arm === arm))])),
  }]));
  return { byArm, byTask };
}

const COMPARISON_METRICS = [
  "totalProviderTokens",
  "usageInput",
  "usageOutput",
  "usageCacheRead",
  "usageCacheWrite",
  "wallTimeMs",
  "toolCalls",
  "shellReruns",
  "fileRereads",
  "testReruns",
  "buildReruns",
  "retrievalCalls",
  "retrievalFailures",
];

function pairedMetric(blocks, treatment, baseline, field) {
  const changes = [];
  const percentages = [];
  for (const block of blocks) {
    const left = block.arms[treatment];
    const right = block.arms[baseline];
    if (left?.success !== true || right?.success !== true) continue;
    const treatmentValue = left[field];
    const baselineValue = right[field];
    if (![treatmentValue, baselineValue].every((value) => typeof value === "number" && Number.isFinite(value))) continue;
    changes.push(treatmentValue - baselineValue);
    if (baselineValue !== 0) percentages.push(((treatmentValue - baselineValue) / baselineValue) * 100);
  }
  return {
    n: changes.length,
    meanPairedChange: mean(changes),
    medianPairedChange: median(changes),
    meanPairedPercentChange: mean(percentages),
    medianPairedPercentChange: median(percentages),
  };
}

function comparisonSummary(blocks, summaries, treatment, baseline) {
  return {
    treatment,
    baseline,
    successRateDifference: summaries.byArm[treatment].successRate - summaries.byArm[baseline].successRate,
    ...Object.fromEntries(COMPARISON_METRICS.map((field) => [field, pairedMetric(blocks, treatment, baseline, field)])),
  };
}

/**
 * Build and write the sanitized report for one phase. `label` names the
 * report files; an existing file refuses the write.
 */
export function providerStudyReport({ repoRoot, runsRoot, phase, label }) {
  const loaded = loadProviderStudyManifestFile(repoRoot, { phase });
  const schedule = providerStudySchedule(repoRoot, phase);
  const resultsRoot = join(repoRoot, "evaluation", "results", "provider-study");
  mkdirSync(resultsRoot, { recursive: true });
  const base = join(resultsRoot, `${phase}-${label}`);
  const jsonPath = `${base}.json`;
  const markdownPath = `${base}.md`;
  if (existsSync(jsonPath) || existsSync(markdownPath)) {
    throw new Error(`refusing to overwrite an existing report at ${base}.json or ${base}.md`);
  }
  const rows = [];
  for (const task of loaded.tasks) {
    const taskSchedule = schedule.tasks.find((entry) => entry.taskId === task.id);
    for (const block of providerStudyPlannedBlocks(taskSchedule)) {
      for (const arm of block.arms) {
        const attemptDir = providerStudySlotPath(runsRoot, phase, task.id, arm, block.rep);
        const result = providerStudyReadCompletedResult(attemptDir);
        // Unstarted slots are not rows; started attempts always stay in
        // the report, including failed ones. Conditional slots appear
        // whenever they exist because the shared planned-block walk
        // enumerates reps 6-10 next to the preallocated reps.
        if (result === null) continue;
        rows.push(sanitizedRow(
          task.id,
          arm,
          block.rep,
          result,
          readJsonOrNull(join(attemptDir, "quality.json")),
        ));
      }
    }
  }
  const blocks = completeBlocks(rows, ARMS);
  const primary = primaryInterval(rows, {
    treatment: "remediated-defaults",
    baseline: "upstream",
    seed: `provider-study:${phase}`,
    arms: ARMS,
  });
  const conclusion = primaryConclusion(primary);
  // After-ten state: when conditional slots exist the report says
  // whether the extended evidence settled the endpoint. After ten
  // repetitions an includes-zero interval stays inconclusive and no
  // further calls exist to make.
  const conditionalSlots = providerStudyPlannedSlots(repoRoot, phase).filter((slot) => slot.conditional);
  const conditionalComplete = conditionalSlots.length > 0 && conditionalSlots.every((slot) =>
    providerStudyReadCompletedResult(providerStudySlotPath(runsRoot, phase, slot.taskId, slot.arm, slot.rep)) !== null);
  const extended = rows.some((row) => row.rep >= 6);
  const afterTen = conditionalComplete
    ? (conclusion.conclusive ? "conclusive" : "inconclusive")
    : extended
      ? "pending"
      : null;
  const summaries = reportSummaries(rows, loaded.tasks.map((task) => task.id));
  const comparisons = {
    "remediated-defaults-vs-upstream": comparisonSummary(blocks, summaries, "remediated-defaults", "upstream"),
    "remediated-defaults-vs-none": comparisonSummary(blocks, summaries, "remediated-defaults", "none"),
    "remediated-archive-vs-remediated-defaults": comparisonSummary(blocks, summaries, "remediated-archive", "remediated-defaults"),
    "remediated-archive-vs-upstream": comparisonSummary(blocks, summaries, "remediated-archive", "upstream"),
  };
  const failures = rows
    .filter((row) => row.status !== "completed" || row.success !== true)
    .map((row) => ({ taskId: row.taskId, arm: row.arm, rep: row.rep, status: row.status }));
  const body = {
    schemaVersion: 1,
    study: "provider-study",
    phase,
    label,
    rows,
    summaries,
    comparisons,
    failures,
    statistics: {
      completeBlocks: blocks.length,
      primary,
      primaryConclusion: conclusion,
      fiveToTen: {
        extensionRequired: fiveToTenRequired(primary),
        extended,
        conditionalComplete,
        afterTen,
        maxRepetitions: 10,
      },
    },
    judgeUsageIncludedInTotals: false,
  };
  writeFileSync(jsonPath, `${JSON.stringify(body, null, 2)}\n`, "utf8");
  writeFileSync(markdownPath, `${markdownFor(body)}\n`, "utf8");
  return { jsonPath, markdownPath, rows: rows.length, completeBlocks: blocks.length };
}

function markdownFor(body) {
  return [
    `# Provider study ${body.phase} report ${body.label}`,
    "",
    `- Rows: ${body.rows.length}`,
    `- Complete blocks: ${body.statistics.completeBlocks}`,
    `- Five-to-ten extension required: ${body.statistics.fiveToTen.extensionRequired}`,
    `- Judge usage included in totals: ${body.judgeUsageIncludedInTotals}`,
  ].join("\n");
}
