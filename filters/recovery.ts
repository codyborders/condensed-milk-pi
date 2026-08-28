/**
 * Bounded, secret-safe archive for pre-transform tool output.
 * Retrieval supports exact paging plus bounded search modes.
 */
import { createHash } from "node:crypto";
import {
  chmodSync,
  mkdirSync,
  readFileSync,
  readdirSync,
  renameSync,
  rmSync,
  statSync,
  unlinkSync,
  utimesSync,
  writeFileSync,
} from "node:fs";
import { join } from "node:path";
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
    next: end < totalBytes || (end === totalBytes && requested < totalBytes) ? end : null,
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
  private readonly dir: string;
  private dirEnsured = false;

  constructor(rootDir: string, sessionKey: string, limits: ArchiveLimits, now: () => number = () => Date.now()) {
    this.rootDir = rootDir;
    this.sessionKey = sanitizeSessionKey(sessionKey);
    this.limits = limits;
    this.now = now;
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
      mkdirSync(this.dir, { recursive: true, mode: 0o700 });
      if (process.platform !== "win32") {
        chmodSync(this.dir, 0o700);
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
      raw = readFileSync(this.indexPath(), "utf8");
    } catch (e: any) {
      if (e?.code === "ENOENT") return emptyIndex();
      return null; // unreadable index: storage is unavailable, not empty
    }
    try {
      const parsed = JSON.parse(raw) as StoreIndex;
      if (parsed?.v !== 1 || typeof parsed.entries !== "object" || parsed.entries === null || !Array.isArray(parsed.evicted)) {
        return emptyIndex(); // wrong shape: rebuild rather than fail
      }
      return parsed;
    } catch {
      return emptyIndex(); // corrupted index: rebuild from live writes
    }
  }

  private writeIndex(index: StoreIndex): boolean {
    try {
      const path = this.indexPath();
      const tmp = `${path}.tmp`;
      writeFileSync(tmp, JSON.stringify(index), { mode: 0o600 });
      renameSync(tmp, path);
      return true;
    } catch {
      return false;
    }
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

  private removeEntry(index: StoreIndex, id: string, reason: "expired" | "evicted" = "evicted"): void {
    try {
      unlinkSync(this.entryPath(id));
    } catch { /* already gone */ }
    delete index.entries[id];
    this.tombstone(index, id, reason);
    this.writeIndex(index);
  }

  /** Normalize blocks for storage: text blocks are ANSI-stripped and pass
   *  mandatory line-preserving redaction. Non-text blocks are unchanged. */
  private normalizeBlocks(blocks: unknown[]): unknown[] {
    return blocks.map((block) => {
      if (isPlainObject(block) && block.type === "text" && typeof block.text === "string") {
        const stripped = stripAnsi(block.text);
        const redacted = redactPrivacyLines(stripped);
        return { type: "text", text: redacted ?? stripped };
      }
      return block;
    });
  }

  /** Archive one tool result. Returns the stable id, or null on any
   *  failure (oversize, unwritable, verification mismatch) so callers can
   *  fail open. Re-archiving the same tool call reuses the existing entry
   *  without rewriting it. */
  store(toolCallId: string | undefined, blocks: unknown[]): string | null {
    if (typeof toolCallId !== "string" || toolCallId.length === 0) return null;
    if (!Array.isArray(blocks)) return null;
    if (!this.ensureDir()) return null;

    const id = deriveArchiveId(this.sessionKey, toolCallId);

    // Reuse: a live, valid entry is never rewritten.
    const existing = this.loadEntry(id);
    if (existing.kind === "ok") return id;

    let canonical: string;
    try {
      canonical = canonicalArchiveText(id, this.now(), this.normalizeBlocks(blocks));
    } catch {
      return null; // unserializable blocks (cyclic, bigint) never archive
    }
    if (Buffer.byteLength(canonical, "utf8") > this.limits.maxEntryBytes) {
      return null; // oversize: refuse rather than store an unrecoverable cut
    }

    const path = this.entryPath(id);
    const tmp = `${path}.tmp`;
    try {
      writeFileSync(tmp, canonical, { mode: 0o600 });
      renameSync(tmp, path);
      const verify = readFileSync(path, "utf8");
      if (verify !== canonical) {
        try { unlinkSync(path); } catch { /* best effort */ }
        return null;
      }
    } catch {
      try { unlinkSync(tmp); } catch { /* best effort */ }
      return null;
    }

    const index = this.readIndex();
    if (!index) return null;
    index.entries[id] = { bytes: Buffer.byteLength(canonical, "utf8"), createdAt: this.now() };
    if (!this.writeIndex(index)) {
      try { unlinkSync(path); } catch { /* best effort */ }
      return null;
    }

    // Retention runs after every successful write, then the new entry is
    // verified to still be retrievable. If retention removed it (for
    // example an aggregate cap smaller than one entry), the store reports
    // failure so callers fail open instead of holding a dead reference.
    this.cleanup();
    if (this.loadEntry(id).kind !== "ok") {
      const index = this.readIndex();
      if (index) this.removeEntry(index, id, "evicted");
      return null;
    }
    return id;
  }

  /** Load one entry for retrieval. Distinguishes evicted (tombstoned),
   *  missing (unknown id), and unavailable (storage cannot be used). */
  retrieve(id: string): RetrieveOutcome {
    if (!ARCHIVE_ID_PATTERN.test(id)) return { kind: "missing" };
    if (!this.ensureDir()) return { kind: "unavailable" };
    return this.loadEntry(id);
  }

  private loadEntry(id: string): RetrieveOutcome {
    const index = this.readIndex();
    if (!index) return { kind: "unavailable" };
    const path = this.entryPath(id);
    let raw: string;
    try {
      raw = readFileSync(path, "utf8");
    } catch (e: any) {
      if (e?.code === "ENOENT") {
        const reason = this.tombstoneReason(index, id);
        if (reason === "expired") return { kind: "expired" };
        if (reason === "evicted") return { kind: "evicted" };
        return { kind: "missing" };
      }
      return { kind: "unavailable" };
    }
    let parsed: any;
    try {
      parsed = JSON.parse(raw);
    } catch {
      // Corrupted entry: drop it from the index so the index never lists
      // an entry without valid bytes, then report missing.
      this.removeEntry(index, id, "evicted");
      return { kind: "missing" };
    }
    if (parsed?.id !== id || !Array.isArray(parsed?.blocks) || typeof parsed?.createdAt !== "number") {
      this.removeEntry(index, id, "evicted");
      return { kind: "missing" };
    }
    const now = this.now();
    if (now - parsed.createdAt >= this.limits.ttlMs) {
      this.removeEntry(index, id, "expired");
      return { kind: "expired" };
    }
    // LRU access refresh (best effort). Retrieval also refreshes the
    // session index mtime so active sessions are never swept as stale.
    try {
      const at = now / 1000;
      utimesSync(path, at, at);
      utimesSync(this.indexPath(), at, at);
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
    const index = this.readIndex();
    if (!index) return;
    const now = this.now();

    // Drop index rows whose backing file is gone or unreadable.
    for (const id of Object.keys(index.entries)) {
      try {
        statSync(this.entryPath(id));
      } catch {
        delete index.entries[id];
        this.tombstone(index, id, "evicted");
      }
    }

    // TTL pass.
    for (const id of Object.keys(index.entries)) {
      if (now - index.entries[id].createdAt >= this.limits.ttlMs) {
        try {
          unlinkSync(this.entryPath(id));
        } catch { /* already gone */ }
        delete index.entries[id];
        this.tombstone(index, id, "expired");
      }
    }

    // Cap pass: LRU oldest first, deterministic ties.
    const candidates = Object.keys(index.entries).map((id) => {
      let atime = index.entries[id].createdAt;
      try {
        atime = Math.round(statSync(this.entryPath(id)).mtimeMs);
      } catch { /* fall back to createdAt */ }
      return { id, atime, createdAt: index.entries[id].createdAt, bytes: index.entries[id].bytes };
    });
    candidates.sort((a, b) =>
      a.atime - b.atime || a.createdAt - b.createdAt || (a.id < b.id ? -1 : a.id > b.id ? 1 : 0),
    );
    let totalBytes = candidates.reduce((sum, c) => sum + c.bytes, 0);
    let count = candidates.length;
    for (const candidate of candidates) {
      if (count <= this.limits.maxEntries && totalBytes <= this.limits.maxAggregateBytes) break;
      try {
        unlinkSync(this.entryPath(candidate.id));
      } catch { /* already gone */ }
      delete index.entries[candidate.id];
      this.tombstone(index, candidate.id, "evicted");
      totalBytes -= candidate.bytes;
      count--;
    }

    // Orphan pass: entry files absent from the index are garbage.
    try {
      for (const name of readdirSync(this.dir)) {
        const match = /^(cm-[0-9a-f]{16})\.json$/.exec(name);
        if (match && index.entries[match[1]] === undefined) {
          try { unlinkSync(join(this.dir, name)); } catch { /* best effort */ }
        }
      }
    } catch { /* unreadable directory: skip */ }

    this.writeIndex(index);
  }

  /** Best-effort sweep of other sessions' archive directories that have
   *  been idle longer than the TTL. Called once at session start so old
   *  session directories cannot accumulate unbounded. */
  sweepStaleSessions(): void {
    try {
      const entries = readdirSync(this.rootDir, { withFileTypes: true });
      const now = this.now();
      for (const entry of entries) {
        if (!entry.isDirectory()) continue;
        if (!/^[A-Za-z0-9._-]{1,128}$/.test(entry.name)) continue;
        if (entry.name === this.sessionKey) continue;
        const path = join(this.rootDir, entry.name);
        try {
          // Activity = newest mtime among the session's entry files and
          // its index. Directory mtime alone never keeps a session alive
          // (it moves on any child create/delete); it is only a fallback
          // for an empty directory. Active retrieval refreshes index
          // mtime, so a live session is never swept.
          let newest = -Infinity;
          let sawChild = false;
          for (const child of readdirSync(path)) {
            try {
              const childMtime = statSync(join(path, child)).mtimeMs;
              sawChild = true;
              if (childMtime > newest) newest = childMtime;
            } catch { /* skip unreadable children */ }
          }
          if (!sawChild) newest = statSync(path).mtimeMs;
          if (now - newest >= this.limits.ttlMs) {
            // Reclaim stale content but keep a bounded tombstone index so
            // later retrievals in that session can still distinguish
            // eviction from never-archived references.
            try {
              const indexRaw = readFileSync(join(path, "index.json"), "utf8");
              const parsed = JSON.parse(indexRaw) as StoreIndex;
              const prior = Array.isArray(parsed?.evicted) ? parsed.evicted : [];
              const liveIds = parsed && typeof parsed.entries === "object" && parsed.entries !== null
                ? Object.keys(parsed.entries)
                : [];
              const merged = [...prior, ...liveIds.map((liveId) => ({ id: liveId, reason: "evicted" as const }))];
              const tombstones = merged.slice(-MAX_TOMBSTONES);
              writeFileSync(join(path, "index.json"), JSON.stringify({ v: 1, entries: {}, evicted: tombstones }), { mode: 0o600 });
            } catch {
              // No readable index: write an empty tombstone index instead.
              try {
                writeFileSync(join(path, "index.json"), JSON.stringify(emptyIndex()), { mode: 0o600 });
              } catch { /* unwritable: fall through to full removal */ }
            }
            let removedAll = true;
            try {
              for (const child of readdirSync(path)) {
                if (/^cm-[0-9a-f]{16}\.json$/.test(child)) {
                  try { unlinkSync(join(path, child)); } catch { removedAll = false; }
                }
              }
            } catch { removedAll = false; }
            if (!removedAll) {
              rmSync(path, { recursive: true, force: true });
            } else {
              const at = now / 1000;
              try { utimesSync(join(path, "index.json"), at, at); } catch { /* best effort */ }
            }
          }
        } catch { /* skip unreadable entries */ }
      }
    } catch { /* root missing: nothing to sweep */ }
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
  const result: ArchiveConfig = {
    enabled: true,
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
      result.warnings.push("archive.enabled must be a boolean; keeping enabled=true");
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
