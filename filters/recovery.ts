/**
 * Bounded, secret-safe archive for pre-transform tool output.
 * Retrieval supports exact paging plus bounded search modes.
 */
import { createHash, randomBytes } from "node:crypto";
import {
  chmodSync,
  closeSync,
  lstatSync,
  mkdirSync,
  openSync,
  opendirSync,
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

/** Legacy and rolling archive reference shapes. Legacy references remain
 *  readable but are never assigned to new entries. */
export const LEGACY_ARCHIVE_ID_PATTERN = /^cm-[0-9a-f]{16}$/;
export const ROLLING_ARCHIVE_ID_PATTERN = /^cm2-[0-9a-f]{64}$/;
export const ARCHIVE_ID_PATTERN = /^(?:cm-[0-9a-f]{16}|cm2-[0-9a-f]{64})$/;

/** Stable legacy archive id. Kept only for v1 compatibility and tests. */
export function deriveArchiveId(sessionKey: string, toolCallId: string): string {
  const digest = createHash("sha256")
    .update("condensed-milk-archive-v1\0")
    .update(sessionKey)
    .update("\0")
    .update(toolCallId)
    .digest("hex");
  return `cm-${digest.slice(0, 16)}`;
}

function sha256(input: string | Buffer): string {
  return createHash("sha256").update(input).digest("hex");
}

/** A rolling id binds one admission to its session generation, tool
 *  identity, normalized content, and persisted sequence. Changed content
 *  or a later sequence therefore cannot repoint an old reference. */
function deriveRollingArchiveId(
  sessionKey: string,
  generation: string,
  toolDigest: string,
  contentDigest: string,
  sequence: number,
): string {
  const digest = createHash("sha256")
    .update("condensed-milk-archive-v2\0")
    .update(sessionKey)
    .update("\0")
    .update(generation)
    .update("\0")
    .update(toolDigest)
    .update("\0")
    .update(contentDigest)
    .update("\0")
    .update(String(sequence))
    .digest("hex");
  return `cm2-${digest}`;
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
  statSync(path: string): { size: number; mtimeMs: number; ctimeMs: number; isDirectory?: () => boolean };
  lstatSync(path: string): { size: number; mtimeMs: number; ctimeMs: number; isDirectory?: () => boolean };
  readdirSync(path: string): string[];
  utimesSync(path: string, atime: number, mtime: number): void;
  rmSync(path: string, options: { recursive: boolean; force: boolean }): void;
  openSync(path: string, flags: "wx", mode?: number): number;
  opendirSync(path: string): { readSync(): { name: string } | null; closeSync(): void };
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
    lstatSync: (path) => lstatSync(path),
    readdirSync: (path) => readdirSync(path),
    utimesSync: (path, atime, mtime) => utimesSync(path, atime, mtime),
    rmSync: (path, options) => rmSync(path, options),
    openSync: (path, flags, mode) => openSync(path, flags, mode),
    opendirSync: (path) => opendirSync(path),
    closeSync: (fd) => closeSync(fd),
    realpathSync: (path) => realpathSync(path),
    rmdirSync: (path) => rmdirSync(path),
  };
}

/** Read at most `limit` names without materializing an unbounded root
 *  listing. An oversized or uncertain directory fails open. */
function readDirectoryBounded(
  fs: ArchiveFilesystem,
  path: string,
  limit: number,
): string[] | null {
  let directory: ReturnType<ArchiveFilesystem["opendirSync"]>;
  try {
    directory = fs.opendirSync(path);
  } catch {
    return null;
  }
  const names: string[] = [];
  let valid = true;
  try {
    for (let index = 0; index <= limit; index++) {
      const entry = directory.readSync();
      if (entry === null) break;
      if (index === limit) {
        valid = false;
        break;
      }
      names.push(entry.name);
    }
  } catch {
    valid = false;
  }
  try {
    directory.closeSync();
  } catch {
    valid = false;
  }
  return valid ? names : null;
}

/** Counting wrapper: one tick per filesystem or directory-handle call. */
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
      const value = (base[key] as (...a: unknown[]) => unknown)(...args);
      if (key !== "opendirSync") return value;
      const directory = value as ReturnType<ArchiveFilesystem["opendirSync"]>;
      return {
        readSync() {
          counts.directoryReadSync = (counts.directoryReadSync ?? 0) + 1;
          return directory.readSync();
        },
        closeSync() {
          counts.directoryCloseSync = (counts.directoryCloseSync ?? 0) + 1;
          directory.closeSync();
        },
      };
    };
  }
  counts.directoryReadSync = 0;
  counts.directoryCloseSync = 0;
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
  maxEntryBytes: 2_097_152,
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

function canonicalRollingArchiveText(id: string, createdAtMs: number, blocks: unknown[]): string {
  return JSON.stringify({ v: 2, id, createdAt: createdAtMs, blocks });
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

export type ArchiveCandidateKind = "semantic" | "historical";

interface LegacyIndexEntry {
  bytes: number;
  createdAt: number;
}

interface RollingIndexEntry extends LegacyIndexEntry {
  format: 2;
  sha256: string;
  contentDigest: string;
  toolDigest: string;
  sequence: number;
  kind: ArchiveCandidateKind;
}

type IndexEntry = LegacyIndexEntry | RollingIndexEntry;

interface StoreIndex {
  v: 2;
  generation: string;
  nextSequence: number;
  entries: Record<string, IndexEntry>;
  /** Bounded removal records. Correctness does not depend on retaining an
   *  old record because rolling ids are never reused. */
  evicted: Array<string | { id: string; reason: "expired" | "evicted" }>;
}

interface LegacyStoreIndex {
  v: 1;
  entries: Record<string, LegacyIndexEntry>;
  evicted: Array<string | { id: string; reason: "expired" | "evicted" }>;
  admissionClosed?: boolean;
}

/** Short synchronous sleep used only for bounded lock retries. */
function sleepSync(ms: number): void {
  const cell = new Int32Array(new SharedArrayBuffer(4));
  Atomics.wait(cell, 0, 0, ms);
}

function newArchiveGeneration(): string {
  return randomBytes(16).toString("hex");
}

function emptyIndex(_sessionKey: string): StoreIndex {
  return {
    v: 2,
    generation: newArchiveGeneration(),
    nextSequence: 1,
    entries: {},
    evicted: [],
  };
}

/** Bounded tombstone list for distinct evicted/expired errors. */
const MAX_TOMBSTONES = 512;
const MAX_BATCH_CANDIDATES = 10_000;
const MAX_DIRECTORY_ENTRIES = 8_192;
const MAX_INDEX_BYTES = 2_097_152;
const MAX_CANDIDATE_NODES = 10_000;
const MAX_CANDIDATE_DEPTH = 64;

/** Direct session directory names below the recovery root. */
const SESSION_NAME_PATTERN = /^[A-Za-z0-9._-]{1,128}$/;

/** Hard cap on direct session directories below the recovery root.
 *  Exceeding it fails new archive admission open; existing session
 *  directories are never removed to make room. */
export const MAX_ROOT_SESSIONS = 512;

/** Fixed allowance for root state and one lock per bounded session. */
const MAX_ROOT_CONTROL_ENTRIES = MAX_ROOT_SESSIONS + 16;

/** Root scan ceiling. The direct-session cap remains separately enforced. */
export const MAX_ROOT_SCAN_ENTRIES = MAX_ROOT_SESSIONS + MAX_ROOT_CONTROL_ENTRIES;

/** Session directories selected by one stale sweep. */
export const MAX_SWEEP_BATCH_SESSIONS = 128;

/** Session children examined by each preliminary and locked retirement check. */
const MAX_SWEEP_SESSION_ENTRIES = 2_048;

/** Conservative fixed call ceiling implied by all sweep loop bounds. */
export const MAX_SWEEP_FILESYSTEM_OPERATIONS = 1_400_000;

/** Constant-size sweep state bound: a v1 envelope plus one name. */
const MAX_SWEEP_STATE_BYTES = 256;

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
  /** Metadata-aware verification records. A metadata change forces a
   *  fresh read and digest check. Bounded by the live entry count. */
  private readonly verifiedLive = new Map<string, {
    size: number;
    mtimeMs: number;
    ctimeMs: number;
    indexedDigest: string;
  }>();
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

  private rememberVerified(id: string, record: {
    size: number;
    mtimeMs: number;
    ctimeMs: number;
    indexedDigest: string;
  }): void {
    this.verifiedLive.delete(id);
    this.verifiedLive.set(id, record);
    while (this.verifiedLive.size > this.limits.maxEntries) {
      const oldest = this.verifiedLive.keys().next().value;
      if (typeof oldest !== "string") break;
      this.verifiedLive.delete(oldest);
    }
  }

  private isRootControlName(name: string): boolean {
    return name === ArchiveStore.ROOT_LOCK_FILE
      || name === ArchiveStore.ROOT_SWEEP_STATE_FILE
      || /^\.session-[0-9a-f]{64}\.batch\.lock$/.test(name);
  }

  private sessionPathIsDirect(): boolean {
    try {
      return this.isDirectSessionDirectory(this.sessionKey, this.fs.realpathSync(this.rootDir));
    } catch {
      return false;
    }
  }

  /** Ensure root and session directories exist with mode 0700. Every
   *  ensure runs under the root maintenance lock and enforces the direct
   *  session cap. Lock and release uncertainty emits no reference. */
  private ensureDir(): boolean {
    if (this.isRootControlName(this.sessionKey)) return false;
    if (this.dirEnsured) return this.sessionPathIsDirect();
    try {
      this.fs.mkdirSync(this.rootDir, { recursive: true, mode: 0o700 });
    } catch {
      return false;
    }
    const lock = this.acquireRootLock();
    if (lock === null) return false;
    let prepared = false;
    try {
      const resolvedRoot = this.fs.realpathSync(this.rootDir);
      if (this.rootWithinSessionCap(resolvedRoot)) {
        this.fs.mkdirSync(this.dir, { recursive: true, mode: 0o700 });
        if (!this.isDirectSessionDirectory(this.sessionKey, resolvedRoot)) throw new Error("unsafe session directory");
        if (process.platform !== "win32") this.fs.chmodSync(this.dir, 0o700);
        prepared = true;
      }
    } catch {
      prepared = false;
    }
    const released = this.releaseRootLock(lock);
    if (!prepared || !released) return false;
    this.dirEnsured = true;
    return true;
  }

  private isDirectSessionDirectory(name: string, resolvedRoot: string): boolean {
    const path = join(this.rootDir, name);
    const stat = this.fs.lstatSync(path);
    if (stat.isDirectory && !stat.isDirectory()) return false;
    return this.fs.realpathSync(path) === join(resolvedRoot, name);
  }

  /** Count resolved direct session directories in one bounded root scan.
   *  Symlinks never count and cannot become the current session path. */
  private rootWithinSessionCap(resolvedRoot: string): boolean {
    const names = readDirectoryBounded(this.fs, this.rootDir, MAX_ROOT_SCAN_ENTRIES);
    if (names === null) return false;
    let sessions = 0;
    let currentExists = false;
    for (const name of names) {
      if (this.isRootControlName(name)) continue;
      if (!SESSION_NAME_PATTERN.test(name)) continue;
      const isDirectDirectory = this.isDirectSessionDirectory(name, resolvedRoot);
      if (!isDirectDirectory) {
        if (name === this.sessionKey) return false;
        continue;
      }
      sessions += 1;
      if (name === this.sessionKey) currentExists = true;
      if (sessions > MAX_ROOT_SESSIONS) return false;
    }
    return currentExists ? sessions <= MAX_ROOT_SESSIONS : sessions < MAX_ROOT_SESSIONS;
  }

  private entryPath(id: string): string {
    return join(this.dir, `${id}.json`);
  }

  private indexPath(): string {
    return join(this.dir, "index.json");
  }

  private readIndex(): StoreIndex | null {
    const path = this.indexPath();
    let indexedSize: number;
    try {
      indexedSize = this.fs.statSync(path).size;
    } catch (error: any) {
      if (error?.code === "ENOENT") return emptyIndex(this.sessionKey);
      return null;
    }
    if (!Number.isSafeInteger(indexedSize) || indexedSize < 0 || indexedSize > MAX_INDEX_BYTES) return null;
    let raw: string;
    try {
      raw = this.fs.readFileSync(path, "utf8");
    } catch {
      return null;
    }
    if (Buffer.byteLength(raw, "utf8") !== indexedSize || indexedSize > MAX_INDEX_BYTES) return null;
    try {
      const parsed = JSON.parse(raw) as StoreIndex | LegacyStoreIndex;
      if (!isPlainObject(parsed) || !isPlainObject(parsed.entries) || !Array.isArray(parsed.evicted)) return null;
      if (parsed.v !== 1 && parsed.v !== 2) return null;
      if (parsed.v === 1 && parsed.admissionClosed !== undefined && typeof parsed.admissionClosed !== "boolean") return null;
      if (parsed.v === 2) {
        if (typeof parsed.generation !== "string" || !/^[0-9a-f]{32}$/.test(parsed.generation)) return null;
        if (!Number.isSafeInteger(parsed.nextSequence) || parsed.nextSequence < 1) return null;
      }

      const parsedEntries = Object.entries(parsed.entries);
      if (parsedEntries.length > ARCHIVE_LIMIT_CEILINGS.maxEntries) return null;
      if (parsed.evicted.length > MAX_TOMBSTONES) return null;
      for (const [id, entry] of parsedEntries) {
        if (!ARCHIVE_ID_PATTERN.test(id) || !isPlainObject(entry)) return null;
        if (!Number.isSafeInteger(entry.bytes) || entry.bytes < 0 || entry.bytes > ARCHIVE_LIMIT_CEILINGS.maxEntryBytes) return null;
        if (!Number.isFinite(entry.createdAt) || entry.createdAt < 0) return null;
        if ("format" in entry) {
          if (parsed.v !== 2 || entry.format !== 2 || !ROLLING_ARCHIVE_ID_PATTERN.test(id)) return null;
          if (typeof entry.sha256 !== "string" || !/^[0-9a-f]{64}$/.test(entry.sha256)) return null;
          if (typeof entry.contentDigest !== "string" || !/^[0-9a-f]{64}$/.test(entry.contentDigest)) return null;
          if (typeof entry.toolDigest !== "string" || !/^[0-9a-f]{64}$/.test(entry.toolDigest)) return null;
          if (typeof entry.sequence !== "number" || !Number.isSafeInteger(entry.sequence) || entry.sequence < 1) return null;
          if (entry.kind !== "semantic" && entry.kind !== "historical") return null;
        } else if (!LEGACY_ARCHIVE_ID_PATTERN.test(id)) {
          return null;
        }
      }
      for (const removed of parsed.evicted) {
        if (typeof removed === "string") {
          if (!ARCHIVE_ID_PATTERN.test(removed)) return null;
          continue;
        }
        if (!isPlainObject(removed) || typeof removed.id !== "string") return null;
        if (!ARCHIVE_ID_PATTERN.test(removed.id)) return null;
        if (removed.reason !== "expired" && removed.reason !== "evicted") return null;
      }
      if (parsed.v === 2) return parsed;
      return {
        v: 2,
        generation: newArchiveGeneration(),
        nextSequence: 1,
        entries: parsed.entries,
        evicted: parsed.evicted,
      };
    } catch {
      return null;
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
    seen.delete(id);
    this.tombstone(index, id, reason);
    seen.set(id, reason);
    return true;
  }

  private removeEntry(index: StoreIndex, id: string, reason: "expired" | "evicted" = "evicted"): boolean {
    delete index.entries[id];
    this.tombstone(index, id, reason);
    if (!this.writeIndex(index)) return false;
    this.verifiedLive.delete(id);
    try {
      this.fs.unlinkSync(this.entryPath(id));
    } catch (error: any) {
      if (error?.code !== "ENOENT") return false;
    }
    return true;
  }

  /** Reject oversized or pathologically nested candidate structures
   *  before normalization or JSON serialization can allocate without a
   *  fixed bound. */
  private candidateFitsPreflight(blocks: unknown[]): boolean {
    if (blocks.length > MAX_CANDIDATE_NODES) return false;
    let remainingBytes = this.limits.maxEntryBytes;
    // The synthetic root array does not consume one of the value slots.
    let visitedNodes = -1;
    const seen = new Set<object>();
    const pending: Array<{ value: unknown; depth: number }> = [{ value: blocks, depth: 0 }];
    while (pending.length > 0) {
      const current = pending.pop()!;
      visitedNodes += 1;
      if (visitedNodes > MAX_CANDIDATE_NODES) return false;
      if (typeof current.value === "string") {
        if (current.value.length > remainingBytes) return false;
        remainingBytes -= Buffer.byteLength(current.value, "utf8");
        if (remainingBytes < 0) return false;
        continue;
      }
      if (current.value === null || typeof current.value !== "object") {
        remainingBytes -= 16;
        if (remainingBytes < 0) return false;
        continue;
      }
      if (current.depth >= MAX_CANDIDATE_DEPTH || seen.has(current.value)) return false;
      seen.add(current.value);
      for (const key in current.value) {
        if (!Object.prototype.hasOwnProperty.call(current.value, key)) continue;
        if (key.length > remainingBytes) return false;
        remainingBytes -= Buffer.byteLength(key, "utf8") + 4;
        if (remainingBytes < 0) return false;
        pending.push({ value: (current.value as Record<string, unknown>)[key], depth: current.depth + 1 });
      }
    }
    return true;
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
    return this.prepareBatch([{ toolCallId, blocks, kind: "semantic" }])?.get(toolCallId) ?? null;
  }

  /** Two-phase batch archive API. It keeps the newest bounded candidate
   *  window, reads the index once, runs retention once, and commits at
   *  most one final index. Returned references are live after retention
   *  and digest verification. Any uncertainty returns null. Live entries
   *  avoid rewrites, while metadata changes force content revalidation. */
  prepareBatch(
    candidates: ReadonlyArray<{ toolCallId: string | undefined; blocks: unknown[]; kind?: ArchiveCandidateKind }>,
  ): Map<string, string> | null {
    const normalized: Array<{ toolCallId: string; blocks: unknown[]; kind: ArchiveCandidateKind }> = [];
    const seen = new Set<string>();
    const start = Math.max(0, candidates.length - MAX_BATCH_CANDIDATES);
    for (let candidateIndex = start; candidateIndex < candidates.length; candidateIndex++) {
      const candidate = candidates[candidateIndex];
      if (candidate === null || typeof candidate !== "object") continue;
      const toolCallId = candidate.toolCallId;
      if (typeof toolCallId !== "string" || toolCallId.length === 0) continue;
      if (!Array.isArray(candidate.blocks)) continue;
      if (seen.has(toolCallId)) continue;
      seen.add(toolCallId);
      normalized.push({ toolCallId, blocks: candidate.blocks, kind: candidate.kind ?? "historical" });
    }
    const references = new Map<string, string>();
    if (normalized.length === 0) return references; // no candidates: no IO at all
    if (!this.ensureDir()) return null;
    const lockFd = this.acquireLock();
    if (lockFd === null) return null; // lock unavailable: no references
    let refs: Map<string, string> | null = null;
    try {
      refs = this.sessionPathIsDirect() ? this.runBatch(normalized, references) : null;
    } catch {
      refs = null; // any unexpected failure fails open
    } finally {
      if (!this.releaseLock(lockFd)) refs = null; // uncertain final state
    }
    return refs;
  }

  /** Per-session lock suffix. Locks live directly below the trusted root. */
  private static readonly LOCK_FILE = "batch.lock";
  /** Root maintenance lock directory and sweep cursor control file. */
  private static readonly ROOT_LOCK_FILE = "root.lock";
  private static readonly ROOT_SWEEP_STATE_FILE = "sweep.state";
  private static readonly LOCK_ATTEMPTS = 5;
  private static readonly LOCK_RETRY_DELAY_MS = 5;
  private static readonly LOCK_STALE_MS = 300_000;

  private sessionLockName(): string {
    return `.session-${sha256(this.sessionKey)}.${ArchiveStore.LOCK_FILE}`;
  }

  private lockPath(): string {
    return join(this.rootDir, this.sessionLockName());
  }

  /** Acquire a root-contained session lock. Directory replacement cannot
   *  redirect lock creation outside the recovery root. */
  private acquireLock(): ArchiveLock | null {
    return this.acquireLockAt(this.rootDir, this.sessionLockName());
  }

  private acquireRootLock(): ArchiveLock | null {
    return this.acquireLockAt(this.rootDir, ArchiveStore.ROOT_LOCK_FILE);
  }

  private acquireLockAt(directory: string, lockFile: string): ArchiveLock | null {
    const lockfilePath = join(directory, lockFile);
    for (let attempt = 0; attempt < ArchiveStore.LOCK_ATTEMPTS; attempt++) {
      try {
        const release = lockSync(directory, {
          fs: this.fs,
          lockfilePath,
          realpath: false,
          retries: 0,
          stale: ArchiveStore.LOCK_STALE_MS,
          update: ArchiveStore.LOCK_STALE_MS / 2,
          onCompromised: () => {},
        });
        try {
          this.fs.chmodSync(lockfilePath, 0o700);
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

  /** A failed release leaves ownership uncertain. Do not remove a lock
   *  that another process might already own. */
  private releaseRootLock(lock: ArchiveLock): boolean {
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
    rawCandidates: ReadonlyArray<{ toolCallId: string; blocks: unknown[]; kind: ArchiveCandidateKind }>,
    references: Map<string, string>,
  ): Map<string, string> | null {
    const index = this.readIndex();
    if (!index) return null;
    const now = this.now();
    let dirty = false;

    // One bounded directory read drives retention presence checks AND the
    // later orphan pass, so no per-entry stat calls are needed.
    const listing = readDirectoryBounded(this.fs, this.dir, MAX_DIRECTORY_ENTRIES);
    if (listing === null) return null;
    const present = new Set(listing);

    // Integrity repair: find every index row whose entry file is missing.
    // Each row is tombstoned as evicted in memory and committed through
    // the same atomic index write used everywhere else. The pass then
    // returns null: no candidate file is written, nextSequence stays
    // unchanged, and no reference is emitted while storage is uncertain.
    // A failed commit leaves the old index bytes intact and also returns
    // null, so the next pass retries the repair before admitting. Rolling
    // ids are sequence-bound and monotonic, so a repaired id is never
    // reused by a later admission.
    const missingRows: string[] = [];
    for (const id of Object.keys(index.entries)) {
      if (!present.has(`${id}.json`)) missingRows.push(id);
    }
    if (missingRows.length > 0) {
      for (const id of missingRows) {
        delete index.entries[id];
        this.verifiedLive.delete(id);
        this.tombstone(index, id, "evicted");
      }
      this.writeIndex(index);
      return null;
    }

    // Clear bounded crash leftovers before identity collision checks. A
    // cleanup failure leaves storage uncertain and emits no references.
    for (const name of listing) {
      const entryMatch = /^((?:cm-[0-9a-f]{16}|cm2-[0-9a-f]{64}))\.json$/.exec(name);
      const entryTemporary = /^(?:cm-[0-9a-f]{16}|cm2-[0-9a-f]{64})\.json\..+\.tmp$/.test(name);
      const indexTemporary = /^index\.json\..+\.tmp$/.test(name);
      if (entryMatch && index.entries[entryMatch[1]] !== undefined) continue;
      if (!entryMatch && !entryTemporary && !indexTemporary) continue;
      try {
        this.fs.unlinkSync(join(this.dir, name));
        present.delete(name);
      } catch (error: any) {
        if (error?.code !== "ENOENT") return null;
      }
    }

    // Tombstone lookups in O(1): the evicted list is bounded but scanned
    // once per candidate otherwise.
    const tombstoned = new Map<string, "expired" | "evicted">();
    for (const entry of index.evicted) {
      if (typeof entry === "string") tombstoned.set(entry, "evicted");
      else tombstoned.set(entry.id, entry.reason);
    }

    // Retention over existing entries: rows whose file vanished were
    // repaired above, so this pass only applies the TTL. Existing files
    // are deleted only after the final index commits, so an index failure
    // preserves old state.
    const removalsToUnlink = new Set<string>();
    for (const id of Object.keys(index.entries)) {
      if (now - index.entries[id].createdAt >= this.limits.ttlMs) {
        removalsToUnlink.add(id);
        delete index.entries[id];
        this.verifiedLive.delete(id);
        if (this.tombstoneChanged(tombstoned, index, id, "expired")) dirty = true;
      }
    }

    // Resolve live reuse only after TTL removal, so an expired tool
    // result can receive a distinct sequence-bound id in this batch.
    // Every non-live candidate stays a temporary in-memory
    // representation: no persisted sequence, final id, entry file, index
    // row, or removal record exists before survivor selection.
    const liveByDigest = new Map<string, string>();
    for (const [id, row] of Object.entries(index.entries)) {
      if (!("format" in row)) continue;
      const key = `${row.toolDigest}\0${row.contentDigest}`;
      if (!liveByDigest.has(key)) liveByDigest.set(key, id);
    }

    interface TemporaryCandidate {
      key: string;
      toolCallId: string;
      blocks: unknown[];
      toolDigest: string;
      contentDigest: string;
      kind: ArchiveCandidateKind;
      /** Exact estimated canonical bytes: the placeholder id has the
       * fixed width of every final cm2 id, so the estimate equals the
       * final byte count. */
      estimatedBytes: number;
      /** Raw batch position. Descending position ranks the newest
       * context results first and keeps an identical complete batch
       * stable across passes. */
      position: number;
    }
    const candidates: Array<{
      toolCallId: string;
      liveId: string | null;
      temp: TemporaryCandidate | null;
    }> = [];
    const batchPositionByLiveId = new Map<string, number>();
    const placeholderId = `cm2-${"0".repeat(64)}`;
    for (let position = 0; position < rawCandidates.length; position++) {
      const raw = rawCandidates[position];
      if (!this.candidateFitsPreflight(raw.blocks)) continue;
      let blocks: unknown[];
      let contentText: string;
      try {
        blocks = this.normalizeBlocks(raw.blocks);
        contentText = JSON.stringify(blocks);
      } catch {
        continue;
      }
      const toolDigest = sha256(raw.toolCallId);
      const contentDigest = sha256(contentText);
      const liveId = liveByDigest.get(`${toolDigest}\0${contentDigest}`);
      if (liveId !== undefined) {
        const liveRow = index.entries[liveId] as RollingIndexEntry;
        if (raw.kind === "semantic" && liveRow.kind === "historical") {
          liveRow.kind = "semantic";
          dirty = true;
        }
        batchPositionByLiveId.set(liveId, position);
        candidates.push({ toolCallId: raw.toolCallId, liveId, temp: null });
        continue;
      }
      const estimatedBytes = Buffer.byteLength(
        canonicalRollingArchiveText(placeholderId, now, blocks),
        "utf8",
      );
      if (estimatedBytes > this.limits.maxEntryBytes) continue;
      candidates.push({
        toolCallId: raw.toolCallId,
        liveId: null,
        temp: {
          key: `pending\0${position}\0${raw.toolCallId}`,
          toolCallId: raw.toolCallId,
          blocks,
          toolDigest,
          contentDigest,
          kind: raw.kind,
          estimatedBytes,
          position,
        },
      });
    }

    // TTL runs first. Capacity then ranks the complete live and temporary
    // pool by recovery value: semantic before historical, then candidates
    // present in the current batch by descending raw position, so the
    // newest context results win and an identical complete batch stays
    // stable. Rows absent from the batch fall back to persisted sequence,
    // creation time, and id as later tie-breakers. This policy gives new
    // work a deterministic path into a full archive without allowing
    // historical masks to displace semantic recovery.
    const ranked: Array<{
      key: string;
      liveId: string | null;
      temp: TemporaryCandidate | null;
      bytes: number;
      kind: ArchiveCandidateKind;
      position: number;
      sequence: number;
      createdAt: number;
      tieBreak: string;
    }> = [];
    for (const [id, row] of Object.entries(index.entries)) {
      const position = batchPositionByLiveId.get(id);
      ranked.push({
        key: id,
        liveId: id,
        temp: null,
        bytes: row.bytes,
        kind: "format" in row ? row.kind : "semantic",
        position: position === undefined ? -1 : position,
        sequence: "format" in row ? row.sequence : 0,
        createdAt: row.createdAt,
        tieBreak: id,
      });
    }
    for (const candidate of candidates) {
      if (candidate.temp === null) continue;
      ranked.push({
        key: candidate.temp.key,
        liveId: null,
        temp: candidate.temp,
        bytes: candidate.temp.estimatedBytes,
        kind: candidate.temp.kind,
        position: candidate.temp.position,
        sequence: 0,
        createdAt: now,
        tieBreak: candidate.temp.key,
      });
    }
    ranked.sort((left, right) => {
      if (left.kind !== right.kind) return left.kind === "semantic" ? -1 : 1;
      if (left.position !== right.position) return right.position - left.position;
      if (left.sequence !== right.sequence) return right.sequence - left.sequence;
      if (left.createdAt !== right.createdAt) return right.createdAt - left.createdAt;
      return left.tieBreak < right.tieBreak ? -1 : left.tieBreak > right.tieBreak ? 1 : 0;
    });
    const survivorKeys = new Set<string>();
    let totalBytes = 0;
    for (const candidate of ranked) {
      if (candidate.bytes > this.limits.maxEntryBytes) continue;
      if (survivorKeys.size >= this.limits.maxEntries) continue;
      if (totalBytes + candidate.bytes > this.limits.maxAggregateBytes) continue;
      survivorKeys.add(candidate.key);
      totalBytes += candidate.bytes;
    }

    // Stage existing non-survivors for deletion after the index commits.
    for (const candidate of ranked) {
      if (candidate.liveId === null) continue;
      if (survivorKeys.has(candidate.key)) continue;
      removalsToUnlink.add(candidate.liveId);
      delete index.entries[candidate.liveId];
      this.verifiedLive.delete(candidate.liveId);
      dirty = true;
      if (this.tombstoneChanged(tombstoned, index, candidate.liveId, "evicted")) dirty = true;
    }

    // Allocate nextSequence and derive final cm2 ids only for selected
    // non-live candidates, in deterministic survivor order. Rejected
    // candidates stay visible and consume no sequence, tombstone, write,
    // or index commit.
    const pending: Array<{ id: string; canonical: string; bytes: number; row: RollingIndexEntry }> = [];
    const idByTempKey = new Map<string, string>();
    let nextSequence = index.nextSequence;
    for (const candidate of ranked) {
      if (candidate.temp === null || !survivorKeys.has(candidate.key)) continue;
      if (!Number.isSafeInteger(nextSequence) || nextSequence < 1 || nextSequence >= Number.MAX_SAFE_INTEGER) return null;
      const sequence = nextSequence++;
      const id = deriveRollingArchiveId(
        this.sessionKey,
        index.generation,
        candidate.temp.toolDigest,
        candidate.temp.contentDigest,
        sequence,
      );
      idByTempKey.set(candidate.key, id);
      const canonical = canonicalRollingArchiveText(id, now, candidate.temp.blocks);
      const bytes = Buffer.byteLength(canonical, "utf8");
      pending.push({
        id,
        canonical,
        bytes,
        row: {
          format: 2,
          bytes,
          createdAt: now,
          sha256: sha256(canonical),
          contentDigest: candidate.temp.contentDigest,
          toolDigest: candidate.temp.toolDigest,
          sequence,
          kind: candidate.temp.kind,
        },
      });
    }
    if (nextSequence !== index.nextSequence) {
      index.nextSequence = nextSequence;
      dirty = true;
    }

    // Write only the selected survivors. Track every final file so a
    // pre-commit failure can restore the prior on-disk live set.
    const newFilesWritten: string[] = [];
    const rollbackNewFiles = (): void => {
      for (const id of newFilesWritten) {
        this.verifiedLive.delete(id);
        try { this.fs.unlinkSync(this.entryPath(id)); } catch { /* best effort */ }
      }
    };
    for (const entry of pending) {
      const path = this.entryPath(entry.id);
      if (present.has(`${entry.id}.json`)) {
        rollbackNewFiles();
        return null;
      }
      const tmp = this.uniqueTemp(path);
      try {
        this.fs.writeFileSync(tmp, entry.canonical, { mode: 0o600 });
        this.fs.renameSync(tmp, path);
        newFilesWritten.push(entry.id);
        if (this.fs.readFileSync(path, "utf8") !== entry.canonical) {
          rollbackNewFiles();
          return null;
        }
        const metadata = this.fs.statSync(path);
        if (metadata.size !== entry.bytes || ![metadata.mtimeMs, metadata.ctimeMs].every(Number.isFinite)) {
          rollbackNewFiles();
          return null;
        }
        this.rememberVerified(entry.id, {
          size: metadata.size,
          mtimeMs: metadata.mtimeMs,
          ctimeMs: metadata.ctimeMs,
          indexedDigest: entry.row.sha256,
        });
      } catch {
        try { this.fs.unlinkSync(tmp); } catch { /* best effort */ }
        rollbackNewFiles();
        return null;
      }
      index.entries[entry.id] = entry.row;
      dirty = true;
    }

    if (dirty && !this.writeIndex(index)) {
      rollbackNewFiles();
      return null;
    }

    // The index now names the final set. Delete old files before returning
    // references. Cleanup uncertainty emits no placeholders.
    for (const id of removalsToUnlink) {
      try {
        this.fs.unlinkSync(this.entryPath(id));
      } catch (error: any) {
        if (error?.code !== "ENOENT") return null;
      }
      this.verifiedLive.delete(id);
    }

    // Orphan pass reuses the single directory listing taken before any
    // write: entry files and stale temporary files absent from the final
    // index are removed (best effort; the index stays authoritative).
    for (const name of listing) {
      const entryMatch = /^((?:cm-[0-9a-f]{16}|cm2-[0-9a-f]{64}))\.json$/.exec(name);
      const tmpMatch = /^((?:cm-[0-9a-f]{16}|cm2-[0-9a-f]{64}))\.json\..+\.tmp$/.exec(name);
      const target = entryMatch?.[1] ?? tmpMatch?.[1];
      const staleIndexTemporary = /^index\.json\..+\.tmp$/.test(name);
      if (!staleIndexTemporary && (target === undefined || index.entries[target] !== undefined)) continue;
      try {
        this.fs.unlinkSync(join(this.dir, name));
      } catch (error: any) {
        if (error?.code !== "ENOENT") return null;
      }
    }

    // Emit references only for final live candidates that pass
    // metadata-aware content verification. Any uncertainty fails open.
    for (const candidate of candidates) {
      const id = candidate.liveId
        ?? (candidate.temp !== null ? idByTempKey.get(candidate.temp.key) : undefined);
      if (id === undefined || index.entries[id] === undefined) continue;
      if (!this.verifyLiveEntry(id, index.entries[id])) return null;
      references.set(candidate.toolCallId, id);
    }
    return references;
  }

  /** Validate one live file against its row and a bounded metadata cache. */
  private verifyLiveEntry(id: string, row: IndexEntry): boolean {
    const path = this.entryPath(id);
    const indexedDigest = "format" in row ? row.sha256 : `legacy:${row.bytes}:${row.createdAt}`;
    let before: { size: number; mtimeMs: number; ctimeMs: number };
    try {
      before = this.fs.statSync(path);
    } catch {
      return false;
    }
    if (![before.size, before.mtimeMs, before.ctimeMs].every(Number.isFinite)) return false;
    if (before.size !== row.bytes || row.bytes > ARCHIVE_LIMIT_CEILINGS.maxEntryBytes) return false;
    const cached = this.verifiedLive.get(id);
    if (cached
      && cached.size === before.size
      && cached.mtimeMs === before.mtimeMs
      && cached.ctimeMs === before.ctimeMs
      && cached.indexedDigest === indexedDigest) {
      return true;
    }

    let raw: string;
    try {
      raw = this.fs.readFileSync(path, "utf8");
    } catch {
      return false;
    }
    let after: { size: number; mtimeMs: number; ctimeMs: number };
    try {
      after = this.fs.statSync(path);
    } catch {
      return false;
    }
    if (before.size !== after.size || before.mtimeMs !== after.mtimeMs || before.ctimeMs !== after.ctimeMs) return false;
    let parsed: any;
    try {
      parsed = JSON.parse(raw);
    } catch {
      return false;
    }
    if (!isPlainObject(parsed) || parsed.id !== id || !Array.isArray(parsed.blocks)) return false;
    if (typeof parsed.createdAt !== "number" || parsed.createdAt !== row.createdAt) return false;
    if (Buffer.byteLength(raw, "utf8") !== row.bytes || after.size !== row.bytes) return false;
    if ("format" in row) {
      if (row.format !== 2 || parsed.v !== 2 || sha256(raw) !== row.sha256) return false;
    } else if (parsed.v !== 1) {
      return false;
    }
    this.rememberVerified(id, { ...after, indexedDigest });
    return true;
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
      outcome = this.sessionPathIsDirect() ? this.loadEntry(id) : { kind: "unavailable" };
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
    const row = index.entries[id];
    try {
      const metadata = this.fs.statSync(path);
      if (!Number.isFinite(metadata.size) || row.bytes > ARCHIVE_LIMIT_CEILINGS.maxEntryBytes) {
        return { kind: "unavailable" };
      }
      if (metadata.size !== row.bytes) {
        return this.removeEntry(index, id, "evicted")
          ? { kind: "missing" }
          : { kind: "unavailable" };
      }
    } catch (error: any) {
      if (error?.code === "ENOENT") {
        return this.removeEntry(index, id, "evicted")
          ? { kind: "evicted" }
          : { kind: "unavailable" };
      }
      return { kind: "unavailable" };
    }
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
    const validVersion = "format" in row ? parsed?.v === 2 : parsed?.v === 1;
    const validDigest = !("format" in row) || sha256(raw) === row.sha256;
    if (!validVersion || !validDigest || parsed?.id !== id || !Array.isArray(parsed?.blocks) || typeof parsed?.createdAt !== "number" || parsed.createdAt !== row.createdAt || Buffer.byteLength(raw, "utf8") !== row.bytes) {
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
      if (this.sessionPathIsDirect()) this.cleanupUnderLock();
    } finally {
      this.releaseLock(lockFd);
    }
  }

  /** Run maintenance while the caller owns the session lock. */
  private cleanupUnderLock(): boolean {
    const index = this.readIndex();
    if (!index) return false;
    const now = this.now();
    let dirty = false;
    const removals = new Map<string, "expired" | "evicted">();

    for (const id of Object.keys(index.entries)) {
      try {
        this.fs.statSync(this.entryPath(id));
      } catch (error: any) {
        if (error?.code !== "ENOENT") return false;
        delete index.entries[id];
        this.verifiedLive.delete(id);
        this.tombstone(index, id, "evicted");
        dirty = true;
      }
    }

    for (const id of Object.keys(index.entries)) {
      if (now - index.entries[id].createdAt < this.limits.ttlMs) continue;
      delete index.entries[id];
      this.verifiedLive.delete(id);
      this.tombstone(index, id, "expired");
      removals.set(id, "expired");
      dirty = true;
    }

    const candidates: Array<{
      id: string;
      row: IndexEntry;
      accessedAt: number;
      kind: ArchiveCandidateKind;
      sequence: number;
    }> = [];
    for (const [id, row] of Object.entries(index.entries)) {
      let accessedAt: number;
      try {
        accessedAt = Math.round(this.fs.statSync(this.entryPath(id)).mtimeMs);
      } catch {
        return false;
      }
      candidates.push({
        id,
        row,
        accessedAt,
        kind: "format" in row ? row.kind : "semantic",
        sequence: "format" in row ? row.sequence : 0,
      });
    }
    candidates.sort((left, right) => {
      if (left.kind !== right.kind) return left.kind === "semantic" ? -1 : 1;
      if (left.sequence !== right.sequence) return right.sequence - left.sequence;
      if (left.accessedAt !== right.accessedAt) return right.accessedAt - left.accessedAt;
      if (left.row.createdAt !== right.row.createdAt) return right.row.createdAt - left.row.createdAt;
      return left.id.localeCompare(right.id);
    });
    const survivors = new Set<string>();
    let totalBytes = 0;
    for (const candidate of candidates) {
      if (candidate.row.bytes > this.limits.maxEntryBytes) continue;
      if (survivors.size >= this.limits.maxEntries) continue;
      if (totalBytes + candidate.row.bytes > this.limits.maxAggregateBytes) continue;
      survivors.add(candidate.id);
      totalBytes += candidate.row.bytes;
    }
    for (const candidate of candidates) {
      if (survivors.has(candidate.id)) continue;
      delete index.entries[candidate.id];
      this.verifiedLive.delete(candidate.id);
      this.tombstone(index, candidate.id, "evicted");
      removals.set(candidate.id, "evicted");
      dirty = true;
    }

    if (dirty && !this.writeIndex(index)) return false;
    for (const id of removals.keys()) {
      try {
        this.fs.unlinkSync(this.entryPath(id));
      } catch (error: any) {
        if (error?.code !== "ENOENT") return false;
      }
    }

    const names = readDirectoryBounded(this.fs, this.dir, MAX_DIRECTORY_ENTRIES);
    if (names === null) return false;
    for (const name of names) {
      const match = /^((?:cm-[0-9a-f]{16}|cm2-[0-9a-f]{64}))\.json$/.exec(name);
      const staleIndexTemporary = /^index\.json\..+\.tmp$/.test(name);
      if (!staleIndexTemporary && (!match || index.entries[match[1]] !== undefined)) continue;
      try {
        this.fs.unlinkSync(join(this.dir, name));
      } catch (error: any) {
        if (error?.code !== "ENOENT") return false;
      }
    }
    return true;
  }

  /** Retirement maintenance path: the target directory was already
   *  observed by the sweep's bounded root scan, so plain existence plus
   *  permissions is enough. Root-cap admission checks do not gate
   *  retirement, and retirement must not re-scan the root per target. */
  private ensureRetirementDir(): boolean {
    try {
      const resolvedRoot = this.fs.realpathSync(this.rootDir);
      if (!this.isDirectSessionDirectory(this.sessionKey, resolvedRoot)) return false;
      if (process.platform !== "win32") this.fs.chmodSync(this.dir, 0o700);
      return true;
    } catch {
      return false;
    }
  }

  /** Retire all live entries after a session becomes inactive. The
   *  final decision happens under this session's batch lock because a
   *  preliminary unlocked freshness check may have raced with concurrent
   *  activity: the child listing, child stats, index validation, indexed
   *  entry presence, and newest mtime are all re-read while the lock is
   *  held, and any uncertainty or renewed freshness skips retirement.
   *  When still stale, the index commits tombstones before entry cleanup,
   *  so leftover orphan files cannot revive references and old references
   *  keep their exact evicted retrieval outcome. */
  private retireInactiveSession(): void {
    if (!this.ensureRetirementDir()) return;
    const lockFd = this.acquireLock();
    if (lockFd === null) return;
    try {
      const resolvedRoot = this.fs.realpathSync(this.rootDir);
      if (!this.isDirectSessionDirectory(this.sessionKey, resolvedRoot)) return;
      // Bounded child listing under the lock.
      const children = readDirectoryBounded(this.fs, this.dir, MAX_SWEEP_SESSION_ENTRIES);
      if (children === null) return;
      // Stat every relevant child except the lock itself.
      let newest = -Infinity;
      let sawChild = false;
      for (const child of children) {
        if (child === ArchiveStore.LOCK_FILE) continue;
        let childStat: { mtimeMs: number };
        try {
          childStat = this.fs.statSync(join(this.dir, child));
        } catch {
          return; // uncertain stat: skip retirement
        }
        sawChild = true;
        if (childStat.mtimeMs > newest) newest = childStat.mtimeMs;
      }
      // Read and validate the index under the lock.
      const index = this.readIndex();
      if (!index) return;
      // Confirm every indexed entry file is still present.
      const childNames = new Set(children);
      for (const id of Object.keys(index.entries)) {
        if (!childNames.has(`${id}.json`)) return; // uncertain presence: skip
      }
      // Recompute the newest mtime, falling back to the directory itself
      // when no relevant children exist.
      if (!sawChild) {
        try {
          newest = this.fs.statSync(this.dir).mtimeMs;
        } catch {
          return;
        }
      }
      const now = this.now();
      if (now - newest < this.limits.ttlMs) return; // became fresh: skip
      // Still stale: tombstone all rows, commit, then delete entry files.
      for (const id of Object.keys(index.entries)) {
        delete index.entries[id];
        this.verifiedLive.delete(id);
        this.tombstone(index, id, "evicted");
      }
      if (!this.writeIndex(index)) return;
      for (const child of children) {
        if (!/^(?:cm-[0-9a-f]{16}|cm2-[0-9a-f]{64})\.json$/.test(child) && !/^index\.json\..+\.tmp$/.test(child)) continue;
        try {
          this.fs.unlinkSync(join(this.dir, child));
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

  /** Read the persisted lexical sweep cursor. An empty string is the
   *  initial cursor; a present-but-invalid state file is uncertainty and
   *  fails the sweep open. */
  private readSweepCursor(): string | null {
    const path = join(this.rootDir, ArchiveStore.ROOT_SWEEP_STATE_FILE);
    let size: number;
    try {
      size = this.fs.statSync(path).size;
    } catch (error: any) {
      if (error?.code === "ENOENT") return "";
      return null;
    }
    if (!Number.isSafeInteger(size) || size < 0 || size > MAX_SWEEP_STATE_BYTES) return null;
    let raw: string;
    try {
      raw = this.fs.readFileSync(path, "utf8");
    } catch {
      return null;
    }
    if (Buffer.byteLength(raw, "utf8") !== size) return null;
    try {
      const parsed = JSON.parse(raw);
      if (!isPlainObject(parsed) || parsed.v !== 1 || typeof parsed.cursor !== "string") return null;
      if (parsed.cursor !== "" && !SESSION_NAME_PATTERN.test(parsed.cursor)) return null;
      return parsed.cursor;
    } catch {
      return null;
    }
  }

  /** Atomically persist the sweep cursor. Constant size: one versioned
   *  envelope plus one session name. */
  private writeSweepCursor(cursor: string): boolean {
    const path = join(this.rootDir, ArchiveStore.ROOT_SWEEP_STATE_FILE);
    const tmp = this.uniqueTemp(path);
    try {
      this.fs.writeFileSync(tmp, JSON.stringify({ v: 1, cursor }), { mode: 0o600 });
      this.fs.renameSync(tmp, path);
      return true;
    } catch {
      try { this.fs.unlinkSync(tmp); } catch { /* best effort */ }
      return false;
    }
  }

  /** Sweep stale session directories through each target store's strict,
   *  locked retirement path. One bounded pass under the root maintenance
   *  lock scans the root, sorts valid session names, selects at most
   *  MAX_SWEEP_BATCH_SESSIONS names strictly after the persisted lexical
   *  cursor (wrapping around), and commits the last selected name as the
   *  new cursor. Retirement then runs outside the root lock, so repeated
   *  calls make progress with fixed work regardless of root size.
   *  Malformed indexes and any uncertain root state, lock, scan, or
   *  cursor commit fail open by skipping retirement. */
  sweepStaleSessions(): void {
    const rootLock = this.acquireRootLock();
    if (rootLock === null) return;
    let selected: string[] = [];
    let released = false;
    try {
      const names = readDirectoryBounded(this.fs, this.rootDir, MAX_ROOT_SCAN_ENTRIES);
      if (names === null) return;
      const cursor = this.readSweepCursor();
      if (cursor === null) return;
      const resolvedRoot = this.fs.realpathSync(this.rootDir);
      const sessions: string[] = [];
      for (const name of names) {
        if (!SESSION_NAME_PATTERN.test(name) || this.isRootControlName(name) || name === this.sessionKey) continue;
        try {
          if (this.isDirectSessionDirectory(name, resolvedRoot)) sessions.push(name);
        } catch {
          // An uncertain or non-directory root entry is not a retirement target.
        }
      }
      sessions.sort();
      if (sessions.length === 0) return;
      // Wraparound selection is disjoint from the strictly-after segment
      // and includes the cursor name itself, so with stable names every
      // call selects each name at most once and no name starves between
      // rounds.
      const after = sessions.filter((name) => name > cursor);
      const wrapped = sessions.filter((name) => name <= cursor);
      selected = [...after, ...wrapped].filter((_, index) => index < MAX_SWEEP_BATCH_SESSIONS);
      if (selected.length === 0) return;
      if (!this.writeSweepCursor(selected[selected.length - 1])) return;
    } finally {
      released = this.releaseRootLock(rootLock);
    }
    if (!released) return; // uncertain root state: skip retirement
    this.retireSelectedSessions(selected);
  }

  /** Preliminary unlocked freshness screening for sweep-selected names.
   *  The final decision always happens under each target's session lock. */
  private retireSelectedSessions(selected: string[]): void {
    const now = this.now();
    let resolvedRoot: string;
    try {
      resolvedRoot = this.fs.realpathSync(this.rootDir);
    } catch {
      return;
    }
    for (const name of selected) {
      const directory = join(this.rootDir, name);
      try {
        if (!this.isDirectSessionDirectory(name, resolvedRoot)) continue;
        const directoryStat = this.fs.statSync(directory);
        let newest = -Infinity;
        let sawChild = false;
        const children = readDirectoryBounded(this.fs, directory, MAX_SWEEP_SESSION_ENTRIES);
        if (children === null) continue;
        for (const child of children) {
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
