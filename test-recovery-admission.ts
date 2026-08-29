/**
 * Recovery admission-closure and live-reference validation tests
 * (independent review corrections).
 *
 * Covers: persisted admissionClosed after entry-count or aggregate-byte
 * capacity rejection, closure survival across fresh ArchiveStore
 * instances and tombstone-list overflow, deterministic eviction to
 * changed limits, TTL expiry remaining allowed while closed, and
 * validation of reused live references (id, blocks array, createdAt,
 * exact byte count, readability) with the per-instance verification
 * cache. Invalid or unreadable live content must make the batch fail
 * open so caller content stays visible.
 *
 * Run: npx tsx test-recovery-admission.ts
 */
import assert from "node:assert/strict";
import { mkdtempSync, readFileSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import {
  ArchiveStore,
  DEFAULT_ARCHIVE_LIMITS,
  defaultArchiveFilesystem,
  deriveArchiveId,
} from "./filters/recovery.js";
import { compressStaleToolResults, resolveRules, emptyUserConfig } from "./filters/context-compress.js";

let passed = 0;
function ok(name: string) {
  passed++;
  console.log(`PASS ${name}`);
}

const root = mkdtempSync(join(tmpdir(), "cm-recovery-admission-"));
const baseClock = 1_700_000_000_000;
const long = (mark: string) => `${mark} ${"payload ".repeat(30)}\n`.repeat(3);

process.on("exit", () => {
  try { require("node:fs").rmSync(root, { recursive: true, force: true }); } catch { /* ignore */ }
});

function makeStore(
  sessionKey: string,
  limits?: Partial<typeof DEFAULT_ARCHIVE_LIMITS>,
  fs?: any,
  now: () => number = () => baseClock,
) {
  return new ArchiveStore(root, sessionKey, { ...DEFAULT_ARCHIVE_LIMITS, ...limits }, now, fs);
}

function readIndexFile(real: ReturnType<typeof defaultArchiveFilesystem>, sessionKey: string): any {
  return JSON.parse(real.readFileSync(join(root, sessionKey, "index.json"), "utf8"));
}

// --- entry-count pressure rolls admission forward persistently ---
{
  const real = defaultArchiveFilesystem();
  const store = makeStore("admit-count", { maxEntries: 2 });
  const seeded = store.prepareBatch([
    { toolCallId: "tc-a", blocks: [{ type: "text", text: long("a") }] },
    { toolCallId: "tc-b", blocks: [{ type: "text", text: long("b") }] },
  ]);
  assert.ok(seeded && seeded.size === 2, "seeding succeeds under capacity");
  const idA = seeded!.get("tc-a")!;
  const idB = seeded!.get("tc-b")!;
  const refs = store.prepareBatch([
    { toolCallId: "tc-a", blocks: [{ type: "text", text: long("a") }] },
    { toolCallId: "tc-b", blocks: [{ type: "text", text: long("b") }] },
    { toolCallId: "tc-c", blocks: [{ type: "text", text: long("c") }] },
  ]);
  assert.ok(refs, "batch under capacity pressure succeeds");
  assert.equal(refs!.size, 2, "the entry cap holds");
  assert.ok(refs!.has("tc-c"), "the newer candidate wins a slot");
  assert.ok(refs!.has("tc-b"), "the newer existing row survives");
  assert.ok(!refs!.has("tc-a"), "the oldest row is displaced without a reference");
  assert.equal(store.retrieve(idA).kind, "evicted", "the displaced row keeps its distinct evicted state");
  // A still-live row reuses its exact reference.
  const reuse = store.prepareBatch([
    { toolCallId: "tc-b", blocks: [{ type: "text", text: long("b") }] },
  ]);
  assert.equal(reuse!.get("tc-b"), idB, "a live row reuses its exact reference");
  const persisted = readIndexFile(real, "admit-count");
  assert.equal(persisted.v, 2, "the rolling index persists");
  assert.equal(Object.keys(persisted.entries).length, 2, "persisted entry count stays at the cap");
  // A fresh instance keeps rolling: a new id is admitted, not refused.
  const fresh = makeStore("admit-count", { maxEntries: 2 });
  const rolledNew = fresh.prepareBatch([
    { toolCallId: "tc-brand-new", blocks: [{ type: "text", text: long("n") }] },
  ]);
  assert.ok(rolledNew && rolledNew.size === 1, "rolling admission persists across fresh instances");
  assert.equal(fresh.retrieve(rolledNew!.get("tc-brand-new")!).kind, "ok", "the fresh admission retrieves");
  ok("admission: entry-count pressure rolls admission forward across fresh instances");
}

// --- more than 512 removals: tombstone rollover stays bounded and never repoints ids ---
{
  const session = "admit-overflow";
  const real = defaultArchiveFilesystem();
  let clock = baseClock;
  const store = makeStore(session, { maxEntries: 4 }, real, () => clock);
  const seedBatch = Array.from({ length: 4 }, (_, i) => ({
    toolCallId: `tc-seed-${i}`,
    blocks: [{ type: "text", text: long(`s${i}`) }],
  }));
  const seeded = store.prepareBatch(seedBatch);
  assert.ok(seeded && seeded.size === 4, "four seeded rows go live");
  const seedIds = [...seeded!.values()];
  // Replacing every seed with fresh content tombstones all four known ids.
  clock += 1;
  const replaceBatch = Array.from({ length: 4 }, (_, i) => ({
    toolCallId: `tc-next-${i}`,
    blocks: [{ type: "text", text: long(`n${i}`) }],
  }));
  const replaced = store.prepareBatch(replaceBatch);
  assert.ok(replaced && replaced.size === 4, "four replacement rows go live");
  for (const id of seedIds) {
    assert.equal(store.retrieve(id).kind, "evicted", "the displaced seed reports evicted while tombstoned");
  }
  // More than 512 further removals overflow the bounded tombstone list.
  clock += 1;
  const flood = Array.from({ length: 600 }, (_, i) => ({
    toolCallId: `tc-flood-${i}`,
    blocks: [{ type: "text", text: long(`o${i}`) }],
  }));
  const flooded = store.prepareBatch(flood);
  assert.ok(flooded && flooded.size === 4, "cap 4 holds after the flood");
  for (const id of flooded!.values()) {
    assert.equal(store.retrieve(id).kind, "ok", "every emitted reference retrieves");
  }
  const index = readIndexFile(real, session);
  assert.equal(Object.keys(index.entries).length, 4, "persisted entries stay at the cap");
  // Rejected candidates consume no tombstone: only live-row evictions
  // append removal records, so the list stays far below the bound here.
  assert.equal(index.evicted.length, 8, "only live-row evictions append tombstones");
  for (const id of seedIds) {
    assert.equal(store.retrieve(id).kind, "evicted", "the displaced seed keeps its tombstoned state");
  }
  // Fresh-instance validation cache runs while the flood survivors are
  // still the exact live set, so the warm pass performs pure reuse.
  const counting = defaultArchiveFilesystem();
  let entryReads = 0;
  const countingFs = { ...counting, readFileSync: (path: string, encoding: "utf8") => {
    if (/\/(?:cm-[0-9a-f]{16}|cm2-[0-9a-f]{64})\.json$/.test(path)) entryReads += 1;
    return counting.readFileSync(path, encoding);
  } };
  const cached = makeStore(session, { maxEntries: 4 }, countingFs);
  const liveOnly = flood.filter((candidate) => flooded!.has(candidate.toolCallId));
  const warm = cached.prepareBatch(liveOnly);
  assert.ok(warm && warm.size === 4, "live-only warm pass reuses every row");
  const readsAfterWarm = entryReads;
  const again = cached.prepareBatch(liveOnly);
  assert.ok(again && again.size === 4);
  assert.equal(entryReads - readsAfterWarm, 0, "cached validation does not reread live content");
  // Genuine rollover past 512 removals driven only by live-row
  // evictions: repeated full batches keep rolling the window forward.
  let rollClock = clock;
  const roller = makeStore(session, { maxEntries: 4 }, real, () => rollClock);
  for (let round = 0; round < 130; round++) {
    rollClock += 1;
    const rolled = roller.prepareBatch(Array.from({ length: 5 }, (_, i) => ({
      toolCallId: `tc-roll-${round}-${i}`,
      blocks: [{ type: "text", text: long(`r${round}-${i}`) }],
    })));
    assert.ok(rolled, `rollover round ${round} succeeds`);
  }
  const rolledIndex = readIndexFile(real, session);
  assert.equal(rolledIndex.evicted.length, 512, "the tombstone list is bounded at 512 after overflow");
  // The oldest tombstones rolled off: those ids are simply unknown now.
  // Rolling ids are sequence-bound, so a rolled-off id can never repoint.
  assert.equal(store.retrieve(seedIds[0]).kind, "missing", "a rolled-off tombstone reads as missing, never recreated");
  // Re-admission after rollover: the same content consumes a fresh
  // sequence, never the rolled-off reference.
  const readmitted = roller.prepareBatch([seedBatch[0]]);
  assert.ok(readmitted, "re-admission batch succeeds after rollover");
  const readmitId = readmitted!.get("tc-seed-0");
  assert.ok(readmitId && !seedIds.includes(readmitId), "re-admitted content receives a brand-new rolling reference");
  assert.equal(roller.retrieve(readmitId!).kind, "ok", "the new reference retrieves");
  ok("admission: 512+ removals roll tombstones over without ever repointing an id");
}

// --- existing rows over changed limits: deterministic eviction, admission keeps rolling ---
{
  const real = defaultArchiveFilesystem();
  let clock = baseClock;
  const seed = makeStore("admit-tighten", { maxEntries: 3 }, real, () => clock);
  const ids: string[] = [];
  for (let i = 0; i < 3; i++) {
    clock += 10;
    ids.push(seed.store(`tc-t${i}`, [{ type: "text", text: long(`t${i}`) }])!);
  }
  // Same directory, tighter limits: the oldest existing rows are evicted
  // deterministically down to the new cap and admission keeps rolling.
  const tighter = makeStore("admit-tighten", { maxEntries: 2 }, real, () => clock);
  const refs = tighter.prepareBatch([
    { toolCallId: "tc-t0", blocks: [{ type: "text", text: long("t0") }] },
    { toolCallId: "tc-t1", blocks: [{ type: "text", text: long("t1") }] },
    { toolCallId: "tc-t2", blocks: [{ type: "text", text: long("t2") }] },
  ]);
  assert.ok(refs && refs.size === 2, "eviction to the new limit keeps two live rows");
  assert.ok(!refs!.has("tc-t0"), "oldest existing row is evicted deterministically");
  assert.equal(tighter.retrieve(ids[0]).kind, "evicted", "evicted row reports evicted");
  assert.equal(tighter.retrieve(ids[2]).kind, "ok", "newest rows survive the tightened limit");
  assert.equal(Object.keys(readIndexFile(real, "admit-tighten").entries).length, 2,
    "the persisted entry set compacts to the new cap");
  const after = tighter.store("tc-t-new", [{ type: "text", text: long("x") }]);
  assert.ok(after, "a new semantic id still wins a slot after tightening");
  assert.ok(!ids.includes(after!), "the new admission uses a distinct rolling reference");
  assert.equal(tighter.retrieve(after!).kind, "ok", "the post-tightening admission retrieves exactly");
  ok("admission: changed limits evict deterministically and admission keeps rolling");
}

// --- changed aggregate limits evict older bytes; rolling admission refills them ---
{
  const real = defaultArchiveFilesystem();
  let clock = baseClock;
  const session = "admit-tighten-bytes";
  const seed = makeStore(session, { maxEntries: 10, maxAggregateBytes: 8_192 }, real, () => clock);
  const idA = seed.store("tc-large-a", [{ type: "text", text: long("a") }])!;
  clock += 1;
  const idB = seed.store("tc-large-b", [{ type: "text", text: long("b") }])!;
  const initial = readIndexFile(real, session);
  const rowBytes = Object.values(initial.entries).map((entry: any) => entry.bytes as number);
  const tightenedBytes = Math.max(...rowBytes) + 300;
  const tighter = makeStore(
    session,
    { maxEntries: 10, maxAggregateBytes: tightenedBytes },
    real,
    () => clock,
  );
  const refs = tighter.prepareBatch([
    { toolCallId: "tc-large-a", blocks: [{ type: "text", text: long("a") }] },
    { toolCallId: "tc-large-b", blocks: [{ type: "text", text: long("b") }] },
    { toolCallId: "tc-small-new", blocks: [{ type: "text", text: "small" }] },
  ]);
  assert.ok(refs && refs.size === 2, "the tighter byte cap keeps the newest large row plus the small row");
  assert.ok(refs!.has("tc-large-b"), "the newest large row survives the tighter byte limit");
  assert.ok(refs!.has("tc-small-new"), "a small candidate reuses bytes freed by limit eviction");
  assert.ok(!refs!.has("tc-large-a"), "the older large row loses its bytes deterministically");
  assert.equal(tighter.retrieve(idA).kind, "evicted", "the displaced large row reports evicted");
  assert.equal(tighter.retrieve(idB).kind, "ok", "the surviving large row stays retrievable");
  assert.equal(tighter.retrieve(refs!.get("tc-small-new")!).kind, "ok", "the refilled slot retrieves exactly");
  ok("admission: changed byte limits evict older bytes and rolling admission refills them");
}

// --- aggregate-byte capacity pressure keeps rolling admission ---
{
  const real = defaultArchiveFilesystem();
  const store = makeStore("admit-bytes", { maxEntries: 10, maxAggregateBytes: 4_096 });
  const entries = 8; // each entry is ~700 bytes, so 8 exceeds 4 KiB
  const candidates = Array.from({ length: entries }, (_, i) => ({
    toolCallId: `tc-b${i}`,
    blocks: [{ type: "text", text: long(`b${i}`) }],
  }));
  const refs = store.prepareBatch(candidates);
  assert.ok(refs, "batch succeeds while rejecting by aggregate bytes");
  assert.ok(refs!.size < entries, "aggregate-byte capacity rejected at least one candidate");
  const persisted = readIndexFile(real, "admit-bytes");
  assert.equal(Object.keys(persisted.entries).length, refs!.size, "persisted entries match the byte-bounded live set");
  let totalBytes = Object.values(persisted.entries).reduce((sum: number, entry: any) => sum + entry.bytes, 0);
  assert.ok(totalBytes <= 4_096, "the live set respects the aggregate cap");
  const next = store.prepareBatch([{ toolCallId: "tc-b-extra", blocks: [{ type: "text", text: long("e") }] }]);
  assert.ok(next && next.size === 1, "a later candidate still admits after byte pressure");
  const nextId = next!.get("tc-b-extra")!;
  assert.equal(store.retrieve(nextId).kind, "ok", "the later admission retrieves exactly");
  totalBytes = Object.values(readIndexFile(real, "admit-bytes").entries).reduce((sum: number, entry: any) => sum + entry.bytes, 0);
  assert.ok(totalBytes <= 4_096, "rolling eviction keeps the aggregate cap after the later admission");
  ok("admission: aggregate-byte pressure keeps rolling within the cap");
}

// --- TTL expiry runs before rolling admission ---
{
  const real = defaultArchiveFilesystem();
  let clock = baseClock;
  const store = makeStore("admit-ttl", { maxEntries: 1, ttlMs: 60_000 }, real, () => clock);
  const seeded = store.prepareBatch([
    { toolCallId: "tc-keep", blocks: [{ type: "text", text: long("l") }] },
  ]);
  const keepId = seeded?.get("tc-keep");
  assert.ok(keepId, "one live row starts under capacity");
  clock += 1;
  const pressured = store.prepareBatch([
    { toolCallId: "tc-drop", blocks: [{ type: "text", text: long("d") }] },
  ]);
  const dropId = pressured?.get("tc-drop");
  assert.ok(dropId && dropId !== keepId, "newer work replaces the older row at capacity");
  assert.equal(store.retrieve(keepId!).kind, "evicted", "the displaced reference keeps its eviction outcome");
  clock += 120_000;
  const afterExpiry = store.prepareBatch([
    { toolCallId: "tc-after-ttl", blocks: [{ type: "text", text: long("n") }] },
  ]);
  const afterId = afterExpiry?.get("tc-after-ttl");
  assert.ok(afterId && afterId !== dropId, "TTL removal admits a distinct new reference in the same batch");
  assert.equal(store.retrieve(dropId!).kind, "expired", "the expired reference keeps its distinct outcome");
  assert.equal(store.retrieve(afterId!).kind, "ok", "the post-TTL reference retrieves immediately");
  assert.equal(Object.keys(readIndexFile(real, "admit-ttl").entries).length, 1, "TTL-first rolling retention stays bounded");
  ok("admission: TTL expiry runs before rolling admission");
}

// ── Live reference validation ──

function seedOne(session: string, toolCallId: string): string {
  const store = makeStore(session);
  const id = store.store(toolCallId, [{ type: "text", text: long("v") }]);
  assert.ok(id, "seeding must succeed");
  return id!;
}

const invalidLiveCases: Array<{ name: string; mutate: (real: ReturnType<typeof defaultArchiveFilesystem>, dir: string, id: string) => void }> = [
  {
    name: "truncated-json",
    mutate: (_real, dir, id) => {
      writeFileSync(join(dir, `${id}.json`), "{truncated", { mode: 0o600 });
    },
  },
  {
    name: "unsupported-version",
    mutate: (real, dir, id) => {
      const parsed = JSON.parse(real.readFileSync(join(dir, `${id}.json`), "utf8"));
      parsed.v = 3;
      writeFileSync(join(dir, `${id}.json`), JSON.stringify(parsed), { mode: 0o600 });
    },
  },
  {
    name: "mismatched-id",
    mutate: (real, dir, id) => {
      const parsed = JSON.parse(real.readFileSync(join(dir, `${id}.json`), "utf8"));
      parsed.id = "cm-00000000000000ff";
      writeFileSync(join(dir, `${id}.json`), JSON.stringify(parsed), { mode: 0o600 });
    },
  },
  {
    name: "blocks-not-array",
    mutate: (real, dir, id) => {
      const parsed = JSON.parse(real.readFileSync(join(dir, `${id}.json`), "utf8"));
      parsed.blocks = { type: "text" };
      writeFileSync(join(dir, `${id}.json`), JSON.stringify(parsed), { mode: 0o600 });
    },
  },
  {
    name: "created-at-mismatch",
    mutate: (real, dir, id) => {
      const parsed = JSON.parse(real.readFileSync(join(dir, `${id}.json`), "utf8"));
      parsed.createdAt += 1;
      writeFileSync(join(dir, `${id}.json`), JSON.stringify(parsed), { mode: 0o600 });
    },
  },
  {
    name: "byte-count-mismatch",
    mutate: (real, dir, id) => {
      const raw = real.readFileSync(join(dir, `${id}.json`), "utf8");
      writeFileSync(join(dir, `${id}.json`), raw + " ", { mode: 0o600 });
    },
  },
  {
    name: "directory-collision",
    mutate: (real, dir, id) => {
      real.unlinkSync(join(dir, `${id}.json`));
      real.mkdirSync(join(dir, `${id}.json`), { recursive: false, mode: 0o700 });
    },
  },
  {
    name: "unreadable-file",
    mutate: (real, dir, id) => {
      writeFileSync(join(dir, `${id}.json`), "", { mode: 0o600 });
      real.chmodSync(join(dir, `${id}.json`), 0o000);
    },
  },
];

for (const failure of invalidLiveCases) {
  const session = `live-invalid-${failure.name}`;
  const real = defaultArchiveFilesystem();
  const id = seedOne(session, "tc-live");
  failure.mutate(real, join(root, session), id);
  // A fresh ArchiveStore must validate the reused live reference before
  // emitting it; any invalid content makes the whole batch fail open.
  const store = makeStore(session, undefined, real);
  const refs = store.prepareBatch([{ toolCallId: "tc-live", blocks: [{ type: "text", text: long("v") }] }]);
  assert.equal(refs, null, `${failure.name}: invalid live content fails the batch open`);
  ok(`live validation: ${failure.name} makes the batch return null`);
}

// --- no invalid placeholder reaches the caller through the context pass ---
{
  const rules = resolveRules(emptyUserConfig());
  const session = "live-invalid-context";
  const real = defaultArchiveFilesystem();
  const id = seedOne(session, "call-1");
  writeFileSync(join(root, session, `${id}.json`), "{broken", { mode: 0o600 });
  const store = makeStore(session, undefined, real);
  const messages: any[] = [
    { role: "user", content: [{ type: "text", text: "turn" }] },
    {
      role: "toolResult",
      toolCallId: "call-1",
      toolName: "bash",
      isError: false,
      details: { command: "echo 1" },
      content: [{ type: "text", text: long("v") }],
    },
  ];
  const result = compressStaleToolResults(messages, {
    thresholds: [0.3],
    coverage: [1],
    contextUsage: 1,
    previousCutoff: 0,
    zoneEntered: -1,
    rules,
    archiveBatch: { prepareBatch: (candidates) => store.prepareBatch(candidates) },
  });
  assert.equal(result, null, "corrupt live reference masks nothing");
  assert.equal(
    (messages[1].content as any[])[0].text,
    long("v"),
    "original content stays visible with no invalid placeholder",
  );
  ok("live validation: corrupt live reference emits no placeholder through the context pass");
}

// --- a missing indexed file fails the context batch open ---
{
  const rules = resolveRules(emptyUserConfig());
  const session = "live-missing-context";
  const real = defaultArchiveFilesystem();
  const id = seedOne(session, "call-missing");
  real.unlinkSync(join(root, session, `${id}.json`));
  const store = makeStore(session, undefined, real);
  const messages: any[] = [
    { role: "user", content: [{ type: "text", text: "turn" }] },
    { role: "toolResult", toolCallId: "call-missing", toolName: "bash", isError: false, details: { command: "echo missing" }, content: [{ type: "text", text: long("missing") }] },
    { role: "user", content: [{ type: "text", text: "end" }] },
  ];
  const original = JSON.stringify(messages);
  const result = compressStaleToolResults(messages, {
    thresholds: [0.3], coverage: [1], contextUsage: 1, previousCutoff: 0, zoneEntered: -1, rules,
    archiveBatch: { prepareBatch: (candidates) => store.prepareBatch(candidates) },
  });
  assert.equal(result, null, "missing indexed content emits no historical placeholder");
  assert.equal(JSON.stringify(messages), original, "missing indexed content leaves original redacted content visible");
  ok("live validation: missing indexed file fails the context batch open");
}

// --- validation cache: writes enter the cache, repeats do not reread ---
{
  const real = defaultArchiveFilesystem();
  let entryReads = 0;
  const fs = { ...real, readFileSync: (path: string, encoding: "utf8") => {
    if (/\/(?:cm-[0-9a-f]{16}|cm2-[0-9a-f]{64})\.json$/.test(path)) entryReads += 1;
    return real.readFileSync(path, encoding);
  } };
  const store = makeStore("live-cache", undefined, fs);
  const candidates = [
    { toolCallId: "tc-c1", blocks: [{ type: "text", text: long("c1") }] },
    { toolCallId: "tc-c2", blocks: [{ type: "text", text: long("c2") }] },
  ];
  const first = store.prepareBatch(candidates);
  assert.ok(first && first.size === 2);
  // Each new write performs exactly one entry read: its verify readback.
  assert.equal(entryReads, 2, "newly verified writes enter the cache without a second read");
  const second = store.prepareBatch(candidates);
  assert.ok(second && second.size === 2);
  assert.equal(entryReads, 2, "repeated passes validate from the cache without rereading");
  ok("live validation: verified writes enter the per-instance cache");
}

// --- selection defers sequence, id, and tombstone allocation to survivors ---
{
  const real = defaultArchiveFilesystem();
  const store = makeStore("admit-selection", { maxEntries: 4 }, real);
  const batch = (count: number) => Array.from({ length: count }, (_, i) => ({
    toolCallId: `tc-sel-${i}`,
    blocks: [{ type: "text", text: long(`sel${i}`) }],
  }));
  const first = store.prepareBatch(batch(8));
  assert.ok(first && first.size === 4, "capacity 4 holds");
  for (let i = 4; i < 8; i++) {
    assert.ok(first!.has(`tc-sel-${i}`), `raw position ${i} wins a slot`);
  }
  for (let i = 0; i < 4; i++) {
    assert.ok(!first!.has(`tc-sel-${i}`), `rejected position ${i} stays visible with no reference`);
  }
  const persisted = readIndexFile(real, "admit-selection");
  assert.equal(persisted.nextSequence, 5, "rejected candidates consume no persisted sequence");
  assert.equal(persisted.evicted.length, 0, "rejected candidates leave no removal record");
  // An identical repeated batch must be byte-identical and perform zero
  // entry or index writes and renames while keeping every id stable.
  const idsBefore = Object.keys(persisted.entries).sort().join(",");
  const counting = defaultArchiveFilesystem();
  let writes = 0;
  let renames = 0;
  const countingFs = {
    ...counting,
    writeFileSync: (path: string, data: string, options?: { mode?: number }) => {
      writes += 1;
      return counting.writeFileSync(path, data, options);
    },
    renameSync: (from: string, to: string) => {
      renames += 1;
      return counting.renameSync(from, to);
    },
  };
  const repeatStore = makeStore("admit-selection", { maxEntries: 4 }, countingFs);
  const second = repeatStore.prepareBatch(batch(8));
  assert.ok(second && second.size === 4, "identical repeat keeps exactly the cap");
  assert.deepEqual(
    [...second!.entries()].sort((a, b) => a[0].localeCompare(b[0])),
    [...first!.entries()].sort((a, b) => a[0].localeCompare(b[0])),
    "identical repeat returns byte-identical placeholders",
  );
  const persistedAfter = readIndexFile(real, "admit-selection");
  assert.equal(Object.keys(persistedAfter.entries).sort().join(","), idsBefore, "identical repeat keeps ids stable");
  assert.equal(writes, 0, "identical repeat writes zero entry or index files");
  assert.equal(renames, 0, "identical repeat renames zero files");
  ok("admission: selection defers sequence, id, and tombstone allocation to survivors");
}

// --- a progressive batch with appended results admits them and evicts older live rows ---
{
  const store = makeStore("admit-progressive", { maxEntries: 4 });
  const candidate = (i: number) => ({
    toolCallId: `tc-prog-${i}`,
    blocks: [{ type: "text", text: long(`prog${i}`) }],
  });
  const base = Array.from({ length: 6 }, (_, i) => candidate(i));
  const first = store.prepareBatch(base);
  assert.ok(first && first.size === 4, "first pass keeps the cap");
  for (let i = 2; i < 6; i++) {
    assert.ok(first!.has(`tc-prog-${i}`), `position ${i} survives the first pass`);
  }
  const evictedId = first!.get("tc-prog-2")!;
  const keptId = first!.get("tc-prog-5")!;
  const appended = [...base, candidate(6), candidate(7)];
  const second = store.prepareBatch(appended);
  assert.ok(second && second.size === 4, "progressive pass keeps the cap");
  for (let i = 4; i < 8; i++) {
    assert.ok(second!.has(`tc-prog-${i}`), `appended newest position ${i} admits`);
  }
  for (let i = 2; i < 4; i++) {
    assert.ok(!second!.has(`tc-prog-${i}`), `older live row ${i} loses its slot`);
  }
  assert.equal(store.retrieve(evictedId).kind, "evicted", "the displaced older live row keeps its eviction state");
  assert.equal(store.retrieve(second!.get("tc-prog-6")!).kind, "ok", "an appended admission retrieves");
  assert.equal(store.retrieve(keptId).kind, "ok", "a reused live row keeps its reference");
  ok("admission: progressive batches admit appended results and evict older live rows");
}

// --- a non-boolean persisted admissionClosed fails open ---
{
  const real = defaultArchiveFilesystem();
  const session = "admit-malformed";
  const directory = join(root, session);
  real.mkdirSync(directory, { recursive: true, mode: 0o700 });
  real.writeFileSync(
    join(directory, "index.json"),
    JSON.stringify({ v: 1, entries: {}, evicted: [], admissionClosed: "yes" }),
    { mode: 0o600 },
  );
  const store = makeStore(session, undefined, real);
  const refs = store.prepareBatch([{ toolCallId: "tc-m", blocks: [{ type: "text", text: long("m") }] }]);
  assert.equal(refs, null, "malformed admissionClosed makes index integrity uncertain");
  ok("admission: malformed persisted admissionClosed fails open");
}

// --- full archives keep admitting through deterministic rolling eviction ---
{
  const store = makeStore("admit-open-until-reject", { maxEntries: 3 });
  const ids: string[] = [];
  for (let i = 0; i < 5; i++) {
    const ref = store.store(`tc-open-${i}`, [{ type: "text", text: long(`o${i}`) }]);
    assert.ok(ref, `store ${i} succeeds through rolling capacity`);
    ids.push(ref!);
  }
  assert.equal(store.retrieve(ids[0]).kind, "evicted", "the oldest reference is evicted first");
  assert.equal(store.retrieve(ids[1]).kind, "evicted", "the second oldest reference rolls out next");
  assert.equal(store.retrieve(ids[4]).kind, "ok", "the latest reference retrieves exactly");
  const index = JSON.parse(readFileSync(join(store.directory(), "index.json"), "utf8"));
  assert.equal(Object.keys(index.entries).length, 3, "rolling admission keeps the entry bound");
  ok("admission: full archives keep admitting through deterministic rolling eviction");
}

// --- persisted expiry permits collision-safe readmission after reload ---
{
  const real = defaultArchiveFilesystem();
  let clock = baseClock;
  const session = "admit-expiry-closes";
  const store = makeStore(session, { maxEntries: 4, ttlMs: 60_000 }, real, () => clock);
  const live = store.store("tc-expiring", [{ type: "text", text: long("e") }]);
  assert.ok(live, "seeded entry is live");
  clock += 120_000;
  const expiredPass = store.prepareBatch([
    { toolCallId: "tc-expiring", blocks: [{ type: "text", text: long("e") }] },
  ]);
  const readmitted = expiredPass?.get("tc-expiring");
  assert.ok(readmitted && readmitted !== live, "expired content can return only under a distinct reference");
  assert.equal(store.retrieve(live!).kind, "expired", "the old reference keeps its expiry outcome");
  assert.equal(store.retrieve(readmitted!).kind, "ok", "the readmitted reference retrieves exactly");
  const fresh = makeStore(session, { maxEntries: 4, ttlMs: 60_000 }, real, () => clock);
  const later = fresh.store("tc-after-expiry", [{ type: "text", text: long("n") }]);
  assert.ok(later && later !== live && later !== readmitted, "a fresh store admits later work without aliasing old references");
  ok("admission: persisted expiry permits collision-safe readmission after reload");
}

console.log(`recovery admission tests: ${passed} groups passed`);
