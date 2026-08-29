#!/usr/bin/env node
/**
 * Real-filesystem archive contract benchmark.
 *
 * This benchmark measures local ArchiveStore work only. It records no token,
 * provider, model-quality, or cost claim. Use --write only after intentional
 * result regeneration.
 */
import { mkdtempSync, readFileSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";

const quick = process.env.ARCHIVE_BENCH_QUICK === "1";
const repoRoot = new URL("..", import.meta.url).pathname;
const {
  ARCHIVE_LIMIT_CEILINGS,
  ArchiveStore,
  DEFAULT_ARCHIVE_LIMITS,
  defaultArchiveFilesystem,
} = await import(join(repoRoot, "filters", "recovery.ts"));
const { compressStaleToolResults, resolveRules, emptyUserConfig } = await import(
  join(repoRoot, "filters", "context-compress.ts")
);

const rules = resolveRules(emptyUserConfig());
const progressiveCandidateCounts = [100, 200, 300, 400, 500];
const WARMUP = quick ? 0 : 2;
const ITERATIONS = quick ? 1 : 20;
const P95_BUDGET_MS = quick ? 1_000 : 250;
const STEADY_P95_BUDGET_MS = quick ? 1_000 : 25;
const BASE_CLOCK = 1_700_000_000_000;
const long = (i) => `bench-${i} ${"payload ".repeat(30)}\n`.repeat(3);
const entryName = /(?:^|\/)cm2-[0-9a-f]{64}\.json(?:$|\.)/;
const entryTempName = /(?:^|\/)cm2-[0-9a-f]{64}\.json\..+\.tmp$/;
const indexTempName = /(?:^|\/)index\.json\..+\.tmp$/;

function buildMessages(count) {
  const messages = [{ role: "user", content: [{ type: "text", text: "turn" }] }];
  for (let i = 0; i < count; i++) {
    messages.push({
      role: "toolResult",
      toolCallId: `call-${i}`,
      toolName: "bash",
      isError: false,
      details: { command: `echo ${i}` },
      content: [{ type: "text", text: long(i) }],
    });
  }
  return messages;
}

function maskOnce(messages, store) {
  const options = {
    thresholds: [0.3],
    coverage: [1],
    contextUsage: 1,
    previousCutoff: 0,
    zoneEntered: -1,
    rules,
    // This matches production: disabled archive installs a batch wrapper
    // whose preparation result is null, so masking fails open.
    archiveBatch: {
      prepareBatch: (candidates) => (store ? store.prepareBatch(candidates) : null),
    },
  };
  return compressStaleToolResults(messages, options);
}

function percentile(values, p) {
  if (values.length === 0) return null;
  const sorted = [...values].sort((a, b) => a - b);
  const index = Math.min(sorted.length - 1, Math.ceil((p / 100) * sorted.length) - 1);
  return sorted[Math.max(0, index)];
}

function countingFilesystem() {
  const base = defaultArchiveFilesystem();
  const counts = {
    filesystemCalls: 0,
    entryWrites: 0,
    entryRenames: 0,
    indexWrites: 0,
    indexRenames: 0,
    verificationReads: 0,
    verificationStats: 0,
  };
  const fs = {};
  for (const key of Object.keys(base)) {
    fs[key] = (...args) => {
      counts.filesystemCalls++;
      const first = typeof args[0] === "string" ? args[0] : "";
      const second = typeof args[1] === "string" ? args[1] : "";
      if (key === "writeFileSync") {
        if (entryTempName.test(first)) counts.entryWrites++;
        if (indexTempName.test(first)) counts.indexWrites++;
      }
      if (key === "renameSync") {
        if (entryName.test(second)) counts.entryRenames++;
        if (second.endsWith("/index.json")) counts.indexRenames++;
      }
      if (key === "readFileSync" && entryName.test(first)) counts.verificationReads++;
      if (key === "statSync" && entryName.test(first)) counts.verificationStats++;
      return base[key](...args);
    };
  }
  return { fs, counts };
}

function delta(after, before) {
  const result = {};
  for (const key of Object.keys(after)) result[key] = after[key] - (before[key] ?? 0);
  return result;
}

function canonicalFor(id, createdAt, blocks) {
  return JSON.stringify({ v: 2, id, createdAt, blocks });
}

function extractReferences(result) {
  const references = new Map();
  let masked = 0;
  let visible = 0;
  for (const message of result?.messages ?? []) {
    if (message?.role !== "toolResult") continue;
    const text = (message.content ?? [])
      .filter((block) => block?.type === "text")
      .map((block) => block.text ?? "")
      .join("\n");
    const match = /\[cm-archive ((?:cm-[0-9a-f]{16}|cm2-[0-9a-f]{64}))\]/.exec(text);
    if (text.startsWith("[cm-masked bash]")) {
      masked++;
      if (match && typeof message.toolCallId === "string") references.set(message.toolCallId, match[1]);
    } else {
      visible++;
    }
  }
  return { references, masked, visible };
}

function readLiveTotals(root, sessionKey) {
  try {
    const index = JSON.parse(readFileSync(join(root, sessionKey, "index.json"), "utf8"));
    const rows = Object.values(index.entries ?? {});
    return {
      entries: rows.length,
      bytes: rows.reduce((sum, row) => sum + (typeof row.bytes === "number" ? row.bytes : 0), 0),
    };
  } catch {
    return { entries: 0, bytes: 0 };
  }
}

function configuredTotals(limits) {
  return {
    maxEntries: limits.maxEntries,
    maxEntryBytes: limits.maxEntryBytes,
    maxAggregateBytes: limits.maxAggregateBytes,
    ttlMs: limits.ttlMs,
  };
}

function makeLimits(overrides = {}) {
  return {
    ...DEFAULT_ARCHIVE_LIMITS,
    ...overrides,
  };
}

function scenarioDefinitions() {
  const fullAggregate = ARCHIVE_LIMIT_CEILINGS.maxAggregateBytes;
  return [
    {
      name: "steady-state",
      enabled: true,
      counts: [100, 100, 100, 100, 100],
      limits: makeLimits({ maxEntries: 512, maxAggregateBytes: fullAggregate }),
    },
    {
      name: "progressive-disabled",
      enabled: false,
      counts: progressiveCandidateCounts,
      limits: makeLimits({ maxEntries: 512, maxAggregateBytes: fullAggregate }),
    },
    {
      name: "progressive-capacity-above",
      enabled: true,
      counts: progressiveCandidateCounts,
      limits: makeLimits({ maxEntries: 512, maxAggregateBytes: fullAggregate }),
    },
    {
      name: "progressive-capacity-below",
      enabled: true,
      counts: progressiveCandidateCounts,
      limits: makeLimits({ maxEntries: 128, maxAggregateBytes: fullAggregate }),
    },
    {
      name: "progressive-entry-pressure",
      enabled: true,
      counts: progressiveCandidateCounts,
      limits: makeLimits({ maxEntries: 4, maxAggregateBytes: fullAggregate }),
    },
    {
      name: "progressive-aggregate-pressure",
      enabled: true,
      counts: progressiveCandidateCounts,
      limits: makeLimits({ maxEntries: 512, maxAggregateBytes: 32_000 }),
    },
    {
      name: "progressive-ttl-expiry",
      enabled: true,
      counts: progressiveCandidateCounts,
      limits: makeLimits({ maxEntries: 512, maxAggregateBytes: fullAggregate, ttlMs: 60_000 }),
      advanceClock: true,
    },
    {
      name: "progressive-recreation",
      enabled: true,
      counts: progressiveCandidateCounts,
      limits: makeLimits({ maxEntries: 512, maxAggregateBytes: fullAggregate }),
      recreate: true,
    },
  ];
}

function runSequence(scenario, capture) {
  const root = mkdtempSync(join(tmpdir(), quick ? "cm-archive-bench-q-" : "cm-archive-bench-"));
  const sessionKey = `bench-${scenario.name}`;
  const { fs, counts } = countingFilesystem();
  const clock = { value: BASE_CLOCK };
  let store = null;
  let previous = new Map();
  const expectedByReference = new Map();
  const passes = [];
  try {
    for (let pass = 0; pass < scenario.counts.length; pass++) {
      if (scenario.advanceClock && pass > 0) clock.value += scenario.limits.ttlMs + 1;
      if (scenario.enabled && (store === null || scenario.recreate)) {
        store = new ArchiveStore(root, sessionKey, scenario.limits, () => clock.value, fs);
      }
      const count = scenario.counts[pass];
      const messages = buildMessages(count);
      const before = { ...counts };
      const started = performance.now();
      const result = maskOnce(messages, scenario.enabled ? store : null);
      const elapsed = performance.now() - started;
      const operations = delta(counts, before);
      const extracted = extractReferences(result);
      if (!result) extracted.visible = count;
      const current = extracted.references;
      let existing = 0;
      for (const [toolCallId, reference] of current) {
        if (previous.get(toolCallId) === reference) existing++;
      }
      let retrievalCount = 0;
      let oldReferenceAliasCount = 0;
      let evictions = 0;
      let expirations = 0;
      const passFailures = [];

      if (scenario.enabled) {
        for (const [toolCallId, reference] of current) {
          retrievalCount++;
          const outcome = store.retrieve(reference);
          if (outcome.kind !== "ok") {
            passFailures.push(`${scenario.name} pass ${pass + 1}: emitted reference ${reference} returned ${outcome.kind}`);
            continue;
          }
          const candidateIndex = Number(toolCallId.substring("call-".length));
          const expected = expectedByReference.get(reference)
            ?? canonicalFor(reference, clock.value, messages[candidateIndex + 1].content);
          if (outcome.canonical !== expected) {
            passFailures.push(`${scenario.name} pass ${pass + 1}: reference ${reference} returned unexpected canonical bytes`);
          }
          expectedByReference.set(reference, expected);
        }
        for (const [toolCallId, oldReference] of previous) {
          if (current.get(toolCallId) === oldReference) continue;
          retrievalCount++;
          const outcome = store.retrieve(oldReference);
          if (outcome.kind === "evicted") evictions++;
          if (outcome.kind === "expired") expirations++;
          if (outcome.kind === "ok") {
            const expected = expectedByReference.get(oldReference);
            if (expected !== undefined && outcome.canonical !== expected) oldReferenceAliasCount++;
          }
        }
      }

      const liveStorageTotals = scenario.enabled
        ? readLiveTotals(root, sessionKey)
        : { entries: 0, bytes: 0 };
      const configuredStorageTotals = configuredTotals(scenario.limits);
      if (liveStorageTotals.entries > scenario.limits.maxEntries) {
        passFailures.push(`${scenario.name} pass ${pass + 1}: live entry count exceeds configured limit`);
      }
      if (liveStorageTotals.bytes > scenario.limits.maxAggregateBytes) {
        passFailures.push(`${scenario.name} pass ${pass + 1}: live aggregate bytes exceed configured limit`);
      }
      if (scenario.enabled && extracted.masked !== current.size) {
        passFailures.push(`${scenario.name} pass ${pass + 1}: masked survivor count does not match emitted references`);
      }
      if (!scenario.enabled && (extracted.masked !== 0 || operations.filesystemCalls !== 0)) {
        passFailures.push(`${scenario.name} pass ${pass + 1}: disabled archive performed masking or filesystem work`);
      }
      const expectedVisible = count - extracted.masked;
      if (extracted.visible !== expectedVisible) {
        passFailures.push(`${scenario.name} pass ${pass + 1}: non-survivors were not visible`);
      }

      const record = {
        pass: pass + 1,
        candidates: count,
        existingLiveReferences: existing,
        newlyAdmittedReferences: current.size - existing,
        evictions,
        expirations,
        maskedSurvivors: extracted.masked,
        visibleNonSurvivors: extracted.visible,
        entryWrites: operations.entryWrites,
        entryRenames: operations.entryRenames,
        indexWrites: operations.indexWrites,
        indexRenames: operations.indexRenames,
        entryWriteFileSync: operations.entryWrites,
        entryRenameSync: operations.entryRenames,
        indexWriteFileSync: operations.indexWrites,
        indexRenameSync: operations.indexRenames,
        verificationReads: operations.verificationReads,
        verificationStats: operations.verificationStats,
        retrievalCount,
        oldReferenceAliasCount,
        configuredStorageTotals,
        liveStorageTotals,
        archiveFilesystemWork: operations.filesystemCalls,
        medianRuntimeMs: null,
        p95RuntimeMs: null,
        failures: passFailures,
      };
      if (capture && capture.passRecords[pass] === undefined) capture.passRecords[pass] = record;
      passes.push({ record, elapsed });
      previous = current;
    }
    if (capture) capture.captured = true;
    return passes;
  } finally {
    rmSync(root, { recursive: true, force: true });
  }
}

function measureScenario(scenario) {
  const samples = Array.from({ length: scenario.counts.length }, () => []);
  const capture = { passRecords: [], captured: false };
  for (let iteration = 0; iteration < WARMUP + ITERATIONS; iteration++) {
    const sequence = runSequence(scenario, iteration >= WARMUP ? capture : null);
    if (iteration >= WARMUP) {
      for (const item of sequence) samples[item.record.pass - 1].push(item.elapsed);
    }
  }
  const passes = capture.passRecords.map((record, index) => ({
    ...record,
    medianRuntimeMs: Number(percentile(samples[index], 50).toFixed(3)),
    p95RuntimeMs: Number(percentile(samples[index], 95).toFixed(3)),
    timingSamples: samples[index].length,
  }));
  return {
    name: scenario.name,
    archive: scenario.enabled ? "enabled" : "disabled",
    recreatedBetweenPasses: Boolean(scenario.recreate),
    ttlAdvancesBetweenPasses: Boolean(scenario.advanceClock),
    candidateCounts: scenario.counts,
    configuredStorageTotals: configuredTotals(scenario.limits),
    passes,
  };
}

const failures = [];
const scenarios = scenarioDefinitions().map(measureScenario);
const steady = scenarios.find((scenario) => scenario.name === "steady-state");
const steadyStateRepeatedRewriteFailures = [];
for (const pass of steady.passes.filter((_, index) => index > 0)) {
  if (pass.entryWrites !== 0 || pass.entryRenames !== 0 || pass.indexWrites !== 0 || pass.indexRenames !== 0) {
    steadyStateRepeatedRewriteFailures.push(`steady-state pass ${pass.pass}: archive content or index rewrite occurred`);
  }
  if (pass.p95RuntimeMs >= STEADY_P95_BUDGET_MS) {
    steadyStateRepeatedRewriteFailures.push(`steady-state pass ${pass.pass}: p95 ${pass.p95RuntimeMs}ms >= ${STEADY_P95_BUDGET_MS}ms`);
  }
}
failures.push(...steadyStateRepeatedRewriteFailures);

for (const scenario of scenarios) {
  for (const pass of scenario.passes) {
    failures.push(...pass.failures);
    if (![pass.medianRuntimeMs, pass.p95RuntimeMs].every(Number.isFinite)) {
      failures.push(`${scenario.name} pass ${pass.pass}: timing sample is not finite`);
    }
    if (pass.pass > 1 && pass.p95RuntimeMs >= P95_BUDGET_MS) {
      failures.push(`${scenario.name} pass ${pass.pass}: p95 ${pass.p95RuntimeMs}ms >= ${P95_BUDGET_MS}ms`);
    }
  }
}

const above = scenarios.find((scenario) => scenario.name === "progressive-capacity-above");
for (const pass of above.passes) {
  if (pass.newlyAdmittedReferences <= 0) failures.push(`progressive-capacity-above pass ${pass.pass}: no new candidate was admitted`);
}
const ttl = scenarios.find((scenario) => scenario.name === "progressive-ttl-expiry");
if (!ttl.passes.filter((_, index) => index > 0).some((pass) => pass.expirations > 0)) failures.push("progressive-ttl-expiry: no expirations recorded");
const recreation = scenarios.find((scenario) => scenario.name === "progressive-recreation");
if (!recreation.passes.filter((_, index) => index > 0).some((pass) => pass.verificationReads > 0 && pass.verificationStats > 0)) {
  failures.push("progressive-recreation: recreated stores did not verify existing entries");
}
const aggregate = scenarios.find((scenario) => scenario.name === "progressive-aggregate-pressure");
if (!aggregate.passes.some((pass) => pass.liveStorageTotals.bytes >= aggregate.configuredStorageTotals.maxAggregateBytes * 0.9)) {
  failures.push("progressive-aggregate-pressure: aggregate-byte pressure was not exercised");
}

const report = {
  schemaVersion: 2,
  benchmark: "archive-context",
  generatedAt: new Date().toISOString(),
  nodeVersion: process.version,
  quick,
  warmupIterations: WARMUP,
  measuredIterations: ITERATIONS,
  progressiveCandidateCounts,
  gateBudgetMs: P95_BUDGET_MS,
  steadyStateP95BudgetMs: STEADY_P95_BUDGET_MS,
  gates: {
    steadyStateRepeatedRewriteFailures,
    failures,
  },
  scenarios,
  failures,
};

if (process.argv.includes("--write")) {
  writeFileSync(join(repoRoot, "benchmarks", "archive-results.json"), JSON.stringify(report, null, 2) + "\n");
}

console.log(`archive benchmark: ${scenarios.length} scenarios, ${failures.length === 0 ? "all gates passed" : `${failures.length} gate failures`}`);
if (failures.length > 0) {
  for (const failure of failures) console.error(` - ${failure}`);
}
if (process.argv.includes("--json")) console.log(JSON.stringify(report));
if (failures.length > 0) process.exit(1);
