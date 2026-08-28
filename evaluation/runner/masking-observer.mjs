/**
 * Neutral masking observer: per-attempt pre/post measurement extensions
 * plus the strict extractor.
 *
 * generateMaskingObservers writes two standalone attempt-local .mjs
 * extensions (phase pre and post). Loaded around the arm implementation
 * in the fixed order [pre, arm, post], the pre observer records the
 * fresh event stream and the post observer records the stream the model
 * actually sees. Handlers never return event changes: the extensions
 * are neutral. They persist only bounded JSONL metrics (mode 0600)
 * under <attemptDir>/observer. Raw text, commands, paths, prompts,
 * queries, archive bodies, and secret values never persist; identity is
 * hashed, tools collapse to an allowlisted bucket, and diagnostic
 * markers are embedded as sha256 digests only.
 *
 * extractMaskingInstrumentation pairs pre/post records by event type
 * and sequence, refuses missing, duplicate, malformed, overflow, or
 * unmatched records, and computes the study metrics. Archived bytes come
 * only from the current attempt's recovery index metadata; archive
 * entry bodies are never read.
 *
 * The generated sources embed no absolute paths (the metrics file is
 * resolved from import.meta.url) and no task text, so the same inputs
 * regenerate byte-identical extensions with stable digests.
 */

import { createHash } from "node:crypto";
import { chmodSync, existsSync, lstatSync, mkdirSync, readFileSync, readdirSync, writeFileSync } from "node:fs";
import { join } from "node:path";
import { verifyObserverOrderingCached } from "./observer-ordering.mjs";

/** Pinned caps for the observer and its persisted metrics. */
export const MASKING_OBSERVER_LIMITS = Object.freeze({
  maxEvents: 4096,
  maxBlocksPerEvent: 64,
  maxLineBytes: 4096,
  maxTotalBytes: 524288,
  maxDupSet: 8192,
  maxHashInputBytes: 65536,
  maxDiagLinesPerBlock: 64,
  maxDiagTokensPerLine: 64,
  maxDiagGram: 8,
});

const LIMIT_FIELDS = Object.freeze(Object.keys(MASKING_OBSERVER_LIMITS));
const METRICS_FILENAMES = Object.freeze({ pre: "pre-metrics.jsonl", post: "post-metrics.jsonl" });
const OBSERVER_FILENAMES = Object.freeze({ pre: "pre.mjs", post: "post.mjs" });

function sha256Text(text) {
  return createHash("sha256").update(text).digest("hex");
}

/** Deterministic key-sorted JSON: the digest basis for wrapper and input identities. */
export function stableStringify(value) {
  if (value === undefined) return "null";
  if (value === null || typeof value !== "object") return JSON.stringify(value) ?? "null";
  if (Array.isArray(value)) return `[${value.map(stableStringify).join(",")}]`;
  const keys = Object.keys(value).sort();
  return `{${keys.map((key) => `${JSON.stringify(key)}:${stableStringify(value[key])}`).join(",")}}`;
}

function normalizeMarker(marker) {
  return marker.split(/\s+/).filter((token) => token.length > 0).join(" ");
}

/**
 * Limits for one generation: every field defaults to the pinned cap and
 * an override may only shrink a cap (fail-closed: never larger).
 */
function resolveLimits(override) {
  if (override === null || override === undefined) return { ...MASKING_OBSERVER_LIMITS };
  if (typeof override !== "object" || Array.isArray(override)) {
    throw new Error("observer limits must be an object of numeric caps");
  }
  const resolved = {};
  for (const field of LIMIT_FIELDS) {
    const value = Object.prototype.hasOwnProperty.call(override, field) ? override[field] : MASKING_OBSERVER_LIMITS[field];
    if (!Number.isSafeInteger(value) || value < 1) {
      throw new Error(`observer limit ${field} must be a positive integer`);
    }
    if (value > MASKING_OBSERVER_LIMITS[field]) {
      throw new Error(`observer limit ${field} may not exceed the pinned cap ${MASKING_OBSERVER_LIMITS[field]}`);
    }
    resolved[field] = value;
  }
  return resolved;
}

function renderObserverSource(phase, wrapperJson) {
  return `// Condensed Milk masking study observer (${phase}).
// Generated per attempt. Neutral: handlers record bounded metrics and
// never return event changes. Metrics are JSONL (mode 0600) beside this
// file. Raw text, commands, paths, prompts, queries, archive bodies,
// and secret values never persist.
import { createHash } from "node:crypto";
import { appendFileSync, existsSync, writeFileSync } from "node:fs";
import { dirname, join } from "node:path";
import { fileURLToPath } from "node:url";

const PHASE = ${JSON.stringify(phase)};
const WRAPPER = ${wrapperJson};
const L = WRAPPER.limits;
const METRICS_PATH = join(dirname(fileURLToPath(import.meta.url)), WRAPPER.metrics[PHASE]);
const TOOL_BUCKETS = { bash: "bash", read: "read", edit: "edit", write: "write", grep: "grep", find: "find", ls: "ls", condensed_milk_retrieve: "retrieval" };
const SENTINELS = [
  /(api[-_]?key|secret|token|password|passwd|credential)["']?\\s*[=:]\\s*\\S{15,}/i,
  /\\bsk-[A-Za-z0-9]{20,}\\b/,
  /\\bghp_[A-Za-z0-9]{20,}\\b/,
  /\\bAKIA[0-9A-Z]{12,}\\b/,
  /\\bxox[baprs]-[A-Za-z0-9-]{16,}\\b/,
];

function sha(text) {
  return createHash("sha256").update(text).digest("hex");
}

function stableStringify(value) {
  if (value === undefined) return "null";
  if (value === null || typeof value !== "object") return JSON.stringify(value) === undefined ? "null" : JSON.stringify(value);
  if (Array.isArray(value)) return "[" + value.map(stableStringify).join(",") + "]";
  const keys = Object.keys(value).sort();
  return "{" + keys.map(function (key) { return JSON.stringify(key) + ":" + stableStringify(value[key]); }).join(",") + "}";
}

function canonical(value) {
  let text;
  try {
    text = stableStringify(value === undefined ? null : value);
  } catch (error) {
    text = "unserializable";
  }
  return text.length > L.maxHashInputBytes ? text.slice(0, L.maxHashInputBytes) : text;
}

function textBlocks(content) {
  if (typeof content === "string") return [{ type: "text", text: content }];
  if (!Array.isArray(content)) return [];
  return content.filter(function (block) { return block !== null && typeof block === "object"; });
}

function occurrences(text, needle) {
  return text.split(needle).length - 1;
}

function sentinelHit(text) {
  for (let index = 0; index < SENTINELS.length; index += 1) {
    if (SENTINELS[index].test(text)) return true;
  }
  return false;
}

function diagnosticHit(text) {
  if (WRAPPER.markers.length === 0) return false;
  const lines = text.split("\\n").slice(0, L.maxDiagLinesPerBlock);
  for (let li = 0; li < lines.length; li += 1) {
    const tokens = lines[li].split(/\\s+/).filter(function (token) { return token.length > 0; }).slice(0, L.maxDiagTokensPerLine);
    const widest = Math.min(L.maxDiagGram, tokens.length);
    for (let n = 1; n <= widest; n += 1) {
      for (let start = 0; start + n <= tokens.length; start += 1) {
        if (WRAPPER.markers.indexOf(sha(tokens.slice(start, start + n).join(" "))) !== -1) return true;
      }
    }
  }
  return false;
}

function blockHash(block) {
  if (block !== null && typeof block === "object" && block.type === "text" && typeof block.text === "string") {
    const text = block.text.length > L.maxHashInputBytes ? block.text.slice(0, L.maxHashInputBytes) : block.text;
    return sha(text).slice(0, 16);
  }
  return sha(canonical(block)).slice(0, 16);
}

function measureBlocks(blocks, messageIndex, entries) {
  const out = { bytes: 0, masked: 0, archive: 0, diag: false, sentinel: false };
  for (let index = 0; index < blocks.length; index += 1) {
    const block = blocks[index];
    const isText = block.type === "text" && typeof block.text === "string";
    if (isText) {
      out.bytes += Buffer.byteLength(block.text, "utf8");
      out.masked += occurrences(block.text, "[cm-masked");
      out.archive += occurrences(block.text, "[cm-archive ");
      if (!out.diag) out.diag = diagnosticHit(block.text);
      if (!out.sentinel) out.sentinel = sentinelHit(block.text);
    }
    if (entries.blocks.length < L.maxBlocksPerEvent) {
      entries.blocks.push({
        m: messageIndex,
        t: typeof block.type === "string" && block.type.length > 0 ? block.type.slice(0, 24) : "unknown",
        h: blockHash(block),
      });
    } else {
      entries.truncated = true;
    }
  }
  return out;
}

const state = { started: false, dead: false, events: 0, bytes: 0 };
const seq = { tool_result: 0, context: 0, tool_call: 0 };
const dupSets = { tool_call: new Set(), tool_result: new Set() };

function ensureMetricsFile() {
  if (state.started) return;
  if (!existsSync(METRICS_PATH)) writeFileSync(METRICS_PATH, "", { mode: 0o600 });
  state.started = true;
}

/** Exactly one bounded error marker; after it the observer records nothing. */
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
  let line = JSON.stringify(record);
  if (Buffer.byteLength(line, "utf8") > L.maxLineBytes) {
    record.blocks = [];
    record.blocksTrunc = true;
    line = JSON.stringify(record);
    if (Buffer.byteLength(line, "utf8") > L.maxLineBytes) {
      errorMarker("overflow");
      return;
    }
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

function bucket(toolName) {
  return typeof toolName === "string" && Object.prototype.hasOwnProperty.call(TOOL_BUCKETS, toolName)
    ? TOOL_BUCKETS[toolName]
    : "other";
}

function callHash(toolName, input) {
  return sha(bucket(toolName) + "\\u0000" + canonical(input)).slice(0, 16);
}

function dupFlag(kind, hash) {
  const set = dupSets[kind];
  if (!set) return false;
  if (set.has(hash)) return true;
  if (set.size >= L.maxDupSet) return false;
  set.add(hash);
  return false;
}

function onToolResult(event) {
  try {
    if (state.dead) return;
    seq.tool_result += 1;
    const blocks = textBlocks(event && event.content);
    const entries = { blocks: [], truncated: false };
    const measured = measureBlocks(blocks, 0, entries);
    const hash = callHash(event && event.toolName, event && event.input);
    writeRecord({
      v: 1,
      phase: PHASE,
      event: "tool_result",
      seq: seq.tool_result,
      tool: bucket(event && event.toolName),
      call: hash,
      dup: dupFlag("tool_result", hash),
      bytes: measured.bytes,
      masked: measured.masked,
      archive: measured.archive,
      diag: measured.diag,
      sentinel: measured.sentinel,
      msgCount: null,
      blocks: entries.blocks,
      blocksTrunc: entries.truncated,
    });
  } catch (error) {
    errorMarker("write-failed");
  }
}

function onContext(event) {
  try {
    if (state.dead) return;
    seq.context += 1;
    const messages = event && Array.isArray(event.messages) ? event.messages : [];
    const entries = { blocks: [], truncated: false };
    const totals = { bytes: 0, masked: 0, archive: 0, diag: false, sentinel: false };
    for (let index = 0; index < messages.length; index += 1) {
      const message = messages[index];
      const blocks = textBlocks(message !== null && typeof message === "object" ? message.content : null);
      const measured = measureBlocks(blocks, index, entries);
      totals.bytes += measured.bytes;
      totals.masked += measured.masked;
      totals.archive += measured.archive;
      if (measured.diag) totals.diag = true;
      if (measured.sentinel) totals.sentinel = true;
    }
    writeRecord({
      v: 1,
      phase: PHASE,
      event: "context",
      seq: seq.context,
      tool: "context",
      call: null,
      dup: false,
      bytes: totals.bytes,
      masked: totals.masked,
      archive: totals.archive,
      diag: totals.diag,
      sentinel: totals.sentinel,
      msgCount: messages.length,
      blocks: entries.blocks,
      blocksTrunc: entries.truncated,
    });
  } catch (error) {
    errorMarker("write-failed");
  }
}

function onToolCall(event) {
  try {
    if (state.dead) return;
    seq.tool_call += 1;
    const hash = callHash(event && event.toolName, event && event.input);
    writeRecord({
      v: 1,
      phase: PHASE,
      event: "tool_call",
      seq: seq.tool_call,
      tool: bucket(event && event.toolName),
      call: hash,
      dup: dupFlag("tool_call", hash),
      bytes: 0,
      masked: 0,
      archive: 0,
      diag: false,
      sentinel: false,
      msgCount: null,
      blocks: [],
      blocksTrunc: false,
    });
  } catch (error) {
    errorMarker("write-failed");
  }
}

export default function maskingObserver(pi) {
  pi.on("tool_result", onToolResult);
  pi.on("context", onContext);
  pi.on("tool_call", onToolCall);
}
`;
}

/**
 * Generate the two standalone attempt-local observer extensions.
 *
 * Writes <attemptDir>/observer/{pre,post}.mjs (mode 0600, directory
 * 0700). The wrapper config (limits, metrics filenames, hashed
 * diagnostic markers) is identical in both sources; each source pins
 * its own phase and resolves the metrics path from import.meta.url, so
 * no absolute path or task text is embedded. Returns the extension
 * paths plus observerSha256 (sha256 over pre then post source bytes)
 * and observerWrapperSha256 (sha256 over the canonical wrapper config).
 * Deterministic: identical inputs regenerate identical bytes.
 */
export function generateMaskingObservers({ attemptDir, diagnosticMarkers = [], limits = null }) {
  if (typeof attemptDir !== "string" || attemptDir.length === 0) {
    throw new Error("generateMaskingObservers needs the attempt directory");
  }
  if (!Array.isArray(diagnosticMarkers)) {
    throw new Error("diagnosticMarkers must be an array of strings");
  }
  for (const marker of diagnosticMarkers) {
    if (typeof marker !== "string" || marker.trim().length === 0 || marker.length > 256) {
      throw new Error("each diagnostic marker must be a nonempty string of at most 256 characters");
    }
  }
  const resolvedLimits = resolveLimits(limits);
  const markers = [...new Set(diagnosticMarkers.map((marker) => sha256Text(normalizeMarker(marker))))].sort();
  const wrapper = {
    v: 1,
    metrics: { ...METRICS_FILENAMES },
    limits: resolvedLimits,
    markers,
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

/** Diagnostic markers derived from a task's hidden fileContains assertions. */
export function diagnosticMarkersFromAssertions(assertions) {
  if (!Array.isArray(assertions)) return [];
  const markers = new Set();
  for (const assertion of assertions) {
    if (assertion === null || typeof assertion !== "object") continue;
    if (assertion.kind !== "fileContains" || !Array.isArray(assertion.all)) continue;
    for (const text of assertion.all) {
      if (typeof text === "string" && text.trim().length > 0) {
        markers.add(normalizeMarker(text));
      }
    }
  }
  return [...markers].sort();
}

/**
 * Study observer callbacks for real-attempt study configuration:
 * generate() writes the extensions before invocation; extract() runs
 * the strict extractor after scoring and final collection.
 */
export function maskingObserverStudyObservers({ diagnosticMarkers = [] } = {}) {
  return {
    generate: ({ attemptDir }) => generateMaskingObservers({ attemptDir, diagnosticMarkers }),
    extract: ({ attemptDir }) => extractMaskingInstrumentation({ attemptDir }),
  };
}

/**
 * Exact-runtime observer ordering verifier for runPaidPreflight: one
 * cached passing record per runtime digest, run strictly before any
 * reservation. A violation throws and the preflight refuses.
 */
export function observerOrderingVerifier() {
  return ({ pi, cacheRoot }) =>
    verifyObserverOrderingCached({
      runtimeDir: pi.runtimeDir,
      runtimeManifest: pi.runtimeManifest,
      cacheDir: cacheRoot,
    });
}

const EVENT_TYPES = new Set(["tool_result", "context", "tool_call"]);
const TOOL_BUCKET_SET = new Set(["bash", "read", "edit", "write", "grep", "find", "ls", "retrieval", "other", "context"]);
const HEX16 = /^[0-9a-f]{16}$/;
const RECORD_KEYS = Object.freeze([
  "v", "phase", "event", "seq", "tool", "call", "dup", "bytes", "masked",
  "archive", "diag", "sentinel", "msgCount", "blocks", "blocksTrunc",
]);
const SESSION_DIR_PATTERN = /^[A-Za-z0-9._-]{1,128}$/;

function metricsFileLabel(phase) {
  return `observer/${METRICS_FILENAMES[phase]}`;
}

function malformed(where, detail) {
  return new Error(`observer metrics record is malformed (${where}: ${detail})`);
}

function validateRecord(record, phase, where, limits) {
  if (record === null || typeof record !== "object" || Array.isArray(record)) {
    throw malformed(where, "not an object");
  }
  const keys = Object.keys(record);
  if (keys.length !== RECORD_KEYS.length || !RECORD_KEYS.every((key) => keys.includes(key))) {
    throw malformed(where, "unexpected field set");
  }
  if (record.v !== 1) throw malformed(where, "v must be 1");
  if (record.phase !== phase) throw malformed(where, "phase mismatch");
  if (!EVENT_TYPES.has(record.event)) throw malformed(where, "unknown event type");
  if (!Number.isSafeInteger(record.seq) || record.seq < 1) throw malformed(where, "seq must be a positive integer");
  if (typeof record.tool !== "string" || !TOOL_BUCKET_SET.has(record.tool)) throw malformed(where, "tool not in the allowlist");
  for (const field of ["dup", "diag", "sentinel", "blocksTrunc"]) {
    if (typeof record[field] !== "boolean") throw malformed(where, `${field} must be a boolean`);
  }
  for (const field of ["bytes", "masked", "archive"]) {
    if (!Number.isSafeInteger(record[field]) || record[field] < 0) throw malformed(where, `${field} must be a nonnegative integer`);
  }
  if (record.event === "context") {
    if (record.tool !== "context" || record.call !== null || record.dup !== false) {
      throw malformed(where, "context records carry no call identity");
    }
    if (!Number.isSafeInteger(record.msgCount) || record.msgCount < 1) {
      throw malformed(where, "context records need a positive msgCount");
    }
  } else {
    if (record.tool === "context") throw malformed(where, "bucket context is reserved for context records");
    if (typeof record.call !== "string" || !HEX16.test(record.call)) throw malformed(where, "call must be a 16-hex digest");
    if (record.msgCount !== null) throw malformed(where, "msgCount must be null outside context records");
  }
  if (record.event === "tool_call") {
    if (record.bytes !== 0 || record.masked !== 0 || record.archive !== 0 || record.diag !== false || record.sentinel !== false) {
      throw malformed(where, "tool_call records carry no content metrics");
    }
    if (record.blocks.length !== 0 || record.blocksTrunc !== false) {
      throw malformed(where, "tool_call records carry no blocks");
    }
  }
  if (!Array.isArray(record.blocks) || record.blocks.length > limits.maxBlocksPerEvent) {
    throw malformed(where, "blocks exceed the per-event cap");
  }
  for (const entry of record.blocks) {
    if (entry === null || typeof entry !== "object" || Array.isArray(entry)) throw malformed(where, "block entry not an object");
    const entryKeys = Object.keys(entry);
    const hasHash = entryKeys.includes("h");
    const expectedLength = hasHash ? 3 : 2;
    if (entryKeys.length !== expectedLength || !entryKeys.every((key) => key === "m" || key === "t" || key === "h")) {
      throw malformed(where, "block entry field set");
    }
    if (!Number.isSafeInteger(entry.m) || entry.m < 0) throw malformed(where, "block entry m");
    if (typeof entry.t !== "string" || entry.t.length === 0 || entry.t.length > 24) throw malformed(where, "block entry t");
    if (hasHash && !HEX16.test(entry.h)) throw malformed(where, "block entry h must be 16-hex");
  }
}

function readMetrics(phase, observerDir, limits) {
  const path = join(observerDir, METRICS_FILENAMES[phase]);
  if (!existsSync(path)) {
    throw new Error(`masking observer metrics missing: ${metricsFileLabel(phase)}`);
  }
  const raw = readFileSync(path, "utf8");
  if (Buffer.byteLength(raw, "utf8") > limits.maxTotalBytes) {
    throw new Error(`masking observer metrics exceed the total byte cap: ${metricsFileLabel(phase)}`);
  }
  const lines = raw.split("\n");
  if (lines.length > 0 && lines[lines.length - 1] === "") lines.pop();
  const records = [];
  const lastSeq = {};
  for (let index = 0; index < lines.length; index += 1) {
    const line = lines[index];
    const where = `${metricsFileLabel(phase)} line ${index + 1}`;
    if (Buffer.byteLength(line, "utf8") > limits.maxLineBytes) {
      throw new Error(`observer metrics line exceeds the byte cap (${where})`);
    }
    let record;
    try {
      record = JSON.parse(line);
    } catch {
      throw malformed(where, "not valid JSON");
    }
    if (record !== null && typeof record === "object" && !Array.isArray(record) && typeof record.error === "string") {
      throw new Error(`observer ${phase} metrics stopped early: ${record.error} (${metricsFileLabel(phase)})`);
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

function pairRecords(preRecords, postRecords) {
  const postByKey = new Map();
  for (const record of postRecords) {
    postByKey.set(`${record.event}#${record.seq}`, record);
  }
  const seen = new Set();
  const pairs = [];
  for (const record of preRecords) {
    const key = `${record.event}#${record.seq}`;
    seen.add(key);
    const match = postByKey.get(key);
    if (!match) {
      throw new Error(`observer pairing refused: pre ${record.event} ${record.seq} has no post record`);
    }
    if (match.tool !== record.tool) {
      throw new Error(`observer pairing refused: bucket mismatch on ${record.event} ${record.seq}`);
    }
    pairs.push({ pre: record, post: match });
  }
  for (const key of postByKey.keys()) {
    if (!seen.has(key)) {
      throw new Error(`observer pairing refused: post ${key.replace("#", " ")} has no pre record`);
    }
  }
  return pairs;
}

function recordsIdentical(pre, post) {
  return (
    pre.bytes === post.bytes &&
    pre.masked === post.masked &&
    pre.archive === post.archive &&
    JSON.stringify(pre.blocks) === JSON.stringify(post.blocks)
  );
}

/**
 * Non-text ordering incident: message/block positions or types changed,
 * or any non-text block hash changed. Text hashes may differ freely
 * (that is the treatment under measurement). Truncated evidence is
 * compared over the shared prefix only.
 */
function blocksOrderIncident(pre, post) {
  const a = pre.blocks;
  const b = post.blocks;
  if (!pre.blocksTrunc && !post.blocksTrunc && a.length !== b.length) return true;
  const shared = Math.min(a.length, b.length);
  for (let index = 0; index < shared; index += 1) {
    if (a[index].m !== b[index].m || a[index].t !== b[index].t) return true;
    if (a[index].t !== "text" && a[index].h !== b[index].h) return true;
  }
  return false;
}

/**
 * Sum archived bytes from the current attempt's recovery entry metadata
 * only: index.json ledgers under the attempt home. Entry bodies (raw
 * archived text) are never read. A malformed index refuses.
 */
export function sumAttemptRecoveryArchivedBytes(attemptDir) {
  const root = join(attemptDir, "home", ".pi", "agent", "condensed-milk-recovery");
  if (!existsSync(root)) return 0;
  let total = 0;
  for (const dirent of readdirSync(root, { withFileTypes: true })) {
    if (!dirent.isDirectory()) continue;
    if (!SESSION_DIR_PATTERN.test(dirent.name) || dirent.name.includes("..")) continue;
    const indexPath = join(root, dirent.name, "index.json");
    if (!existsSync(indexPath)) continue;
    const info = lstatSync(indexPath);
    if (!info.isFile()) {
      throw new Error("recovery index is not a regular file; refusing");
    }
    let index;
    try {
      index = JSON.parse(readFileSync(indexPath, "utf8"));
    } catch {
      throw new Error("recovery index is malformed JSON; refusing");
    }
    if (
      index === null ||
      typeof index !== "object" ||
      Array.isArray(index) ||
      index.v !== 1 ||
      typeof index.entries !== "object" ||
      index.entries === null ||
      !Array.isArray(index.evicted)
    ) {
      throw new Error("recovery index has an unexpected shape; refusing");
    }
    for (const entry of Object.values(index.entries)) {
      if (entry === null || typeof entry !== "object" || Array.isArray(entry)) {
        throw new Error("recovery index entry is malformed; refusing");
      }
      if (!Number.isSafeInteger(entry.bytes) || entry.bytes < 0) {
        throw new Error("recovery index entry bytes must be a nonnegative integer; refusing");
      }
      total += entry.bytes;
    }
  }
  return total;
}

function recoveryResultFor({ retrievalCalls, returnedBytes, reruns, rereads }) {
  if (retrievalCalls >= 1 && returnedBytes > 0) return "archive";
  if (reruns >= 1) return "rerun";
  if (rereads >= 1) return "reread";
  return "none";
}

/**
 * Extract one attempt's masking instrumentation from the paired
 * observer metrics. Throws on missing, duplicate, malformed, overflow,
 * or unmatched records, on any missing required value, and on a
 * malformed recovery index. Deterministic: no timestamps, no paths,
 * no raw content in the result.
 */
export function extractMaskingInstrumentation({ attemptDir }) {
  if (typeof attemptDir !== "string" || attemptDir.length === 0) {
    throw new Error("extractMaskingInstrumentation needs the attempt directory");
  }
  const observerDir = join(attemptDir, "observer");
  const limits = MASKING_OBSERVER_LIMITS;
  const preRecords = readMetrics("pre", observerDir, limits);
  const postRecords = readMetrics("post", observerDir, limits);
  const pairs = pairRecords(preRecords, postRecords);

  let toolResultPairs = 0;
  let contextPairs = 0;
  let toolCallPairs = 0;
  let originalBytes = 0;
  let visibleToolResultBytes = 0;
  let semanticBytes = 0;
  let historicalMaskedBytes = 0;
  let historicalMaskEvents = 0;
  let semanticTransforms = 0;
  let archiveReferences = 0;
  let retrievalCalls = 0;
  let returnedBytes = 0;
  let reruns = 0;
  let rereads = 0;
  let diagnosticPresent = false;
  let secretIncidents = 0;
  let nonTextOrderingIncidents = 0;
  // Cumulative accounting over the same observed surfaces: pre and
  // post bytes both count tool_result and context observations. The
  // semantic and historical ledgers stay separate, and removedBytes is
  // their sum, so repeated context savings can never drive visible
  // bytes negative or double-count one-time tool bytes.
  let preBytesTotal = 0;
  let postBytesTotal = 0;

  for (const { pre, post } of pairs) {
    if (pre.event === "tool_call") {
      toolCallPairs += 1;
      if (pre.tool === "retrieval") retrievalCalls += 1;
      if (pre.dup && pre.tool === "bash") reruns += 1;
      if (pre.dup && pre.tool === "read") rereads += 1;
      continue;
    }
    preBytesTotal += pre.bytes;
    postBytesTotal += post.bytes;
    if (pre.event === "tool_result") {
      toolResultPairs += 1;
      originalBytes += pre.bytes;
      visibleToolResultBytes += post.bytes;
      semanticBytes += pre.bytes - post.bytes;
      if (post.archive > pre.archive) archiveReferences += post.archive - pre.archive;
      // Historical masks count only paired context-event differences.
      // Tool-result archive references and semantic transforms stay
      // separate counters and never inflate historical masking.
      if (pre.tool === "retrieval") returnedBytes += post.bytes;
      if (!recordsIdentical(pre, post)) semanticTransforms += 1;
    } else {
      contextPairs += 1;
      historicalMaskedBytes += Math.max(0, pre.bytes - post.bytes);
      if (post.masked > pre.masked || post.archive > pre.archive) historicalMaskEvents += 1;
    }
    if (pre.diag || post.diag) diagnosticPresent = true;
    if (post.sentinel) secretIncidents += 1;
    if (blocksOrderIncident(pre, post)) nonTextOrderingIncidents += 1;
  }

  const archivedBytes = sumAttemptRecoveryArchivedBytes(attemptDir);
  const removedBytes = semanticBytes + historicalMaskedBytes;
  const visibleBytes = postBytesTotal;
  originalBytes = preBytesTotal;
  const instrumentation = {
    schemaVersion: 1,
    source: "observer-extract",
    pairs: { total: pairs.length, toolResult: toolResultPairs, context: contextPairs, toolCall: toolCallPairs },
    originalBytes,
    visibleBytes,
    removedBytes,
    semanticBytes,
    historicalMaskedBytes,
    archivedBytes,
    estimatedTokensSavedSemantic: Math.floor(semanticBytes / 4),
    estimatedTokensSavedHistorical: Math.floor(historicalMaskedBytes / 4),
    historicalMaskEvents,
    semanticTransforms,
    archiveReferences,
    retrievalCalls,
    returnedBytes,
    reruns,
    rereads,
    diagnosticPresent,
    secretIncidents,
    nonTextOrderingIncidents,
    activatedFilterIds: [],
    usage: null,
    cost: null,
    wallTimeMs: null,
    firstEventLatencyMs: null,
    correctness: null,
    recoveryResult: recoveryResultFor({ retrievalCalls, returnedBytes, reruns, rereads }),
    digests: null,
  };
  for (const field of [
    "originalBytes", "visibleBytes", "removedBytes", "semanticBytes", "historicalMaskedBytes",
    "archivedBytes", "estimatedTokensSavedSemantic", "estimatedTokensSavedHistorical",
    "historicalMaskEvents", "semanticTransforms", "archiveReferences", "retrievalCalls",
    "returnedBytes", "reruns", "rereads", "secretIncidents", "nonTextOrderingIncidents",
  ]) {
    if (typeof instrumentation[field] !== "number" || !Number.isFinite(instrumentation[field])) {
      throw new Error(`extracted instrumentation field ${field} is not a finite number`);
    }
  }
  if (typeof instrumentation.diagnosticPresent !== "boolean" || typeof instrumentation.recoveryResult !== "string") {
    throw new Error("extracted instrumentation booleans and enums are incomplete");
  }
  return instrumentation;
}
