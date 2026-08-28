#!/usr/bin/env node
/**
 * Real-filesystem archive-enabled context benchmark.
 *
 * Dimensions: candidate counts 100, 300, 1000, 10000; passes 1, 2, 5;
 * archive enabled and disabled, with supported capacities above and below
 * candidate count. Reports absolute timings and recorded upstream ratios.
 * A 10,000-candidate case uses the supported maximum, which stays below
 * candidate count. The report also includes survivor
 * counts, and filesystem operation counts. Gates: repeated-pass p95 must
 * stay under 25 ms and repeated passes must perform zero content
 * rewrites. Use --write to persist results to benchmarks/archive-results.json.
 */
import { mkdtempSync, readFileSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";

const quick = process.env.ARCHIVE_BENCH_QUICK === "1";
const repoRoot = new URL("..", import.meta.url).pathname;
const { ARCHIVE_LIMIT_CEILINGS, ArchiveStore, DEFAULT_ARCHIVE_LIMITS, defaultArchiveFilesystem } = await import(
  join(repoRoot, "filters", "recovery.ts")
);
const { compressStaleToolResults, resolveRules, emptyUserConfig } = await import(
  join(repoRoot, "filters", "context-compress.ts")
);

const rules = resolveRules(emptyUserConfig());
const CANDIDATES = quick ? [100] : [100, 300, 1000, 10000];
const PASSES = [1, 2, 5];
const ITERATIONS = quick ? 3 : 8;
const WARMUP = 2;
const P95_BUDGET_MS = 25;
const long = (i) => `bench-${i} ${"payload ".repeat(30)}\n`.repeat(3);

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
  };
  if (store !== null) {
    options.archiveBatch = { prepareBatch: (candidates) => store.prepareBatch(candidates) };
  }
  return compressStaleToolResults(messages, options);
}

function percentile(values, p) {
  if (values.length === 0) return null;
  const sorted = [...values].sort((a, b) => a - b);
  const idx = Math.min(sorted.length - 1, Math.ceil((p / 100) * sorted.length) - 1);
  return sorted[Math.max(0, idx)];
}

// Exact upstream timings use the same candidate generator and pass numbers.
const baselineByCount = new Map();
try {
  const recorded = JSON.parse(readFileSync(join(repoRoot, "benchmarks", "archive-upstream-baseline.json"), "utf8"));
  for (const measurement of recorded.measurements ?? []) {
    if (typeof measurement.candidates !== "number") continue;
    baselineByCount.set(measurement.candidates, measurement.passTimingsMs);
  }
} catch {
  // A missing baseline leaves ratios null. Release tests reject that state.
}

function exactBaseline(count) {
  const passTimingsMs = baselineByCount.get(count);
  return passTimingsMs === undefined ? null : { count, passTimingsMs };
}

function countingFilesystem() {
  const base = defaultArchiveFilesystem();
  const counts = {
    entryWriteFileSync: 0,
    entryRenameSync: 0,
    indexWriteFileSync: 0,
    indexRenameSync: 0,
    lockAcquireSync: 0,
    lockReleaseSync: 0,
  };
  const fs = {};
  for (const key of Object.keys(base)) {
    counts[key] = 0;
    fs[key] = (...args) => {
      counts[key] += 1;
      const first = typeof args[0] === "string" ? args[0] : "";
      const second = typeof args[1] === "string" ? args[1] : "";
      if (key === "writeFileSync") {
        if (/\/cm-[0-9a-f]{16}\.json\..+\.tmp$/.test(first)) counts.entryWriteFileSync += 1;
        else if (/\/index\.json\..+\.tmp$/.test(first)) counts.indexWriteFileSync += 1;
      }
      if (key === "mkdirSync" && first.endsWith("/batch.lock")) counts.lockAcquireSync += 1;
      if (key === "rmdirSync" && first.endsWith("/batch.lock")) counts.lockReleaseSync += 1;
      if (key === "renameSync") {
        if (/\/cm-[0-9a-f]{16}\.json$/.test(second)) counts.entryRenameSync += 1;
        else if (second.endsWith("/index.json")) counts.indexRenameSync += 1;
      }
      return base[key](...args);
    };
  }
  return { fs, counts };
}

function countMasks(result) {
  if (!result) return 0;
  return result.messages.filter((m) =>
    m.role === "toolResult" &&
    (m.content ?? []).some((b) => b?.type === "text" && b.text?.startsWith("[cm-masked bash]")),
  ).length;
}

const measurements = [];
const failures = [];
for (const count of CANDIDATES) {
  const messages = buildMessages(count);
  for (const enabled of [true, false]) {
    const supportedHighCapacity = Math.min(ARCHIVE_LIMIT_CEILINGS.maxEntries, count + 50);
    const capacities = [
      {
        mode: supportedHighCapacity > count ? "above" : "maximum-below",
        maxEntries: supportedHighCapacity,
      },
      { mode: "below", maxEntries: Math.max(1, Math.min(128, count - 1)) },
    ];
    for (const capacity of capacities) {
      const key = {
        candidates: count,
        archive: enabled ? "enabled" : "disabled",
        capacityMode: capacity.mode,
        maxEntries: capacity.maxEntries,
      };
      const passSamples = new Map(PASSES.map((p) => [p, []]));
      let survivors = null;
      for (let iter = 0; iter < WARMUP + ITERATIONS; iter++) {
        const root = mkdtempSync(join(tmpdir(), quick ? "cm-arch-bench-q-" : "cm-arch-bench-"));
        try {
          const store = new ArchiveStore(
            root,
            "bench-session",
            {
              ...DEFAULT_ARCHIVE_LIMITS,
              maxEntries: capacity.maxEntries,
              maxAggregateBytes: Math.min(
                ARCHIVE_LIMIT_CEILINGS.maxAggregateBytes,
                Math.max(DEFAULT_ARCHIVE_LIMITS.maxAggregateBytes, count * 2_048),
              ),
            },
            () => 1_700_000_000_000,
          );
          for (let pass = 1; pass <= 5; pass++) {
            const started = performance.now();
            const result = maskOnce(messages, enabled ? store : null);
            const elapsed = performance.now() - started;
            if (iter >= WARMUP && PASSES.includes(pass)) passSamples.get(pass).push(elapsed);
            if (pass === 5 && iter === WARMUP) survivors = countMasks(result);
          }
        } finally {
          rmSync(root, { recursive: true, force: true });
        }
      }
      const stats = {};
      for (const p of PASSES) {
        const samples = passSamples.get(p);
        stats[p] = {
          samples: samples.length,
          medianMs: Number(percentile(samples, 50).toFixed(3)),
          p95Ms: Number(percentile(samples, 95).toFixed(3)),
        };
      }
      const repeatedP95 = Math.max(...PASSES.filter((p) => p >= 2).map((p) => stats[p].p95Ms));
      const gateRepeatedP95 = repeatedP95 < P95_BUDGET_MS;
      if (!gateRepeatedP95) failures.push(`${JSON.stringify(key)}: repeated-pass p95 ${repeatedP95}ms >= ${P95_BUDGET_MS}ms`);

      // Operation counts for one five-pass sequence on a fresh store.
      const root = mkdtempSync(join(tmpdir(), "cm-arch-bench-ops-"));
      let ops;
      try {
        const { fs, counts } = countingFilesystem();
        const store = new ArchiveStore(
          root,
          "bench-session",
          {
            ...DEFAULT_ARCHIVE_LIMITS,
            maxEntries: capacity.maxEntries,
            maxAggregateBytes: Math.min(
              ARCHIVE_LIMIT_CEILINGS.maxAggregateBytes,
              Math.max(DEFAULT_ARCHIVE_LIMITS.maxAggregateBytes, count * 2_048),
            ),
          },
          () => 1_700_000_000_000,
          fs,
        );
        const snapshots = [];
        for (let pass = 1; pass <= 5; pass++) {
          maskOnce(messages, enabled ? store : null);
          snapshots.push({ ...counts });
        }
        ops = { perPass: snapshots };
        const repeatedDelta = {};
        for (const op of [
          "entryWriteFileSync",
          "entryRenameSync",
          "indexWriteFileSync",
          "indexRenameSync",
          "lockAcquireSync",
          "lockReleaseSync",
          "readFileSync",
        ]) {
          repeatedDelta[op] = snapshots[4][op] - snapshots[3][op];
        }
        ops.repeatedPassDelta = repeatedDelta;
        if (enabled) {
          if (repeatedDelta.entryWriteFileSync !== 0 || repeatedDelta.entryRenameSync !== 0) {
            failures.push(`${JSON.stringify(key)}: repeated pass rewrote archive content`);
          }
          if (repeatedDelta.indexWriteFileSync !== 0 || repeatedDelta.indexRenameSync !== 0) {
            failures.push(`${JSON.stringify(key)}: repeated pass rewrote the archive index`);
          }
        }
      } finally {
        rmSync(root, { recursive: true, force: true });
      }

      const base = exactBaseline(count);
      measurements.push({
        ...key,
        baseline: base,
        passTimingsMs: stats,
        repeatedP95BudgetMs: P95_BUDGET_MS,
        repeatedP95Ms: Number(repeatedP95.toFixed(3)),
        gateRepeatedP95Passed: gateRepeatedP95,
        survivors,
        operationCounts: ops,
        ratiosVsUpstream: base ? Object.fromEntries(PASSES.map((pass) => [
          pass,
          Number((stats[pass].medianMs / base.passTimingsMs[pass].medianMs).toFixed(3)),
        ])) : null,
      });
    }
  }
}

const report = {
  generatedAt: new Date().toISOString(),
  nodeVersion: process.version,
  quick,
  measuredIterations: ITERATIONS,
  gate: { repeatedP95BudgetMs: P95_BUDGET_MS, zeroRepeatedRewrites: true },
  baselineSource: "benchmarks/archive-upstream-baseline.json exact upstream passes",
  measurements,
  failures,
};

if (process.argv.includes("--write")) {
  writeFileSync(join(repoRoot, "benchmarks", "archive-results.json"), JSON.stringify(report, null, 2) + "\n");
}
for (const m of measurements) {
  console.log(
    `cand=${m.candidates} archive=${m.archive} cap=${m.maxEntries} ` +
    `p1 med/p95=${m.passTimingsMs[1].medianMs}/${m.passTimingsMs[1].p95Ms}ms ` +
    `p5 med/p95=${m.passTimingsMs[5].medianMs}/${m.passTimingsMs[5].p95Ms}ms ` +
    `upstreamRatios=${JSON.stringify(m.ratiosVsUpstream)} survivors=${m.survivors} ` +
    `repeatDelta=${JSON.stringify(m.operationCounts.repeatedPassDelta)} gate=${m.gateRepeatedP95Passed}`,
  );
}
if (failures.length > 0) {
  console.error("archive benchmark FAILED gates:");
  for (const f of failures) console.error(` - ${f}`);
  process.exit(1);
}
console.log(`archive benchmark: ${measurements.length} combinations, all gates passed`);
