/**
 * Rolling admission (cm2) recovery tests — corrective PR.
 *
 * Covers the cm2 identity shape, v2 persistence, migration, rolling
 * retention, verification, PR #9 missing-entry index repair, the bounded
 * cursor-driven stale-session sweep, and the locked retirement decision.
 *
 * Run: npx tsx test-recovery-rolling.ts
 */
import assert from "node:assert/strict";
import { createHash } from "node:crypto";
import { existsSync, mkdirSync, mkdtempSync, readdirSync, readFileSync, rmSync, symlinkSync, utimesSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import {
  ArchiveStore,
  DEFAULT_ARCHIVE_LIMITS,
  MAX_ROOT_SCAN_ENTRIES,
  MAX_SWEEP_BATCH_SESSIONS,
  MAX_SWEEP_FILESYSTEM_OPERATIONS,
  createCountingFilesystem,
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

// ── verification cache stays bounded across external live-set rotation ──
{
  const session = "roll-verification-cache";
  const limits = { ...DEFAULT_ARCHIVE_LIMITS, maxEntries: 1 };
  const writer = new ArchiveStore(root, session, limits, () => baseClock);
  const reader = new ArchiveStore(root, session, limits, () => baseClock);
  for (let index = 0; index < 20; index++) {
    const id = writer.store(`tc-cache-${index}`, [{ type: "text", text: long(`cache-${index}`) }]);
    assert.ok(id, `rotated live row ${index} admits`);
    const reused = reader.prepareBatch([{ toolCallId: `tc-cache-${index}`, blocks: [{ type: "text", text: long(`cache-${index}`) }] }]);
    assert.equal(reused?.get(`tc-cache-${index}`), id, `rotated live row ${index} verifies and reuses`);
  }
  assert.ok((reader as any).verifiedLive.size <= limits.maxEntries, "verification cache never exceeds the configured live-entry bound");
  ok("rolling: verification cache remains bounded across store instances");
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

// ── PR #9: a missing indexed entry file repairs the row and fails the batch open ──
{
  const session = "roll-missing-entry";
  const directory = join(root, session);
  const real = defaultArchiveFilesystem();
  const seed = new ArchiveStore(root, session, DEFAULT_ARCHIVE_LIMITS, () => baseClock);
  const id1 = seed.store("tc-missing-seed", [{ type: "text", text: long("missing-seed") }]);
  const id2 = seed.store("tc-missing-keep", [{ type: "text", text: long("missing-keep") }]);
  assert.ok(id1 && id2 && id1 !== id2, "two seed rows go live");
  const before = JSON.parse(readFileSync(join(directory, "index.json"), "utf8"));
  // Delete ONLY the indexed entry file; index.json must stay in place.
  real.unlinkSync(join(directory, `${id1}.json`));
  const store = new ArchiveStore(root, session, DEFAULT_ARCHIVE_LIMITS, () => baseClock);
  const refs = store.prepareBatch([{ toolCallId: "tc-missing-new", blocks: [{ type: "text", text: long("missing-new") }] }]);
  assert.equal(refs, null, "first missing pass returns null with no reference");
  const entryFiles = readdirSync(directory).filter((name) => /^cm2-/.test(name));
  assert.deepEqual(entryFiles, [`${id2}.json`], "no candidate entry file is written");
  const repaired = JSON.parse(readFileSync(join(directory, "index.json"), "utf8"));
  assert.equal(repaired.entries[id1], undefined, "the missing row is removed by the atomic repair");
  assert.ok(repaired.entries[id2] !== undefined, "the surviving row is preserved");
  assert.equal(repaired.nextSequence, before.nextSequence, "nextSequence stays unchanged through the repair");
  assert.deepEqual(
    repaired.evicted.find((removed: any) => typeof removed === "object" && removed.id === id1),
    { id: id1, reason: "evicted" },
    "the missing row is tombstoned as evicted",
  );
  assert.equal(store.retrieve(id2).kind, "ok", "the surviving row still retrieves exactly");
  assert.equal(store.retrieve(id1).kind, "evicted", "the missing row reports evicted");
  // The next pass admits a new distinct retrievable id; the old id is
  // never reused because sequences stay monotonic.
  const admitted = store.prepareBatch([{ toolCallId: "tc-missing-new", blocks: [{ type: "text", text: long("missing-new") }] }]);
  const newId = admitted?.get("tc-missing-new");
  assert.ok(newId && CM2_PATTERN.test(newId), "second pass admits without a retrieval or store restart");
  assert.notEqual(newId, id1, "the missing id is never reused");
  assert.notEqual(newId, id2, "the admitted id is distinct from the survivor");
  assert.equal(store.retrieve(newId).kind, "ok", "the admitted reference retrieves immediately");
  assert.equal(store.retrieve(id1).kind, "evicted", "the old id remains evicted");
  ok("rolling: missing indexed entry file repairs the row and fails the batch open");
}

// ── PR #9: a failed repair commit keeps the exact old index bytes ──
{
  const session = "roll-missing-commit";
  const directory = join(root, session);
  const real = defaultArchiveFilesystem();
  const seed = new ArchiveStore(root, session, DEFAULT_ARCHIVE_LIMITS, () => baseClock);
  const id1 = seed.store("tc-commit-seed", [{ type: "text", text: long("commit-seed") }]);
  const id2 = seed.store("tc-commit-keep", [{ type: "text", text: long("commit-keep") }]);
  assert.ok(id1 && id2, "failed-commit seed rows are live");
  real.unlinkSync(join(directory, `${id1}.json`));
  const before = readFileSync(join(directory, "index.json"), "utf8");
  const failing = {
    ...real,
    renameSync(from: string, to: string) {
      if (to.endsWith("/index.json")) {
        throw Object.assign(new Error("repair commit failure"), { code: "EIO" });
      }
      real.renameSync(from, to);
    },
  };
  const store = new ArchiveStore(root, session, DEFAULT_ARCHIVE_LIMITS, () => baseClock, failing);
  assert.equal(
    store.prepareBatch([{ toolCallId: "tc-commit-new", blocks: [{ type: "text", text: long("commit-new") }] }]),
    null,
    "failed repair commit returns null",
  );
  assert.equal(readFileSync(join(directory, "index.json"), "utf8"), before, "old index bytes remain exactly intact");
  assert.deepEqual(
    readdirSync(directory).filter((name) => /^cm2-/.test(name)),
    [`${id2}.json`],
    "failed repair writes no candidate file",
  );
  const reopened = new ArchiveStore(root, session, DEFAULT_ARCHIVE_LIMITS, () => baseClock);
  assert.equal(reopened.retrieve(id2).kind, "ok", "the surviving row stays retrievable after the failed commit");
  ok("rolling: failed repair commit keeps the exact old index bytes");
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

// ── sweep helpers: seed, backdate, and count retired sessions ──
function seedSweepSessions(sweepRoot: string, count: number, prefix: string): Map<string, string> {
  const seeded = new Map<string, string>();
  for (let index = 0; index < count; index++) {
    const name = `${prefix}-${String(index).padStart(4, "0")}`;
    const store = new ArchiveStore(sweepRoot, name, DEFAULT_ARCHIVE_LIMITS, () => baseClock);
    const id = store.store(`tc-${name}`, [{ type: "text", text: long(name) }]);
    assert.ok(id, `sweep seed ${name} is live`);
    seeded.set(name, id!);
  }
  return seeded;
}

function sweepSessionLockPath(sweepRoot: string, sessionKey: string): string {
  return join(sweepRoot, `.session-${sha(sessionKey)}.batch.lock`);
}

function backdateDirectory(directory: string, at: number): void {
  const seconds = at / 1000;
  utimesSync(directory, seconds, seconds);
  for (const name of readdirSync(directory)) {
    utimesSync(join(directory, name), seconds, seconds);
  }
}

function retiredSweepCount(sweepRoot: string, seeded: Map<string, string>): number {
  let retired = 0;
  for (const [name, id] of seeded) {
    const index = JSON.parse(readFileSync(join(sweepRoot, name, "index.json"), "utf8"));
    if (index.entries[id] === undefined) retired += 1;
  }
  return retired;
}

const SWEEP_TTL_MS = 60_000;
const SWEEP_STALE_AT = baseClock - 120_000;

// ── 129 stale directories progress across repeated bounded sweeps ──
{
  const sweepRoot = mkdtempSync(join(tmpdir(), "cm-roll-sweep-129-"));
  try {
    const seeded = seedSweepSessions(sweepRoot, MAX_SWEEP_BATCH_SESSIONS + 1, "p129");
    for (const name of seeded.keys()) backdateDirectory(join(sweepRoot, name), SWEEP_STALE_AT);
    const real = defaultArchiveFilesystem();
    const counting = createCountingFilesystem(real);
    let retireCommits = 0;
    const countedRename = counting.fs.renameSync;
    const fs = {
      ...counting.fs,
      renameSync(from: string, to: string) {
        if (to.endsWith("/index.json")) retireCommits += 1;
        return countedRename(from, to);
      },
    };
    const operations = (): number => Object.values(counting.counts).reduce((sum, count) => sum + count, 0);
    const resetCounts = (): void => {
      for (const key of Object.keys(counting.counts)) counting.counts[key] = 0;
    };
    const sweeper = new ArchiveStore(sweepRoot, "sweeper-129", { ...DEFAULT_ARCHIVE_LIMITS, ttlMs: SWEEP_TTL_MS }, () => baseClock, fs);
    sweeper.sweepStaleSessions();
    assert.equal(retiredSweepCount(sweepRoot, seeded), MAX_SWEEP_BATCH_SESSIONS, "first sweep retires exactly the batch size");
    assert.equal(retireCommits, MAX_SWEEP_BATCH_SESSIONS, "first sweep performs at most 128 retirement commits");
    assert.ok((counting.counts.directoryReadSync ?? 0) > 0, "directory readSync calls count toward sweep work");
    assert.ok(operations() <= MAX_SWEEP_FILESYSTEM_OPERATIONS, "first sweep stays within the filesystem operation ceiling");
    resetCounts();
    retireCommits = 0;
    sweeper.sweepStaleSessions();
    assert.equal(retiredSweepCount(sweepRoot, seeded), 129, "second sweep finishes the 129-directory root");
    assert.equal(retireCommits, 1, "second sweep retires only the remaining directory");
    assert.ok(operations() <= MAX_SWEEP_FILESYSTEM_OPERATIONS, "every sweep stays within the filesystem operation ceiling");
    const sample = [...seeded.entries()][0];
    const check = new ArchiveStore(sweepRoot, sample[0], { ...DEFAULT_ARCHIVE_LIMITS, ttlMs: SWEEP_TTL_MS }, () => baseClock);
    assert.equal(check.retrieve(sample[1]).kind, "evicted", "a retired reference reports evicted exactly");
    ok("rolling: 129 stale directories progress across two bounded sweeps");
  } finally {
    rmSync(sweepRoot, { recursive: true, force: true });
  }
}

// ── 257 stale directories progress with fixed per-sweep work ──
{
  const sweepRoot = mkdtempSync(join(tmpdir(), "cm-roll-sweep-257-"));
  try {
    const seeded = seedSweepSessions(sweepRoot, 2 * MAX_SWEEP_BATCH_SESSIONS + 1, "p257");
    for (const name of seeded.keys()) backdateDirectory(join(sweepRoot, name), SWEEP_STALE_AT);
    const real = defaultArchiveFilesystem();
    let rootReads = 0;
    let retireCommits = 0;
    const fs = {
      ...real,
      opendirSync(path: string) {
        if (path !== sweepRoot) return real.opendirSync(path);
        const directory = real.opendirSync(path);
        return {
          readSync() {
            const entry = directory.readSync();
            if (entry !== null) rootReads += 1;
            return entry;
          },
          closeSync() { directory.closeSync(); },
        };
      },
      renameSync(from: string, to: string) {
        if (to.endsWith("/index.json")) retireCommits += 1;
        return real.renameSync(from, to);
      },
    };
    const sweeper = new ArchiveStore(sweepRoot, "sweeper-257", { ...DEFAULT_ARCHIVE_LIMITS, ttlMs: SWEEP_TTL_MS }, () => baseClock, fs);
    for (let sweep = 1; sweep <= 2; sweep++) {
      rootReads = 0;
      retireCommits = 0;
      sweeper.sweepStaleSessions();
      assert.equal(retiredSweepCount(sweepRoot, seeded), MAX_SWEEP_BATCH_SESSIONS * sweep, `sweep ${sweep} retires one bounded batch`);
      assert.equal(retireCommits, MAX_SWEEP_BATCH_SESSIONS, `sweep ${sweep} commits at most 128 retirements`);
      assert.ok(rootReads <= MAX_ROOT_SCAN_ENTRIES + 1, `sweep ${sweep} root readSync stays under the ceiling`);
    }
    rootReads = 0;
    retireCommits = 0;
    sweeper.sweepStaleSessions();
    assert.equal(retiredSweepCount(sweepRoot, seeded), 257, "third sweep finishes the 257-directory root");
    assert.equal(retireCommits, 1, "third sweep retires only the remaining directory");
    assert.ok(rootReads <= MAX_ROOT_SCAN_ENTRIES + 1, "third sweep root readSync stays under the ceiling");
    ok("rolling: 257 stale directories progress across three bounded sweeps");
  } finally {
    rmSync(sweepRoot, { recursive: true, force: true });
  }
}

// ── a full fresh batch still lets later stale directories progress ──
{
  const sweepRoot = mkdtempSync(join(tmpdir(), "cm-roll-sweep-fresh-"));
  try {
    const freshSeeded = seedSweepSessions(sweepRoot, MAX_SWEEP_BATCH_SESSIONS, "fresh");
    const staleSeeded = seedSweepSessions(sweepRoot, 2, "zz-stale");
    for (const name of staleSeeded.keys()) backdateDirectory(join(sweepRoot, name), SWEEP_STALE_AT);
    const sweeper = new ArchiveStore(sweepRoot, "sweeper-fresh", { ...DEFAULT_ARCHIVE_LIMITS, ttlMs: SWEEP_TTL_MS }, () => baseClock);
    sweeper.sweepStaleSessions();
    assert.equal(retiredSweepCount(sweepRoot, freshSeeded), 0, "first sweep retires no fresh session");
    assert.equal(retiredSweepCount(sweepRoot, staleSeeded), 0, "later stale sessions wait for the next batch");
    const sample = [...freshSeeded.entries()][0];
    const freshCheck = new ArchiveStore(sweepRoot, sample[0], DEFAULT_ARCHIVE_LIMITS, () => baseClock);
    assert.equal(freshCheck.retrieve(sample[1]).kind, "ok", "fresh sessions stay fully retrievable");
    sweeper.sweepStaleSessions();
    assert.equal(retiredSweepCount(sweepRoot, staleSeeded), 2, "second sweep reaches the stale names after the cursor");
    assert.equal(retiredSweepCount(sweepRoot, freshSeeded), 0, "fresh sessions are never retired");
    ok("rolling: a full fresh batch still lets later stale directories progress");
  } finally {
    rmSync(sweepRoot, { recursive: true, force: true });
  }
}

// ── stale sweeps never follow a session-directory symlink ──
if (process.platform !== "win32") {
  const sweepRoot = mkdtempSync(join(tmpdir(), "cm-roll-sweep-link-"));
  const outsideRoot = mkdtempSync(join(tmpdir(), "cm-roll-sweep-outside-"));
  try {
    const outside = new ArchiveStore(outsideRoot, "outside-target", DEFAULT_ARCHIVE_LIMITS, () => baseClock);
    const id = outside.store("tc-outside", [{ type: "text", text: long("outside") }]);
    assert.ok(id, "outside target seed is live");
    backdateDirectory(outside.directory(), SWEEP_STALE_AT);
    symlinkSync(outside.directory(), join(sweepRoot, "linked-target"), "dir");
    const sweeper = new ArchiveStore(sweepRoot, "link-sweeper", { ...DEFAULT_ARCHIVE_LIMITS, ttlMs: SWEEP_TTL_MS }, () => baseClock);
    sweeper.sweepStaleSessions();
    assert.equal(outside.retrieve(id!).kind, "ok", "stale cleanup never changes a symlink target outside the root");
    ok("rolling: stale sweeps never follow session-directory symlinks");
  } finally {
    rmSync(sweepRoot, { recursive: true, force: true });
    rmSync(outsideRoot, { recursive: true, force: true });
  }
}

// ── sweep wraparound re-selects the cursor name when it goes stale again ──
{
  const sweepRoot = mkdtempSync(join(tmpdir(), "cm-roll-sweep-wrap-"));
  try {
    const seeded = new Map<string, string>();
    for (const name of ["wrap-a", "wrap-b"]) {
      const store = new ArchiveStore(sweepRoot, name, DEFAULT_ARCHIVE_LIMITS, () => baseClock);
      seeded.set(name, store.store(`tc-${name}`, [{ type: "text", text: long(name) }])!);
    }
    for (const name of seeded.keys()) backdateDirectory(join(sweepRoot, name), SWEEP_STALE_AT);
    const real = defaultArchiveFilesystem();
    let retireCommits = 0;
    const fs = {
      ...real,
      renameSync(from: string, to: string) {
        if (to.endsWith("/index.json")) retireCommits += 1;
        return real.renameSync(from, to);
      },
    };
    const sweeper = new ArchiveStore(sweepRoot, "wrap-sweeper", { ...DEFAULT_ARCHIVE_LIMITS, ttlMs: SWEEP_TTL_MS }, () => baseClock, fs);
    sweeper.sweepStaleSessions();
    assert.equal(retireCommits, 2, "first sweep retires both stale sessions");
    // wrap-b is the committed cursor (the lexically last selected name).
    // Make it stale again: the next sweep's wraparound must include the
    // cursor name itself so no name starves between rounds.
    backdateDirectory(join(sweepRoot, "wrap-b"), SWEEP_STALE_AT);
    retireCommits = 0;
    sweeper.sweepStaleSessions();
    assert.equal(retireCommits, 1, "wraparound re-selects the cursor name when it is stale again");
    const check = new ArchiveStore(sweepRoot, "wrap-b", DEFAULT_ARCHIVE_LIMITS, () => baseClock);
    assert.equal(check.retrieve(seeded.get("wrap-b")!).kind, "evicted", "the cursor session keeps its exact retired state");
    ok("rolling: sweep wraparound includes the cursor name");
  } finally {
    rmSync(sweepRoot, { recursive: true, force: true });
  }
}

// ── refresh interleaving before the target lock skips retirement ──
{
  const sweepRoot = mkdtempSync(join(tmpdir(), "cm-roll-sweep-race-"));
  try {
    const targetDir = join(sweepRoot, "race-target");
    const target = new ArchiveStore(sweepRoot, "race-target", DEFAULT_ARCHIVE_LIMITS, () => baseClock);
    const oldId = target.store("tc-race-old", [{ type: "text", text: long("race-old") }]);
    assert.ok(oldId, "race target seed is live");
    backdateDirectory(targetDir, SWEEP_STALE_AT);
    const real = defaultArchiveFilesystem();
    const targetLock = sweepSessionLockPath(sweepRoot, "race-target");
    let refreshed = false;
    let refreshedId: string | null = null;
    // Interleave a normal concurrent writer after the preliminary
    // unlocked scan but before the retiring store creates its target
    // batch lock: intercept that one outer lock mkdir and let a real
    // ArchiveStore writer (real filesystem, its own locking) admit a
    // fresh entry first. No index or entry bytes are written by hand.
    const fs = {
      ...real,
      mkdirSync(path: string, options?: { recursive?: boolean; mode?: number }) {
        if (path === targetLock && !refreshed) {
          refreshed = true;
          const writer = new ArchiveStore(sweepRoot, "race-target", DEFAULT_ARCHIVE_LIMITS, () => baseClock);
          refreshedId = writer.store("tc-race-refresh", [{ type: "text", text: long("race-refresh") }]);
        }
        return real.mkdirSync(path, options);
      },
    };
    const sweeper = new ArchiveStore(sweepRoot, "race-sweeper", { ...DEFAULT_ARCHIVE_LIMITS, ttlMs: SWEEP_TTL_MS }, () => baseClock, fs);
    sweeper.sweepStaleSessions();
    assert.equal(refreshed, true, "the interleaved writer runs before the target lock exists");
    assert.ok(refreshedId && CM2_PATTERN.test(refreshedId), "the interleaved writer admits a new cm2 entry");
    assert.notEqual(refreshedId, oldId, "the refreshed entry is a distinct admission");
    const check = new ArchiveStore(sweepRoot, "race-target", DEFAULT_ARCHIVE_LIMITS, () => baseClock);
    assert.equal(check.retrieve(oldId!).kind, "ok", "the pre-race entry stays retrievable");
    assert.equal(check.retrieve(refreshedId!).kind, "ok", "the returned new ID retrieves exactly after the sweep");
    ok("rolling: refresh interleaving before the target lock skips retirement");
  } finally {
    rmSync(sweepRoot, { recursive: true, force: true });
  }
}

// ── focused sweep failures: target lock, root release, cursor commit ──
{
  const sweepRoot = mkdtempSync(join(tmpdir(), "cm-roll-sweep-lockfail-"));
  try {
    const target = new ArchiveStore(sweepRoot, "zz-lockfail-target", DEFAULT_ARCHIVE_LIMITS, () => baseClock);
    const id = target.store("tc-lockfail", [{ type: "text", text: long("lockfail") }]);
    assert.ok(id, "lock-failure seed is live");
    backdateDirectory(join(sweepRoot, "zz-lockfail-target"), SWEEP_STALE_AT);
    const real = defaultArchiveFilesystem();
    const fs = {
      ...real,
      mkdirSync(path: string, options?: { recursive?: boolean; mode?: number }) {
        if (path === sweepSessionLockPath(sweepRoot, "zz-lockfail-target")) {
          throw Object.assign(new Error("lock refused"), { code: "EIO" });
        }
        return real.mkdirSync(path, options);
      },
    };
    const sweeper = new ArchiveStore(sweepRoot, "lockfail-sweeper", { ...DEFAULT_ARCHIVE_LIMITS, ttlMs: SWEEP_TTL_MS }, () => baseClock, fs);
    sweeper.sweepStaleSessions();
    const check = new ArchiveStore(sweepRoot, "zz-lockfail-target", DEFAULT_ARCHIVE_LIMITS, () => baseClock);
    assert.equal(check.retrieve(id!).kind, "ok", "an unlockable target stays fully retrievable");
    ok("rolling: target lock acquisition failure fails retirement open");
  } finally {
    rmSync(sweepRoot, { recursive: true, force: true });
  }
}

{
  const sweepRoot = mkdtempSync(join(tmpdir(), "cm-roll-sweep-releasefail-"));
  try {
    const target = new ArchiveStore(sweepRoot, "zz-releasefail-target", DEFAULT_ARCHIVE_LIMITS, () => baseClock);
    const id = target.store("tc-releasefail", [{ type: "text", text: long("releasefail") }]);
    assert.ok(id, "release-failure seed is live");
    backdateDirectory(join(sweepRoot, "zz-releasefail-target"), SWEEP_STALE_AT);
    const real = defaultArchiveFilesystem();
    const fs = {
      ...real,
      rmdirSync(path: string) {
        if (path === join(sweepRoot, "root.lock")) throw new Error("root lock release refused");
        return real.rmdirSync(path);
      },
    };
    const sweeper = new ArchiveStore(sweepRoot, "releasefail-sweeper", { ...DEFAULT_ARCHIVE_LIMITS, ttlMs: SWEEP_TTL_MS }, () => baseClock, fs);
    sweeper.sweepStaleSessions();
    assert.equal(
      JSON.parse(real.readFileSync(join(sweepRoot, "sweep.state"), "utf8")).cursor,
      "zz-releasefail-target",
      "the cursor still commits before the release attempt",
    );
    assert.equal(target.retrieve(id!).kind, "ok", "a failed root release skips retirement");
    ok("rolling: root lock release failure skips retirement");
  } finally {
    rmSync(sweepRoot, { recursive: true, force: true });
  }
}

{
  const sweepRoot = mkdtempSync(join(tmpdir(), "cm-roll-sweep-statefail-"));
  try {
    const target = new ArchiveStore(sweepRoot, "zz-statefail-target", DEFAULT_ARCHIVE_LIMITS, () => baseClock);
    const id = target.store("tc-statefail", [{ type: "text", text: long("statefail") }]);
    assert.ok(id, "state-failure seed is live");
    backdateDirectory(join(sweepRoot, "zz-statefail-target"), SWEEP_STALE_AT);
    const real = defaultArchiveFilesystem();
    const fs = {
      ...real,
      renameSync(from: string, to: string) {
        if (to.endsWith("/sweep.state")) throw new Error("cursor commit refused");
        return real.renameSync(from, to);
      },
    };
    const sweeper = new ArchiveStore(sweepRoot, "statefail-sweeper", { ...DEFAULT_ARCHIVE_LIMITS, ttlMs: SWEEP_TTL_MS }, () => baseClock, fs);
    sweeper.sweepStaleSessions();
    assert.equal(existsSync(join(sweepRoot, "sweep.state")), false, "a failed cursor commit persists no state");
    const check = new ArchiveStore(sweepRoot, "zz-statefail-target", DEFAULT_ARCHIVE_LIMITS, () => baseClock);
    assert.equal(check.retrieve(id!).kind, "ok", "a failed cursor commit skips retirement");
    ok("rolling: sweep cursor commit failure skips retirement");
  } finally {
    rmSync(sweepRoot, { recursive: true, force: true });
  }
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
