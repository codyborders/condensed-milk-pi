import { createHash } from "node:crypto";
import { existsSync, readFileSync, readdirSync, statSync, writeFileSync } from "node:fs";
import { join, relative } from "node:path";
import { validateSelectedAttemptReceipt, runtimePinDigest } from "./receipt.mjs";

const ARMS = ["upstream", "fork"];
const USAGE_FIELDS = ["input", "output", "cacheRead", "cacheWrite"];
const PIN_FIELDS = ["promptSha256", "scorerSha256", "provider", "model", "thinking", "piVersion"];

function readJson(path) {
  if (!existsSync(path)) return null;
  try { return JSON.parse(readFileSync(path, "utf8")); } catch { return null; }
}
function selectedAttemptDir(runDir, taskId, arm, attempt) {
  return join(runDir, "attempts", taskId, arm, `attempt-${String(attempt).padStart(3, "0")}`);
}
function pairStatus({ runDir, runId, task, manifest, selection }) {
  const chosen = {};
  for (const arm of ARMS) {
    const attempt = selection[`${task.id}:${arm}`];
    if (typeof attempt !== "number") return { kind: "incomplete" };
    const dir = selectedAttemptDir(runDir, task.id, arm, attempt);
    const result = readJson(join(dir, "result.json"));
    if (!result) return { kind: "incomplete" };
    chosen[arm] = { dir, result };
  }
  for (const arm of ARMS) {
    const item = chosen[arm];
    // Receipt gate mirrors the select command: each selected attempt
    // must prove its invocation kind through its durable receipt.
    const receiptCheck = validateSelectedAttemptReceipt({
      runDir,
      attemptDir: item.dir,
      runId,
      taskId: task.id,
      arm,
      attempt: selection[`${task.id}:${arm}`],
      manifest,
    });
    if (!receiptCheck.ok) return { kind: "invalid", chosen };
    if (item.result.status !== "completed" || !["passed", "failed"].includes(item.result.scorer?.status)) return { kind: "invalid", chosen };
    item.before = readJson(join(item.dir, "fixture-before.json"));
    item.pinned = readJson(join(item.dir, "pinned.json"));
    if (!item.before?.contentSha256 || !item.before?.gitStateSha256 || !item.pinned) return { kind: "invalid", chosen };
    if (typeof item.pinned.promptSha256 !== "string" || typeof item.pinned.scorerSha256 !== "string") return { kind: "invalid", chosen };
  }
  if (chosen.upstream.before.contentSha256 !== chosen.fork.before.contentSha256 || chosen.upstream.before.gitStateSha256 !== chosen.fork.before.gitStateSha256) return { kind: "invalid", chosen };
  for (const field of PIN_FIELDS) if (chosen.upstream.pinned[field] !== chosen.fork.pinned[field]) return { kind: "invalid", chosen };
  // Runtime pin validity: legacy handling applies only when piRuntime
  // is absent everywhere (both arms and run.json). Any present pin must
  // be a valid object with a 64-hex digest; present-but-malformed pins
  // are invalid rather than compared as undefined; all present pins
  // must agree.
  const runPin = readJson(join(runDir, "run.json"))?.piRuntime;
  const upstreamPin = chosen.upstream.pinned.piRuntime;
  const forkPin = chosen.fork.pinned.piRuntime;
  if (runPin !== undefined || upstreamPin !== undefined || forkPin !== undefined) {
    if (runPin !== undefined && !runtimePinDigest(runPin)) return { kind: "invalid", chosen };
    for (const armPin of [upstreamPin, forkPin]) {
      if (armPin !== undefined && !runtimePinDigest(armPin)) return { kind: "invalid", chosen };
    }
    const upstreamDigest = runtimePinDigest(upstreamPin);
    const forkDigest = runtimePinDigest(forkPin);
    if (!upstreamDigest || !forkDigest) return { kind: "invalid", chosen };
    if (upstreamDigest !== forkDigest) return { kind: "invalid", chosen };
    const runDigest = runtimePinDigest(runPin);
    if (runDigest && runDigest !== upstreamDigest) return { kind: "invalid", chosen };
  }
  for (const arm of ARMS) {
    const expected = manifest.evaluation?.arms?.find((entry) => entry.name === arm)?.commit;
    if (chosen[arm].pinned.armCommit !== expected) return { kind: "invalid", chosen };
  }
  return { kind: "valid", chosen };
}
function valuesStats(values) {
  if (values.length === 0) return { total: null, mean: null, median: null, p95: null };
  const ordered = [...values].sort((left, right) => left - right);
  const middle = Math.floor(ordered.length / 2);
  const total = values.reduce((sum, value) => sum + value, 0);
  return { total, mean: total / values.length, median: values.length % 2 === 0 ? (ordered[middle - 1] + ordered[middle]) / 2 : ordered[middle], p95: ordered[Math.max(0, Math.ceil(ordered.length * 0.95) - 1)] };
}
function difference(fork, upstream) {
  return typeof fork === "number" && typeof upstream === "number" ? fork - upstream : null;
}
function eventStats(attemptDir) {
  const path = join(attemptDir, "pi-stdout.jsonl");
  if (!existsSync(path)) return { calls: 0, errors: 0, malformed: 0, placeholders: 0 };
  const body = readFileSync(path, "utf8");
  let calls = 0; let errors = 0; let malformed = 0; let placeholders = 0;
  for (const line of body.split("\n")) {
    if (line.trim().length === 0) continue;
    placeholders += line.split("[cm-masked ").length - 1;
    let event;
    try { event = JSON.parse(line); } catch { malformed += 1; continue; }
    if (event?.type === "tool_execution_start") calls += 1;
    if (event?.type === "tool_execution_end" && event.isError === true) errors += 1;
  }
  return { calls, errors, malformed, placeholders };
}
function makeArmMetrics() {
  return { scorerPasses: 0, totalScoreChecks: 0, durationMs: [], firstEventLatencyMs: [], usage: Object.fromEntries(USAGE_FIELDS.map((field) => [field, { total: null, missing: 0 }])), missingFields: Object.fromEntries(USAGE_FIELDS.map((field) => [field, 0])), proxy: { requests: 0, rejected: 0 }, tools: { calls: 0, errors: 0 }, jsonl: { malformed: 0 }, staticMaskPlaceholders: 0, attempts: 0 };
}
function addAttempt(metrics, chosen) {
  const result = chosen.result;
  metrics.attempts += 1;
  metrics.scorerPasses += result.scorer?.passedCount ?? 0;
  metrics.totalScoreChecks += result.scorer?.totalCount ?? 0;
  if (typeof result.durationMs === "number") metrics.durationMs.push(result.durationMs);
  if (typeof result.firstEventLatencyMs === "number") metrics.firstEventLatencyMs.push(result.firstEventLatencyMs);
  for (const field of USAGE_FIELDS) {
    if (typeof result.usage?.[field] === "number") metrics.usage[field].total = (metrics.usage[field].total ?? 0) + result.usage[field];
    else { metrics.usage[field].missing += 1; metrics.missingFields[field] += 1; }
  }
  const proxy = result.proxy ?? readJson(join(chosen.dir, "proxy.json"));
  metrics.proxy.requests += proxy?.requestCount ?? proxy?.requests?.length ?? 0;
  metrics.proxy.rejected += proxy?.rejectedCount ?? proxy?.rejected?.length ?? 0;
  const events = eventStats(chosen.dir);
  metrics.tools.calls += events.calls; metrics.tools.errors += events.errors; metrics.jsonl.malformed += events.malformed; metrics.staticMaskPlaceholders += events.placeholders;
}
function finalizeArmMetrics(metrics) {
  metrics.durationMs = valuesStats(metrics.durationMs);
  metrics.firstEventLatencyMs = valuesStats(metrics.firstEventLatencyMs);
  return metrics;
}
function csvCell(value) {
  const text = value === null || value === undefined ? "" : String(value);
  return /[",\n]/.test(text) ? `"${text.replaceAll('"', '""')}"` : text;
}
function artifactIndex(runDir, selected) {
  const artifacts = [];
  // Collected git state files live under final-state/ next to the
  // attempt; only their plain relative names are indexed, never
  // absolute paths or traversal segments from result data.
  const collectedName = /^[A-Za-z0-9][A-Za-z0-9._-]*$/;
  for (const item of selected) {
    const candidates = new Set(["result.json", "pinned.json", "fixture-before.json", "scorer.json", "proxy.json", "pi-stdout.jsonl", "pi-stderr.txt", "invocations.jsonl", "final-state.json"]);
    for (const entry of item.result.collection?.artifacts ?? []) {
      if (typeof entry?.file === "string" && collectedName.test(entry.file)) {
        candidates.add(join("final-state", entry.file));
      }
    }
    for (const file of [...candidates].sort()) {
      const path = join(item.dir, file);
      if (!existsSync(path) || !statSync(path).isFile()) continue;
      const body = readFileSync(path);
      artifacts.push({ taskId: item.taskId, arm: item.arm, attempt: item.attempt, file: relative(runDir, path), bytes: body.length, sha256: createHash("sha256").update(body).digest("hex") });
    }
  }
  return { schemaVersion: 1, artifacts };
}

export function buildAggregateReports({ runDir, runId, run, manifest, selection = {} }) {
  const arms = { upstream: makeArmMetrics(), fork: makeArmMetrics() };
  const pairs = { valid: 0, incomplete: 0, invalid: 0, outcomes: { bothPass: 0, upstreamOnly: 0, forkOnly: 0, bothFail: 0 }, rows: [] };
  const selected = []; const failures = []; let selectedCompleted = 0; let attemptsTotal = 0;
  for (const task of manifest.tasks) {
    for (const arm of ARMS) {
      const armDir = join(runDir, "attempts", task.id, arm);
      if (existsSync(armDir)) attemptsTotal += readdirSync(armDir).filter((name) => /^attempt-\d+$/.test(name)).length;
      const attempt = selection[`${task.id}:${arm}`];
      if (typeof attempt === "number" && readJson(join(selectedAttemptDir(runDir, task.id, arm, attempt), "result.json"))?.status === "completed") selectedCompleted += 1;
    }
    const pair = pairStatus({ runDir, runId, task, manifest, selection });
    if (pair.kind === "valid") {
      pairs.valid += 1;
      for (const arm of ARMS) {
        const attempt = selection[`${task.id}:${arm}`];
        addAttempt(arms[arm], pair.chosen[arm]);
        selected.push({ taskId: task.id, arm, attempt, dir: pair.chosen[arm].dir, result: pair.chosen[arm].result });
      }
      const upstreamPass = pair.chosen.upstream.result.scorer.status === "passed";
      const forkPass = pair.chosen.fork.result.scorer.status === "passed";
      if (upstreamPass && forkPass) pairs.outcomes.bothPass += 1;
      else if (upstreamPass) pairs.outcomes.upstreamOnly += 1;
      else if (forkPass) pairs.outcomes.forkOnly += 1;
      else pairs.outcomes.bothFail += 1;
    } else if (pair.kind === "invalid") pairs.invalid += 1;
    else pairs.incomplete += 1;
    const upstream = pair.chosen?.upstream?.result; const fork = pair.chosen?.fork?.result;
    pairs.rows.push({ taskId: task.id, pairStatus: pair.kind, upstreamAttempt: selection[`${task.id}:upstream`] ?? null, forkAttempt: selection[`${task.id}:fork`] ?? null, promptSha256: pair.chosen?.upstream?.pinned?.promptSha256 ?? null, scorerSha256: pair.chosen?.upstream?.pinned?.scorerSha256 ?? null, upstreamPass: upstream?.scorer?.status === "passed" ? true : upstream?.scorer?.status === "failed" ? false : null, forkPass: fork?.scorer?.status === "passed" ? true : fork?.scorer?.status === "failed" ? false : null, durationDeltaMs: difference(fork?.durationMs, upstream?.durationMs), inputDelta: difference(fork?.usage?.input, upstream?.usage?.input), outputDelta: difference(fork?.usage?.output, upstream?.usage?.output), cacheReadDelta: difference(fork?.usage?.cacheRead, upstream?.usage?.cacheRead), cacheWriteDelta: difference(fork?.usage?.cacheWrite, upstream?.usage?.cacheWrite) });
    for (const arm of ARMS) {
      const result = pair.chosen?.[arm]?.result;
      if (result && (result.status !== "completed" || result.scorer?.status === "failed")) failures.push({ taskId: task.id, arm, attempt: selection[`${task.id}:${arm}`], status: result.status, scorerStatus: result.scorer?.status ?? null });
    }
  }
  for (const arm of ARMS) finalizeArmMetrics(arms[arm]);
  const summary = { schemaVersion: 2, runId, mode: run.mode, selection, slots: { total: manifest.tasks.length * 2, completed: selectedCompleted }, attempts: { total: attemptsTotal }, pairs, arms, metrics: arms, usage: Object.fromEntries(ARMS.map((arm) => [arm, Object.fromEntries(USAGE_FIELDS.map((field) => [field, arms[arm].usage[field].total]))])) };
  writeFileSync(join(runDir, "summary.json"), `${JSON.stringify(summary, null, 2)}\n`, "utf8");
  const pairLines = ["taskId,pairStatus,upstreamAttempt,forkAttempt,promptSha256,scorerSha256,upstreamPass,forkPass,durationDeltaMs,inputDelta,outputDelta,cacheReadDelta,cacheWriteDelta"];
  for (const row of pairs.rows) pairLines.push([row.taskId, row.pairStatus, row.upstreamAttempt, row.forkAttempt, row.promptSha256, row.scorerSha256, row.upstreamPass, row.forkPass, row.durationDeltaMs, row.inputDelta, row.outputDelta, row.cacheReadDelta, row.cacheWriteDelta].map(csvCell).join(","));
  writeFileSync(join(runDir, "pairs.csv"), `${pairLines.join("\n")}\n`, "utf8");
  const markdown = [`# Evaluation run ${runId}`, "", `- Mode: ${run.mode}`, `- Pairs (valid / incomplete): ${pairs.valid} / ${pairs.incomplete}`, `- Invalid pairs: ${pairs.invalid}`, `- Valid / incomplete / invalid pairs: ${pairs.valid} / ${pairs.incomplete} / ${pairs.invalid}`, `- Both pass / upstream only / fork only / both fail: ${pairs.outcomes.bothPass} / ${pairs.outcomes.upstreamOnly} / ${pairs.outcomes.forkOnly} / ${pairs.outcomes.bothFail}`, "", "| arm | scorer passes | score checks | duration mean | duration median | duration p95 | first event mean | input | output | cache read | cache write | tool calls | tool errors | malformed JSONL | mask placeholders |", "| --- | ---: | ---: | ---: | ---: | ---: | ---: | ---: | ---: | ---: | ---: | ---: | ---: | ---: | ---: | ---: |", ...ARMS.map((arm) => { const metric = arms[arm]; return `| ${arm} | ${metric.scorerPasses} | ${metric.totalScoreChecks} | ${metric.durationMs.mean} | ${metric.durationMs.median} | ${metric.durationMs.p95} | ${metric.firstEventLatencyMs.mean} | ${metric.usage.input.total} | ${metric.usage.output.total} | ${metric.usage.cacheRead.total} | ${metric.usage.cacheWrite.total} | ${metric.tools.calls} | ${metric.tools.errors} | ${metric.jsonl.malformed} | ${metric.staticMaskPlaceholders} |`; })].join("\n");
  writeFileSync(join(runDir, "summary.md"), `${markdown}\n`, "utf8");
  writeFileSync(join(runDir, "failures.json"), `${JSON.stringify({ schemaVersion: 1, failures }, null, 2)}\n`, "utf8");
  writeFileSync(join(runDir, "artifact-index.json"), `${JSON.stringify(artifactIndex(runDir, selected), null, 2)}\n`, "utf8");
  return { summary, failures };
}
