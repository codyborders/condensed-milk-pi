/**
 * Recovery batch archive tests (release-blocker correction).
 *
 * Run: npx tsx test-recovery-batch.ts
 */
import assert from "node:assert/strict";
import { createHash } from "node:crypto";
import { mkdtempSync, renameSync, symlinkSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import {
  ArchiveStore,
  DEFAULT_ARCHIVE_LIMITS,
  defaultArchiveFilesystem,
  deriveArchiveId,
  validateArchiveConfig,
} from "./filters/recovery.js";

let passed = 0;
function ok(name: string) {
  passed++;
  console.log(`PASS ${name}`);
}

const root = mkdtempSync(join(tmpdir(), "cm-recovery-batch-"));
const baseClock = 1_700_000_000_000;
const long = (mark: string) => `${mark} ${"payload ".repeat(30)}\n`.repeat(3);

function sessionLockPath(sessionKey: string): string {
  const digest = createHash("sha256").update(sessionKey).digest("hex");
  return join(root, `.session-${digest}.batch.lock`);
}

function makeStore(
  sessionKey: string,
  limits?: Partial<typeof DEFAULT_ARCHIVE_LIMITS>,
  fs?: any,
  now: () => number = () => baseClock,
) {
  return new ArchiveStore(root, sessionKey, { ...DEFAULT_ARCHIVE_LIMITS, ...limits }, now, fs);
}

process.on("exit", () => {
  try { require("node:fs").rmSync(root, { recursive: true, force: true }); } catch { /* ignore */ }
});

// --- defaults: archive-backed lossy masking disabled by default ---
{
  const dflt = validateArchiveConfig(undefined);
  assert.equal(dflt.enabled, false, "archive must default to disabled");
  const enabled = validateArchiveConfig({ enabled: true });
  assert.equal(enabled.enabled, true, "explicit enable still works");
  const bad = validateArchiveConfig({ enabled: "yes" });
  assert.equal(bad.enabled, false, "invalid enabled keeps the disabled default");
  ok("default archive configuration is disabled (explicit opt-in required)");
}

// --- batch basics: capacity 1 with 2 candidates ---
{
  const store = makeStore("batch-cap1", { maxEntries: 1 });
  const refs = store.prepareBatch([
    { toolCallId: "tc-first", blocks: [{ type: "text", text: long("first") }] },
    { toolCallId: "tc-second", blocks: [{ type: "text", text: long("second") }] },
  ]);
  assert.ok(refs, "batch succeeds under capacity pressure");
  assert.equal(refs!.size, 1, "exactly one survivor under maxEntries 1");
  const survivor = [...refs!.entries()][0];
  assert.equal(survivor[0], "tc-second", "deterministic survivor: later submission order wins the tie");
  assert.match(survivor[1], /^cm2-[0-9a-f]{64}$/, "rolling admissions use full-width cm2 references");
  assert.equal(store.retrieve(survivor[1]).kind, "ok", "emitted reference retrieves");
  // The rejected candidate never allocates a rolling id under deferred
  // selection, so rejection itself leaves no removal record and consumes
  // no sequence: only the survivor reached the persisted state.
  const persisted = JSON.parse(defaultArchiveFilesystem().readFileSync(join(root, "batch-cap1", "index.json"), "utf8"));
  assert.equal(persisted.nextSequence, 2, "only the survivor consumed a sequence");
  assert.equal(persisted.evicted.length, 0, "the rejected candidate leaves no tombstone");
  // Determinism: a fresh store makes the identical decision.
  const store2 = makeStore("batch-cap1-b", { maxEntries: 1 });
  const refs2 = store2.prepareBatch([
    { toolCallId: "tc-first", blocks: [{ type: "text", text: long("first") }] },
    { toolCallId: "tc-second", blocks: [{ type: "text", text: long("second") }] },
  ]);
  assert.ok(refs2!.has("tc-second") && /^cm2-[0-9a-f]{64}$/.test(refs2!.get("tc-second")!), "survivor selection is deterministic");
  // Re-submitting the rejected candidate alone wins the single slot,
  // evicts the live row under its own tombstoned id, and admits with a
  // distinct rolling reference.
  const again = store.prepareBatch([{ toolCallId: "tc-first", blocks: [{ type: "text", text: long("first") }] }]);
  assert.ok(again);
  const readmitId = again!.get("tc-first");
  assert.ok(readmitId && readmitId !== survivor[1], "re-admission uses a distinct rolling reference");
  assert.equal(store.retrieve(readmitId!).kind, "ok", "the re-admitted reference retrieves");
  assert.equal(store.retrieve(survivor[1]).kind, "evicted", "the displaced live row keeps its own tombstoned id");
  // A tombstoned live id is never recreated by later batches: identical
  // content reuses the live row instead.
  const onceMore = store.prepareBatch([{ toolCallId: "tc-first", blocks: [{ type: "text", text: long("first") }] }]);
  assert.ok(onceMore);
  assert.equal(onceMore!.get("tc-first"), readmitId, "live reuse keeps the reference stable");
  assert.equal(store.retrieve(survivor[1]).kind, "evicted", "the tombstoned id stays distinct");
  ok("batch: maxEntries 1 with 2 candidates, deterministic survivor, no tombstone recreation");
}

// --- eviction must unlink through injected filesystem operations ---
{
  const real = defaultArchiveFilesystem();
  let unlinks = 0;
  const fs = { ...real, unlinkSync: (p: string) => { unlinks++; return real.unlinkSync(p); } };
  let clock = baseClock;
  const seeder = makeStore("batch-inject-evict", { maxEntries: 2 }, fs, () => clock);
  seeder.prepareBatch([{ toolCallId: "old-a", blocks: [{ type: "text", text: long("a") }] }]);
  clock += 1_000;
  seeder.prepareBatch([{ toolCallId: "old-b", blocks: [{ type: "text", text: long("b") }] }]);
  clock += 1_000;
  // Tightened limits evict the oldest rows deterministically; rolling
  // admission still lets the newest candidate take the single slot.
  const store = makeStore("batch-inject-evict", { maxEntries: 1 }, fs, () => clock);
  const refs = store.prepareBatch([
    { toolCallId: "old-a", blocks: [{ type: "text", text: long("a") }] },
    { toolCallId: "old-b", blocks: [{ type: "text", text: long("b") }] },
    { toolCallId: "new-c", blocks: [{ type: "text", text: long("c") }] },
  ]);
  assert.ok(refs, "batch succeeds after changed-limit eviction");
  assert.ok(refs.has("new-c"), "the newest candidate wins the tightened slot");
  assert.ok(!refs.has("old-a"), "oldest existing row loses the tightened limit");
  assert.ok(!refs.has("old-b"), "older existing rows yield to the newer admission");
  assert.ok(unlinks >= 1, "eviction unlinks through the injected filesystem");
  ok("injected filesystem: eviction unlinks run through injected operations");
}

// --- per-session lock: acquired once, released after the batch ---
{
  const real = defaultArchiveFilesystem();
  let lockCreates = 0;
  const fs = { ...real, mkdirSync: (path: string, options?: { recursive?: boolean; mode?: number }) => {
    if (path.endsWith("batch.lock")) lockCreates += 1;
    return real.mkdirSync(path, options);
  } };
  const store = makeStore("batch-lock-basic", undefined, fs);
  const refs = store.prepareBatch([{ toolCallId: "lock-1", blocks: [{ type: "text", text: long("l") }] }]);
  assert.ok(refs && refs.size === 1, "batch under the lock succeeds");
  assert.equal(lockCreates, 1, "lock acquired with one atomic directory create");
  const left = (readdirSync(real, root) as string[]).filter((name) => name.endsWith(".batch.lock"));
  assert.equal(left.length, 0, "no lock file remains after the batch");
  ok("locking: lock acquired once and released after a successful batch");
}

function readdirSync(real: ReturnType<typeof defaultArchiveFilesystem>, dir: string): string[] {
  return real.readdirSync(dir);
}

// --- a held lock fails the batch open and writes nothing ---
{
  const real = defaultArchiveFilesystem();
  real.mkdirSync(join(root, "held-lock-session"), { recursive: true, mode: 0o700 });
  const heldPath = sessionLockPath("held-lock-session");
  real.mkdirSync(heldPath, { recursive: false, mode: 0o700 });
  const store = makeStore("held-lock-session");
  const refs = store.prepareBatch([{ toolCallId: "held-1", blocks: [{ type: "text", text: long("h") }] }]);
  assert.equal(refs, null, "unavailable lock returns no references");
  const dirListing = real.readdirSync(join(root, "held-lock-session")) as string[];
  assert.ok(!dirListing.some((n) => n.startsWith("cm-")), "no entry written while the lock is unavailable");
  real.rmdirSync(heldPath);
  const after = store.prepareBatch([{ toolCallId: "held-1", blocks: [{ type: "text", text: long("h") }] }]);
  assert.ok(after && after.has("held-1"), "batch succeeds after the lock is released");
  ok("locking: held lock fails open with no writes, then released lock admits the next batch");
}

// --- lock acquisition retries briefly when a create is transiently refused ---
{
  const real = defaultArchiveFilesystem();
  let refusals = 0;
  const fs = { ...real, mkdirSync: (path: string, options?: { recursive?: boolean; mode?: number }) => {
    if (path.endsWith("batch.lock") && refusals++ < 2) {
      throw Object.assign(new Error("busy"), { code: "EEXIST" });
    }
    return real.mkdirSync(path, options);
  } };
  const store = makeStore("batch-lock-retry", undefined, fs);
  const refs = store.prepareBatch([{ toolCallId: "retry-1", blocks: [{ type: "text", text: long("r") }] }]);
  assert.ok(refs && refs.has("retry-1"), "a transiently refused lock is retried and the batch succeeds");
  ok("locking: transient lock refusal is retried within a bounded budget");
}

// --- an old crash-left lock is reclaimed without deleting a new owner ---
{
  const real = defaultArchiveFilesystem();
  real.mkdirSync(join(root, "batch-lock-old"), { recursive: true, mode: 0o700 });
  const lockPath = sessionLockPath("batch-lock-old");
  real.mkdirSync(lockPath, { recursive: false, mode: 0o700 });
  const oldSeconds = (Date.now() - 600_000) / 1000;
  real.utimesSync(lockPath, oldSeconds, oldSeconds);
  const store = makeStore("batch-lock-old");
  const refs = store.prepareBatch([{ toolCallId: "old-lock-1", blocks: [{ type: "text", text: long("s") }] }]);
  assert.ok(refs?.has("old-lock-1"), "stale crash-left lock is replaced after the bounded age");
  assert.ok(!real.readdirSync(root).includes(lockPath.substring(root.length + 1)), "new owner releases only its own lock");
  ok("locking: crash-left lock is safely reclaimed");
}

// --- one-entry semantic storage uses the same batch lock ---
{
  const real = defaultArchiveFilesystem();
  const directory = join(root, "single-store-lock");
  real.mkdirSync(directory, { recursive: true, mode: 0o700 });
  const lockPath = sessionLockPath("single-store-lock");
  real.mkdirSync(lockPath, { recursive: false, mode: 0o700 });
  const store = makeStore("single-store-lock");
  const reference = store.store("single-1", [{ type: "text", text: long("single") }]);
  assert.equal(reference, null, "single-entry storage fails open while another process owns the lock");
  assert.ok(real.readdirSync(root).includes(lockPath.substring(root.length + 1)), "single-entry storage does not disturb the owner lock");
  real.rmdirSync(lockPath);
  ok("locking: semantic one-entry storage uses batch locking");
}

// --- retrieval coordinates with the same session lock ---
{
  const real = defaultArchiveFilesystem();
  const session = "retrieve-lock";
  const store = makeStore(session);
  const id = store.store("retrieve-lock-1", [{ type: "text", text: long("r") }]);
  assert.ok(id);
  const lockPath = sessionLockPath(session);
  real.mkdirSync(lockPath, { recursive: false, mode: 0o700 });
  assert.equal(store.retrieve(id!).kind, "unavailable", "retrieval fails open while the batch lock is held");
  assert.ok(real.readdirSync(root).includes(lockPath.substring(root.length + 1)), "retrieval does not disturb the owner lock");
  real.rmdirSync(lockPath);
  assert.equal(store.retrieve(id!).kind, "ok", "retrieval resumes after lock release");
  ok("locking: retrieval uses the batch lock");
}

// --- retrieval honors injected filesystem failures ---
{
  const real = defaultArchiveFilesystem();
  const session = "retrieve-injected-failure";
  const writer = makeStore(session);
  const id = writer.store("retrieve-injected-1", [{ type: "text", text: long("r") }]);
  assert.ok(id);
  const fs = { ...real, readFileSync: (path: string, encoding: "utf8") => {
    if (path.endsWith(`${id}.json`)) throw Object.assign(new Error("read refused"), { code: "EACCES" });
    return real.readFileSync(path, encoding);
  } };
  const reader = makeStore(session, undefined, fs);
  assert.equal(reader.retrieve(id!).kind, "unavailable", "injected entry read failure fails open");
  ok("filesystem injection: retrieval uses the configured operations");
}

// --- retention cleanup coordinates with the same session lock ---
{
  const real = defaultArchiveFilesystem();
  const session = "cleanup-lock";
  let clock = baseClock;
  const writer = new ArchiveStore(root, session, { ...DEFAULT_ARCHIVE_LIMITS, maxEntries: 2 }, () => clock);
  const first = writer.store("cleanup-lock-1", [{ type: "text", text: long("a") }]);
  clock += 1;
  const second = writer.store("cleanup-lock-2", [{ type: "text", text: long("b") }]);
  assert.ok(first && second);
  const lockPath = sessionLockPath(session);
  real.mkdirSync(lockPath, { recursive: false, mode: 0o700 });
  const cleaner = makeStore(session, { maxEntries: 1 });
  cleaner.cleanup();
  real.rmdirSync(lockPath);
  assert.equal(writer.retrieve(first!).kind, "ok", "cleanup does not mutate the index without lock ownership");
  assert.equal(writer.retrieve(second!).kind, "ok", "cleanup leaves every live entry intact when lock is unavailable");
  ok("locking: retention cleanup uses the batch lock");
}

// --- cleanup revalidates the session path after lock acquisition ---
if (process.platform !== "win32") {
  const real = defaultArchiveFilesystem();
  const session = "cleanup-lock-race";
  const writer = makeStore(session);
  assert.ok(writer.store("cleanup-race-1", [{ type: "text", text: long("race") }]), "cleanup-race seed is live");
  const outside = mkdtempSync(join(tmpdir(), "cm-cleanup-race-outside-"));
  let replaced = false;
  let redirectedStats = 0;
  const fs = {
    ...real,
    mkdirSync(path: string, options?: { recursive?: boolean; mode?: number }) {
      if (path === sessionLockPath(session) && !replaced) {
        replaced = true;
        renameSync(join(root, session), join(root, `${session}-parked`));
        symlinkSync(outside, join(root, session), "dir");
      }
      return real.mkdirSync(path, options);
    },
    statSync(path: string) {
      if (replaced && path.startsWith(`${join(root, session)}/`)) redirectedStats += 1;
      return real.statSync(path);
    },
  };
  const cleaner = makeStore(session, undefined, fs);
  cleaner.cleanup();
  assert.equal(replaced, true, "cleanup replacement runs at session-lock acquisition");
  assert.equal(redirectedStats, 0, "cleanup performs no file access through the replacement path");
  real.rmSync(outside, { recursive: true, force: true });
  ok("locking: cleanup revalidates its path after session-lock acquisition");
}

// --- lock release failure is uncertain final state: no references ---
{
  const real = defaultArchiveFilesystem();
  const fs = { ...real, rmdirSync: (path: string) => {
    if (path.endsWith("batch.lock")) throw new Error("cannot remove lock");
    return real.rmdirSync(path);
  } };
  const store = makeStore("batch-lock-release", undefined, fs);
  const refs = store.prepareBatch([{ toolCallId: "release-1", blocks: [{ type: "text", text: long("r") }] }]);
  assert.equal(refs, null, "lock release failure returns no references");
  ok("locking: lock release failure fails the whole batch open");
}

// --- eviction unlink failure is uncertain final state: no references ---
{
  const real = defaultArchiveFilesystem();
  let clock = baseClock;
  const seeder = makeStore("batch-orphan-unlink", { maxEntries: 2 }, undefined, () => clock);
  const seeded = seeder.prepareBatch([
    { toolCallId: "gone-soon", blocks: [{ type: "text", text: long("g") }] },
    { toolCallId: "also-gone", blocks: [{ type: "text", text: long("g2") }] },
  ]);
  assert.ok(seeded && seeded.size === 2);
  clock += 1_000;
  const broken = { ...real, unlinkSync: (p: string) => {
    if (/^(?:cm-[0-9a-f]{16}|cm2-[0-9a-f]{64})\.json$/.test(p.substring(p.lastIndexOf("/") + 1))) throw new Error("unlink refused");
    return real.unlinkSync(p);
  } };
  // Tightened limits force an existing eviction; the refused unlink
  // leaves uncertain final state, so the batch must fail open.
  const store2 = makeStore("batch-orphan-unlink", { maxEntries: 1 }, broken, () => clock);
  const refs = store2.prepareBatch([
    { toolCallId: "gone-soon", blocks: [{ type: "text", text: long("g") }] },
    { toolCallId: "also-gone", blocks: [{ type: "text", text: long("g2") }] },
    { toolCallId: "fresh-1", blocks: [{ type: "text", text: long("f") }] },
  ]);
  assert.equal(refs, null, "eviction unlink failure returns no references");
  ok("batch: eviction unlink failure fails the batch open");
}

// --- TTL expiry unlink failure is uncertain final state: no references ---
{
  const real = defaultArchiveFilesystem();
  let clock = baseClock;
  const seeded = new ArchiveStore(root, "batch-ttl-unlink", { ...DEFAULT_ARCHIVE_LIMITS }, () => clock, real);
  seeded.prepareBatch([{ toolCallId: "aged", blocks: [{ type: "text", text: long("a") }] }]);
  clock += 86_400_000 * 2; // well past the 24 h TTL
  const broken = { ...real, unlinkSync: (p: string) => {
    if (/^(?:cm-[0-9a-f]{16}|cm2-[0-9a-f]{64})\.json$/.test(p.substring(p.lastIndexOf("/") + 1))) throw new Error("unlink refused");
    return real.unlinkSync(p);
  } };
  const store2 = new ArchiveStore(root, "batch-ttl-unlink", { ...DEFAULT_ARCHIVE_LIMITS }, () => clock, broken);
  const refs = store2.prepareBatch([{ toolCallId: "fresh", blocks: [{ type: "text", text: long("f") }] }]);
  assert.equal(refs, null, "TTL unlink failure returns no references");
  ok("batch: TTL expiry unlink failure fails the batch open");
}

// --- live-only repeats write nothing; full repeats churn but stay bounded ---
{
  const real = defaultArchiveFilesystem();
  const counts: Record<string, number> = {};
  const fs = {} as any;
  for (const key of Object.keys(real) as Array<keyof typeof real>) {
    counts[key] = 0;
    (fs as any)[key] = (...args: unknown[]) => {
      const path = typeof args[0] === "string" ? args[0] : "";
      if (key !== "writeFileSync" || !path.endsWith("batch.lock")) {
        counts[key] = (counts[key] ?? 0) + 1;
      }
      return (real[key] as (...a: unknown[]) => unknown)(...args);
    };
  }
  const store = makeStore("batch-tomb-overflow", { maxEntries: 10 }, fs);
  const candidates = Array.from({ length: 600 }, (_, i) => ({
    toolCallId: `overflow-${i}`,
    blocks: [{ type: "text", text: long(`o${i}`) }],
  }));
  const first = store.prepareBatch(candidates);
  assert.ok(first && first.size === 10, "cap 10 holds after overflow");
  for (const id of first!.values()) {
    assert.equal(store.retrieve(id).kind, "ok", "every reference emitted under pressure retrieves");
  }
  // Repeating only the live set performs no writes at all: every row is
  // reused, retention is stable, and the index stays clean.
  const liveCandidates = candidates.filter((candidate) => first!.has(candidate.toolCallId));
  const writesAfterFirst = counts.writeFileSync ?? 0;
  const renamesAfterFirst = counts.renameSync ?? 0;
  const liveRepeat = store.prepareBatch(liveCandidates);
  assert.ok(liveRepeat && liveRepeat.size === 10, "live-only repeat reuses every row");
  assert.equal((counts.writeFileSync ?? 0) - writesAfterFirst, 0,
    "live-only repeats perform no index or entry writes");
  assert.equal((counts.renameSync ?? 0) - renamesAfterFirst, 0,
    "live-only repeats perform no renames");
  // A full repeated batch rolls the window forward; the entry set and
  // the tombstone list both stay bounded.
  const second = store.prepareBatch(candidates);
  assert.ok(second && second.size === 10, "second full pass keeps exactly the cap");
  for (const id of second!.values()) {
    assert.equal(store.retrieve(id).kind, "ok", "every reference emitted by the churning pass retrieves");
  }
  const persisted = JSON.parse(real.readFileSync(join(root, "batch-tomb-overflow", "index.json"), "utf8"));
  assert.equal(Object.keys(persisted.entries).length, 10, "entry set stays at the cap after churn");
  assert.ok(persisted.evicted.length <= 512, "tombstone list stays bounded after churn");
  ok("batch: live-only repeats write nothing while churn stays bounded");
}

// --- repeated 10000-candidate batch stays inside the 25 ms gate ---
{
  const store = makeStore("batch-perf-10k");
  const candidates = Array.from({ length: 10000 }, (_, i) => ({
    toolCallId: `perf-${i}`,
    blocks: [{ type: "text", text: long(`p${i}`) }],
  }));
  const warm = store.prepareBatch(candidates); // warm the live set
  const liveCandidates = candidates.filter((candidate) => warm!.has(candidate.toolCallId));
  let best = Infinity;
  for (let attempt = 0; attempt < 3; attempt++) {
    const started = performance.now();
    const refs = store.prepareBatch(liveCandidates);
    best = Math.min(best, performance.now() - started);
    assert.ok(refs, "repeated batch succeeds");
    assert.equal(refs!.size, 128, "live set stays at capacity");
  }
  assert.ok(best < 25, `best repeated live-only batch took ${best.toFixed(1)}ms`);
  ok("batch: repeated live-only pass inside the 25 ms budget");
}

// --- normalization changes only text and preserves every other field ---
{
  const store = makeStore("batch-block-properties");
  const blocks = [
    {
      type: "text",
      text: "\u001b[31mvisible\u001b[0m\nTOKEN=hidden",
      annotations: [{ kind: "note", value: 1 }],
      _meta: { source: "fixture" },
      extra: { nested: true },
    },
    { type: "image", data: "aGVsbG8=", mimeType: "image/png", unknown: 7 },
    { type: "text", text: "tail", custom: "keep" },
  ];
  const refs = store.prepareBatch([{ toolCallId: "blocks-1", blocks }]);
  assert.ok(refs?.has("blocks-1"));
  const retrieved = store.retrieve(refs!.get("blocks-1")!);
  assert.equal(retrieved.kind, "ok");
  const stored = JSON.parse(retrieved.kind === "ok" ? retrieved.canonical : "{}").blocks;
  assert.equal(stored.length, 3, "block count stays unchanged");
  assert.equal(stored[0].text, "visible\nTOKEN=[REDACTED]", "only stripped and redacted text changes");
  assert.deepEqual(stored[0].annotations, blocks[0].annotations);
  assert.deepEqual(stored[0]._meta, blocks[0]._meta);
  assert.deepEqual(stored[0].extra, blocks[0].extra);
  assert.deepEqual(stored[1], blocks[1], "non-text block and position stay unchanged");
  assert.deepEqual(stored[2], blocks[2], "later text block fields and position stay unchanged");
  ok("batch: archive normalization preserves complete ordered blocks");
}

// --- tombstones remain authoritative when an orphan file survives ---
{
  const real = defaultArchiveFilesystem();
  const session = "tombstone-orphan";
  const directory = join(root, session);
  real.mkdirSync(directory, { recursive: true, mode: 0o700 });
  const id = "cm-1111111111111111";
  const canonical = JSON.stringify({ v: 1, id, createdAt: baseClock, blocks: [{ type: "text", text: "orphan" }] });
  real.writeFileSync(join(directory, `${id}.json`), canonical, { mode: 0o600 });
  real.writeFileSync(
    join(directory, "index.json"),
    JSON.stringify({ v: 1, entries: {}, evicted: [{ id, reason: "evicted" }] }),
    { mode: 0o600 },
  );
  const store = makeStore(session);
  assert.equal(store.retrieve(id).kind, "evicted", "orphan bytes cannot revive a tombstoned reference");
  ok("retrieval: tombstones override orphan files");
}

// --- failed index commits remove their unique temporary file ---
{
  const real = defaultArchiveFilesystem();
  const session = "index-temp-cleanup";
  const fs = { ...real, renameSync: (from: string, to: string) => {
    if (to.endsWith("index.json")) throw new Error("index rename refused");
    return real.renameSync(from, to);
  } };
  const store = makeStore(session, undefined, fs);
  const refs = store.prepareBatch([
    { toolCallId: "index-temp-1", blocks: [{ type: "text", text: long("new") }] },
  ]);
  assert.equal(refs, null, "failed index commit emits no reference");
  const leftovers = real.readdirSync(join(root, session)).filter((name) => /^index\.json\..+\.tmp$/.test(name));
  assert.deepEqual(leftovers, [], "failed index commit leaves no temporary files");
  ok("index: failed commit cleans its unique temporary file");
}

// --- malformed index entries fail open without rebuilding ---
{
  const real = defaultArchiveFilesystem();
  const session = "batch-malformed-index";
  const directory = join(root, session);
  real.mkdirSync(directory, { recursive: true, mode: 0o700 });
  real.writeFileSync(
    join(directory, "index.json"),
    JSON.stringify({ v: 1, entries: { "../outside": { bytes: 1, createdAt: baseClock } }, evicted: [] }),
    { mode: 0o600 },
  );
  const store = makeStore(session);
  const refs = store.prepareBatch([
    { toolCallId: "malformed-new", blocks: [{ type: "text", text: long("new") }] },
  ]);
  assert.equal(refs, null, "invalid archive IDs make index integrity uncertain");
  ok("batch: malformed index entries fail open");
}

// --- orphan cleanup failure makes the batch fail open ---
{
  const real = defaultArchiveFilesystem();
  const session = "batch-cleanup-fail";
  const directory = join(root, session);
  real.mkdirSync(directory, { recursive: true, mode: 0o700 });
  real.writeFileSync(join(directory, "cm-0000000000000000.json"), "orphan", { mode: 0o600 });
  const fs = { ...real, unlinkSync: (path: string) => {
    if (path.endsWith("cm-0000000000000000.json")) throw new Error("cleanup refused");
    return real.unlinkSync(path);
  } };
  const store = makeStore(session, undefined, fs);
  const refs = store.prepareBatch([
    { toolCallId: "cleanup-new", blocks: [{ type: "text", text: long("new") }] },
  ]);
  assert.equal(refs, null, "cleanup failure returns no references");
  ok("batch: orphan cleanup failure fails open");
}

console.log(`recovery batch tests: ${passed} groups passed`);
