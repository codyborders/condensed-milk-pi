/**
 * Bounded, secret-safe archive for pre-transform tool output.
 * Retrieval supports exact paging plus bounded search modes.
 */
import { createHash } from "node:crypto";
import {
  chmodSync,
  closeSync,
  mkdirSync,
  openSync,
  realpathSync,
  readFileSync,
  readdirSync,
  renameSync,
  rmdirSync,
  rmSync,
  statSync,
  unlinkSync,
  utimesSync,
  writeFileSync,
} from "node:fs";
import { homedir } from "node:os";
import { join } from "node:path";
import { fileURLToPath } from "node:url";
import { lockSync } from "proper-lockfile";
import { stripAnsi } from "./ansi-strip.js";
import { redactPrivacyLines } from "./dispatch.js";
// Guarantee the mandatory environment redaction filter is registered no
// matter which entry point loads this module. The storage boundary must
// never depend on filter import order elsewhere.
import "./env.js";

/** Opaque archive reference shape: cm- + 16 hex chars. */
export const ARCHIVE_ID_PATTERN = /^cm-[0-9a-f]{16}$/;

/** Stable opaque archive id for one session tool result. Hashing keeps
 *  commands, paths, content, and credentials out of the id. */
export function deriveArchiveId(sessionKey: string, toolCallId: string): string {
  const digest = createHash("sha256")
    .update("condensed-milk-archive-v1\0")
    .update(sessionKey)
    .update("\0")
    .update(toolCallId)
    .digest("hex");
  return `cm-${digest.slice(0, 16)}`;
}

/** Minimal filesystem surface the store needs. Injectable so tests and
 *  benchmarks can count operations and inject per-operation failures. */
interface ArchiveLock {
  release: () => void;
}

export interface ArchiveFilesystem {
  mkdirSync(path: string, options?: { recursive?: boolean; mode?: number }): void;
  chmodSync(path: string, mode: number): void;
  readFileSync(path: string, encoding: "utf8"): string;
  writeFileSync(path: string, data: string, options?: { mode?: number }): void;
  renameSync(from: string, to: string): void;
  unlinkSync(path: string): void;
  statSync(path: string): { mtimeMs: number; isDirectory?: () => boolean };
  readdirSync(path: string): string[];
  utimesSync(path: string, atime: number, mtime: number): void;
  rmSync(path: string, options: { recursive: boolean; force: boolean }): void;
  openSync(path: string, flags: "wx", mode?: number): number;
  closeSync(fd: number): void;
  realpathSync(path: string): string;
  rmdirSync(path: string): void;
}

/** Fresh object of real filesystem operations. Spread this to override
 *  individual operations in tests. */
export function defaultArchiveFilesystem(): ArchiveFilesystem {
  return {
    mkdirSync: (path, options) => mkdirSync(path, options),
    chmodSync: (path, mode) => chmodSync(path, mode),
    readFileSync: (path, encoding) => readFileSync(path, encoding),
    writeFileSync: (path, data, options) => writeFileSync(path, data, options),
    renameSync: (from, to) => renameSync(from, to),
    unlinkSync: (path) => unlinkSync(path),
    statSync: (path) => statSync(path),
    readdirSync: (path) => readdirSync(path),
    utimesSync: (path, atime, mtime) => utimesSync(path, atime, mtime),
    rmSync: (path, options) => rmSync(path, options),
    openSync: (path, flags, mode) => openSync(path, flags, mode),
    closeSync: (fd) => closeSync(fd),
    realpathSync: (path) => realpathSync(path),
    rmdirSync: (path) => rmdirSync(path),
  };
}

/** Counting wrapper: one tick per operation name. Counters are live. */
export function createCountingFilesystem(base: ArchiveFilesystem = defaultArchiveFilesystem()): {
  fs: ArchiveFilesystem;
  counts: Record<string, number>;
} {
  const counts: Record<string, number> = {};
  const fs: ArchiveFilesystem = {} as ArchiveFilesystem;
  for (const key of Object.keys(base) as Array<keyof ArchiveFilesystem>) {
    counts[key] = 0;
    (fs as any)[key] = (...args: unknown[]) => {
      counts[key] = (counts[key] ?? 0) + 1;
      return (base[key] as (...a: unknown[]) => unknown)(...args);
    };
  }
  return { fs, counts };
}

let cachedPackageVersion: string | null = null;

/** Telemetry package version read from package metadata next to the
 *  extension. Falls back to "unknown" (never throws, never crashes a
 *  session) when the manifest cannot be read. */
export function packageVersion(): string {
  if (cachedPackageVersion !== null) return cachedPackageVersion;
  try {
    const manifestPath = join(dirnameOfFile(import.meta.url), "..", "package.json");
    const parsed = JSON.parse(readFileSync(manifestPath, "utf8"));
    if (typeof parsed?.version === "string" && parsed.version.length > 0) {
      cachedPackageVersion = parsed.version;
      return parsed.version;
    }
  } catch {
    // Missing or unreadable manifest: report unknown, never fail a session.
  }
  cachedPackageVersion = "unknown";
  return cachedPackageVersion;
}

function dirnameOfFile(url: string): string {
  const path = fileURLToPath(url);
  const slash = Math.max(path.lastIndexOf("/"), path.lastIndexOf("\\"));
  return slash === -1 ? "." : path.substring(0, slash);
}

/** Pi agent directory: PI_CODING_AGENT_DIR when set (non-empty), else the
 *  normal ~/.pi/agent default. Evaluated per call so environment changes
 *  apply at the next session start. */
export function recoveryAgentRoot(env: { PI_CODING_AGENT_DIR?: string; [key: string]: string | undefined } = process.env): string {
  const custom = env.PI_CODING_AGENT_DIR;
  if (typeof custom === "string" && custom.length > 0) return custom;
  return join(homedir(), ".pi", "agent");
}

/** Recovery archive root below the Pi agent directory. */
export function recoveryRoot(env: { PI_CODING_AGENT_DIR?: string; [key: string]: string | undefined } = process.env): string {
  return join(recoveryAgentRoot(env), "condensed-milk-recovery");
}

export interface ArchiveLimits {
  maxEntries: number;
  maxEntryBytes: number;
  maxAggregateBytes: number;
  ttlMs: number;
}

/** Conservative defaults: 128 entries, 64 KiB per entry, 4 MiB aggregate,
 *  24 h TTL. Pi caps bash results at 50 KiB, so the entry cap covers any
 *  single result plus the JSON envelope. */
export const DEFAULT_ARCHIVE_LIMITS: ArchiveLimits = {
  maxEntries: 128,
  maxEntryBytes: 65_536,
  maxAggregateBytes: 4_194_304,
  ttlMs: 86_400_000,
};

export interface ArchiveConfig {
  enabled: boolean;
  limits: ArchiveLimits;
  warnings: string[];
}

/** Hard ceilings for user configuration. Larger values are rejected with
 *  a warning and the default is retained. */
export const ARCHIVE_LIMIT_CEILINGS: ArchiveLimits = {
  maxEntries: 1_024,
  maxEntryBytes: 1_048_576,
  maxAggregateBytes: 16_777_216,
  ttlMs: 604_800_000,
};

/** Minimum TTL (1 minute). */
const MIN_TTL_MS = 60_000;

/** The single deterministic serialized form. Entry files hold exactly these
 *  bytes; pagination targets them. Block key order is whatever the caller
 *  supplied; it is frozen at write time, so the stored bytes are stable. */
export function canonicalArchiveText(id: string, createdAtMs: number, blocks: unknown[]): string {
  return JSON.stringify({ v: 1, id, createdAt: createdAtMs, blocks });
}

/** Deterministic searchable rendering used by tail, literal, and regex
 *  modes: text blocks verbatim, one deterministic marker line per
 *  non-text block, joined by newlines. */
export function searchableTextFromBlocks(blocks: unknown[]): string {
  const parts: string[] = [];
  for (const block of blocks) {
    if (isPlainObject(block) && block.type === "text" && typeof block.text === "string") {
      parts.push(block.text);
    } else {
      parts.push(`[cm-block ${JSON.stringify(block)}]`);
    }
  }
  return parts.join("\n");
}

function isPlainObject(value: unknown): value is Record<string, unknown> {
  return typeof value === "object" && value !== null && !Array.isArray(value);
}

// ── UTF-8 byte helpers ──

function roundDownToCodepoint(bytes: Buffer, index: number): number {
  let i = index;
  while (i > 0 && (bytes[i] & 0xc0) === 0x80) i--;
  return i;
}

function roundUpToCodepoint(bytes: Buffer, index: number): number {
  let i = index;
  while (i < bytes.length && (bytes[i] & 0xc0) === 0x80) i++;
  return i;
}

function codepointLength(bytes: Buffer, start: number): number {
  const first = bytes[start];
  if (first === undefined) return 1;
  if (first < 0x80) return 1;
  if ((first & 0xe0) === 0xc0) return 2;
  if ((first & 0xf0) === 0xe0) return 3;
  return 4;
}

export interface ArchivePage {
  /** "text": model-readable UTF-8 covering exactly bytes [start, end).
   *  "base64": reversible raw-byte page used only when the requested
   *  offset lands inside a codepoint, so bytes are never duplicated by
   *  rounding down. */
  mode: "text" | "base64";
  /** Decoded page text (mode "text"). */
  text?: string;
  /** Base64 raw bytes covering exactly [start, end) (mode "base64"). */
  bytes?: string;
  /** Byte offset the returned payload starts at. Always the exact
   *  requested offset — never rounded. */
  start: number;
  /** Byte offset just past the returned payload. */
  end: number;
  /** Next byte offset to request, or null when the end was reached. */
  next: number | null;
  /** Total UTF-8 bytes of the canonical form. */
  totalBytes: number;
}

/** Page the canonical text by UTF-8 byte offsets under an exact
 *  reconstruction contract:
 *
 *  - When `offset` lands on a codepoint boundary, the page is plain text
 *    covering exactly bytes [offset, end), where end never splits a
 *    codepoint. This is the normal paging flow via `next`.
 *  - When `offset` lands inside a codepoint, the page is a base64 byte
 *    page covering exactly [offset, end). The partial codepoint bytes
 *    appear only in this page — no rounding down, no duplication.
 *
 *  Decoding each page (text as UTF-8, base64 as raw bytes) and
 *  concatenating in offset order reproduces the canonical bytes exactly. */
export function pageCanonicalText(canonical: string, offset: number, limit: number): ArchivePage {
  const bytes = Buffer.from(canonical, "utf8");
  const totalBytes = bytes.length;
  const requested = Math.max(0, Math.min(Math.trunc(offset), totalBytes));
  const effectiveLimit = Math.max(1, Math.trunc(limit));

  // Align the END down so the payload never splits a codepoint.
  const rawEnd = Math.min(requested + effectiveLimit, totalBytes);
  let end = roundDownToCodepoint(bytes, rawEnd);
  // Progress guarantee: always advance past the codepoint that starts at
  // or contains `requested`, even when the limit is smaller than one
  // codepoint. The page may then be short or mid-codepoint (base64).
  if (end <= requested && requested < totalBytes) {
    const midCodepoint = (bytes[requested] & 0xc0) === 0x80;
    end = midCodepoint
      ? roundUpToCodepoint(bytes, requested)
      : requested + codepointLength(bytes, requested);
    end = Math.min(end, totalBytes);
    if (end <= requested) end = Math.min(requested + 1, totalBytes); // defensive
  }

  const base: Omit<ArchivePage, "mode" | "text" | "bytes"> = {
    start: requested,
    end,
    // The stream ends exactly when the page end reaches totalBytes: no
    // trailing empty request is ever required to observe next=null.
    next: end < totalBytes ? end : null,
    totalBytes,
  };

  if (end === requested) {
    // Terminal empty page at/after the end.
    return { mode: "text", text: "", ...base, next: requested >= totalBytes ? null : end };
  }

  const startsMidCodepoint = requested > 0 && (bytes[requested] & 0xc0) === 0x80;
  if (startsMidCodepoint) {
    return { mode: "base64", bytes: bytes.subarray(requested, end).toString("base64"), ...base };
  }
  return { mode: "text", text: bytes.subarray(requested, end).toString("utf8"), ...base };
}

// ── Tail (over the searchable rendering) ──

export interface ArchiveTail {
  text: string;
  start: number;
  totalBytes: number;
}

/** Return the trailing `bytes` (UTF-8) of the searchable rendering. A
 *  leading partial codepoint is skipped, never split. */
export function tailOfSearchable(searchable: string, bytes: number): ArchiveTail {
  const buf = Buffer.from(searchable, "utf8");
  const totalBytes = buf.length;
  const wanted = Math.max(1, Math.trunc(bytes));
  const rawStart = Math.max(0, totalBytes - wanted);
  const start = roundUpToCodepoint(buf, rawStart);
  return { text: buf.subarray(start).toString("utf8"), start, totalBytes };
}

// ── Search (line-based, over the searchable rendering) ──

export interface SearchHit {
  /** 1-based line number in the searchable rendering. */
  line: number;
  text: string;
}

export interface SearchResult {
  hits: SearchHit[];
  truncated: boolean;
}

function collectHits(
  lines: string[],
  matches: (line: string) => boolean,
  maxMatches: number,
  maxResultBytes: number,
): SearchResult {
  const hits: SearchHit[] = [];
  let used = 0;
  let truncated = false;
  for (let i = 0; i < lines.length; i++) {
    if (!matches(lines[i])) continue;
    if (hits.length >= maxMatches) {
      truncated = true;
      break;
    }
    const lineBytes = Buffer.byteLength(lines[i], "utf8");
    if (used + lineBytes > maxResultBytes) {
      truncated = true;
      break;
    }
    hits.push({ line: i + 1, text: lines[i] });
    used += lineBytes;
  }
  return { hits, truncated };
}

/** Literal (case-sensitive, substring) line search with bounded results. */
export function findLiteralLines(
  searchable: string,
  needle: string,
  maxMatches: number,
  maxResultBytes: number,
): SearchResult {
  if (needle.length === 0) return { hits: [], truncated: false };
  const lines = searchable.split("\n");
  return collectHits(lines, (line) => line.includes(needle), maxMatches, maxResultBytes);
}

/** Only these regex flags are accepted. No global or sticky iteration. */
const ALLOWED_REGEX_FLAGS = new Set(["i", "m", "s", "u"]);

/** Each line is truncated to this many bytes (codepoint-aligned) before
 *  RegExp.test so a pathological line cannot blow up evaluation. */
export const MAX_REGEX_LINE_BYTES = 4_096;

/** Conservative regex safety screen. Rejects backreferences, lookarounds,
 *  quantified groups (which also covers nested quantifiers), and more than
 *  one unbounded repetition. These shapes are the classic exponential
 *  backtracking risks, and archive search never needs them. */
function isSafeRegexSource(source: string): boolean {
  // Backreferences: \1 .. \9 and named \k<...>.
  if (/\\[1-9]/.test(source) || /\\k</.test(source)) return false;
  // Lookarounds and named groups: (?= (?! (?<= (?<! (?<name>. Any
  // "(?" other than the non-capturing "(?:" is rejected.
  if (/\(\?(?!:)/.test(source)) return false;
  // Quantified groups: ")" followed by any quantifier. This also covers
  // nested quantifiers such as (a+)+ because the inner group is quantified
  // by the outer one only through the closing paren.
  if (/\)[+*{]/.test(source)) return false;
  // At most one unbounded repetition outside character classes.
  let unbounded = 0;
  let inClass = false;
  for (let i = 0; i < source.length; i++) {
    const ch = source[i];
    if (ch === "\\") {
      i++; // skip escaped character
      continue;
    }
    if (ch === "[") inClass = true;
    else if (ch === "]") inClass = false;
    else if (!inClass && (ch === "*" || ch === "+")) unbounded++;
    else if (!inClass && ch === "{") {
      // {n,} with no upper bound counts as unbounded.
      const rest = source.slice(i);
      if (/^\{\d+,\}/.test(rest)) unbounded++;
    }
    if (unbounded > 1) return false;
  }
  return true;
}

/** Truncate one line to the test bound, codepoint-aligned at the end. */
function boundLine(line: string): string {
  if (Buffer.byteLength(line, "utf8") <= MAX_REGEX_LINE_BYTES) return line;
  const buf = Buffer.from(line, "utf8");
  let end = roundDownToCodepoint(buf, MAX_REGEX_LINE_BYTES);
  if (end <= 0) end = 1;
  return buf.subarray(0, end).toString("utf8");
}

/** Compile-check the restricted flag set. Throws a safe error that never
 *  echoes the pattern or flags. */
function compileSearchRegex(source: string, flags: string): RegExp {
  if (flags.length > 0) {
    const seen = new Set<string>();
    for (const flag of flags) {
      if (!ALLOWED_REGEX_FLAGS.has(flag) || seen.has(flag)) {
        throw new Error("condensed_milk_retrieve: invalid regex flags");
      }
      seen.add(flag);
    }
  }
  if (!isSafeRegexSource(source)) {
    throw new Error("condensed_milk_retrieve: invalid regex");
  }
  try {
    return new RegExp(source, flags);
  } catch {
    throw new Error("condensed_milk_retrieve: invalid regex");
  }
}

/** Regex line search restricted to flags i, m, s, u with bounded results.
 *  The source length is capped by the caller (MAX_REGEX_BYTES). */
export function findRegexLines(
  searchable: string,
  source: string,
  flags: string,
  maxMatches: number,
  maxResultBytes: number,
): SearchResult {
  const regex = compileSearchRegex(source, flags);
  const lines = searchable.split("\n");
  return collectHits(lines, (line) => {
    regex.lastIndex = 0;
    return regex.test(boundLine(line));
  }, maxMatches, maxResultBytes);
}

// ── Retrieval caps (fixed; not user-configurable) ──

/** Maximum bytes returned by one page, tail, or search request. */
export const MAX_PAGE_BYTES = 32_768;
/** Default page size when offset is given without limit. */
export const DEFAULT_PAGE_BYTES = 8_192;
/** Maximum accepted offset value (caps request size). */
export const MAX_OFFSET_BYTES = 268_435_456;
/** Maximum literal query length in UTF-8 bytes. */
export const MAX_LITERAL_BYTES = 512;
/** Maximum regex source length in UTF-8 bytes. */
export const MAX_REGEX_BYTES = 256;
/** Maximum reported matches per search. */
export const MAX_MATCHES = 50;
/** Maximum total match-line bytes per search response. */
export const MAX_SEARCH_RESULT_BYTES = 32_768;
/** Maximum searchable bytes scanned per search request (work cap). */
export const MAX_SEARCH_SCAN_BYTES = 1_048_576;

// ── Retrieval request executor (independent of pi registration) ──

/** Raw request params as they arrive from a tool call. Unknown-typed on
 *  purpose: every field is validated here, never trusted. */
export interface RetrieveRequestParams {
  id?: unknown;
  offset?: unknown;
  limit?: unknown;
  tail?: unknown;
  literal?: unknown;
  regex?: unknown;
  flags?: unknown;
}

export type RetrieveErrorKind =
  | "malformed-id"
  | "missing"
  | "expired"
  | "evicted"
  | "unavailable"
  | "invalid-regex"
  | "invalid-options";

export interface RetrieveError {
  kind: RetrieveErrorKind;
  /** Safe, static message. Never echoes query text. */
  message: string;
}

export type RetrieveExecution =
  | { ok: true; text: string }
  | { ok: false; error: RetrieveError };

function invalidOptions(reason: string): RetrieveExecution {
  return { ok: false, error: { kind: "invalid-options", message: `condensed_milk_retrieve: invalid options (${reason})` } };
}

function isPresent(value: unknown): boolean {
  return value !== undefined;
}

/** Validate one optional non-negative integer option. */
function optionalInt(params: RetrieveRequestParams, key: "offset" | "limit" | "tail", min: number, max: number): number | "absent" | RetrieveExecution {
  const raw = params[key];
  if (!isPresent(raw)) return "absent";
  if (typeof raw !== "number" || !Number.isSafeInteger(raw) || raw < min || raw > max) {
    return invalidOptions(`${key} must be an integer between ${min} and ${max}`);
  }
  return raw;
}

function optionalString(params: RetrieveRequestParams, key: "literal" | "regex" | "flags"): string | "absent" | RetrieveExecution {
  const raw = params[key];
  if (!isPresent(raw)) return "absent";
  if (typeof raw !== "string") return invalidOptions(`${key} must be a string`);
  return raw;
}

/** Reapply mandatory line redaction to returned text. Storage already
 *  redacts; this is defense in depth at the retrieval boundary. */
function reapplyRedaction(text: string): string {
  const redacted = redactPrivacyLines(text);
  return redacted ?? text;
}

/** Execute one retrieval request against a store. Pure with respect to pi:
 *  no ExtensionAPI, no tool registration — callers map {@link RetrieveError}
 *  values to their own error surfaces. All mode, cap, integer, and safety
 *  rules are enforced here. */
export function executeRetrieveRequest(
  store: ArchiveStore | null,
  params: RetrieveRequestParams,
): RetrieveExecution {
  const id = params.id;
  if (typeof id !== "string" || !ARCHIVE_ID_PATTERN.test(id)) {
    return { ok: false, error: { kind: "malformed-id", message: "condensed_milk_retrieve: malformed archive reference" } };
  }
  if (store === null) {
    return { ok: false, error: { kind: "unavailable", message: "condensed_milk_retrieve: archive storage unavailable" } };
  }

  const offset = optionalInt(params, "offset", 0, MAX_OFFSET_BYTES);
  if (typeof offset === "object" && offset !== null && "ok" in offset) return offset;
  const limit = optionalInt(params, "limit", 1, MAX_PAGE_BYTES);
  if (typeof limit === "object" && limit !== null && "ok" in limit) return limit;
  const tail = optionalInt(params, "tail", 1, MAX_PAGE_BYTES);
  if (typeof tail === "object" && tail !== null && "ok" in tail) return tail;
  const literal = optionalString(params, "literal");
  if (typeof literal === "object" && literal !== null && "ok" in literal) return literal;
  const regex = optionalString(params, "regex");
  if (typeof regex === "object" && regex !== null && "ok" in regex) return regex;
  const flags = optionalString(params, "flags");
  if (typeof flags === "object" && flags !== null && "ok" in flags) return flags;

  // Mode selection: page (default), tail, literal search, regex search.
  const searchCount = [literal, regex].filter((v) => v !== "absent").length;
  if (searchCount > 1) return invalidOptions("tail, literal, and regex are mutually exclusive");
  if (tail !== "absent" && searchCount > 0) return invalidOptions("tail, literal, and regex are mutually exclusive");
  const searchMode = searchCount > 0;
  const tailMode = tail !== "absent";
  if ((searchMode || tailMode) && (offset !== "absent" || limit !== "absent")) {
    return invalidOptions("offset and limit apply only to page mode");
  }
  if (flags !== "absent") {
    if (regex === "absent") return invalidOptions("flags require regex");
    for (const flag of flags as string) {
      if (!ALLOWED_REGEX_FLAGS.has(flag)) {
        return { ok: false, error: { kind: "invalid-regex", message: "condensed_milk_retrieve: invalid regex flags" } };
      }
    }
    if (new Set(flags as string).size !== (flags as string).length) {
      return { ok: false, error: { kind: "invalid-regex", message: "condensed_milk_retrieve: invalid regex flags" } };
    }
  }
  if (literal !== "absent") {
    if ((literal as string).length === 0) return invalidOptions("literal query must be a non-empty string");
    if (Buffer.byteLength(literal as string, "utf8") > MAX_LITERAL_BYTES) {
      return invalidOptions(`literal query exceeds ${MAX_LITERAL_BYTES} bytes`);
    }
  }
  if (regex !== "absent") {
    if (Buffer.byteLength(regex as string, "utf8") > MAX_REGEX_BYTES) {
      return invalidOptions(`regex exceeds ${MAX_REGEX_BYTES} bytes`);
    }
  }

  // Load the entry once for every mode.
  const outcome = store.retrieve(id);
  if (outcome.kind !== "ok") {
    const messages: Record<string, string> = {
      unavailable: "condensed_milk_retrieve: archive storage unavailable",
      expired: "condensed_milk_retrieve: archive entry expired",
      evicted: "condensed_milk_retrieve: archive entry evicted by retention limits",
      missing: "condensed_milk_retrieve: archive entry not found",
    };
    return { ok: false, error: { kind: outcome.kind, message: messages[outcome.kind] } };
  }

  if (tailMode) {
    const tailBytes = tail as number;
    const slice = tailOfSearchable(outcome.searchable, tailBytes);
    const text = reapplyRedaction(slice.text);
    const header = `archive ${id} tail bytes ${slice.start}-${slice.totalBytes} of ${slice.totalBytes}`;
    return { ok: true, text: `${header}\n---\n${text}` };
  }

  if (searchMode) {
    // Work cap: scan at most MAX_SEARCH_SCAN_BYTES of the searchable text.
    let searchable = outcome.searchable;
    let scanTruncated = false;
    if (Buffer.byteLength(searchable, "utf8") > MAX_SEARCH_SCAN_BYTES) {
      const buf = Buffer.from(searchable, "utf8");
      const cut = roundUpToCodepoint(buf, MAX_SEARCH_SCAN_BYTES);
      searchable = buf.subarray(0, cut).toString("utf8");
      scanTruncated = true;
    }
    let result: SearchResult;
    let modeLabel: string;
    if (literal !== "absent") {
      modeLabel = "literal";
      result = findLiteralLines(searchable, literal as string, MAX_MATCHES, MAX_SEARCH_RESULT_BYTES);
    } else {
      modeLabel = "regex";
      try {
        result = findRegexLines(searchable, regex as string, (flags as string) ?? "", MAX_MATCHES, MAX_SEARCH_RESULT_BYTES);
      } catch {
        return { ok: false, error: { kind: "invalid-regex", message: "condensed_milk_retrieve: invalid regex" } };
      }
    }
    const truncated = result.truncated || scanTruncated ? " truncated" : "";
    const header = `archive ${id} ${modeLabel} matches ${result.hits.length}${truncated}`;
    const body = result.hits.map((hit) => `${hit.line}: ${reapplyRedaction(hit.text)}`).join("\n");
    return { ok: true, text: body.length > 0 ? `${header}\n---\n${body}` : header };
  }

  // Page mode.
  const offsetBytes = offset === "absent" ? 0 : (offset as number);
  const limitBytes = limit === "absent" ? DEFAULT_PAGE_BYTES : (limit as number);
  const page = pageCanonicalText(outcome.canonical, offsetBytes, limitBytes);
  const nextLabel = page.next === null ? "end" : String(page.next);
  const header = `archive ${id} page bytes ${page.start}-${page.end} of ${page.totalBytes} (next ${nextLabel}) encoding ${page.mode}`;
  if (page.mode === "base64") {
    return { ok: true, text: `${header}\n---\n${page.bytes}` };
  }
  return { ok: true, text: `${header}\n---\n${reapplyRedaction(page.text ?? "")}` };
}

// ── Store ──

interface IndexEntry {
  bytes: number;
  createdAt: number;
}

interface StoreIndex {
  v: 1;
  entries: Record<string, IndexEntry>;
  /** Bounded removal records carrying the removal reason so later
   *  retrievals can distinguish expired from evicted persistently. */
  evicted: Array<string | { id: string; reason: "expired" | "evicted" }>;
}

/** Short synchronous sleep used only for bounded lock retries. */
function sleepSync(ms: number): void {
  const cell = new Int32Array(new SharedArrayBuffer(4));
  Atomics.wait(cell, 0, 0, ms);
}

function emptyIndex(): StoreIndex {
  return { v: 1, entries: {}, evicted: [] };
}

/** Bounded tombstone list for distinct evicted/expired errors. */
const MAX_TOMBSTONES = 512;

export type RetrieveOutcome =
  | { kind: "ok"; canonical: string; searchable: string; bytes: number; createdAt: number }
  | { kind: "unavailable" }
  | { kind: "expired" }
  | { kind: "evicted" }
  | { kind: "missing" };

/** Session-scoped archive store. One instance per session. Storage lives
 *  outside model context in a per-session directory (mode 0700) with one
 *  JSON entry per archive id (mode 0600) plus an index.json ledger. All
 *  failures are reported as null (store) or non-ok outcomes (retrieve);
 *  none throw, so callers can fail open. */
export class ArchiveStore {
  private readonly rootDir: string;
  private readonly sessionKey: string;
  private readonly limits: ArchiveLimits;
  private readonly now: () => number;
  private readonly fs: ArchiveFilesystem;
  private readonly dir: string;
  private dirEnsured = false;
  /** Session memory of every tombstoned id, including records the
   *  bounded index list dropped, so repeated batches never rewrite the
   *  index just to re-record forgotten tombstones. */
  private readonly knownTombstones = new Set<string>();
  /** toolCallId -> archive id cache so repeated batches skip rehashing
   *  every candidate. The whole cache resets at a fixed bound. */
  private readonly idCache = new Map<string, string>();
  private static readonly MAX_ID_CACHE_ENTRIES = 20_000;

  /** Cached deriveArchiveId for the batch candidate loop. */
  private idCacheFor(toolCallId: string): string {
    const cached = this.idCache.get(toolCallId);
    if (cached !== undefined) return cached;
    if (this.idCache.size >= ArchiveStore.MAX_ID_CACHE_ENTRIES) this.idCache.clear();
    const id = deriveArchiveId(this.sessionKey, toolCallId);
    this.idCache.set(toolCallId, id);
    return id;
  }

  constructor(rootDir: string, sessionKey: string, limits: ArchiveLimits, now: () => number = () => Date.now(), fs: ArchiveFilesystem = defaultArchiveFilesystem()) {
    this.rootDir = rootDir;
    this.sessionKey = sanitizeSessionKey(sessionKey);
    this.limits = limits;
    this.now = now;
    this.fs = fs;
    this.dir = join(rootDir, this.sessionKey);
  }

  /** Session archive directory (opaque name). Exposed for permission tests. */
  directory(): string {
    return this.dir;
  }

  /** Ensure root and session directories exist with mode 0700. Returns
   *  false when the tree cannot be created or locked down. */
  private ensureDir(): boolean {
    if (this.dirEnsured) return true;
    try {
      this.fs.mkdirSync(this.dir, { recursive: true, mode: 0o700 });
      if (process.platform !== "win32") {
        this.fs.chmodSync(this.dir, 0o700);
      }
      this.dirEnsured = true;
      return true;
    } catch {
      return false;
    }
  }

  private entryPath(id: string): string {
    return join(this.dir, `${id}.json`);
  }

  private indexPath(): string {
    return join(this.dir, "index.json");
  }

  private readIndex(): StoreIndex | null {
    let raw: string;
    try {
      raw = this.fs.readFileSync(this.indexPath(), "utf8");
    } catch (e: any) {
      if (e?.code === "ENOENT") return emptyIndex();
      return null; // unreadable index: storage is unavailable, not empty
    }
    try {
      const parsed = JSON.parse(raw) as StoreIndex;
      if (!isPlainObject(parsed) || parsed.v !== 1 || !isPlainObject(parsed.entries) || !Array.isArray(parsed.evicted)) {
        return null;
      }
      for (const [id, entry] of Object.entries(parsed.entries)) {
        if (!ARCHIVE_ID_PATTERN.test(id) || !isPlainObject(entry)) return null;
        if (!Number.isSafeInteger(entry.bytes) || entry.bytes < 0) return null;
        if (!Number.isFinite(entry.createdAt) || entry.createdAt < 0) return null;
      }
      for (const tombstone of parsed.evicted) {
        if (typeof tombstone === "string") {
          if (!ARCHIVE_ID_PATTERN.test(tombstone)) return null;
          continue;
        }
        if (!isPlainObject(tombstone) || typeof tombstone.id !== "string") return null;
        if (!ARCHIVE_ID_PATTERN.test(tombstone.id)) return null;
        if (tombstone.reason !== "expired" && tombstone.reason !== "evicted") return null;
      }
      return parsed;
    } catch {
      return null; // corrupted index: unavailable (fail open), never empty
    }
  }

  private writeIndex(index: StoreIndex): boolean {
    const path = this.indexPath();
    const tmp = this.uniqueTemp(path);
    try {
      this.fs.writeFileSync(tmp, JSON.stringify(index), { mode: 0o600 });
      this.fs.renameSync(tmp, path);
      return true;
    } catch {
      try { this.fs.unlinkSync(tmp); } catch { /* best effort */ }
      return false;
    }
  }

  /** Unique temporary path per write attempt: pid + time + random. */
  private uniqueTemp(path: string): string {
    return `${path}.${process.pid}.${Date.now()}.${Math.random().toString(16).substring(2, 8)}.tmp`;
  }

  private tombstone(index: StoreIndex, id: string, reason: "expired" | "evicted"): void {
    // Drop any earlier record for the same id, then append with its reason.
    index.evicted = index.evicted.filter((entry) =>
      typeof entry === "string" ? entry !== id : entry.id !== id,
    );
    index.evicted.push({ id, reason });
    while (index.evicted.length > MAX_TOMBSTONES) index.evicted.shift();
  }

  private tombstoneReason(index: StoreIndex, id: string): "expired" | "evicted" | undefined {
    for (const entry of index.evicted) {
      if (typeof entry === "string") {
        if (entry === id) return "evicted"; // legacy pre-reason index shape
      } else if (entry.id === id) {
        return entry.reason;
      }
    }
    return undefined;
  }

  /** Tombstone one id and report whether the record actually changed.
   *  Batch passes mark the index dirty only on real changes so repeated
   *  live batches perform no index writes. */
  private tombstoneChanged(
    seen: Map<string, "expired" | "evicted">,
    index: StoreIndex,
    id: string,
    reason: "expired" | "evicted",
  ): boolean {
    const prior = seen.get(id);
    if (prior === reason) return false;
    if (!seen.has(id) && this.knownTombstones.has(id)) return false; // dropped by the bounded list on purpose
    seen.delete(id);
    this.tombstone(index, id, reason);
    seen.set(id, reason);
    this.knownTombstones.add(id);
    return true;
  }

  private removeEntry(index: StoreIndex, id: string, reason: "expired" | "evicted" = "evicted"): boolean {
    try {
      this.fs.unlinkSync(this.entryPath(id));
    } catch (error: any) {
      if (error?.code !== "ENOENT") return false;
    }
    delete index.entries[id];
    this.tombstone(index, id, reason);
    return this.writeIndex(index);
  }

  /** Normalize blocks for storage: text blocks are ANSI-stripped and pass
   *  mandatory line-preserving redaction. Every OTHER property of the
   *  block (annotations, _meta, unknown fields, key order) and every
   *  non-text block is preserved unchanged. */
  private normalizeBlocks(blocks: unknown[]): unknown[] {
    return blocks.map((block) => {
      if (isPlainObject(block) && block.type === "text" && typeof block.text === "string") {
        const stripped = stripAnsi(block.text);
        const redacted = redactPrivacyLines(stripped);
        return { ...block, text: redacted ?? stripped };
      }
      return block;
    });
  }

  /** Archive one tool result through the same locked transaction used by
   *  historical batches. Returns null whenever no final live reference is
   *  available. */
  store(toolCallId: string | undefined, blocks: unknown[]): string | null {
    if (typeof toolCallId !== "string" || toolCallId.length === 0) return null;
    if (!Array.isArray(blocks)) return null;
    return this.prepareBatch([{ toolCallId, blocks }])?.get(toolCallId) ?? null;
  }

  /** Two-phase batch archive API (release-blocker correction). Collect all
   *  eligible candidates for one context pass, then call this once. Reads
   *  the index once, runs retention once, persists the index at most once,
   *  and returns references only for ids live after final retention. Any
   *  storage, verification, or index failure returns null so callers fail
   *  open. Existing live entries are reused without content reads or
   *  rewrites. Tombstoned ids are never recreated. */
  prepareBatch(
    candidates: ReadonlyArray<{ toolCallId: string | undefined; blocks: unknown[] }>,
  ): Map<string, string> | null {
    const normalized: Array<{ toolCallId: string; id: string; blocks: unknown[] }> = [];
    const seen = new Set<string>();
    for (const candidate of candidates) {
      if (candidate === null || typeof candidate !== "object") continue;
      const toolCallId = candidate.toolCallId;
      if (typeof toolCallId !== "string" || toolCallId.length === 0) continue;
      if (!Array.isArray(candidate.blocks)) continue;
      let id = this.idCacheFor(toolCallId);
      if (seen.has(id)) continue; // first submission wins on duplicate ids
      seen.add(id);
      normalized.push({ toolCallId, id, blocks: candidate.blocks });
    }
    const references = new Map<string, string>();
    if (normalized.length === 0) return references; // no candidates: no IO at all
    if (!this.ensureDir()) return null;
    const lockFd = this.acquireLock();
    if (lockFd === null) return null; // lock unavailable: no references
    let refs: Map<string, string> | null = null;
    try {
      refs = this.runBatch(normalized, references);
    } catch {
      refs = null; // any unexpected failure fails open
    } finally {
      if (!this.releaseLock(lockFd)) refs = null; // uncertain final state
    }
    return refs;
  }

  /** Per-session atomic lock directory. */
  private static readonly LOCK_FILE = "batch.lock";
  private static readonly LOCK_ATTEMPTS = 5;
  private static readonly LOCK_RETRY_DELAY_MS = 5;
  private static readonly LOCK_STALE_MS = 300_000;

  private lockPath(): string {
    return join(this.dir, ArchiveStore.LOCK_FILE);
  }

  /** Acquire an atomic directory lock. The lock library removes stale
   *  crash-left directories before retrying its mkdir operation. */
  private acquireLock(): ArchiveLock | null {
    for (let attempt = 0; attempt < ArchiveStore.LOCK_ATTEMPTS; attempt++) {
      try {
        const release = lockSync(this.dir, {
          fs: this.fs,
          lockfilePath: this.lockPath(),
          realpath: false,
          retries: 0,
          stale: ArchiveStore.LOCK_STALE_MS,
          update: ArchiveStore.LOCK_STALE_MS / 2,
          onCompromised: () => {},
        });
        try {
          this.fs.chmodSync(this.lockPath(), 0o700);
        } catch {
          try { release(); } catch { /* best effort */ }
          return null;
        }
        return { release };
      } catch {
        sleepSync(ArchiveStore.LOCK_RETRY_DELAY_MS);
      }
    }
    return null;
  }

  private releaseLock(lock: ArchiveLock): boolean {
    try {
      lock.release();
      return true;
    } catch {
      return false;
    }
  }

  /** Batch core: assumes at least one valid candidate and an ensured
   *  directory. Single index read, single retention run, single index
   *  persist, bounded writes. */
  private runBatch(
    candidates: ReadonlyArray<{ toolCallId: string; id: string; blocks: unknown[] }>,
    references: Map<string, string>,
  ): Map<string, string> | null {
    const index = this.readIndex();
    if (!index) return null;
    const now = this.now();
    let dirty = false;

    // One bounded directory read drives retention presence checks AND the
    // later orphan pass, so no per-entry stat calls are needed.
    let listing: string[];
    try {
      listing = this.fs.readdirSync(this.dir);
    } catch {
      return null; // unreadable directory: final state unknown
    }
    const present = new Set(listing);

    // Tombstone lookups in O(1): the evicted list is bounded but scanned
    // once per candidate otherwise.
    const tombstoned = new Map<string, "expired" | "evicted">();
    for (const entry of index.evicted) {
      if (typeof entry === "string") tombstoned.set(entry, "evicted");
      else tombstoned.set(entry.id, entry.reason);
    }
    for (const id of tombstoned.keys()) this.knownTombstones.add(id);

    // Retention over existing entries: drop rows whose file vanished,
    // then expire rows past the TTL.
    for (const id of Object.keys(index.entries)) {
      if (!present.has(`${id}.json`)) {
        delete index.entries[id];
        if (this.tombstoneChanged(tombstoned, index, id, "evicted")) dirty = true;
        continue;
      }
      if (now - index.entries[id].createdAt >= this.limits.ttlMs) {
        try {
          this.fs.unlinkSync(this.entryPath(id));
        } catch (e: any) {
          if (e?.code !== "ENOENT") return null; // uncertain final state
        }
        delete index.entries[id];
        if (this.tombstoneChanged(tombstoned, index, id, "expired")) dirty = true;
      }
    }

    // Classify candidates. Live ids are reused with no read or rewrite.
    // Tombstoned ids are never recreated. Oversize and unserializable
    // candidates are rejected (stay visible) without failing the batch.
    const pending: Array<{ id: string; canonical: string; bytes: number }> = [];
    for (const candidate of candidates) {
      if (tombstoned.has(candidate.id) || this.knownTombstones.has(candidate.id)) continue;
      if (index.entries[candidate.id] !== undefined) continue;
      let canonical: string;
      try {
        canonical = canonicalArchiveText(candidate.id, now, this.normalizeBlocks(candidate.blocks));
      } catch {
        continue;
      }
      const bytes = Buffer.byteLength(canonical, "utf8");
      if (bytes > this.limits.maxEntryBytes) continue;
      pending.push({ id: candidate.id, canonical, bytes });
    }

    // Deterministic survivor selection BEFORE any write. Ties on
    // createdAt keep EXISTING rows first (order = MAX_SAFE_INTEGER for
    // new rows below): re-storing a live entry costs a rewrite, so a
    // repeated identical batch never churns its live set. Among new
    // rows, earlier submissions are evicted first, so the survivor
    // window is the submission tail.
    const rows = Object.entries(index.entries).map(([id, entry]) => ({
      id,
      bytes: entry.bytes,
      createdAt: entry.createdAt,
      order: Number.MAX_SAFE_INTEGER,
    }));
    pending.forEach((p, order) => rows.push({ id: p.id, bytes: p.bytes, createdAt: now, order }));
    const survivorIds = new Set(rows.map((row) => row.id));
    let totalBytes = rows.reduce((sum, row) => sum + row.bytes, 0);
    let count = rows.length;
    if (count > this.limits.maxEntries || totalBytes > this.limits.maxAggregateBytes) {
      rows.sort((a, b) =>
        a.createdAt - b.createdAt || a.order - b.order || (a.id < b.id ? -1 : a.id > b.id ? 1 : 0),
      );
      for (const row of rows) {
        if (count <= this.limits.maxEntries && totalBytes <= this.limits.maxAggregateBytes) break;
        survivorIds.delete(row.id);
        totalBytes -= row.bytes;
        count -= 1;
      }
    }

    // Evict existing non-survivors (unlink + tombstone). An unlink
    // failure leaves uncertain final state, so the batch fails open.
    for (const id of Object.keys(index.entries)) {
      if (survivorIds.has(id)) continue;
      try {
        this.fs.unlinkSync(this.entryPath(id));
      } catch (e: any) {
        if (e?.code !== "ENOENT") return null;
      }
      delete index.entries[id];
      if (this.tombstoneChanged(tombstoned, index, id, "evicted")) dirty = true;
    }

    // Write only new survivors, each verified by readback. Bounded by the
    // capacity simulation above. Any write/rename/verify failure fails the
    // whole batch open (no references).
    for (const entry of pending) {
      if (!survivorIds.has(entry.id)) {
        // Evicted before writing: tombstone so it is never recreated.
        if (this.tombstoneChanged(tombstoned, index, entry.id, "evicted")) dirty = true;
        continue;
      }
      const path = this.entryPath(entry.id);
      const tmp = this.uniqueTemp(path);
      try {
        this.fs.writeFileSync(tmp, entry.canonical, { mode: 0o600 });
        this.fs.renameSync(tmp, path);
        if (this.fs.readFileSync(path, "utf8") !== entry.canonical) {
          try { this.fs.unlinkSync(path); } catch { /* best effort */ }
          return null;
        }
      } catch {
        try { this.fs.unlinkSync(tmp); } catch { /* best effort */ }
        return null;
      }
      index.entries[entry.id] = { bytes: entry.bytes, createdAt: now };
      dirty = true;
    }

    if (dirty && !this.writeIndex(index)) return null;

    // Orphan pass reuses the single directory listing taken before any
    // write: entry files and stale temporary files absent from the final
    // index are removed (best effort; the index stays authoritative).
    for (const name of listing) {
      const entryMatch = /^(cm-[0-9a-f]{16})\.json$/.exec(name);
      const tmpMatch = /^(cm-[0-9a-f]{16})\.json\..+\.tmp$/.exec(name);
      const target = entryMatch?.[1] ?? tmpMatch?.[1];
      const staleIndexTemporary = /^index\.json\..+\.tmp$/.test(name);
      if (!staleIndexTemporary && (target === undefined || index.entries[target] !== undefined)) continue;
      try {
        this.fs.unlinkSync(join(this.dir, name));
      } catch (error: any) {
        if (error?.code !== "ENOENT") return null;
      }
    }

    // Emit references only for candidates whose id is live after the pass.
    for (const candidate of candidates) {
      if (index.entries[candidate.id] !== undefined) {
        references.set(candidate.toolCallId, candidate.id);
      }
    }
    return references;
  }

  /** Load one entry for retrieval. Distinguishes evicted (tombstoned),
   *  missing (unknown id), and unavailable (storage cannot be used). */
  retrieve(id: string): RetrieveOutcome {
    if (!ARCHIVE_ID_PATTERN.test(id)) return { kind: "missing" };
    if (!this.ensureDir()) return { kind: "unavailable" };
    const lockFd = this.acquireLock();
    if (lockFd === null) return { kind: "unavailable" };
    let outcome: RetrieveOutcome;
    try {
      outcome = this.loadEntry(id);
    } catch {
      outcome = { kind: "unavailable" };
    }
    if (!this.releaseLock(lockFd)) return { kind: "unavailable" };
    return outcome;
  }

  private loadEntry(id: string): RetrieveOutcome {
    const index = this.readIndex();
    if (!index) return { kind: "unavailable" };
    if (index.entries[id] === undefined) {
      const reason = this.tombstoneReason(index, id);
      if (reason === "expired") return { kind: "expired" };
      if (reason === "evicted") return { kind: "evicted" };
      return { kind: "missing" };
    }
    const path = this.entryPath(id);
    let raw: string;
    try {
      raw = this.fs.readFileSync(path, "utf8");
    } catch (error: any) {
      if (error?.code === "ENOENT") {
        return this.removeEntry(index, id, "evicted")
          ? { kind: "evicted" }
          : { kind: "unavailable" };
      }
      return { kind: "unavailable" };
    }
    let parsed: any;
    try {
      parsed = JSON.parse(raw);
    } catch {
      // Corrupted entries are removed while the retrieval lock is held.
      return this.removeEntry(index, id, "evicted")
        ? { kind: "missing" }
        : { kind: "unavailable" };
    }
    if (parsed?.id !== id || !Array.isArray(parsed?.blocks) || typeof parsed?.createdAt !== "number") {
      return this.removeEntry(index, id, "evicted")
        ? { kind: "missing" }
        : { kind: "unavailable" };
    }
    const now = this.now();
    if (now - parsed.createdAt >= this.limits.ttlMs) {
      return this.removeEntry(index, id, "expired")
        ? { kind: "expired" }
        : { kind: "unavailable" };
    }
    // LRU access refresh (best effort). Retrieval also refreshes the
    // session index mtime so active sessions are never swept as stale.
    try {
      const at = now / 1000;
      this.fs.utimesSync(path, at, at);
      this.fs.utimesSync(this.indexPath(), at, at);
    } catch { /* best effort */ }
    return {
      kind: "ok",
      canonical: raw,
      searchable: searchableTextFromBlocks(parsed.blocks),
      bytes: Buffer.byteLength(raw, "utf8"),
      createdAt: parsed.createdAt,
    };
  }

  /** Deterministic retention cleanup: TTL first, then LRU oldest-first
   *  eviction (order: access time, createdAt, id) until entry-count and
   *  aggregate-byte caps hold. Indexed entries whose files vanished or
   *  became unreadable are dropped, and orphan entry files no longer in
   *  the index are removed. */
  cleanup(): void {
    if (!this.ensureDir()) return;
    const lockFd = this.acquireLock();
    if (lockFd === null) return;
    try {
      this.cleanupUnderLock();
    } finally {
      this.releaseLock(lockFd);
    }
  }

  /** Run maintenance while the caller owns the session lock. */
  private cleanupUnderLock(): boolean {
    const index = this.readIndex();
    if (!index) return false;
    const now = this.now();

    for (const id of Object.keys(index.entries)) {
      try {
        this.fs.statSync(this.entryPath(id));
      } catch (error: any) {
        if (error?.code !== "ENOENT") return false;
        delete index.entries[id];
        this.tombstone(index, id, "evicted");
      }
    }

    for (const id of Object.keys(index.entries)) {
      if (now - index.entries[id].createdAt < this.limits.ttlMs) continue;
      try {
        this.fs.unlinkSync(this.entryPath(id));
      } catch (error: any) {
        if (error?.code !== "ENOENT") return false;
      }
      delete index.entries[id];
      this.tombstone(index, id, "expired");
    }

    const candidates: Array<{ id: string; atime: number; createdAt: number; bytes: number }> = [];
    for (const id of Object.keys(index.entries)) {
      let atime: number;
      try {
        atime = Math.round(this.fs.statSync(this.entryPath(id)).mtimeMs);
      } catch {
        return false;
      }
      candidates.push({ id, atime, createdAt: index.entries[id].createdAt, bytes: index.entries[id].bytes });
    }
    candidates.sort((left, right) =>
      left.atime - right.atime || left.createdAt - right.createdAt || left.id.localeCompare(right.id),
    );
    let totalBytes = candidates.reduce((sum, candidate) => sum + candidate.bytes, 0);
    let count = candidates.length;
    for (const candidate of candidates) {
      if (count <= this.limits.maxEntries && totalBytes <= this.limits.maxAggregateBytes) break;
      try {
        this.fs.unlinkSync(this.entryPath(candidate.id));
      } catch (error: any) {
        if (error?.code !== "ENOENT") return false;
      }
      delete index.entries[candidate.id];
      this.tombstone(index, candidate.id, "evicted");
      totalBytes -= candidate.bytes;
      count -= 1;
    }

    let names: string[];
    try {
      names = this.fs.readdirSync(this.dir);
    } catch {
      return false;
    }
    for (const name of names) {
      const match = /^(cm-[0-9a-f]{16})\.json$/.exec(name);
      const staleIndexTemporary = /^index\.json\..+\.tmp$/.test(name);
      if (!staleIndexTemporary && (!match || index.entries[match[1]] !== undefined)) continue;
      try {
        this.fs.unlinkSync(join(this.dir, name));
      } catch (error: any) {
        if (error?.code !== "ENOENT") return false;
      }
    }

    return this.writeIndex(index);
  }

  /** Retire all live entries after a session becomes inactive. The index
   *  commits tombstones before entry cleanup, so leftover orphan files
   *  cannot revive references. */
  private retireInactiveSession(): void {
    if (!this.ensureDir()) return;
    const lockFd = this.acquireLock();
    if (lockFd === null) return;
    try {
      const index = this.readIndex();
      if (!index) return;
      for (const id of Object.keys(index.entries)) {
        delete index.entries[id];
        this.tombstone(index, id, "evicted");
      }
      if (!this.writeIndex(index)) return;
      let names: string[];
      try {
        names = this.fs.readdirSync(this.dir);
      } catch {
        return;
      }
      for (const name of names) {
        if (!/^cm-[0-9a-f]{16}\.json$/.test(name) && !/^index\.json\..+\.tmp$/.test(name)) continue;
        try {
          this.fs.unlinkSync(join(this.dir, name));
        } catch {
          // The committed tombstone index keeps leftover files inaccessible.
        }
      }
      const at = this.now() / 1000;
      try { this.fs.utimesSync(this.indexPath(), at, at); } catch { /* best effort */ }
    } finally {
      this.releaseLock(lockFd);
    }
  }

  /** Sweep stale session directories through each target store's strict,
   *  locked retirement path. Malformed indexes remain untouched. */
  sweepStaleSessions(): void {
    let names: string[];
    try {
      names = this.fs.readdirSync(this.rootDir);
    } catch {
      return;
    }
    const now = this.now();
    for (const name of names) {
      if (!/^[A-Za-z0-9._-]{1,128}$/.test(name) || name === this.sessionKey) continue;
      const directory = join(this.rootDir, name);
      try {
        const directoryStat = this.fs.statSync(directory);
        if (directoryStat.isDirectory && !directoryStat.isDirectory()) continue;
        let newest = -Infinity;
        let sawChild = false;
        for (const child of this.fs.readdirSync(directory)) {
          if (child === ArchiveStore.LOCK_FILE) continue;
          const childMtime = this.fs.statSync(join(directory, child)).mtimeMs;
          sawChild = true;
          if (childMtime > newest) newest = childMtime;
        }
        if (!sawChild) newest = directoryStat.mtimeMs;
        if (now - newest < this.limits.ttlMs) continue;
        const target = new ArchiveStore(this.rootDir, name, this.limits, this.now, this.fs);
        target.retireInactiveSession();
      } catch {
        // Uncertain directory state remains untouched.
      }
    }
  }
}

/** Session keys become directory names. Anything outside a conservative
 *  safe set is replaced with an opaque hash, so directory names never
 *  contain paths or other attacker-controlled text. */
function sanitizeSessionKey(sessionKey: string): string {
  if (/^[A-Za-z0-9._-]{1,128}$/.test(sessionKey) && !sessionKey.includes("..")) {
    return sessionKey;
  }
  return createHash("sha256").update(sessionKey).digest("hex").slice(0, 32);
}

/** Validate the optional global `archive` configuration object. Invalid
 *  fields keep their defaults and produce one warning each. */
export function validateArchiveConfig(value: unknown): ArchiveConfig {
  // Release-blocker correction: archive-backed lossy masking is DISABLED
  // by default. Archiving must be an explicit opt-in because lossy
  // transforms without recovery destroy information.
  const result: ArchiveConfig = {
    enabled: false,
    limits: { ...DEFAULT_ARCHIVE_LIMITS },
    warnings: [],
  };
  if (value === undefined || value === null) return result;
  if (!isPlainObject(value)) {
    result.warnings.push("archive configuration must be a JSON object; using defaults");
    return result;
  }
  if (value.enabled !== undefined) {
    if (typeof value.enabled !== "boolean") {
      result.warnings.push("archive.enabled must be a boolean; keeping enabled=false");
    } else {
      result.enabled = value.enabled;
    }
  }
  for (const key of ["maxEntries", "maxEntryBytes", "maxAggregateBytes", "ttlMs"] as const) {
    const raw = value[key];
    if (raw === undefined) continue;
    const ceiling = ARCHIVE_LIMIT_CEILINGS[key];
    const minimum = key === "ttlMs" ? MIN_TTL_MS : 1;
    if (typeof raw !== "number" || !Number.isSafeInteger(raw) || raw < minimum || raw > ceiling) {
      result.warnings.push(
        `archive.${key} must be an integer between ${minimum} and ${ceiling}; keeping default ${DEFAULT_ARCHIVE_LIMITS[key]}`,
      );
    } else {
      result.limits[key] = raw;
    }
  }
  if (result.limits.maxEntryBytes > result.limits.maxAggregateBytes) {
    result.warnings.push(
      "archive.maxEntryBytes must not exceed archive.maxAggregateBytes; keeping default limits",
    );
    result.limits = { ...DEFAULT_ARCHIVE_LIMITS };
  }
  return result;
}
