/**
 * Rolling admission (cm2) recovery tests — corrective PR.
 *
 * Active red cycle 1: a new admission through the public ArchiveStore.store
 * boundary must return a full-width cm2- identifier (256-bit hex) instead
 * of the legacy 16-hex cm- identifier.
 *
 * Deferred regression cases for later red cycles are tracked in the handoff
 * notes; they are intentionally not active assertions yet.
 *
 * Run: npx tsx test-recovery-rolling.ts
 */
import assert from "node:assert/strict";
import { createHash } from "node:crypto";
import { existsSync, mkdirSync, mkdtempSync, readdirSync, readFileSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import {
  ArchiveStore,
  DEFAULT_ARCHIVE_LIMITS,
  defaultArchiveFilesystem,
  deriveArchiveId,
} from "./filters/recovery.js";

let passed = 0;
function ok(name: string) {
  passed++;
  console.log(`PASS ${name}`);
}

const root = mkdtempSync(join(tmpdir(), "cm-recovery-rolling-"));
const baseClock = 1_700_000_000_000;
const long = (mark: string) => `${mark} ${"payload ".repeat(30)}\n`.repeat(3);
const CM2_PATTERN = /^cm2-[0-9a-f]{64}$/;
const sha = (input: string | Buffer) => createHash("sha256").update(input).digest("hex");

process.on("exit", () => {
  try { rmSync(root, { recursive: true, force: true }); } catch { /* ignore */ }
});

// ── cycle 1: new admission id shape ──
{
  const store = new ArchiveStore(root, "roll-cm2-id", { ...DEFAULT_ARCHIVE_LIMITS }, () => baseClock);
  const id = store.store("tc-cm2", [{ type: "text", text: long("x") }]);
  assert.ok(id, "store returns a reference for a new admission");
  assert.match(id!, CM2_PATTERN);
  ok("rolling: a new admission returns a full-width cm2 id");
}

// ── cycle 1: v2 persistence shape for new admissions ──
{
  const session = "roll-v2-shape";
  const dir = join(root, session);
  const store = new ArchiveStore(root, session, { ...DEFAULT_ARCHIVE_LIMITS }, () => baseClock);
  const blocks = [{ type: "text", text: long("s") }];
  const id = store.store("tc-shape", blocks);
  assert.ok(id && CM2_PATTERN.test(id), "new admission returns a cm2 reference");
  const index = JSON.parse(readFileSync(join(dir, "index.json"), "utf8"));
  assert.equal(index.v, 2, "index migrates to schema v2");
  assert.equal(Number.isSafeInteger(index.nextSequence), true, "nextSequence is a safe integer");
  assert.equal(index.nextSequence, 2, "one admission advances the sequence cursor to 2");
  assert.match(index.generation, /^[0-9a-f]{32}$/, "v2 index persists a random archive generation");
  const row = index.entries[id!];
  assert.ok(row, "new admission has an index row");
  assert.equal(row.format, 2, "row carries format 2");
  assert.equal(row.kind, "semantic", "row carries the semantic kind default");
  assert.equal(row.sequence, 1, "first admission consumes sequence 1");
  assert.equal(row.createdAt, baseClock, "row records the admission clock");
  assert.equal(row.toolDigest, sha("tc-shape"), "toolDigest is the tool identity digest");
  assert.equal(row.contentDigest, sha(JSON.stringify(blocks)), "contentDigest covers the normalized blocks");
  const entryRaw = readFileSync(join(dir, `${id}.json`), "utf8");
  const entryBytes = Buffer.from(entryRaw, "utf8");
  assert.equal(row.bytes, entryBytes.length, "row bytes match the entry file exactly");
  assert.equal(row.sha256, sha(entryBytes), "row sha256 matches the exact canonical bytes");
  const parsed = JSON.parse(entryRaw);
  assert.equal(parsed.v, 2, "entry canonical bytes use v2");
  assert.equal(parsed.id, id, "entry carries its own reference");
  assert.equal(parsed.createdAt, baseClock, "entry carries the admission clock");
  assert.deepEqual(parsed.blocks, blocks, "entry stores the normalized blocks");
  assert.equal(entryRaw, JSON.stringify({ v: 2, id, createdAt: baseClock, blocks }), "v2 canonical bytes are deterministic");
  // A second admission persists a distinct sequence and advances the cursor.
  const id2 = store.store("tc-shape-2", [{ type: "text", text: long("t") }]);
  assert.ok(id2 && CM2_PATTERN.test(id2) && id2 !== id, "second admission returns a distinct cm2 reference");
  const index2 = JSON.parse(readFileSync(join(dir, "index.json"), "utf8"));
  assert.equal(index2.nextSequence, 3, "cursor advances to 3 after two admissions");
  assert.equal(index2.entries[id2!].sequence, 2, "second admission consumes sequence 2");
  // An invalid persisted sequence fails open instead of admitting.
  const badDir = join(root, "roll-bad-seq");
  mkdirSync(badDir, { recursive: true });
  writeFileSync(join(badDir, "index.json"), JSON.stringify({ v: 2, entries: {}, evicted: [], nextSequence: 0 }), { mode: 0o600 });
  const bad = new ArchiveStore(root, "roll-bad-seq", { ...DEFAULT_ARCHIVE_LIMITS }, () => baseClock);
  assert.equal(bad.store("tc-bad", [{ type: "text", text: long("b") }]), null, "invalid nextSequence fails open");
  ok("rolling: v2 index shape, sequence persistence, and fail-open sequence validation");
}

// ── cycle 1: atomic v1 to v2 migration on the first new admission ──
{
  const session = "roll-migrate";
  const dir = join(root, session);
  mkdirSync(dir, { recursive: true });
  const legacyId = deriveArchiveId(session, "tc-legacy");
  const legacyBlocks = [{ type: "text", text: long("L") }];
  const legacyCanonical = JSON.stringify({ v: 1, id: legacyId, createdAt: baseClock, blocks: legacyBlocks });
  writeFileSync(join(dir, `${legacyId}.json`), legacyCanonical, { mode: 0o600 });
  writeFileSync(join(dir, "index.json"), JSON.stringify({
    v: 1,
    entries: { [legacyId]: { bytes: Buffer.byteLength(legacyCanonical, "utf8"), createdAt: baseClock } },
    evicted: [],
    admissionClosed: true,
  }), { mode: 0o600 });
  const legacyBytes = readFileSync(join(dir, `${legacyId}.json`));
  const store = new ArchiveStore(root, session, { ...DEFAULT_ARCHIVE_LIMITS }, () => baseClock);
  assert.equal(store.retrieve(legacyId).kind, "ok", "legacy retrieval works before migration");
  const id = store.store("tc-new", [{ type: "text", text: long("n") }]);
  assert.ok(id && CM2_PATTERN.test(id), "new admission over a v1 index returns cm2");
  const index = JSON.parse(readFileSync(join(dir, "index.json"), "utf8"));
  assert.equal(index.v, 2, "first committed new admission migrates the index");
  assert.equal(index.nextSequence, 2, "migration installs the sequence cursor");
  assert.deepEqual(
    index.entries[legacyId],
    { bytes: Buffer.byteLength(legacyCanonical, "utf8"), createdAt: baseClock },
    "legacy row is preserved exactly",
  );
  assert.equal(readFileSync(join(dir, `${legacyId}.json`)).equals(legacyBytes), true, "legacy entry file bytes are unchanged");
  const got = store.retrieve(legacyId);
  assert.equal(got.kind, "ok", "legacy retrieval works after migration");
  if (got.kind === "ok") assert.equal(got.canonical, legacyCanonical, "legacy retrieval returns the exact v1 bytes");
  const newRow = index.entries[id!];
  assert.equal(newRow.format, 2, "migrated index carries the v2 row");
  assert.equal(newRow.sequence, 1, "v2 row consumed the first sequence");
  const leftovers = readdirSync(dir).filter((name) => name.endsWith(".tmp"));
  assert.equal(leftovers.length, 0, "migration leaves no temporary files behind");
  // The legacy admissionClosed flag is ignored in v2: admission continues.
  const id2 = store.store("tc-new-2", [{ type: "text", text: long("m") }]);
  assert.ok(id2 && CM2_PATTERN.test(id2), "legacy closure does not block v2 admission");
  assert.equal(JSON.parse(readFileSync(join(dir, "index.json"), "utf8")).entries[id2!].sequence, 2, "cursor advanced past the legacy-closed admission");
  ok("rolling: first new admission migrates v1 to v2 atomically and preserves legacy state");
}

// ── cycle 2: deterministic rolling count retention ──
{
  let clock = baseClock;
  const store = new ArchiveStore(
    root,
    "roll-count",
    { ...DEFAULT_ARCHIVE_LIMITS, maxEntries: 2 },
    () => clock,
  );
  const first = store.store("tc-count-1", [{ type: "text", text: long("1") }]);
  clock += 1;
  const second = store.store("tc-count-2", [{ type: "text", text: long("2") }]);
  clock += 1;
  const third = store.store("tc-count-3", [{ type: "text", text: long("3") }]);
  assert.ok(first && second && third, "a new candidate is admitted after count capacity is reached");
  assert.equal(store.retrieve(first!).kind, "evicted", "the deterministic oldest row is evicted");
  assert.equal(store.retrieve(second!).kind, "ok", "the newer existing row survives");
  assert.equal(store.retrieve(third!).kind, "ok", "the newly admitted row retrieves immediately");
  const index = JSON.parse(readFileSync(join(store.directory(), "index.json"), "utf8"));
  assert.equal(Object.keys(index.entries).length, 2, "entry count remains bounded");
  ok("rolling: count pressure admits new rows and evicts the deterministic oldest row");
}

// ── cycle 3: semantic recovery outranks historical masking ──
{
  let clock = baseClock;
  const store = new ArchiveStore(
    root,
    "roll-kind-priority",
    { ...DEFAULT_ARCHIVE_LIMITS, maxEntries: 2 },
    () => clock,
  );
  const historicalBlocks = [{ type: "text", text: long("historical") }];
  const initial = store.prepareBatch([
    { toolCallId: "tc-kind-semantic", blocks: historicalBlocks, kind: "historical" },
    { toolCallId: "tc-kind-old", blocks: [{ type: "text", text: long("old") }], kind: "historical" },
  ]);
  const promotedId = initial?.get("tc-kind-semantic");
  assert.ok(promotedId, "historical seed receives a reference");
  const semanticId = store.store("tc-kind-semantic", historicalBlocks);
  assert.equal(semanticId, promotedId, "semantic reuse promotes the existing live row without changing its id");
  clock += 1;
  const pressure = store.prepareBatch([
    { toolCallId: "tc-kind-new-a", blocks: [{ type: "text", text: long("new-a") }], kind: "historical" },
    { toolCallId: "tc-kind-new-b", blocks: [{ type: "text", text: long("new-b") }], kind: "historical" },
  ]);
  assert.equal(store.retrieve(promotedId!).kind, "ok", "historical pressure cannot evict the semantic recovery row");
  assert.ok(pressure && pressure.size === 1, "only one historical row survives beside the semantic row");
  const index = JSON.parse(readFileSync(join(store.directory(), "index.json"), "utf8"));
  assert.equal(index.entries[promotedId!].kind, "semantic", "promotion persists in the index");
  ok("rolling: semantic rows outrank historical rows under capacity pressure");
}

// ── cycle 4: metadata-aware digest verification ──
{
  const store = new ArchiveStore(root, "roll-verify-cache", DEFAULT_ARCHIVE_LIMITS, () => baseClock);
  const blocks = [{ type: "text", text: long("verified-a") }];
  const id = store.store("tc-verify-cache", blocks);
  assert.ok(id, "seeded v2 entry receives a reference");
  assert.equal(store.retrieve(id!).kind, "ok", "seeded entry retrieves before mutation");
  const path = join(store.directory(), `${id}.json`);
  const original = readFileSync(path, "utf8");
  const substituted = original.replace("verified-a", "verified-b");
  assert.equal(Buffer.byteLength(substituted), Buffer.byteLength(original), "substitution keeps the exact file size");
  writeFileSync(path, substituted, { mode: 0o600 });
  const reused = store.prepareBatch([{ toolCallId: "tc-verify-cache", blocks, kind: "semantic" }]);
  assert.equal(reused, null, "metadata change forces a digest recheck and fails the batch open");
  assert.equal(store.retrieve(id!).kind, "missing", "digest mismatch cannot retrieve substituted bytes");
  ok("rolling: same-size substitution invalidates prior verification");
}

// ── cycle 5: failed index commit preserves the prior live set ──
{
  const session = "roll-index-rollback";
  let clock = baseClock;
  const seed = new ArchiveStore(
    root,
    session,
    { ...DEFAULT_ARCHIVE_LIMITS, maxEntries: 1 },
    () => clock,
  );
  const seeded = seed.prepareBatch([
    { toolCallId: "tc-rollback-old", blocks: [{ type: "text", text: long("old") }], kind: "historical" },
  ]);
  const oldId = seeded?.get("tc-rollback-old");
  assert.ok(oldId, "prior live historical entry is seeded");
  clock += 1;
  const real = defaultArchiveFilesystem();
  const failing = {
    ...real,
    renameSync(from: string, to: string) {
      if (to.endsWith("/index.json")) {
        const error: NodeJS.ErrnoException = new Error("injected index commit failure");
        error.code = "EIO";
        throw error;
      }
      real.renameSync(from, to);
    },
  };
  const store = new ArchiveStore(
    root,
    session,
    { ...DEFAULT_ARCHIVE_LIMITS, maxEntries: 1 },
    () => clock,
    failing,
  );
  const failed = store.prepareBatch([
    { toolCallId: "tc-rollback-new", blocks: [{ type: "text", text: long("new") }], kind: "historical" },
  ]);
  assert.equal(failed, null, "failed index commit emits no new reference");
  const reopened = new ArchiveStore(
    root,
    session,
    { ...DEFAULT_ARCHIVE_LIMITS, maxEntries: 1 },
    () => clock,
  );
  assert.equal(reopened.retrieve(oldId!).kind, "ok", "failed replacement keeps the prior reference retrievable");
  const files = readdirSync(reopened.directory()).filter((name) => name.endsWith(".json"));
  assert.deepEqual(files.sort(), [`${oldId}.json`, "index.json"].sort(), "failed replacement removes its uncommitted entry file");
  ok("rolling: failed index commit rolls back new files and preserves prior rows");
}

// ── random generation prevents aliasing after complete local state loss ──
{
  const session = "roll-generation-reset";
  const blocks = [{ type: "text", text: long("generation") }];
  const firstStore = new ArchiveStore(root, session, DEFAULT_ARCHIVE_LIMITS, () => baseClock);
  const firstId = firstStore.store("tc-generation", blocks);
  assert.ok(firstId, "first archive state stores a reference");
  const firstIndex = JSON.parse(readFileSync(join(firstStore.directory(), "index.json"), "utf8"));
  rmSync(firstStore.directory(), { recursive: true, force: true });
  const secondStore = new ArchiveStore(root, session, DEFAULT_ARCHIVE_LIMITS, () => baseClock + 1);
  const secondId = secondStore.store("tc-generation", blocks);
  const secondIndex = JSON.parse(readFileSync(join(secondStore.directory(), "index.json"), "utf8"));
  assert.notEqual(secondIndex.generation, firstIndex.generation, "state recreation creates a distinct random generation");
  assert.ok(secondId && secondId !== firstId, "identical content cannot reuse a lost reference id after state recreation");
  assert.equal(secondStore.retrieve(firstId!).kind, "missing", "the old generation reference stays missing");
  assert.equal(secondStore.retrieve(secondId!).kind, "ok", "the new generation reference retrieves exactly");
  ok("rolling: random generation prevents aliasing after complete local state loss");
}

// ── maintenance keeps semantic priority and commits before deletion ──
{
  const session = "roll-cleanup-priority";
  let clock = baseClock;
  const wide = new ArchiveStore(root, session, { ...DEFAULT_ARCHIVE_LIMITS, maxEntries: 2 }, () => clock);
  const semanticId = wide.store("tc-cleanup-semantic", [{ type: "text", text: long("semantic") }]);
  clock += 1;
  const historical = wide.prepareBatch([
    { toolCallId: "tc-cleanup-historical", blocks: [{ type: "text", text: long("historical") }], kind: "historical" },
  ]);
  const historicalId = historical?.get("tc-cleanup-historical");
  assert.ok(semanticId && historicalId, "maintenance priority seed rows are live");
  const tight = new ArchiveStore(root, session, { ...DEFAULT_ARCHIVE_LIMITS, maxEntries: 1 }, () => clock);
  tight.cleanup();
  assert.equal(tight.retrieve(semanticId!).kind, "ok", "maintenance retains semantic recovery before historical masks");
  assert.equal(tight.retrieve(historicalId!).kind, "evicted", "maintenance evicts historical data first");
  ok("rolling: maintenance preserves semantic priority under tighter limits");
}

{
  const session = "roll-cleanup-rollback";
  let clock = baseClock;
  const wide = new ArchiveStore(root, session, { ...DEFAULT_ARCHIVE_LIMITS, maxEntries: 2 }, () => clock);
  const first = wide.prepareBatch([
    { toolCallId: "tc-cleanup-a", blocks: [{ type: "text", text: long("a") }], kind: "historical" },
    { toolCallId: "tc-cleanup-b", blocks: [{ type: "text", text: long("b") }], kind: "historical" },
  ]);
  const idA = first?.get("tc-cleanup-a");
  const idB = first?.get("tc-cleanup-b");
  assert.ok(idA && idB, "maintenance rollback seed rows are live");
  const real = defaultArchiveFilesystem();
  const failing = {
    ...real,
    renameSync(from: string, to: string) {
      if (to.endsWith("/index.json")) throw Object.assign(new Error("cleanup index failure"), { code: "EIO" });
      real.renameSync(from, to);
    },
  };
  const tight = new ArchiveStore(root, session, { ...DEFAULT_ARCHIVE_LIMITS, maxEntries: 1 }, () => clock, failing);
  tight.cleanup();
  const reopened = new ArchiveStore(root, session, { ...DEFAULT_ARCHIVE_LIMITS, maxEntries: 2 }, () => clock);
  assert.equal(reopened.retrieve(idA!).kind, "ok", "failed maintenance commit preserves the first prior file");
  assert.equal(reopened.retrieve(idB!).kind, "ok", "failed maintenance commit preserves the second prior file");
  ok("rolling: failed maintenance commit preserves the prior live set");
}

// ── stale-session startup work stops at a fixed root bound ──
{
  const real = defaultArchiveFilesystem();
  let reads = 0;
  let stats = 0;
  let closed = 0;
  const names = Array.from({ length: 129 }, (_, index) => ({ name: `stale-${index}` }));
  const fs = {
    ...real,
    opendirSync(path: string) {
      if (path !== root) return real.opendirSync(path);
      return {
        readSync() {
          const entry = names[reads] ?? null;
          reads += 1;
          return entry;
        },
        closeSync() { closed += 1; },
      };
    },
    statSync(path: string) {
      stats += 1;
      return real.statSync(path);
    },
  };
  const sweeper = new ArchiveStore(root, "roll-bounded-sweep", DEFAULT_ARCHIVE_LIMITS, () => baseClock, fs);
  sweeper.sweepStaleSessions();
  assert.equal(reads, 129, "root iteration stops after the fixed limit plus one overflow check");
  assert.equal(stats, 0, "oversized roots perform no per-session stat work");
  assert.equal(closed, 1, "bounded root iterator closes on overflow");
  ok("rolling: stale-session sweep has fixed root and child bounds");
}

// ── bounded reads and commit-before-delete retrieval removal ──
{
  const session = "roll-retrieve-rollback";
  let clock = baseClock;
  const seed = new ArchiveStore(root, session, { ...DEFAULT_ARCHIVE_LIMITS, ttlMs: 60_000 }, () => clock);
  const id = seed.store("tc-retrieve-rollback", [{ type: "text", text: long("retrieve") }]);
  assert.ok(id, "retrieval rollback seed is live");
  const path = join(seed.directory(), `${id}.json`);
  const real = defaultArchiveFilesystem();
  const failing = {
    ...real,
    renameSync(from: string, to: string) {
      if (to.endsWith("/index.json")) throw Object.assign(new Error("retrieval index failure"), { code: "EIO" });
      real.renameSync(from, to);
    },
  };
  clock += 120_000;
  const expiring = new ArchiveStore(root, session, { ...DEFAULT_ARCHIVE_LIMITS, ttlMs: 60_000 }, () => clock, failing);
  assert.equal(expiring.retrieve(id!).kind, "unavailable", "failed tombstone commit reports unavailable");
  assert.equal(existsSync(path), true, "failed tombstone commit keeps the prior entry file");
  const reopened = new ArchiveStore(root, session, { ...DEFAULT_ARCHIVE_LIMITS, ttlMs: 60_000 }, () => baseClock);
  assert.equal(reopened.retrieve(id!).kind, "ok", "the prior reference remains retrievable after failed removal commit");
  ok("rolling: retrieval commits removal before deleting entry bytes");
}

{
  const session = "roll-index-read-bound";
  const directory = join(root, session);
  mkdirSync(directory, { recursive: true, mode: 0o700 });
  writeFileSync(join(directory, "index.json"), "x".repeat(2_097_153), { mode: 0o600 });
  const real = defaultArchiveFilesystem();
  let indexReads = 0;
  const fs = {
    ...real,
    readFileSync(path: string, encoding: "utf8") {
      if (path.endsWith("/index.json")) indexReads += 1;
      return real.readFileSync(path, encoding);
    },
  };
  const store = new ArchiveStore(root, session, DEFAULT_ARCHIVE_LIMITS, () => baseClock, fs);
  assert.equal(store.prepareBatch([{ toolCallId: "tc-index-bound", blocks: [{ type: "text", text: long("index") }] }]), null,
    "oversized index fails open");
  assert.equal(indexReads, 0, "oversized index is rejected before its bytes are read");
  ok("rolling: oversized persisted index is rejected before read");
}

{
  const session = "roll-entry-read-bound";
  const blocks = [{ type: "text", text: long("entry") }];
  const seed = new ArchiveStore(root, session, DEFAULT_ARCHIVE_LIMITS, () => baseClock);
  const id = seed.store("tc-entry-bound", blocks);
  assert.ok(id, "entry read bound seed is live");
  writeFileSync(join(seed.directory(), `${id}.json`), "x".repeat(1_048_577), { mode: 0o600 });
  const real = defaultArchiveFilesystem();
  let entryReads = 0;
  const fs = {
    ...real,
    readFileSync(path: string, encoding: "utf8") {
      if (/cm2-[0-9a-f]{64}\.json$/.test(path)) entryReads += 1;
      return real.readFileSync(path, encoding);
    },
  };
  const store = new ArchiveStore(root, session, DEFAULT_ARCHIVE_LIMITS, () => baseClock, fs);
  assert.equal(store.prepareBatch([{ toolCallId: "tc-entry-bound", blocks, kind: "semantic" }]), null,
    "oversized entry metadata mismatch fails open");
  assert.equal(entryReads, 0, "oversized entry is rejected before content read");
  ok("rolling: oversized entry is rejected before read");
}

{
  const store = new ArchiveStore(
    root,
    "roll-candidate-bound",
    { ...DEFAULT_ARCHIVE_LIMITS, maxEntryBytes: 128 },
    () => baseClock,
  );
  const refs = store.prepareBatch([
    { toolCallId: "tc-candidate-bound", blocks: [{ type: "text", text: "x".repeat(1_000) }], kind: "historical" },
  ]);
  assert.ok(refs && refs.size === 0, "oversized candidate stays visible without a reference");
  assert.equal(readdirSync(store.directory()).filter((name) => /^cm2-/.test(name)).length, 0,
    "oversized candidate creates no entry file");
  ok("rolling: candidate structure is bounded before normalization");
}

{
  const store = new ArchiveStore(
    root,
    "roll-candidate-exact-bound",
    { ...DEFAULT_ARCHIVE_LIMITS, maxEntryBytes: 2_097_152, maxAggregateBytes: 4_194_304 },
    () => baseClock,
  );
  const blocks = Array.from({ length: 10_000 }, () => null);
  const id = store.store("tc-candidate-exact-bound", blocks);
  assert.ok(id, "the exact candidate-value bound remains admissible");
  assert.equal(store.retrieve(id!).kind, "ok", "the exact-bound candidate retrieves exactly");
  ok("rolling: candidate preflight has no root-node off-by-one rejection");
}

console.log(`recovery rolling tests: ${passed} groups passed`);
