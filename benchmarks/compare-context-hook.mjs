#!/usr/bin/env node
import { createHash } from "node:crypto";
import { existsSync, readFileSync, mkdirSync, renameSync, writeFileSync, unlinkSync } from "node:fs";
import { dirname, resolve } from "node:path";
import process from "node:process";

function fail(message) {
  throw new Error(`compare-context-hook: ${message}`);
}

function assertCondition(condition, message) {
  if (!condition) fail(message);
}

function stableJson(value) {
  if (Array.isArray(value)) return `[${value.map(stableJson).join(",")}]`;
  if (value && typeof value === "object") {
    return `{${Object.keys(value).sort().map((key) => `${JSON.stringify(key)}:${stableJson(value[key])}`).join(",")}}`;
  }
  return JSON.stringify(value);
}

function machineOf(report) {
  return report.machine ?? { platform: report.platform, cpu: report.cpu };
}

function caseKey(measurement) {
  return `${measurement.messageCount}/${measurement.bashDensity}/${measurement.cwdDistribution}`;
}

/** Recorded p95 values are rounded to three decimals. */
const P95_ROUNDING_TOLERANCE_MS = 0.0005;

/**
 * Verify one source case budget directly from its own numbers:
 * p95BudgetMs must be a present non-negative number, budgetPassed must
 * be a stated boolean consistent with p95Ms <= p95BudgetMs (a flag may
 * only differ from the recomputation inside the rounding window), and
 * the recomputed verdict is authoritative for the comparison.
 */
function verifiedBudget(measurement, arm) {
  const key = caseKey(measurement);
  const budget = measurement.p95BudgetMs;
  assertCondition(
    typeof budget === "number" && Number.isFinite(budget) && budget >= 0,
    `${arm} case ${key} is missing p95BudgetMs`,
  );
  const p95 = measurement.p95Ms;
  assertCondition(
    typeof p95 === "number" && Number.isFinite(p95),
    `${arm} case ${key} has no numeric p95Ms`,
  );
  assertCondition(
    typeof measurement.budgetPassed === "boolean",
    `${arm} case ${key} does not state a boolean budgetPassed`,
  );
  const recomputed = p95 <= budget;
  if (measurement.budgetPassed !== recomputed) {
    assertCondition(
      Math.abs(p95 - budget) <= P95_ROUNDING_TOLERANCE_MS,
      `${arm} case ${key} has inconsistent budgetPassed ${measurement.budgetPassed} for p95Ms ${p95} against p95BudgetMs ${budget}`,
    );
  }
  return recomputed;
}

function indexMeasurements(report, arm) {
  assertCondition(Array.isArray(report?.measurements), `${arm} report measurements must be an array`);
  const indexed = new Map();
  for (const measurement of report.measurements) {
    const key = caseKey(measurement);
    assertCondition(!indexed.has(key), `${arm} report has duplicate case ${key}`);
    assertCondition(measurement.input?.inputHash, `${arm} case ${key} is missing input hash`);
    assertCondition(measurement.repeatedOutputHashesMatch === true, `${arm} case ${key} has non-deterministic output`);
    assertCondition(measurement.outputHashCount === 1, `${arm} case ${key} has multiple output hashes`);
    indexed.set(key, { measurement, budgetPassed: verifiedBudget(measurement, arm) });
  }
  return indexed;
}

function median(values) {
  const ordered = [...values].sort((left, right) => left - right);
  const middle = ordered.length / 2;
  return ordered.length % 2 === 0
    ? (ordered[middle - 1] + ordered[middle]) / 2
    : ordered[Math.floor(middle)];
}

function ratio(fork, upstream) {
  return upstream === 0 ? null : fork / upstream;
}

function round(value) {
  return Number(value.toFixed(6));
}

function timing(upstream, fork) {
  return {
    medianDeltaMs: round(fork.medianMs - upstream.medianMs),
    p95DeltaMs: round(fork.p95Ms - upstream.p95Ms),
    medianRatio: upstream.medianMs === 0 ? null : round(ratio(fork.medianMs, upstream.medianMs)),
    p95Ratio: upstream.p95Ms === 0 ? null : round(ratio(fork.p95Ms, upstream.p95Ms)),
  };
}

function aggregateCases(cases, messageCount = null) {
  const selected = messageCount === null
    ? cases
    : cases.filter((item) => item.messageCount === messageCount);
  const upstreamMedian = median(selected.map((item) => item.upstream.medianMs));
  const forkMedian = median(selected.map((item) => item.fork.medianMs));
  const upstreamP95 = median(selected.map((item) => item.upstream.p95Ms));
  const forkP95 = median(selected.map((item) => item.fork.p95Ms));
  const result = {
    messageCount,
    caseCount: selected.length,
    upstream: {
      medianMs: round(upstreamMedian),
      p95Ms: round(upstreamP95),
      totalMasks: selected.reduce((sum, item) => sum + item.upstream.masksPerRun, 0),
      budgetPassed: selected.every((item) => item.upstream.budgetPassed),
    },
    fork: {
      medianMs: round(forkMedian),
      p95Ms: round(forkP95),
      totalMasks: selected.reduce((sum, item) => sum + item.fork.masksPerRun, 0),
      budgetPassed: selected.every((item) => item.fork.budgetPassed),
    },
  };
  result.timing = {
    medianDeltaMs: round(forkMedian - upstreamMedian),
    p95DeltaMs: round(forkP95 - upstreamP95),
    medianRatio: upstreamMedian === 0 ? null : round(forkMedian / upstreamMedian),
    p95Ratio: upstreamP95 === 0 ? null : round(forkP95 / upstreamP95),
  };
  result.maskCountDifference = result.fork.totalMasks - result.upstream.totalMasks;
  result.budgetStatus = {
    upstream: result.upstream.budgetPassed,
    fork: result.fork.budgetPassed,
    passed: result.upstream.budgetPassed && result.fork.budgetPassed,
  };
  return result;
}

export function compareReports(upstream, fork) {
  assertCondition(upstream?.harnessSha256 && fork?.harnessSha256, "reports must record harness hash");
  assertCondition(upstream.harnessSha256 === fork.harnessSha256, "harness hash mismatch");
  assertCondition(upstream.nodeVersion === fork.nodeVersion, "Node version mismatch");
  assertCondition(stableJson(machineOf(upstream)) === stableJson(machineOf(fork)), "machine mismatch");

  const upstreamCases = indexMeasurements(upstream, "upstream");
  const forkCases = indexMeasurements(fork, "fork");
  assertCondition(upstreamCases.size === forkCases.size, "case dimension count mismatch");
  for (const key of upstreamCases.keys()) assertCondition(forkCases.has(key), `case dimension mismatch at ${key}`);

  const cases = [];
  for (const [key, upstreamEntry] of upstreamCases) {
    const forkEntry = forkCases.get(key);
    const upstreamMeasurement = upstreamEntry.measurement;
    const forkMeasurement = forkEntry.measurement;
    assertCondition(forkMeasurement.input.inputHash === upstreamMeasurement.input.inputHash, `input hash mismatch at ${key}`);
    assertCondition(
      forkMeasurement.p95BudgetMs === upstreamMeasurement.p95BudgetMs,
      `p95BudgetMs mismatch at ${key}: upstream ${upstreamMeasurement.p95BudgetMs} vs fork ${forkMeasurement.p95BudgetMs}`,
    );
    const item = {
      messageCount: upstreamMeasurement.messageCount,
      bashDensity: upstreamMeasurement.bashDensity,
      cwdDistribution: upstreamMeasurement.cwdDistribution,
      inputHash: upstreamMeasurement.input.inputHash,
      upstream: {
        medianMs: upstreamMeasurement.medianMs,
        p95Ms: upstreamMeasurement.p95Ms,
        p95BudgetMs: upstreamMeasurement.p95BudgetMs,
        masksPerRun: upstreamMeasurement.masksPerRun,
        outputHash: upstreamMeasurement.outputHash,
        budgetPassed: upstreamEntry.budgetPassed,
      },
      fork: {
        medianMs: forkMeasurement.medianMs,
        p95Ms: forkMeasurement.p95Ms,
        p95BudgetMs: forkMeasurement.p95BudgetMs,
        masksPerRun: forkMeasurement.masksPerRun,
        outputHash: forkMeasurement.outputHash,
        budgetPassed: forkEntry.budgetPassed,
      },
    };
    item.timing = timing(item.upstream, item.fork);
    item.maskCountDifference = item.fork.masksPerRun - item.upstream.masksPerRun;
    item.outputHashEqual = item.upstream.outputHash === item.fork.outputHash;
    item.budgetStatus = {
      upstream: item.upstream.budgetPassed,
      fork: item.fork.budgetPassed,
      passed: item.upstream.budgetPassed && item.fork.budgetPassed,
    };
    cases.push(item);
  }
  cases.sort((left, right) => left.messageCount - right.messageCount || left.bashDensity - right.bashDensity || left.cwdDistribution.localeCompare(right.cwdDistribution));
  const messageCounts = [...new Set(cases.map((item) => item.messageCount))].sort((left, right) => left - right);
  return {
    schemaVersion: 1,
    generatedAt: new Date().toISOString(),
    upstream: { targetCommit: upstream.targetCommit ?? null, implementationModuleSha256: upstream.implementationModuleSha256 ?? null },
    fork: { targetCommit: fork.targetCommit ?? null, implementationModuleSha256: fork.implementationModuleSha256 ?? null },
    harnessSha256: upstream.harnessSha256,
    nodeVersion: upstream.nodeVersion,
    machine: machineOf(upstream),
    cases,
    aggregates: {
      byMessageCount: messageCounts.map((messageCount) => aggregateCases(cases, messageCount)),
      total: aggregateCases(cases),
    },
    allBudgetsPassed: cases.every((item) => item.budgetStatus.passed),
  };
}

function markdownNumber(value) {
  return value === null || value === undefined ? "-" : String(value);
}

export function renderMarkdown(result) {
  const lines = [
    "# Context-hook benchmark comparison",
    "",
    `- Upstream commit: ${result.upstream.targetCommit ?? "unknown"}`,
    `- Fork commit: ${result.fork.targetCommit ?? "unknown"}`,
    `- Node: ${result.nodeVersion}`,
    `- Budgets passed: ${result.allBudgetsPassed ? "yes" : "no"}`,
    "",
    "## Cases",
    "",
    "| Messages | Bash density | CWD | Median delta (ms) | p95 delta (ms) | Median ratio | p95 ratio | Mask delta | Output hash equal | Budget |",
    "| ---: | ---: | --- | ---: | ---: | ---: | ---: | ---: | :---: | :---: |",
  ];
  for (const item of result.cases) {
    lines.push(`| ${item.messageCount} | ${item.bashDensity} | ${item.cwdDistribution} | ${markdownNumber(item.timing.medianDeltaMs)} | ${markdownNumber(item.timing.p95DeltaMs)} | ${markdownNumber(item.timing.medianRatio)} | ${markdownNumber(item.timing.p95Ratio)} | ${item.maskCountDifference} | ${item.outputHashEqual ? "yes" : "no"} | ${item.budgetStatus.passed ? "pass" : "fail"} |`);
  }
  lines.push("", "## Aggregates", "", "| Group | Cases | Median delta (ms) | p95 delta (ms) | Median ratio | p95 ratio | Mask delta | Budget |", "| --- | ---: | ---: | ---: | ---: | ---: | ---: | :---: |");
  for (const aggregate of [...result.aggregates.byMessageCount, result.aggregates.total]) {
    const group = aggregate.messageCount === null ? "total" : String(aggregate.messageCount);
    lines.push(`| ${group} | ${aggregate.caseCount} | ${markdownNumber(aggregate.timing.medianDeltaMs)} | ${markdownNumber(aggregate.timing.p95DeltaMs)} | ${markdownNumber(aggregate.timing.medianRatio)} | ${markdownNumber(aggregate.timing.p95Ratio)} | ${aggregate.maskCountDifference} | ${aggregate.budgetStatus.passed ? "pass" : "fail"} |`);
  }
  lines.push("", "Timing differences are descriptive only. Output-hash differences are allowed between algorithms.", "");
  return lines.join("\n");
}

function atomicWrite(path, content) {
  const destination = resolve(path);
  mkdirSync(dirname(destination), { recursive: true });
  const temporary = `${destination}.${process.pid}.${Date.now()}.tmp`;
  try {
    writeFileSync(temporary, content, "utf8");
    renameSync(temporary, destination);
  } catch (error) {
    try { unlinkSync(temporary); } catch { /* best effort cleanup */ }
    throw error;
  }
}

function readReport(path, arm) {
  assertCondition(existsSync(path), `${arm} result does not exist: ${path}`);
  try { return JSON.parse(readFileSync(path, "utf8")); } catch (error) { fail(`cannot parse ${arm} result ${path}: ${error.message}`); }
}

function parseArgs(argv) {
  const positional = [];
  const flags = {};
  const valueFlags = new Set(["--json-output", "--markdown-output", "--output"]);
  for (let index = 0; index < argv.length; index += 1) {
    const arg = argv[index];
    if (valueFlags.has(arg)) {
      if (index + 1 >= argv.length) fail(`${arg} needs a path`);
      flags[arg] = argv[++index];
    } else if (arg.startsWith("--") && arg.includes("=")) {
      const [name, ...rest] = arg.split("=");
      if (!valueFlags.has(name)) fail(`unknown option ${name}`);
      flags[name] = rest.join("=");
    } else if (arg.startsWith("--")) {
      fail(`unknown option ${arg}`);
    } else positional.push(arg);
  }
  assertCondition(positional.length === 2, "usage: compare-context-hook.mjs UPSTREAM.json FORK.json [--json-output FILE] [--markdown-output FILE]");
  return { upstream: positional[0], fork: positional[1], flags };
}

export function main(argv = process.argv.slice(2)) {
  const args = parseArgs(argv);
  const comparison = compareReports(readReport(args.upstream, "upstream"), readReport(args.fork, "fork"));
  const markdown = renderMarkdown(comparison);
  const json = `${JSON.stringify({ ...comparison, markdown }, null, 2)}\n`;
  const jsonPath = args.flags["--json-output"] ?? args.flags["--output"];
  const markdownPath = args.flags["--markdown-output"] ?? (args.flags["--output"] ? `${args.flags["--output"]}.md` : null);
  if (jsonPath) atomicWrite(jsonPath, json);
  if (markdownPath) atomicWrite(markdownPath, markdown + "\n");
  process.stdout.write(json);
  return comparison.allBudgetsPassed ? 0 : 1;
}

if (import.meta.url === `file://${process.argv[1]}`) {
  try { process.exitCode = main(); } catch (error) { process.stderr.write(`${error.message}\n`); process.exitCode = 1; }
}
