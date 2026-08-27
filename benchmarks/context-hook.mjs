#!/usr/bin/env node
import { createHash } from "node:crypto";
import { cpus, platform, release } from "node:os";
import { execFileSync } from "node:child_process";
import { mkdirSync, readFileSync, renameSync, unlinkSync, writeFileSync } from "node:fs";
import { fileURLToPath, pathToFileURL } from "node:url";
import { dirname, resolve } from "node:path";
import process from "node:process";
import { performance } from "node:perf_hooks";

function argumentValue(name) {
  const index = process.argv.indexOf(name);
  if (index !== -1) return process.argv[index + 1];
  const prefix = `${name}=`;
  const inline = process.argv.find((argument) => argument.startsWith(prefix));
  return inline?.slice(prefix.length);
}

const implementationRootArgument = argumentValue("--implementation-root");
const implementationRoot = resolve(implementationRootArgument ?? resolve(dirname(fileURLToPath(import.meta.url)), ".."));
const expectedCommit = argumentValue("--expected-commit");
if (implementationRootArgument !== undefined || expectedCommit !== undefined) {
  const rootIndex = process.argv.indexOf("--implementation-root");
  const expectedCommitIndex = process.argv.indexOf("--expected-commit");
  if ((rootIndex === -1 && !process.argv.some((argument) => argument.startsWith("--implementation-root="))) || (expectedCommitIndex === -1 && !process.argv.some((argument) => argument.startsWith("--expected-commit="))) || !expectedCommit) {
    throw new Error("--implementation-root and --expected-commit must be provided together");
  }
  const status = execFileSync("git", ["-C", implementationRoot, "status", "--porcelain=v1", "--untracked-files=all"], { encoding: "utf8" }).trim();
  if (status) throw new Error(`implementation root is not a clean Git worktree: ${implementationRoot}`);
  const actualCommit = execFileSync("git", ["-C", implementationRoot, "rev-parse", "HEAD"], { encoding: "utf8" }).trim();
  if (actualCommit !== expectedCommit) {
    throw new Error(`expected commit ${expectedCommit}, found ${actualCommit}`);
  }
}
const implementationModulePath = resolve(implementationRoot, "filters/context-compress.ts");
const targetCommit = execFileSync("git", ["-C", implementationRoot, "rev-parse", "HEAD"], { encoding: "utf8" }).trim();
const implementationModuleSha256 = sha256File(implementationModulePath);
const harnessSha256 = sha256File(fileURLToPath(import.meta.url));
const { compressStaleToolResults } = await import(pathToFileURL(implementationModulePath).href);

const MESSAGE_COUNTS = [100, 1_000, 5_000, 10_000];
const BASH_DENSITIES = [0.25, 0.5, 0.9];
const CWD_DISTRIBUTIONS = ["single", "balanced", "skewed"];
const WARMUP_ITERATIONS = 5;
const MEASURED_ITERATIONS = 20;
const SEED = 0x4d494c4b;
const P95_BUDGETS_MS = {
  100: 25,
  1000: 75,
  5000: 250,
  10000: 500,
};
const HOOK_OPTIONS = Object.freeze({
  contextUsage: 1,
  previousCutoff: 0,
  zoneEntered: -1,
});

function chooseCwd(distribution, index) {
  if (distribution === "single") return 0;
  if (distribution === "balanced") return index % 4;
  return index % 10 < 8 ? 0 : index % 4;
}

function isBashMessage(index, density) {
  const bucket = (index * 7919 + SEED) % 1000;
  return bucket < density * 1000;
}

function makeHistory(messageCount, bashDensity, cwdDistribution) {
  const messages = [];
  let bashMessages = 0;
  const cwdCounts = [0, 0, 0, 0];
  for (let index = 0; index < messageCount; index += 1) {
    if (isBashMessage(index, bashDensity)) {
      const cwdIndex = chooseCwd(cwdDistribution, index);
      const command = `cd /synthetic/workspace-${cwdIndex} && printf result-${index}`;
      const text = `synthetic bash result ${index} seed ${SEED} ` +
        "fixed output payload for context hook benchmark. ".repeat(4);
      messages.push({
        role: "toolResult",
        toolName: "bash",
        isError: false,
        details: { command },
        content: [{ type: "text", text }],
      });
      bashMessages += 1;
      cwdCounts[cwdIndex] += 1;
    } else if (index % 2 === 0) {
      messages.push({
        role: "user",
        content: [{ type: "text", text: `synthetic user turn ${index}` }],
      });
    } else {
      messages.push({
        role: "assistant",
        content: [{ type: "text", text: `synthetic assistant turn ${index}` }],
      });
    }
  }
  return { messages, bashMessages, cwdCounts };
}

function sha256File(path) {
  return createHash("sha256").update(readFileSync(path)).digest("hex");
}

function hash(value) {
  return createHash("sha256").update(JSON.stringify(value)).digest("hex");
}

function percentile(values, percentileValue) {
  const sorted = [...values].sort((left, right) => left - right);
  const rank = Math.max(0, Math.ceil(percentileValue * sorted.length) - 1);
  return sorted[rank];
}

function median(values) {
  const sorted = [...values].sort((left, right) => left - right);
  const middle = sorted.length / 2;
  return (sorted[middle - 1] + sorted[middle]) / 2;
}

function roundMilliseconds(value) {
  return Number(value.toFixed(3));
}

function runCase(messageCount, bashDensity, cwdDistribution) {
  const input = makeHistory(messageCount, bashDensity, cwdDistribution);
  const inputHash = hash(input.messages);
  const outputHashes = [];
  const durations = [];
  const heapDeltas = [];
  const masks = [];

  for (let iteration = 0; iteration < WARMUP_ITERATIONS; iteration += 1) {
    const result = compressStaleToolResults(input.messages, HOOK_OPTIONS);
    outputHashes.push(hash(result?.messages ?? null));
  }
  if (typeof globalThis.gc === "function") globalThis.gc();

  for (let iteration = 0; iteration < MEASURED_ITERATIONS; iteration += 1) {
    const beforeHeap = process.memoryUsage().heapUsed;
    const started = performance.now();
    const result = compressStaleToolResults(input.messages, HOOK_OPTIONS);
    const elapsed = performance.now() - started;
    const afterHeap = process.memoryUsage().heapUsed;
    outputHashes.push(hash(result?.messages ?? null));
    durations.push(elapsed);
    heapDeltas.push(afterHeap - beforeHeap);
    masks.push(result?.masksApplied ?? 0);
  }

  const firstHash = outputHashes[0];
  const repeatedOutputHashesMatch = outputHashes.every((outputHash) => outputHash === firstHash);
  if (!repeatedOutputHashesMatch) {
    throw new Error(`non-deterministic output hash for ${messageCount}/${bashDensity}/${cwdDistribution}`);
  }

  const rawP95Ms = percentile(durations, 0.95);
  const p95Ms = roundMilliseconds(rawP95Ms);
  const p95BudgetMs = P95_BUDGETS_MS[messageCount];
  return {
    messageCount,
    bashDensity,
    cwdDistribution,
    input: {
      seed: SEED,
      bashMessages: input.bashMessages,
      cwdCounts: input.cwdCounts,
      inputHash,
    },
    warmupIterations: WARMUP_ITERATIONS,
    measuredIterations: MEASURED_ITERATIONS,
    medianMs: roundMilliseconds(median(durations)),
    p95Ms,
    p95BudgetMs,
    observedHeapDeltaBytes: Math.round(Math.max(...heapDeltas)),
    totalMasks: masks[0],
    totalMasksMeasured: masks.reduce((total, count) => total + count, 0),
    masksPerRun: masks[0],
    outputHash: firstHash,
    outputHashCount: new Set(outputHashes).size,
    repeatedOutputHashesMatch,
    budgetPassed: rawP95Ms <= p95BudgetMs,
  };
}

function makeReport() {
  const measurements = [];
  for (const messageCount of MESSAGE_COUNTS) {
    for (const bashDensity of BASH_DENSITIES) {
      for (const cwdDistribution of CWD_DISTRIBUTIONS) {
        measurements.push(runCase(messageCount, bashDensity, cwdDistribution));
      }
    }
  }

  const budgetFailures = measurements.filter((measurement) => !measurement.budgetPassed);
  return {
    generatedAt: new Date().toISOString(),
    targetCommit,
    implementationRoot,
    implementationModule: "filters/context-compress.ts",
    implementationModuleSha256,
    harnessSha256,
    nodeVersion: process.version,
    platform: {
      name: platform(),
      release: release(),
      arch: process.arch,
    },
    cpu: {
      model: cpus()[0]?.model ?? "unknown",
      logicalCores: cpus().length,
    },
    machine: {
      platform: {
        name: platform(),
        release: release(),
        arch: process.arch,
      },
      cpu: {
        model: cpus()[0]?.model ?? "unknown",
        logicalCores: cpus().length,
      },
    },
    config: {
      seed: SEED,
      warmupIterations: WARMUP_ITERATIONS,
      measuredIterations: MEASURED_ITERATIONS,
      hookOptions: HOOK_OPTIONS,
      p95BudgetsMs: P95_BUDGETS_MS,
      garbageCollectionExposed: typeof globalThis.gc === "function",
    },
    inputs: {
      messageCounts: MESSAGE_COUNTS,
      bashDensities: BASH_DENSITIES,
      cwdDistributions: CWD_DISTRIBUTIONS,
      historyGenerator: "fixed synthetic tool-result histories; deterministic seed and payload",
    },
    measurements,
    inputHashes: measurements.map((measurement) => ({
      messageCount: measurement.messageCount,
      bashDensity: measurement.bashDensity,
      cwdDistribution: measurement.cwdDistribution,
      sha256: measurement.input.inputHash,
    })),
    outputHashes: measurements.map((measurement) => ({
      messageCount: measurement.messageCount,
      bashDensity: measurement.bashDensity,
      cwdDistribution: measurement.cwdDistribution,
      sha256: measurement.outputHash,
      count: measurement.outputHashCount,
    })),
    allBudgetsPassed: budgetFailures.length === 0,
    budgetFailures: budgetFailures.map((measurement) => ({
      messageCount: measurement.messageCount,
      bashDensity: measurement.bashDensity,
      cwdDistribution: measurement.cwdDistribution,
      p95Ms: measurement.p95Ms,
      p95BudgetMs: measurement.p95BudgetMs,
    })),
  };
}

function writeReport(report, requestedPath) {
  const scriptDirectory = dirname(fileURLToPath(import.meta.url));
  const outputPath = requestedPath ?? resolve(scriptDirectory, "results.json");
  mkdirSync(dirname(outputPath), { recursive: true });
  const temporaryPath = `${outputPath}.${process.pid}.${Date.now()}.tmp`;
  try {
    writeFileSync(temporaryPath, `${JSON.stringify(report, null, 2)}\n`, "utf8");
    renameSync(temporaryPath, outputPath);
  } catch (error) {
    try { unlinkSync(temporaryPath); } catch { /* best effort cleanup */ }
    throw error;
  }
  return outputPath;
}

const report = makeReport();
const shouldWrite = process.argv.slice(2).includes("--write");
const requestedOutput = argumentValue("--output");
if (requestedOutput) writeReport(report, resolve(requestedOutput));
if (shouldWrite && report.allBudgetsPassed && !requestedOutput) writeReport(report);
process.stdout.write(`${JSON.stringify(report, null, 2)}\n`);
if (!report.allBudgetsPassed) process.exitCode = 1;
