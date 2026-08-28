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
import { mkdtempSync, writeFileSync } from "node:fs";
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

// --- entry-count rejection closes admission persistently ---
{
  const real = defaultArchiveFilesystem();
  const store = makeStore("admit-count", { maxEntries: 2 });
  const seeded = store.prepareBatch([
    { toolCallId: "tc-a", blocks: [{ type: "text", text: long("a") }] },
    { toolCallId: "tc-b", blocks: [{ type: "text", text: long("b") }] },
  ]);
  assert.ok(seeded && seeded.size === 2, "seeding succeeds under capacity");
  const refs = store.prepareBatch([
    { toolCallId: "tc-a", blocks: [{ type: "text", text: long("a") }] },
    { toolCallId: "tc-b", blocks: [{ type: "text", text: long("b") }] },
    { toolCallId: "tc-c", blocks: [{ type: "text", text: long("c") }] },
  ]);
  assert.ok(refs, "batch under capacity pressure succeeds");
  assert.equal(refs!.size, 2, "existing live rows win over the new candidate");
  assert.ok(refs!.has("tc-a") && refs!.has("tc-b"), "existing live rows win over new candidates");
  assert.ok(!refs!.has("tc-c"), "rejected candidate emits no reference");
  const persisted = readIndexFile(real, "admit-count");
  assert.equal(persisted.admissionClosed, true, "entry-count rejection persists admissionClosed=true");
  // A fresh instance honors the persisted closure: no new id is admitted.
  const fresh = makeStore("admit-count", { maxEntries: 2 });
  const closedNew = fresh.prepareBatch([
    { toolCallId: "tc-brand-new", blocks: [{ type: "text", text: long("n") }] },
  ]);
  assert.ok(closedNew, "closed batch still succeeds");
  assert.equal(closedNew!.size, 0, "closed archive never admits a previously non-live id");
  // Live rows are still reused and validated after recreation.
  const closedReuse = fresh.prepareBatch([
    { toolCallId: "tc-a", blocks: [{ type: "text", text: long("a") }] },
    { toolCallId: "tc-c", blocks: [{ type: "text", text: long("c") }] },
  ]);
  assert.equal(closedReuse!.get("tc-a"), deriveArchiveId("admit-count", "tc-a"), "live row reused after recreation");
  assert.ok(!closedReuse!.has("tc-c"), "closed archive refuses the rejected id after recreation");
  ok("admission: entry-count rejection closes admission across fresh instances");
}

// --- fresh store after more than 512 capacity rejections stays closed ---
{
  const session = "admit-overflow";
  const store = makeStore(session, { maxEntries: 4 });
  const candidates = Array.from({ length: 600 }, (_, i) => ({
    toolCallId: `tc-${i}`,
    blocks: [{ type: "text", text: long(`o${i}`) }],
  }));
  const first = store.prepareBatch(candidates);
  assert.ok(first && first.size === 4, "cap 4 holds after 596 capacity rejections");
  const liveIds = [...first!.values()];
  // Fresh ArchiveStore: the bounded tombstone list dropped most rejected
  // ids, but the persisted closure must still refuse every one of them.
  const fresh = makeStore(session, { maxEntries: 4 });
  const second = fresh.prepareBatch(candidates);
  assert.ok(second, "fresh store batch succeeds");
  assert.equal(second!.size, 4, "only the live set is reused");
  assert.deepEqual([...second!.values()].sort(), [...liveIds].sort(), "the exact live set survives");
  for (const id of second!.values()) {
    assert.equal(fresh.retrieve(id).kind, "ok", "every emitted reference retrieves");
  }
  // The same live ids validated by this fresh instance are cached: the
  // next pass emits them without rereading live content.
  const counting = defaultArchiveFilesystem();
  let entryReads = 0;
  const countingFs = { ...counting, readFileSync: (path: string, encoding: "utf8") => {
    if (/\/cm-[0-9a-f]{16}\.json$/.test(path)) entryReads += 1;
    return counting.readFileSync(path, encoding);
  } };
  const cached = makeStore(session, { maxEntries: 4 }, countingFs);
  const warm = cached.prepareBatch(candidates);
  assert.ok(warm && warm.size === 4);
  const readsAfterWarm = entryReads;
  const again = cached.prepareBatch(candidates);
  assert.ok(again && again.size === 4);
  assert.equal(entryReads - readsAfterWarm, 0, "cached validation does not reread live content");
  ok("admission: fresh store after 512+ capacity rejections never re-admits dropped ids");
}

// --- existing rows over changed limits: deterministic eviction + closure ---
{
  const real = defaultArchiveFilesystem();
  let clock = baseClock;
  const seed = makeStore("admit-tighten", { maxEntries: 3 }, real, () => clock);
  const ids: string[] = [];
  for (let i = 0; i < 3; i++) {
    clock += 10;
    ids.push(seed.store(`tc-t${i}`, [{ type: "text", text: long(`t${i}`) }])!);
  }
  // Same directory, tighter limits: the oldest existing row is evicted
  // deterministically and admission closes.
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
  const persisted = readIndexFile(real, "admit-tighten");
  assert.equal(persisted.admissionClosed, true, "changed-limit eviction closes admission");
  const after = tighter.prepareBatch([{ toolCallId: "tc-t-new", blocks: [{ type: "text", text: long("x") }] }]);
  assert.ok(after && after.size === 0, "closed archive refuses a new id after tightening");
  ok("admission: changed limits evict deterministically and close admission");
}

// --- changed aggregate limits close before any new candidate can fill freed bytes ---
{
  const real = defaultArchiveFilesystem();
  let clock = baseClock;
  const session = "admit-tighten-bytes";
  const seed = makeStore(session, { maxEntries: 10, maxAggregateBytes: 8_192 }, real, () => clock);
  assert.ok(seed.store("tc-large-a", [{ type: "text", text: long("a") }]));
  clock += 1;
  assert.ok(seed.store("tc-large-b", [{ type: "text", text: long("b") }]));
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
  assert.ok(refs && refs.size === 1, "one existing row survives the tighter byte limit");
  assert.ok(!refs!.has("tc-small-new"), "closure prevents a new row from using bytes freed by limit eviction");
  assert.equal(readIndexFile(real, session).admissionClosed, true, "byte-limit eviction closes admission");
  ok("admission: changed byte limits close before new candidates can fill freed capacity");
}

// --- aggregate-byte capacity rejection also closes admission ---
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
  assert.equal(persisted.admissionClosed, true, "aggregate-byte rejection persists admissionClosed=true");
  const next = store.prepareBatch([{ toolCallId: "tc-b-extra", blocks: [{ type: "text", text: long("e") }] }]);
  assert.ok(next && next.size === 0, "closed archive refuses new ids after byte rejection");
  ok("admission: aggregate-byte capacity rejection closes admission");
}

// --- TTL expiry remains allowed while admission is closed ---
{
  const real = defaultArchiveFilesystem();
  let clock = baseClock;
  const store = makeStore("admit-ttl", { maxEntries: 1, ttlMs: 60_000 }, real, () => clock);
  const seeded = store.prepareBatch([
    { toolCallId: "tc-keep", blocks: [{ type: "text", text: long("l") }] },
  ]);
  assert.ok(seeded && seeded.size === 1, "one live row under capacity");
  // A second candidate loses the single slot: admission closes.
  const pressured = store.prepareBatch([
    { toolCallId: "tc-keep", blocks: [{ type: "text", text: long("l") }] },
    { toolCallId: "tc-drop", blocks: [{ type: "text", text: long("d") }] },
  ]);
  assert.ok(pressured && pressured.size === 1 && pressured.has("tc-keep"), "live row wins and admission closes");
  const keepId = pressured!.get("tc-keep")!;
  clock += 120_000; // past the TTL
  const expired = store.prepareBatch([
    { toolCallId: "tc-keep", blocks: [{ type: "text", text: long("l") }] },
  ]);
  assert.ok(expired, "batch succeeds on an expired row");
  assert.equal(expired!.size, 0, "TTL expiry removes the row and the closed archive never re-admits it");
  const index = readIndexFile(real, "admit-ttl");
  assert.equal(index.admissionClosed, true, "closure persists across the expiry batch");
  assert.equal(store.retrieve(keepId).kind, "expired", "expired reason survives while closed");
  ok("admission: TTL expiry remains allowed while admission is closed");
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
      parsed.v = 2;
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

// --- validation cache: writes enter the cache, repeats do not reread ---
{
  const real = defaultArchiveFilesystem();
  let entryReads = 0;
  const fs = { ...real, readFileSync: (path: string, encoding: "utf8") => {
    if (/\/cm-[0-9a-f]{16}\.json$/.test(path)) entryReads += 1;
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

// --- open archives keep admitting until capacity actually rejects ---
{
  const store = makeStore("admit-open-until-reject", { maxEntries: 3 });
  for (let i = 0; i < 3; i++) {
    const ref = store.store(`tc-open-${i}`, [{ type: "text", text: long(`o${i}`) }]);
    assert.ok(ref, `store ${i} succeeds while under capacity`);
  }
  const rejected = store.store("tc-open-3", [{ type: "text", text: long("o3") }]);
  assert.equal(rejected, null, "capacity rejection returns no reference");
  const refused = store.store("tc-open-4", [{ type: "text", text: long("o4") }]);
  assert.equal(refused, null, "closed archive refuses the next candidate");
  ok("admission: admission stays open until capacity actually rejects");
}

// --- any persisted removal closes admission before tombstones can roll off ---
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
  assert.ok(expiredPass && expiredPass.size === 0, "expired entry is not recreated in the removal pass");
  assert.equal(store.retrieve(live!).kind, "expired", "expiry reason remains available");
  const persisted = readIndexFile(real, session);
  assert.equal(persisted.admissionClosed, true, "the first persisted removal closes future admission");
  const fresh = makeStore(session, { maxEntries: 4, ttlMs: 60_000 }, real, () => clock);
  const later = fresh.store("tc-after-expiry", [{ type: "text", text: long("n") }]);
  assert.equal(later, null, "a fresh store cannot admit a new id after a persisted removal");
  ok("admission: persisted removals close admission before bounded tombstones roll off");
}

console.log(`recovery admission tests: ${passed} groups passed`);
