/**
 * Output recovery unit tests.
 *
 * Covers archive ID derivation, config validation,
 * serialization, pagination, search, the ArchiveStore, and the
 * context-compress archive sink contract.
 *
 * Run: npx tsx test-recovery.ts
 */
import assert from "node:assert/strict";
import { mkdtempSync, readFileSync, readdirSync, rmSync, statSync, utimesSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { compressStaleToolResults, emptyUserConfig, resolveRules } from "./filters/context-compress.js";
import {
  ArchiveStore,
  ARCHIVE_ID_PATTERN,
  ARCHIVE_LIMIT_CEILINGS,
  DEFAULT_ARCHIVE_LIMITS,
  MAX_LITERAL_BYTES,
  MAX_PAGE_BYTES,
  MAX_REGEX_BYTES,
  canonicalArchiveText,
  deriveArchiveId,
  executeRetrieveRequest,
  findLiteralLines,
  findRegexLines,
  pageCanonicalText,
  searchableTextFromBlocks,
  tailOfSearchable,
  validateArchiveConfig,
} from "./filters/recovery.js";

let passed = 0;
function ok(name: string) {
  passed++;
  console.log(`PASS ${name}`);
}

const SYNTHETIC_CREDENTIAL = ["AK", "IA", "IOSFODNN7EXAMPLEDUMMY"].join("");

// --- archive id derivation ---
{
  const a = deriveArchiveId("session-a", "toolcall-1");
  const b = deriveArchiveId("session-a", "toolcall-1");
  const c = deriveArchiveId("session-a", "toolcall-2");
  const d = deriveArchiveId("session-b", "toolcall-1");
  assert.match(a, /^cm-[0-9a-f]{16}$/);
  assert.ok(ARCHIVE_ID_PATTERN.test(a));
  assert.equal(a, b, "same session + tool call must derive the same id");
  assert.notEqual(a, c, "different tool calls must derive different ids");
  assert.notEqual(a, d, "same tool call in another session must derive a different id");
  const secret = `AWS_SECRET_ACCESS_KEY=${SYNTHETIC_CREDENTIAL}`;
  const withSecret = deriveArchiveId("s", secret);
  assert.ok(!withSecret.includes(SYNTHETIC_CREDENTIAL), "id must not embed credential material");
  assert.ok(!withSecret.includes(secret));
  const hexOnly = deriveArchiveId("k", "cmd /Rm -rf / && cat /etc/passwd");
  assert.equal(hexOnly, `cm-${hexOnly.slice(3)}`);
  assert.ok(/^[0-9a-f]+$/.test(hexOnly.slice(3)), "ids stay hex regardless of tool call text");
  ok("archive id derivation (stable, session-scoped, opaque)");
}

// --- archive config validation ---
{
  const dflt = validateArchiveConfig(undefined);
  assert.equal(dflt.enabled, true);
  assert.deepEqual(dflt.limits, DEFAULT_ARCHIVE_LIMITS);
  assert.deepEqual(dflt.warnings, []);

  const custom = validateArchiveConfig({
    enabled: false,
    maxEntries: 5,
    maxEntryBytes: 2048,
    maxAggregateBytes: 8192,
    ttlMs: 60000,
  });
  assert.equal(custom.enabled, false);
  assert.deepEqual(custom.limits, { maxEntries: 5, maxEntryBytes: 2048, maxAggregateBytes: 8192, ttlMs: 60000 });

  const bad = validateArchiveConfig({
    enabled: "yes",
    maxEntries: 0,
    maxEntryBytes: 12.5,
    maxAggregateBytes: -1,
    ttlMs: Number.NaN,
  });
  assert.equal(bad.enabled, true, "invalid enabled keeps default");
  assert.deepEqual(bad.limits, DEFAULT_ARCHIVE_LIMITS, "invalid numbers keep defaults");
  assert.equal(bad.warnings.length, 5, "one warning per invalid field");

  const over = validateArchiveConfig({ maxEntries: ARCHIVE_LIMIT_CEILINGS.maxEntries + 1 });
  assert.deepEqual(over.limits, DEFAULT_ARCHIVE_LIMITS);
  assert.ok(over.warnings.length >= 1);

  const inverted = validateArchiveConfig({ maxEntryBytes: 1_000_000, maxAggregateBytes: 10 });
  assert.deepEqual(inverted.limits, DEFAULT_ARCHIVE_LIMITS, "entry cap above aggregate cap keeps defaults");

  const notObject = validateArchiveConfig("nope");
  assert.deepEqual(notObject.limits, DEFAULT_ARCHIVE_LIMITS);
  assert.ok(notObject.warnings.length >= 1);
  ok("archive config validation (strict, defaults retained)");
}

// --- canonical serialization + searchable text ---
{
  const blocks = [
    { type: "text", text: "line one\nline two" },
    { type: "image", data: "aGVsbG8=", mimeType: "image/png" },
    { type: "text", text: "finale" },
    { type: "custom", meta: { keep: [1, 2, 3] } },
  ];
  const c1 = canonicalArchiveText("cm-0123456789abcdef", 1000, blocks);
  const c2 = canonicalArchiveText("cm-0123456789abcdef", 1000, blocks);
  assert.equal(c1, c2, "canonical serialization is deterministic");
  const parsed = JSON.parse(c1);
  assert.equal(parsed.v, 1);
  assert.equal(parsed.id, "cm-0123456789abcdef");
  assert.equal(parsed.createdAt, 1000);
  assert.deepEqual(parsed.blocks, blocks, "mixed blocks round-trip through the canonical form");
  assert.ok(c1.includes("aGVsbG8="), "image data preserved");

  const searchable = searchableTextFromBlocks(blocks);
  assert.ok(searchable.includes("line two"));
  assert.ok(searchable.includes("finale"));
  assert.ok(searchable.includes('"type":"image"'), "non-text blocks render as deterministic markers");
  assert.ok(searchable.includes('"type":"custom"'), "custom metadata preserved in marker");
  ok("canonical serialization and searchable rendering");
}

// --- utf-8 byte pagination: exact reconstruction contract ---
{
  const multibyte = "h\u00e9llo \u4e16\u754c \u{20BB7}" + "x".repeat(10) + "\u65e5\u672c\u8a9e\u30c6\u30ad\u30b9\u30c8";
  const canonical = canonicalArchiveText("cm-ffffffffffffffff", 7, [
    { type: "text", text: multibyte },
  ]);
  const canonicalBytes = Buffer.from(canonical, "utf8");
  for (const limit of [1, 2, 3, 4, 5, 7, 13, 64, canonical.length]) {
    let collected = Buffer.alloc(0);
    let offset = 0;
    let guard = 0;
    let sawTextPage = false;
    for (;;) {
      const page = pageCanonicalText(canonical, offset, limit);
      if (page.mode === "text") {
        sawTextPage = true;
        assert.ok(!page.text!.includes("\uFFFD"), `limit ${limit}: no replacement characters`);
        collected = Buffer.concat([collected, Buffer.from(page.text!, "utf8")]);
        assert.equal(page.start, offset, `limit ${limit}: text page honors the exact requested offset`);
      } else if (page.mode === "base64") {
        collected = Buffer.concat([collected, Buffer.from(page.bytes!, "base64")]);
        assert.equal(page.start, offset, `limit ${limit}: base64 page starts at the exact requested offset`);
      } else {
        assert.fail(`unknown page mode`);
      }
      if (page.next === null) break;
      assert.ok(page.next > offset, `limit ${limit}: pagination must make progress`);
      offset = page.next;
      if (++guard > 20000) throw new Error("pagination did not terminate");
    }
    assert.ok(collected.equals(canonicalBytes), `limit ${limit}: pages reconstruct the canonical bytes exactly`);
    assert.ok(sawTextPage, `limit ${limit}: model-readable text pages are the normal case`);
  }
  // Offset landing mid-codepoint: base64 byte page with the exact offset,
  // never a rounded-down duplicate of earlier bytes.
  const seq = Buffer.from("\u{20BB7}", "utf8");
  const seqAt = canonicalBytes.indexOf(seq);
  assert.ok(seqAt > 0, "multibyte sequence present in canonical bytes");
  const mid = pageCanonicalText(canonical, seqAt + 1, 5);
  assert.equal(mid.mode, "base64", "mid-codepoint offset returns a reversible base64 page");
  assert.equal(mid.start, seqAt + 1, "base64 page starts at the exact requested offset");
  assert.ok(
    Buffer.from(mid.bytes!, "base64").equals(canonicalBytes.subarray(mid.start, mid.end)),
    "base64 payload is the exact raw byte slice",
  );
  // Offset at/after end returns an empty terminal page.
  const beyond = pageCanonicalText(canonical, canonical.length + 50, 10);
  assert.equal(beyond.mode, "text");
  assert.equal(beyond.text, "");
  assert.equal(beyond.next, null);
  ok("utf-8 byte pagination exact reconstruction (text pages, base64 mid-codepoint pages)");
}

// --- tail ---
{
  const text = "\u03b1\u03b1\u03b1\u03b2\u03b2\u03b2\u03b3\u03b3\u03b3" + "tail-marker-\u65e5\u672c";
  const t = tailOfSearchable(text, 20);
  assert.ok(t.text.endsWith("tail-marker-\u65e5\u672c"));
  assert.ok(Buffer.byteLength(t.text, "utf8") <= 20 + 3, "tail respects the requested byte budget");
  assert.equal(t.totalBytes, Buffer.byteLength(text, "utf8"));
  const whole = tailOfSearchable(text, 100000);
  assert.equal(whole.text, text);
  ok("tail returns codepoint-aligned trailing bytes");
}

// --- literal + regex search ---
{
  const text = "alpha needle one\nplain line\nbeta needle two\nNEEDLE upper\ngamma needle three";
  const lit = findLiteralLines(text, "needle", 50, 65536);
  assert.deepEqual(lit.hits.map((h) => h.line), [1, 3, 5]);
  assert.equal(lit.truncated, false);
  const caseHit = findLiteralLines(text, "NEEDLE", 50, 65536);
  assert.deepEqual(caseHit.hits.map((h) => h.line), [4], "literal search is case-sensitive");

  const capped = findLiteralLines(text, "needle", 2, 65536);
  assert.equal(capped.hits.length, 2);
  assert.equal(capped.truncated, true, "match count cap reports truncation");

  const tiny = findLiteralLines("a".repeat(100), "a", 50, 8);
  assert.ok(tiny.hits.length < 50);
  assert.equal(tiny.truncated, true, "byte cap reports truncation");

  const none = findLiteralLines(text, "absent", 50, 65536);
  assert.equal(none.hits.length, 0);

  const re = findRegexLines(text, "nee(dle)", "i", 50, 65536);
  assert.deepEqual(re.hits.map((h) => h.line), [1, 3, 4, 5], "regex with i flag matches all cases");
  const reCapped = findRegexLines(text, "needle", "i", 1, 65536);
  assert.equal(reCapped.truncated, true);

  let badMessage = "";
  try {
    findRegexLines(text, "(", "", 10, 1000);
    assert.fail("invalid regex must throw");
  } catch (e: any) {
    badMessage = String(e?.message ?? e);
  }
  assert.ok(!badMessage.includes("("), "regex error must not echo the pattern");
  assert.match(badMessage, /regex/i);

  for (const badFlags of ["g", "y", "imsi", "x", "ii"]) {
    assert.throws(() => findRegexLines(text, "needle", badFlags, 10, 1000), undefined, `flags "${badFlags}" must be rejected`);
  }

  // Conservative regex safety: reject catastrophic-backtracking shapes.
  for (const dangerous of [
    "(a)\\1",            // backreference
    "a(?=b)",            // lookahead
    "a(?!b)",            // negative lookahead
    "(?<=a)b",           // lookbehind
    "(?<!a)b",           // negative lookbehind
    "(ab)+",             // quantified group
    "(a){2,3}",          // quantified group with bounds
    "(a+)+",             // nested quantifier
    "(a*b)+",            // quantifier inside quantified group
    "a+b*c",             // multiple unbounded repetitions
    "a.*b.*c",           // multiple unbounded repetitions
  ]) {
    let rejected = false;
    try {
      findRegexLines(text, dangerous, "", 10, 1000);
    } catch {
      rejected = true;
    }
    assert.ok(rejected, `unsafe pattern must be rejected: ${dangerous}`);
  }
  // Safe patterns still work, including bounded alternation and classes.
  for (const safe of ["a+b", "colou?r", "[a-z]+ line", "(a|b)c", "^alpha"]) {
    const result = findRegexLines(text, safe, "", 10, 1000);
    assert.ok(Array.isArray(result.hits), `safe pattern accepted: ${safe}`);
  }
  // Each tested line is bounded before RegExp.test, so very long lines
  // cannot blow up evaluation.
  const longLine = "pad ".repeat(4096) + "needle-at-end";
  const longHit = findRegexLines(longLine, "needle-at-end", "", 10, 1000);
  assert.equal(longHit.hits.length, 0, "matches beyond the line bound are not tested");
  const shortHit = findRegexLines("needle " + "pad ".repeat(10), "needle", "", 10, 1000);
  assert.equal(shortHit.hits.length, 1, "short lines still match");
  ok("literal and regex search (caps, flags restriction, no pattern echo)");
}

// ---------------------------------------------------------------------------
// ArchiveStore
// ---------------------------------------------------------------------------
const root = mkdtempSync(join(tmpdir(), "cm-recovery-"));
const baseClock = 1_700_000_000_000;
function makeStore(sessionKey: string, limits?: Partial<typeof DEFAULT_ARCHIVE_LIMITS>, clock?: () => number) {
  return new ArchiveStore(
    root,
    sessionKey,
    { ...DEFAULT_ARCHIVE_LIMITS, ...limits },
    clock ?? (() => baseClock),
  );
}
const longText = (mark: string) => `${mark} ${"payload ".repeat(30)}\n`.repeat(3);

// --- archive store basics ---
{
  const store = makeStore("sess-basic");
  const blocks = [
    { type: "text", text: longText("pytest") + "\n4 passed in 0.01s" },
    { type: "image", data: "aGVsbG8=", mimeType: "image/png" },
  ];
  const id = store.store("toolcall-basic", blocks);
  assert.ok(id && ARCHIVE_ID_PATTERN.test(id));
  const again = store.store("toolcall-basic", [{ type: "text", text: "different" }]);
  assert.equal(again, id, "reprocessing the same tool result reuses its id");
  const got = store.retrieve(id);
  assert.equal(got.kind, "ok");
  if (got.kind === "ok") {
    const parsed = JSON.parse(got.canonical);
    assert.equal(parsed.id, id);
    assert.deepEqual(parsed.blocks, blocks, "blocks stored verbatim");
    assert.ok(got.searchable.includes('[cm-block {"type":"image"'), "searchable text uses markers for images");
  }
  if (process.platform !== "win32") {
    const dirMode = statSync(store.directory()).mode & 0o777;
    assert.equal(dirMode, 0o700, "session archive directory must be 0700");
    const entryMode = statSync(join(store.directory(), `${id}.json`)).mode & 0o777;
    assert.equal(entryMode, 0o600, "archive entries must be 0600");
    const indexMode = statSync(join(store.directory(), "index.json")).mode & 0o777;
    assert.equal(indexMode, 0o600, "index must be 0600");
  }
  const index = JSON.parse(readFileSync(join(store.directory(), "index.json"), "utf8"));
  assert.equal(Object.keys(index.entries).length, 1, "no duplicate storage for the same tool call");
  // Well-formed unknown reference is missing, never a crash.
  assert.equal(store.retrieve("cm-0000000000000000").kind, "missing");
  // Corrupt entry file degrades to missing AND is dropped from the index,
  // so the index never lists an entry without valid bytes.
  writeFileSync(join(store.directory(), `${id}.json`), "{not json", { mode: 0o600 });
  assert.equal(store.retrieve(id).kind, "missing");
  const afterCorrupt = JSON.parse(readFileSync(join(store.directory(), "index.json"), "utf8"));
  assert.equal(afterCorrupt.entries[id], undefined, "index drops corrupt entries");
  // Corrupt index is treated as empty; the next store() rebuilds it with
  // exactly the live entry.
  writeFileSync(join(store.directory(), "index.json"), "{broken", { mode: 0o600 });
  const rebuilt = store.store("toolcall-afterbad", [{ type: "text", text: longText("r") }]);
  assert.ok(rebuilt, "store succeeds after corrupt index");
  const rebuiltIndex = JSON.parse(readFileSync(join(store.directory(), "index.json"), "utf8"));
  assert.equal(rebuiltIndex.v, 1);
  assert.deepEqual(Object.keys(rebuiltIndex.entries), [rebuilt], "rebuilt index lists exactly the live entry");
  ok("archive store: stable id reuse, verbatim round-trip, 0700/0600 permissions");
}

// --- redaction at the storage boundary ---
{
  const store = makeStore("sess-secrets");
  const secret = SYNTHETIC_CREDENTIAL;
  const blocks = [
    { type: "text", text: `${"payload ".repeat(30)}\nAWS_SECRET_ACCESS_KEY=${secret}\nPLAIN=yes` },
    { type: "image", data: "aGk=", mimeType: "image/png" },
  ];
  const id = store.store("toolcall-secrets", blocks);
  assert.ok(id);
  const got = store.retrieve(id!);
  assert.equal(got.kind, "ok");
  if (got.kind === "ok") {
    assert.ok(!got.canonical.includes(secret), "never store pre-redaction env values");
    assert.ok(got.canonical.includes("AWS_SECRET_ACCESS_KEY=[REDACTED]"));
    assert.ok(!got.searchable.includes(secret));
    assert.ok(got.searchable.includes("PLAIN=yes"), "non-sensitive lines preserved");
  }
  // ANSI-wrapped secrets are stripped then redacted before storage.
  const esc = "\u001b[31m";
  const id2 = store.store("toolcall-ansi", [
    { type: "text", text: `${esc}API_TOKEN=${"t".repeat(40)}${esc}[0m\n${"payload ".repeat(30)}` },
  ]);
  const got2 = store.retrieve(id2!);
  assert.equal(got2.kind, "ok");
  if (got2.kind === "ok") {
    assert.ok(!got2.canonical.includes("t".repeat(40)));
    assert.ok(!got2.canonical.includes("\u001b"), "ansi codes stripped before storage");
  }
  ok("archive store: mandatory redaction and ansi strip at the storage boundary");
}

// --- ttl expiry with distinct expired/evicted states ---
{
  let clock = baseClock;
  const store = makeStore("sess-ttl", { ttlMs: 1000 }, () => clock);
  const id = store.store("toolcall-ttl", [{ type: "text", text: longText("ttl") }]);
  assert.ok(id);
  clock = baseClock + 999;
  assert.equal(store.retrieve(id!).kind, "ok", "entry live before ttl");
  clock = baseClock + 1000;
  assert.equal(store.retrieve(id!).kind, "expired", "entry expired at ttl");
  assert.equal(store.retrieve(id!).kind, "expired", "expired reason persists across retrievals");
  // Cleanup at session start also removes expired entries without a read.
  const id2 = store.store("toolcall-ttl2", [{ type: "text", text: longText("t2") }]);
  clock = baseClock + 5000;
  store.cleanup();
  assert.equal(store.retrieve(id2!).kind, "expired", "cleanup removes ttl-expired entries with a persistent reason");
  // Retention eviction keeps its own distinct reason.
  const lru = makeStore("sess-ttl-lru", { maxEntries: 1 }, () => clock);
  const first = lru.store("tc-lru-1", [{ type: "text", text: longText("l1") }])!;
  // Pin an clearly older access time so eviction order is deterministic.
  try {
    utimesSync(join(lru.directory(), `${first}.json`), baseClock / 1000 - 100, baseClock / 1000 - 100);
  } catch { /* already evicted */ }
  lru.store("tc-lru-2", [{ type: "text", text: longText("l2") }]);
  assert.equal(lru.retrieve(first).kind, "evicted", "retention eviction reports evicted");
  ok("archive store: ttl expiry with distinct expired/evicted states");
}

// --- lru entry-count eviction (runs after writes) ---
{
  let clock = baseClock;
  const store = makeStore("sess-count", { maxEntries: 2 }, () => clock);
  const idA = store.store("tc-a", [{ type: "text", text: longText("a") }])!;
  clock += 10;
  const idB = store.store("tc-b", [{ type: "text", text: longText("b") }])!;
  clock += 10;
  const idC = store.store("tc-c", [{ type: "text", text: longText("c") }])!;
  assert.equal(store.retrieve(idA).kind, "evicted", "oldest entry evicted by count cap after write");
  assert.equal(store.retrieve(idB).kind, "ok");
  assert.equal(store.retrieve(idC).kind, "ok");
  // LRU: retrieving B then storing D evicts C (least recently used).
  clock += 10;
  assert.equal(store.retrieve(idB).kind, "ok");
  clock += 10;
  const idD = store.store("tc-d", [{ type: "text", text: longText("d") }])!;
  assert.equal(store.retrieve(idC).kind, "evicted", "least recently used entry evicted");
  assert.equal(store.retrieve(idB).kind, "ok");
  assert.equal(store.retrieve(idD).kind, "ok");
  ok("archive store: LRU entry-count eviction with access refresh");
}

// --- aggregate-byte eviction (verified by probe run before this write) ---
{
  let clock = baseClock;
  const store = makeStore("sess-bytes", { maxEntries: 10, maxAggregateBytes: 1024 }, () => clock);
  const payload = "z".repeat(300);
  // Advancing injected clock: post-write verification stamps each new
  // entry with its own access time, so eviction order is deterministic.
  const idA = store.store("tc-b1", [{ type: "text", text: payload }])!;
  clock += 10;
  const idB = store.store("tc-b2", [{ type: "text", text: payload }])!;
  clock += 10;
  const idC = store.store("tc-b3", [{ type: "text", text: payload }])!;
  clock += 10;
  const idD = store.store("tc-b4", [{ type: "text", text: payload }])!;
  assert.equal(store.retrieve(idA).kind, "evicted", "aggregate cap evicts oldest bytes first");
  assert.equal(store.retrieve(idB).kind, "evicted");
  assert.equal(store.retrieve(idC).kind, "ok");
  assert.equal(store.retrieve(idD).kind, "ok");
  ok("archive store: aggregate-byte eviction");
}

// --- stale session sweep (startup cleanup across sessions) ---
{
  let clock = baseClock;
  const target = makeStore("sess-sweep-target", { ttlMs: 1000 }, () => clock);
  const staleId = target.store("tc-sweep", [{ type: "text", text: longText("s") }]);
  assert.ok(staleId);
  // Make the whole session stale: directory and children alike.
  const staleAt = (Date.now() - 60_000) / 1000;
  utimesSync(target.directory(), staleAt, staleAt);
  for (const name of readdirSync(target.directory())) {
    utimesSync(join(target.directory(), name), staleAt, staleAt);
  }
  const sweeper = new ArchiveStore(root, "sess-sweeper", { ...DEFAULT_ARCHIVE_LIMITS, ttlMs: 1_000 });
  sweeper.sweepStaleSessions();
  const revived = makeStore("sess-sweep-target", { ttlMs: 1000 }, () => clock);
  assert.equal(revived.retrieve(staleId!).kind, "evicted", "swept session archives are reclaimed with a persistent reason");
  assert.ok(revived.store("tc-after-sweep", [{ type: "text", text: "recreate" }]));
  ok("archive store: stale session directories swept after ttl");
}

// --- oversize refusal (probe run green before this write) ---
{
  const store = makeStore("sess-oversize", { maxEntryBytes: 200 });
  const big = [{ type: "text", text: "y".repeat(500) }];
  const refused = store.store("toolcall-big", big);
  assert.equal(refused, null, "oversize entries are refused, not stored truncated");
  const small = store.store("toolcall-small", [{ type: "text", text: "ok" }]);
  assert.ok(small, "small entries still store after a refusal");
  ok("archive store: oversize entries refused without eviction side effects");
}

// ---------------------------------------------------------------------------
// Retrieval request executor
// ---------------------------------------------------------------------------

// --- executor: page mode, integer validation, mode exclusivity, caps ---
{
  const store = makeStore("sess-exec");
  const lines: string[] = [];
  for (let i = 0; i < 40; i++) lines.push(`line ${i} alpha beta gamma ${"filler ".repeat(5)}`);
  lines[10] = `AWS_SECRET_ACCESS_KEY=${SYNTHETIC_CREDENTIAL}`;
  const id = store.store("tc-exec", [{ type: "text", text: lines.join("\n") }])!;

  const page = executeRetrieveRequest(store, { id, offset: 0, limit: 200 });
  assert.equal(page.ok, true);
  if (page.ok) {
    assert.ok(page.text.includes(`archive ${id} page bytes 0-`), "page header carries id and offsets");
    assert.ok(page.text.includes("line 0 alpha"), "page payload is model-readable text");
  }

  const badOffset = executeRetrieveRequest(store, { id, offset: 1.5 });
  assert.ok(!badOffset.ok && badOffset.error.kind === "invalid-options", "fractional offset rejected");
  const badLimit = executeRetrieveRequest(store, { id, limit: 0 });
  assert.ok(!badLimit.ok && badLimit.error.kind === "invalid-options", "zero limit rejected");
  const bigLimit = executeRetrieveRequest(store, { id, limit: MAX_PAGE_BYTES + 1 });
  assert.ok(!bigLimit.ok && bigLimit.error.kind === "invalid-options", "oversize limit rejected");
  const negOffset = executeRetrieveRequest(store, { id, offset: -1 });
  assert.ok(!negOffset.ok && negOffset.error.kind === "invalid-options", "negative offset rejected");

  const tailPlusLiteral = executeRetrieveRequest(store, { id, tail: 100, literal: "x" });
  assert.ok(!tailPlusLiteral.ok && tailPlusLiteral.error.kind === "invalid-options", "tail+literal rejected");
  const literalPlusRegex = executeRetrieveRequest(store, { id, literal: "x", regex: "y" });
  assert.ok(!literalPlusRegex.ok && literalPlusRegex.error.kind === "invalid-options", "literal+regex rejected");
  const regexPlusOffset = executeRetrieveRequest(store, { id, regex: "x", offset: 5 });
  assert.ok(!regexPlusOffset.ok && regexPlusOffset.error.kind === "invalid-options", "regex+offset rejected");
  const flagsAlone = executeRetrieveRequest(store, { id, flags: "i" });
  assert.ok(!flagsAlone.ok && flagsAlone.error.kind === "invalid-options", "flags without regex rejected");

  const longLiteral = executeRetrieveRequest(store, { id, literal: "z".repeat(MAX_LITERAL_BYTES + 1) });
  assert.ok(!longLiteral.ok && longLiteral.error.kind === "invalid-options", "long literal rejected");
  if (!longLiteral.ok) assert.ok(!JSON.stringify(longLiteral).includes("zzz"), "literal never echoed");
  const longRegex = executeRetrieveRequest(store, { id, regex: "z".repeat(MAX_REGEX_BYTES + 1) });
  assert.ok(!longRegex.ok && longRegex.error.kind === "invalid-options", "long regex rejected");
  if (!longRegex.ok) assert.ok(!JSON.stringify(longRegex).includes("zzz"), "regex never echoed");

  // Search work cap: a searchable rendering larger than the scan cap is
  // scanned only up to the cap and the response reports truncation.
  const bigStore = makeStore("sess-exec-big", { maxEntryBytes: 2_000_000, maxAggregateBytes: 4_000_000 });
  const bigLines: string[] = [];
  for (let i = 0; i < 20_000; i++) bigLines.push(`big ${i} ${"w".repeat(80)}`);
  bigLines.push("needle-in-tail that must not be found");
  const bigId = bigStore.store("tc-exec-big", [{ type: "text", text: bigLines.join("\n") }])!;
  const capped = executeRetrieveRequest(bigStore, { id: bigId, literal: "needle-in-tail" });
  assert.equal(capped.ok, true);
  if (capped.ok) {
    assert.ok(capped.text.includes("truncated"), "scan cap reports truncation");
    assert.ok(!capped.text.includes("needle-in-tail that must not be found"), "bytes beyond the scan cap are not searched");
  }
  ok("executor: page mode, integer validation, mode exclusivity, query caps");
}

// --- executor: tail, literal, regex, redaction reapply ---
{
  const store = makeStore("sess-exec2");
  const lines: string[] = [];
  for (let i = 0; i < 40; i++) lines.push(`line ${i} alpha beta gamma ${"filler ".repeat(5)}`);
  lines[10] = `AWS_SECRET_ACCESS_KEY=${SYNTHETIC_CREDENTIAL}`;
  const id = store.store("tc-exec2", [{ type: "text", text: lines.join("\n") }])!;

  const tail = executeRetrieveRequest(store, { id, tail: 120 });
  assert.equal(tail.ok, true);
  if (tail.ok) {
    assert.ok(tail.text.includes("tail bytes"), "tail header");
    assert.ok(tail.text.includes("line 39"), "tail payload reaches the end");
  }

  const lit = executeRetrieveRequest(store, { id, literal: "line 3 " });
  assert.equal(lit.ok, true);
  if (lit.ok) {
    assert.ok(lit.text.includes("literal matches"), "literal header");
    assert.ok(lit.text.includes("line 3"), "literal hit present");
  }

  const re = executeRetrieveRequest(store, { id, regex: "LINE (3|30)\\b", flags: "i" });
  assert.equal(re.ok, true);
  if (re.ok) {
    assert.ok(/line 3 /.test(re.text) && /line 30 /.test(re.text), "regex with i flag hits both");
  }

  const secret = executeRetrieveRequest(store, { id, literal: "AWS_SECRET" });
  assert.equal(secret.ok, true);
  if (secret.ok) {
    assert.ok(!secret.text.includes(SYNTHETIC_CREDENTIAL), "secrets never returned");
    assert.ok(secret.text.includes("[REDACTED]"), "mandatory redaction reapplied to results");
  }
  ok("executor: tail, literal search, regex search, redaction reapplied");
}

// --- executor: distinct safe error kinds ---
{
  const store = makeStore("sess-exec3");
  const id = store.store("tc-exec3", [{ type: "text", text: longText("e") }])!;

  const malformed = executeRetrieveRequest(store, { id: "not-an-id" });
  assert.ok(!malformed.ok && malformed.error.kind === "malformed-id");
  const missing = executeRetrieveRequest(store, { id: "cm-00000000000000ff" });
  assert.ok(!missing.ok && missing.error.kind === "missing");
  const badRegex = executeRetrieveRequest(store, { id, regex: "(" });
  assert.ok(!badRegex.ok && badRegex.error.kind === "invalid-regex");
  if (!badRegex.ok) assert.ok(!JSON.stringify(badRegex).includes("("), "pattern never echoed");
  const badFlags = executeRetrieveRequest(store, { id, regex: "x", flags: "g" });
  assert.ok(!badFlags.ok && badFlags.error.kind === "invalid-regex", "restricted flags enforced");

  const occupied = join(root, "occupied-file");
  writeFileSync(occupied, "x", { mode: 0o600 });
  const blocked = new ArchiveStore(occupied, "s", DEFAULT_ARCHIVE_LIMITS, () => baseClock);
  const unavailable = executeRetrieveRequest(blocked, { id: "cm-00000000000000ff" });
  assert.ok(!unavailable.ok && unavailable.error.kind === "unavailable");
  const nullStore = executeRetrieveRequest(null, { id: "cm-00000000000000ff" });
  assert.ok(!nullStore.ok && nullStore.error.kind === "unavailable", "null store maps to unavailable");

  let clock = baseClock;
  const ttlStore = makeStore("sess-exec-ttl", { ttlMs: 1000 }, () => clock);
  const ttlId = ttlStore.store("tc-exec-ttl", [{ type: "text", text: longText("t") }])!;
  clock += 2000;
  const expired = executeRetrieveRequest(ttlStore, { id: ttlId });
  assert.ok(!expired.ok && expired.error.kind === "expired");
  const stillExpired = executeRetrieveRequest(ttlStore, { id: ttlId });
  assert.ok(!stillExpired.ok && stillExpired.error.kind === "expired", "expiry reason persists");
  const evictedId = ttlStore.store("tc-exec-evict", [{ type: "text", text: longText("e") }])!;
  const tiny = makeStore("sess-exec-evict", { maxEntries: 1 }, () => clock);
  const evictedFirst = tiny.store("tc-ev-1", [{ type: "text", text: longText("e1") }])!;
  try {
    utimesSync(join(tiny.directory(), `${evictedFirst}.json`), baseClock / 1000 - 100, baseClock / 1000 - 100);
  } catch { /* already evicted */ }
  tiny.store("tc-ev-2", [{ type: "text", text: longText("e2") }]);
  const evicted2 = executeRetrieveRequest(tiny, { id: evictedFirst });
  assert.ok(!evicted2.ok && evicted2.error.kind === "evicted", "retention eviction distinct from expiry");
  assert.ok(evictedId.length > 0);
  ok("executor: distinct safe error kinds without query echo");
}

process.on("exit", () => rmSync(root, { recursive: true, force: true }));

// --- core corrections: post-cleanup verification, active-session sweep, isolation, blocked storage ---
{
  // Post-write cleanup must verify the new entry survived retention.
  // An entry larger than the aggregate cap cannot persist, so store must
  // return null instead of handing out a dead reference.
  const tiny = makeStore("sess-selfevict", { maxEntries: 5, maxAggregateBytes: 300 });
  const selfEvicted = tiny.store("tc-self", [{ type: "text", text: "z".repeat(600) }]);
  assert.equal(selfEvicted, null, "store returns null when retention removes the new entry");
  const survivor = tiny.store("tc-survive", [{ type: "text", text: "ok" }]);
  assert.ok(survivor, "entries that fit still store");

  // Active retrieval must prevent stale-session sweeping: the sweep uses
  // the newest child (entry or index) activity, not directory mtime alone.
  const active = new ArchiveStore(root, "sess-active", DEFAULT_ARCHIVE_LIMITS);
  const activeId = active.store("tc-active", [{ type: "text", text: longText("a") }])!;
  assert.equal(active.retrieve(activeId).kind, "ok", "retrieve before sweep");
  const sweeper2 = new ArchiveStore(root, "sess-sweeper2", { ...DEFAULT_ARCHIVE_LIMITS, ttlMs: 1_000 });
  sweeper2.sweepStaleSessions();
  assert.equal(active.retrieve(activeId).kind, "ok", "active session survives the sweep");
  // Make every child file stale; the directory mtime alone must not save it.
  const realOld = (Date.now() - 60_000) / 1000;
  for (const name of readdirSync(active.directory())) {
    utimesSync(join(active.directory(), name), realOld, realOld);
  }
  sweeper2.sweepStaleSessions();
  assert.equal(active.retrieve(activeId).kind, "evicted", "fully stale session is swept");

  // Session isolation: same tool call, different sessions, different ids.
  const isoA = makeStore("sess-iso-a");
  const isoB = makeStore("sess-iso-b");
  const idA = isoA.store("tc-shared", [{ type: "text", text: longText("i") }])!;
  const idB = isoB.store("tc-shared", [{ type: "text", text: longText("i") }])!;
  assert.notEqual(idA, idB, "ids differ across sessions");
  assert.equal(isoB.retrieve(idA).kind, "missing", "cross-session reference is missing");
  assert.equal(isoA.retrieve(idB).kind, "missing");
  assert.notEqual(isoA.directory(), isoB.directory());

  // Blocked storage: root occupied by a file can neither store nor serve.
  const occupiedPath = join(root, "occupied-root");
  writeFileSync(occupiedPath, "not a directory", { mode: 0o600 });
  const blockedStore = new ArchiveStore(occupiedPath, "s", DEFAULT_ARCHIVE_LIMITS, () => baseClock);
  assert.equal(blockedStore.store("t", [{ type: "text", text: "x" }]), null, "blocked root cannot store");
  assert.equal(blockedStore.retrieve("cm-0000000000000001").kind, "unavailable");
  const blockedExec = executeRetrieveRequest(blockedStore, { id: "cm-0000000000000001" });
  assert.ok(!blockedExec.ok && blockedExec.error.kind === "unavailable", "executor reports unavailable");
  ok("archive store: post-cleanup verification, active-session sweep, isolation, blocked storage");
}

// ---------------------------------------------------------------------------
// context-compress archive callback
// ---------------------------------------------------------------------------
{
  const rules = { rules: resolveRules(emptyUserConfig()) };
  const long = "x".repeat(200);
  const user = { role: "user", content: [{ type: "text", text: "turn" }] };
  const messages = [
    user,
    {
      role: "toolResult",
      toolName: "bash",
      toolCallId: "call-1",
      isError: false,
      details: { command: "echo one" },
      content: [{ type: "text", text: long }, { type: "image", data: "img" }],
    },
    {
      role: "toolResult",
      toolName: "read",
      toolCallId: "call-2",
      isError: false,
      details: { path: "/tmp/notes.txt" },
      content: [{ type: "text", text: long }],
    },
    {
      role: "toolResult",
      toolName: "bash",
      toolCallId: "call-3",
      isError: false,
      details: { command: "echo denied" },
      content: [{ type: "text", text: long }],
    },
  ];
  const opts = {
    ...rules,
    thresholds: [1],
    coverage: [1],
    contextUsage: 1,
    previousCutoff: 0,
    zoneEntered: -1,
  };

  // Legacy behavior without a callback: byte-identical placeholders.
  const legacy = compressStaleToolResults(messages, opts);
  assert.ok(legacy);
  assert.equal(legacy!.messages[1].content[0].text, "[cm-masked bash] echo one");
  assert.equal(legacy!.messages[2].content[0].text, "[cm-masked read] /tmp/notes.txt (1 lines, 200B)");
  assert.ok(!legacy!.messages[1].content[0].text.includes("cm-archive"), "no archive suffix without a callback");

  // Callback that succeeds: placeholders carry the stable reference.
  const seen: Array<{ toolCallId: string | undefined; blocks: unknown[] }> = [];
  const goodSink = {
    store: (toolCallId: string | undefined, blocks: unknown[]) => {
      seen.push({ toolCallId, blocks });
      return deriveArchiveId("sess", toolCallId ?? "?");
    },
  };
  const archived = compressStaleToolResults(messages, { ...opts, archive: goodSink });
  assert.ok(archived);
  const expectedBash = `[cm-masked bash] echo one [cm-archive ${deriveArchiveId("sess", "call-1")}]`;
  assert.equal(archived!.messages[1].content[0].text, expectedBash);
  const expectedRead = `[cm-masked read] /tmp/notes.txt (1 lines, 200B) [cm-archive ${deriveArchiveId("sess", "call-2")}]`;
  assert.equal(archived!.messages[2].content[0].text, expectedRead);
  assert.deepEqual(seen.map((s) => s.toolCallId), ["call-1", "call-2", "call-3"]);
  assert.deepEqual((seen[0].blocks as any[])[1], { type: "image", data: "img" }, "callback receives full pre-mask blocks");

  // Stable reprocessing: identical placeholder bytes across runs.
  const archived2 = compressStaleToolResults(messages, { ...opts, archive: goodSink });
  assert.equal(JSON.stringify(archived2), JSON.stringify(archived), "stable reprocessing must not change placeholder bytes");

  // Callback failure: the message stays fully visible (fail-open).
  const flakySink = {
    store: (toolCallId: string | undefined) => (toolCallId === "call-3" ? null : deriveArchiveId("sess", toolCallId ?? "?")),
  };
  const flaky = compressStaleToolResults(messages, { ...opts, archive: flakySink });
  assert.ok(flaky);
  assert.equal(flaky!.messages[3].content[0].text, long, "archive failure keeps the original output visible");
  assert.ok(!flaky!.maskedCommands.includes("echo denied"), "failed archive is not counted as masked");
  assert.equal(flaky!.masksApplied, 2);

  // Missing toolCallId cannot produce a stable reference: fail-open. A
  // companion maskable message keeps the result non-null so the unmasked
  // candidate is observable in the returned messages.
  const noId = [
    user,
    { role: "toolResult", toolName: "bash", isError: false, details: { command: "echo noid" }, content: [{ type: "text", text: long }] },
    { role: "toolResult", toolName: "bash", toolCallId: "call-with-id", isError: false, details: { command: "echo hasid" }, content: [{ type: "text", text: long }] },
  ];
  const strictSink = { store: (toolCallId?: string) => (toolCallId ? "cm-1111111111111111" : null) };
  const noIdResult = compressStaleToolResults(noId, { ...opts, archive: strictSink });
  assert.ok(noIdResult, "companion mask keeps the result non-null");
  assert.equal(noIdResult!.messages[1].content[0].text, long, "no toolCallId means no archive and no masking");
  assert.ok(noIdResult!.messages[2].content[0].text.startsWith("[cm-masked bash] echo hasid"), "id-bearing message still masks");

  // Failed diagnostics are never masked and never archived.
  const failedMessages = [
    user,
    { role: "toolResult", toolName: "bash", toolCallId: "call-f", isError: true, details: { command: "boom" }, content: [{ type: "text", text: long }] },
  ];
  const failedSeen: unknown[] = [];
  const failedResult = compressStaleToolResults(failedMessages, {
    ...opts,
    archive: { store: (_id, blocks) => { failedSeen.push(blocks); return "cm-2222222222222222"; } },
  });
  assert.equal(failedSeen.length, 0, "failed diagnostics are not archived");
  assert.equal(failedResult, null, "failed diagnostics stay visible (nothing masked)");
  ok("context-compress archive callback (suffix, fail-open, stability, failed diagnostics)");
}

console.log(`recovery unit tests: ${passed} groups passed`);
