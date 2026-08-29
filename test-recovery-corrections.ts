/**
 * Caller-visible historical masking through one batch archive call.
 * The context pass must collect every eligible candidate, call the
 * batch sink once, and mask only messages whose reference came back
 * live. Everything else stays fully visible.
 *
 * Run: npx tsx test-recovery-corrections.ts
 */
import assert from "node:assert/strict";
import { mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { ArchiveStore, DEFAULT_ARCHIVE_LIMITS, defaultArchiveFilesystem } from "./filters/recovery.js";
import { compressStaleToolResults, resolveRules, emptyUserConfig } from "./filters/context-compress.js";

let passed = 0;
function ok(name: string) {
  passed++;
  console.log(`PASS ${name}`);
}

const root = mkdtempSync(join(tmpdir(), "cm-recovery-context-"));
const rules = resolveRules(emptyUserConfig());
const long = (mark: string) => `${mark} ${"payload ".repeat(40)}\n`.repeat(4);

process.on("exit", () => {
  try { rmSync(root, { recursive: true, force: true }); } catch { /* ignore */ }
});

function buildMessages(count: number, text: (i: number) => string) {
  const messages: any[] = [{ role: "user", content: [{ type: "text", text: "turn" }] }];
  for (let i = 0; i < count; i++) {
    messages.push({ role: "toolResult", toolCallId: `call-${i}`, toolName: "bash", isError: false, details: { command: `echo ${i}` }, content: [{ type: "text", text: text(i) }] });
  }
  return messages;
}

function runMask(messages: any[], store: ArchiveStore | null) {
  return compressStaleToolResults(messages, {
    thresholds: [0.3],
    coverage: [1],
    contextUsage: 1,
    previousCutoff: 0,
    zoneEntered: -1,
    rules,
    archiveBatch: store === null
      ? { prepareBatch: () => null }
      : { prepareBatch: (candidates) => store.prepareBatch(candidates) },
  });
}

function visibleText(message: any): string {
  return (message.content ?? []).filter((b: any) => b?.type === "text").map((b: any) => b.text ?? "").join("\n");
}

// --- capacity 1 with 2 candidates: exactly one mask, no dead reference ---
{
  const store = new ArchiveStore(root, "ctx-cap1", { ...DEFAULT_ARCHIVE_LIMITS, maxEntries: 1 }, () => 1_700_000_000_000);
  const messages = buildMessages(2, (i) => long(`out-${i}`));
  const result = runMask(messages, store);
  assert.ok(result, "masking result produced");
  const masked = result!.messages.filter((m: any) =>
    m.role === "toolResult" && visibleText(m).startsWith("[cm-masked bash]"));
  assert.equal(masked.length, 1, "exactly one message masked under capacity 1");
  const maskedOutput = visibleText(masked[0]);
  const ref = /\[cm-archive ((?:cm-[0-9a-f]{16}|cm2-[0-9a-f]{64}))\]/.exec(maskedOutput);
  assert.ok(ref, "masked message carries a live archive reference");
  assert.match(maskedOutput, /^\[cm-masked bash\] echo 1 \[cm-archive cm2-[0-9a-f]{64}\]$/,
    "the newest deterministic survivor carries a rolling reference");
  assert.equal(store.retrieve(ref[1]).kind, "ok", "the emitted reference retrieves");
  for (const message of result!.messages) {
    if (message === masked[0]) continue;
    if (message.role !== "toolResult") continue;
    const text = visibleText(message);
    assert.ok(!text.includes("[cm-archive"), "non-survivor has no dead reference");
    assert.ok(text.startsWith("out-"), "non-survivor original content stays visible");
  }
  ok("context batch: capacity 1 with 2 candidates masks once with no dead reference");
}

// --- 300 candidates with capacity 128: non-survivors stay visible ---
{
  const store = new ArchiveStore(root, "ctx-300", { ...DEFAULT_ARCHIVE_LIMITS }, () => 1_700_000_000_000);
  const messages = buildMessages(300, (i) => long(`out-${i}`));
  const result = runMask(messages, store);
  assert.ok(result, "masking result produced");
  let masked = 0;
  const refs: string[] = [];
  for (const message of result!.messages) {
    if (message.role !== "toolResult") continue;
    const text = visibleText(message);
    const ref = /\[cm-archive ((?:cm-[0-9a-f]{16}|cm2-[0-9a-f]{64}))\]/.exec(text);
    if (text.startsWith("[cm-masked bash]")) {
      masked++;
      assert.ok(ref, "every mask carries a reference");
      refs.push(ref![1]);
      assert.equal(store.retrieve(ref![1]).kind, "ok", "every emitted reference retrieves");
    } else {
      assert.ok(!ref, "non-survivor carries no dead reference");
      assert.ok(text.startsWith("out-"), "non-survivor original content stays visible");
    }
  }
  assert.equal(masked, DEFAULT_ARCHIVE_LIMITS.maxEntries, "exactly maxEntries messages masked");
  assert.equal(new Set(refs).size, masked, "references are unique");
  ok("context batch: 300 candidates with 128 capacity, non-survivors visible, references retrievable");
}

// --- five repeated passes: deterministic output, no live-entry rewrites ---
{
  const base = defaultArchiveFilesystem();
  const counts: Record<string, number> = {};
  const fs = {} as any;
  for (const key of Object.keys(base) as Array<keyof typeof base>) {
    counts[key] = 0;
    (fs as any)[key] = (...args: unknown[]) => {
      counts[key] = (counts[key] ?? 0) + 1;
      const path = typeof args[0] === "string" ? args[0] : "";
      if (key === "writeFileSync" && !path.endsWith("batch.lock")) {
        counts.durableWrites = (counts.durableWrites ?? 0) + 1;
      }
      if (key === "readFileSync" && path.endsWith("index.json")) {
        counts.indexReads = (counts.indexReads ?? 0) + 1;
      }
      return (base[key] as (...a: unknown[]) => unknown)(...args);
    };
  }
  void counts;
  const store = new ArchiveStore(root, "ctx-repeat", { ...DEFAULT_ARCHIVE_LIMITS }, () => 1_700_000_000_000, fs);
  const messages = buildMessages(300, (i) => long(`out-${i}`));
  const first = runMask(messages, store);
  assert.ok(first, "first pass masks");
  const firstJson = JSON.stringify(first!.messages);
  const writesAfterFirst = counts.durableWrites ?? 0;
  const renamesAfterFirst = counts.renameSync ?? 0;
  const readsAfterFirst = counts.indexReads ?? 0;
  for (let pass = 2; pass <= 5; pass++) {
    const again = runMask(messages, store);
    assert.ok(again, `pass ${pass} masks the same set`);
    assert.equal(JSON.stringify(again!.messages), firstJson, `pass ${pass} output is byte-identical`);
  }
  assert.equal((counts.durableWrites ?? 0) - writesAfterFirst, 0, "repeated passes write zero archive or index files");
  assert.equal((counts.renameSync ?? 0) - renamesAfterFirst, 0, "repeated passes rename zero archive or index files");
  const readsPerPass = ((counts.indexReads ?? 0) - readsAfterFirst) / 4;
  assert.equal(readsPerPass, 1, "each repeated pass reads exactly the index once");
  ok("context batch: five passes deterministic with zero live-entry rewrites");
}

// --- storage failures preserve every message byte-for-byte ---
{
  const base = defaultArchiveFilesystem();
  const cases = [
    {
      name: "write",
      fs: { ...base, writeFileSync: () => { throw new Error("disk full"); } },
    },
    {
      name: "rename",
      fs: { ...base, renameSync: () => { throw new Error("rename refused"); } },
    },
    {
      name: "verification",
      fs: { ...base, readFileSync: (path: string, encoding: "utf8") =>
        path.endsWith("index.json") ? base.readFileSync(path, encoding) : "verification mismatch" },
    },
    {
      name: "index read",
      fs: { ...base, statSync: (path: string) => {
        if (path.endsWith("index.json")) throw Object.assign(new Error("index denied"), { code: "EACCES" });
        return base.statSync(path);
      } },
    },
    {
      name: "index rename",
      fs: { ...base, renameSync: (from: string, to: string) => {
        if (to.endsWith("index.json")) throw new Error("index rename refused");
        return base.renameSync(from, to);
      } },
    },
    {
      name: "lock acquisition",
      fs: { ...base, mkdirSync: (path: string, options?: { recursive?: boolean; mode?: number }) => {
        if (path.endsWith("batch.lock")) throw Object.assign(new Error("lock denied"), { code: "EACCES" });
        return base.mkdirSync(path, options);
      } },
    },
    {
      name: "lock release",
      fs: { ...base, rmdirSync: (path: string) => {
        if (path.endsWith("batch.lock")) throw Object.assign(new Error("release denied"), { code: "EIO" });
        return base.rmdirSync(path);
      } },
    },
  ];

  for (const failure of cases) {
    const store = new ArchiveStore(
      root,
      `ctx-fail-${failure.name.replaceAll(" ", "-")}`,
      { ...DEFAULT_ARCHIVE_LIMITS },
      () => 1_700_000_000_000,
      failure.fs,
    );
    const messages = buildMessages(3, (i) => long(`out-${i}`));
    const before = JSON.stringify(messages);
    const result = runMask(messages, store);
    assert.equal(result, null, `${failure.name} failure masks nothing`);
    assert.equal(JSON.stringify(messages), before, `${failure.name} failure does not mutate input`);
  }
  ok("context batch: storage, index, verification, and lock failures preserve content");
}

console.log(`recovery context tests: ${passed} groups passed`);
