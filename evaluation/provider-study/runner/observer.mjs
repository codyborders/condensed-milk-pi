/**
 * Provider-study observer: per-attempt pre/post measurement extensions
 * plus the strict extractor.
 *
 * generateProviderStudyObservers writes two standalone attempt-local
 * .mjs extensions. The pre observer records tool_call and pre-transform
 * context events; the post observer records tool_result and
 * post-transform context events. Handlers never change events: the
 * extensions are neutral. They persist only bounded JSONL counts
 * (mode 0600) under <attemptDir>/observer. Raw text, commands, paths,
 * prompts, queries, and secret values never persist: tool inputs are
 * bucketed and hashed, bash commands collapse to an allowlisted class
 * token (test, build, shell), and content is reduced to byte and
 * marker counts.
 *
 * extractProviderStudyMetrics pairs pre/post context records by
 * sequence, refuses missing, malformed, duplicate, or overflow records,
 * and computes the observer half of the attempt-metric row: tool
 * calls, shell/test/build reruns, file rereads, retrieval calls and
 * failures, historical mask events, compression events, and archive
 * references. Provider usage never flows through the observer: it is
 * extracted from the provider session separately.
 */

import { createHash } from "node:crypto";
import { chmodSync, existsSync, mkdirSync, readFileSync, writeFileSync } from "node:fs";
import { join } from "node:path";

/** Pinned caps for the observer and its persisted metrics. */
export const PROVIDER_STUDY_OBSERVER_LIMITS = Object.freeze({
  maxEvents: 4096,
  maxLineBytes: 2048,
  maxTotalBytes: 524288,
  maxDupSet: 8192,
  maxHashInputBytes: 65536,
});

const METRICS_FILENAMES = Object.freeze({ pre: "pre-metrics.jsonl", post: "post-metrics.jsonl" });
const OBSERVER_FILENAMES = Object.freeze({ pre: "pre.mjs", post: "post.mjs" });

function sha256Text(text) {
  return createHash("sha256").update(text, "utf8").digest("hex");
}

/** Deterministic key-sorted JSON: the digest basis for wrapper identity. */
function stableStringify(value) {
  if (value === undefined) return "null";
  if (value === null || typeof value !== "object") return JSON.stringify(value) ?? "null";
  if (Array.isArray(value)) return `[${value.map(stableStringify).join(",")}]`;
  const keys = Object.keys(value).sort();
  return `{${keys.map((key) => `${JSON.stringify(key)}:${stableStringify(value[key])}`).join(",")}}`;
}

function renderObserverSource(phase, wrapperJson) {
  return `// Condensed Milk provider-study observer (${phase}).
// Generated per attempt. Neutral: handlers record bounded counts and
// never return event changes. Metrics are JSONL (mode 0600) beside
// this file. Raw text, commands, paths, prompts, and secret values
// never persist.
import { createHash } from "node:crypto";
import { appendFileSync, existsSync, writeFileSync } from "node:fs";
import { dirname, join } from "node:path";
import { fileURLToPath } from "node:url";

const PHASE = ${JSON.stringify(phase)};
const WRAPPER = ${wrapperJson};
const L = WRAPPER.limits;
const METRICS_PATH = join(dirname(fileURLToPath(import.meta.url)), WRAPPER.metrics[PHASE]);
const TOOL_BUCKETS = { bash: "bash", read: "read", edit: "edit", write: "write", grep: "grep", find: "find", ls: "ls", condensed_milk_retrieve: "retrieval" };
const RECORDS = ${JSON.stringify(phase === "pre" ? ["tool_call", "context"] : ["tool_result", "context"])};

function sha(text) {
  return createHash("sha256").update(text).digest("hex");
}

function canonical(value) {
  let text;
  try {
    text = JSON.stringify(value === undefined ? null : value);
  } catch (error) {
    text = "unserializable";
  }
  if (text === undefined) text = "null";
  return text.length > L.maxHashInputBytes ? text.substring(0, L.maxHashInputBytes) : text;
}

function bucket(toolName) {
  return typeof toolName === "string" && Object.prototype.hasOwnProperty.call(TOOL_BUCKETS, toolName)
    ? TOOL_BUCKETS[toolName]
    : "other";
}

function bashClass(input) {
  const text = typeof input === "string" ? input : canonical(input);
  if (/(^|\\s)(pytest|jest|vitest|mocha|node\\s+--test|npm\\s+(run\\s+)?test|go\\s+test|cargo\\s+test)|\\btests?\\//i.test(text)) return "test";
  if (/(^|\\s)(tsc|webpack|rollup|vite|make|compile|npm\\s+run\\s+build|cargo\\s+build|go\\s+build)|\\bbuild\\b/i.test(text)) return "build";
  return "shell";
}

function callHash(toolName, input) {
  return sha(bucket(toolName) + "\\u0000" + canonical(input)).substring(0, 16);
}

function textBlocks(content) {
  if (typeof content === "string") return [{ type: "text", text: content }];
  if (!Array.isArray(content)) return [];
  return content.filter(function (block) { return block !== null && typeof block === "object"; });
}

function occurrences(text, needle) {
  return text.split(needle).length - 1;
}

function measureBlocks(blocks) {
  const out = { bytes: 0, masked: 0, archive: 0 };
  for (let index = 0; index < blocks.length; index += 1) {
    const block = blocks[index];
    if (block !== null && typeof block === "object" && block.type === "text" && typeof block.text === "string") {
      out.bytes += Buffer.byteLength(block.text, "utf8");
      out.masked += occurrences(block.text, "[cm-masked");
      out.archive += occurrences(block.text, "[cm-archive ");
    }
  }
  return out;
}

const state = { started: false, dead: false, events: 0, bytes: 0 };
const seq = { tool_call: 0, tool_result: 0, context: 0 };
const dupSet = new Set();

function ensureMetricsFile() {
  if (state.started) return;
  if (!existsSync(METRICS_PATH)) writeFileSync(METRICS_PATH, "", { mode: 0o600 });
  state.started = true;
}

function errorMarker(kind) {
  if (state.dead) return;
  state.dead = true;
  try {
    ensureMetricsFile();
    appendFileSync(METRICS_PATH, '{"v":1,"phase":' + JSON.stringify(PHASE) + ',"error":' + JSON.stringify(kind) + '}\\n', "utf8");
  } catch (error) {
    /* nothing more can be persisted */
  }
}

function writeRecord(record) {
  if (state.dead) return;
  const line = JSON.stringify(record);
  if (Buffer.byteLength(line, "utf8") > L.maxLineBytes) {
    errorMarker("overflow");
    return;
  }
  if (state.events >= L.maxEvents) {
    errorMarker("overflow");
    return;
  }
  const next = state.bytes + Buffer.byteLength(line, "utf8") + 1;
  if (next > L.maxTotalBytes) {
    errorMarker("overflow");
    return;
  }
  try {
    ensureMetricsFile();
    appendFileSync(METRICS_PATH, line + "\\n", "utf8");
  } catch (error) {
    errorMarker("write-failed");
    return;
  }
  state.events += 1;
  state.bytes = next;
}

function dupFlag(hash) {
  if (dupSet.has(hash)) return true;
  if (dupSet.size >= L.maxDupSet) return false;
  dupSet.add(hash);
  return false;
}

function onToolCall(event) {
  try {
    if (state.dead) return;
    if (RECORDS.indexOf("tool_call") === -1) return;
    seq.tool_call += 1;
    const tool = bucket(event && event.toolName);
    const input = event && event.input;
    const hash = callHash(event && event.toolName, input);
    writeRecord({
      v: 1,
      phase: PHASE,
      event: "tool_call",
      seq: seq.tool_call,
      tool,
      class: tool === "bash" ? bashClass(input) : null,
      call: hash,
      dup: dupFlag(hash),
    });
  } catch (error) {
    errorMarker("write-failed");
  }
}

function onToolResult(event) {
  try {
    if (state.dead) return;
    if (RECORDS.indexOf("tool_result") === -1) return;
    seq.tool_result += 1;
    const measured = measureBlocks(textBlocks(event && event.content));
    writeRecord({
      v: 1,
      phase: PHASE,
      event: "tool_result",
      seq: seq.tool_result,
      tool: bucket(event && event.toolName),
      isError: event && event.isError === true,
      bytes: measured.bytes,
      masked: measured.masked,
      archive: measured.archive,
    });
  } catch (error) {
    errorMarker("write-failed");
  }
}

function onContext(event) {
  try {
    if (state.dead) return;
    if (RECORDS.indexOf("context") === -1) return;
    seq.context += 1;
    const messages = event && Array.isArray(event.messages) ? event.messages : [];
    const totals = { bytes: 0, masked: 0, archive: 0 };
    for (let index = 0; index < messages.length; index += 1) {
      const message = messages[index];
      const measured = measureBlocks(textBlocks(message !== null && typeof message === "object" ? message.content : null));
      totals.bytes += measured.bytes;
      totals.masked += measured.masked;
      totals.archive += measured.archive;
    }
    writeRecord({
      v: 1,
      phase: PHASE,
      event: "context",
      seq: seq.context,
      tool: "context",
      msgCount: messages.length,
      bytes: totals.bytes,
      masked: totals.masked,
      archive: totals.archive,
    });
  } catch (error) {
    errorMarker("write-failed");
  }
}

export default function providerStudyObserver(pi) {
  pi.on("tool_call", onToolCall);
  pi.on("tool_result", onToolResult);
  pi.on("context", onContext);
}
`;
}

/**
 * Generate the two standalone attempt-local observer extensions.
 * Writes <attemptDir>/observer/{pre,post}.mjs (mode 0600, directory
 * 0700). The wrapper config is identical in both sources; each source
 * pins its own phase and record set and resolves the metrics path from
 * import.meta.url, so no absolute path is embedded. Deterministic:
 * identical inputs regenerate identical bytes and digests.
 */
export function generateProviderStudyObservers({ attemptDir }) {
  if (typeof attemptDir !== "string" || attemptDir.length === 0) {
    throw new Error("generateProviderStudyObservers needs the attempt directory");
  }
  const wrapper = {
    v: 1,
    metrics: { ...METRICS_FILENAMES },
    limits: { ...PROVIDER_STUDY_OBSERVER_LIMITS },
  };
  const wrapperJson = stableStringify(wrapper);
  const observerDir = join(attemptDir, "observer");
  mkdirSync(observerDir, { recursive: true, mode: 0o700 });
  chmodSync(observerDir, 0o700);
  const sources = {};
  for (const phase of ["pre", "post"]) {
    sources[phase] = renderObserverSource(phase, wrapperJson);
    const path = join(observerDir, OBSERVER_FILENAMES[phase]);
    writeFileSync(path, sources[phase], { mode: 0o600 });
    chmodSync(path, 0o600);
  }
  return {
    preExtensionPath: join(observerDir, OBSERVER_FILENAMES.pre),
    postExtensionPath: join(observerDir, OBSERVER_FILENAMES.post),
    observerSha256: sha256Text(sources.pre + sources.post),
    observerWrapperSha256: sha256Text(wrapperJson),
  };
}

const TOOL_CALL_KEYS = Object.freeze(["v", "phase", "event", "seq", "tool", "class", "call", "dup"]);
const TOOL_RESULT_KEYS = Object.freeze(["v", "phase", "event", "seq", "tool", "isError", "bytes", "masked", "archive"]);
const CONTEXT_KEYS = Object.freeze(["v", "phase", "event", "seq", "tool", "msgCount", "bytes", "masked", "archive"]);
const TOOL_BUCKET_SET = new Set(["bash", "read", "edit", "write", "grep", "find", "ls", "retrieval", "other", "context"]);
const HEX16 = /^[0-9a-f]{16}$/;
const CLASS_SET = new Set(["test", "build", "shell"]);

function malformed(where, detail) {
  return new Error(`provider-study observer record is malformed (${where}: ${detail})`);
}

function sameKeys(object, keys) {
  const entries = Object.keys(object);
  return entries.length === keys.length && keys.every((key) => entries.includes(key));
}

function validateRecord(record, phase, where, limits) {
  if (record === null || typeof record !== "object" || Array.isArray(record)) {
    throw malformed(where, "not an object");
  }
  if (!sameKeys(record, TOOL_CALL_KEYS) && !sameKeys(record, TOOL_RESULT_KEYS) && !sameKeys(record, CONTEXT_KEYS)) {
    throw malformed(where, "unexpected field set");
  }
  if (record.v !== 1) throw malformed(where, "v must be 1");
  if (record.phase !== phase) throw malformed(where, "phase mismatch");
  if (!Number.isSafeInteger(record.seq) || record.seq < 1) throw malformed(where, "seq must be a positive integer");
  if (typeof record.tool !== "string" || !TOOL_BUCKET_SET.has(record.tool)) throw malformed(where, "tool not in the allowlist");
  if (record.event === "tool_call") {
    if (typeof record.call !== "string" || !HEX16.test(record.call)) throw malformed(where, "call must be 16-hex");
    if (typeof record.dup !== "boolean") throw malformed(where, "dup must be a boolean");
    if (record.tool === "bash") {
      if (typeof record.class !== "string" || !CLASS_SET.has(record.class)) throw malformed(where, "bash class missing");
    } else if (record.class !== null) {
      throw malformed(where, "class is reserved for bash calls");
    }
    return;
  }
  if (record.event === "tool_result") {
    if (typeof record.isError !== "boolean") throw malformed(where, "isError must be a boolean");
  } else if (record.event === "context") {
    if (record.tool !== "context") throw malformed(where, "context records carry the context bucket");
    if (!Number.isSafeInteger(record.msgCount) || record.msgCount < 1) throw malformed(where, "msgCount must be positive");
  } else {
    throw malformed(where, "unknown event type");
  }
  for (const field of ["bytes", "masked", "archive"]) {
    if (!Number.isSafeInteger(record[field]) || record[field] < 0) throw malformed(where, `${field} must be a nonnegative integer`);
  }
  void limits;
}

function readMetrics(phase, observerDir, limits) {
  const path = join(observerDir, METRICS_FILENAMES[phase]);
  if (!existsSync(path)) {
    throw new Error(`provider-study observer metrics missing: observer/${METRICS_FILENAMES[phase]}`);
  }
  const raw = readFileSync(path, "utf8");
  if (Buffer.byteLength(raw, "utf8") > limits.maxTotalBytes) {
    throw new Error(`provider-study observer metrics exceed the total byte cap: observer/${METRICS_FILENAMES[phase]}`);
  }
  const lines = raw.split("\n");
  if (lines.length > 0 && lines[lines.length - 1] === "") lines.pop();
  const records = [];
  const lastSeq = {};
  for (let index = 0; index < lines.length; index += 1) {
    const line = lines[index];
    const where = `observer/${METRICS_FILENAMES[phase]} line ${index + 1}`;
    if (Buffer.byteLength(line, "utf8") > limits.maxLineBytes) {
      throw new Error(`provider-study observer metrics line exceeds the byte cap (${where})`);
    }
    let record;
    try {
      record = JSON.parse(line);
    } catch {
      throw malformed(where, "not valid JSON");
    }
    if (record !== null && typeof record === "object" && !Array.isArray(record) && typeof record.error === "string") {
      throw new Error(`observer ${phase} metrics stopped early: ${record.error} (${where})`);
    }
    validateRecord(record, phase, where, limits);
    const previous = lastSeq[record.event] ?? 0;
    if (record.seq <= previous) {
      throw new Error(`observer metrics hold a duplicate or regressed sequence (${where}: ${record.event} ${record.seq} after ${previous})`);
    }
    lastSeq[record.event] = record.seq;
    records.push(record);
  }
  return records;
}

/** Pair pre/post context records by sequence number. */
function pairContext(preRecords, postRecords) {
  const postBySeq = new Map(postRecords.filter((record) => record.event === "context").map((record) => [record.seq, record]));
  const preContexts = preRecords.filter((record) => record.event === "context");
  const pairs = [];
  for (const record of preContexts) {
    const match = postBySeq.get(record.seq);
    if (!match) {
      throw new Error(`observer pairing refused: pre context ${record.seq} has no post record`);
    }
    pairs.push({ pre: record, post: match });
    postBySeq.delete(record.seq);
  }
  if (postBySeq.size > 0) {
    throw new Error("observer pairing refused: post context records without a pre record");
  }
  return pairs;
}

/**
 * Extract the observer half of the attempt-metric row. Throws on
 * missing, malformed, duplicate, overflow, or unmatched records.
 */
export function extractProviderStudyMetrics({ attemptDir }) {
  if (typeof attemptDir !== "string" || attemptDir.length === 0) {
    throw new Error("extractProviderStudyMetrics needs the attempt directory");
  }
  const observerDir = join(attemptDir, "observer");
  const limits = PROVIDER_STUDY_OBSERVER_LIMITS;
  const preRecords = readMetrics("pre", observerDir, limits);
  const postRecords = readMetrics("post", observerDir, limits);
  const contextPairs = pairContext(preRecords, postRecords);

  let toolCalls = 0;
  let shellReruns = 0;
  let testReruns = 0;
  let buildReruns = 0;
  let fileRereads = 0;
  let retrievalCalls = 0;
  let retrievalFailures = 0;
  let historicalMaskEvents = 0;
  let compressionEvents = 0;
  let archiveReferences = 0;

  for (const record of preRecords) {
    if (record.event !== "tool_call") continue;
    toolCalls += 1;
    if (record.tool === "retrieval") retrievalCalls += 1;
    if (!record.dup) continue;
    if (record.tool === "bash" && record.class === "test") testReruns += 1;
    else if (record.tool === "bash" && record.class === "build") buildReruns += 1;
    else if (record.tool === "bash") shellReruns += 1;
    else if (record.tool === "read") fileRereads += 1;
  }
  for (const record of postRecords) {
    if (record.event !== "tool_result") continue;
    archiveReferences += record.archive;
    if (record.tool === "retrieval" && record.isError) retrievalFailures += 1;
  }
  for (const { pre, post } of contextPairs) {
    archiveReferences += post.archive;
    const removed = Math.max(0, pre.bytes - post.bytes);
    if (removed === 0 && post.msgCount === pre.msgCount) continue;
    const markers = post.masked > 0 || post.archive > 0 || pre.masked > 0 || pre.archive > 0;
    if (markers) historicalMaskEvents += 1;
    else compressionEvents += 1;
  }

  const metrics = {
    schemaVersion: 1,
    source: "observer-extract",
    toolCalls,
    shellReruns,
    fileRereads,
    testReruns,
    buildReruns,
    compressionEvents,
    historicalMaskEvents,
    archiveReferences,
    retrievalCalls,
    retrievalFailures,
  };
  for (const field of Object.keys(metrics)) {
    if (field === "schemaVersion" || field === "source") continue;
    if (typeof metrics[field] !== "number" || !Number.isFinite(metrics[field])) {
      throw new Error(`extracted observer metric ${field} is not a finite number`);
    }
  }
  return metrics;
}

/**
 * Study observer callbacks for the shared real-attempt machinery:
 * generate() writes the extensions before invocation; extract() runs
 * after scoring and final collection.
 */
export function providerStudyObserverStudyObservers() {
  return {
    generate: ({ attemptDir }) => generateProviderStudyObservers({ attemptDir }),
    extract: ({ attemptDir }) => extractProviderStudyMetrics({ attemptDir }),
  };
}
