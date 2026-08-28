/**
 * Masking observer tests (evaluation/runner/masking-observer.mjs).
 *
 * The generator writes two standalone neutral extensions; the extractor
 * pairs their bounded JSONL metrics strictly. These tests drive the
 * generated extensions through the exact pinned runtime ExtensionRunner
 * (real chaining semantics), with scripted fake arm mutators between
 * pre and post. No provider is ever contacted.
 */

import { test, describe } from "node:test";
import assert from "node:assert/strict";
import { existsSync, mkdirSync, mkdtempSync, readFileSync, readdirSync, rmSync, statSync, symlinkSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { pathToFileURL } from "node:url";
import {
  MASKING_OBSERVER_LIMITS,
  diagnosticMarkersFromAssertions,
  extractMaskingInstrumentation,
  generateMaskingObservers,
  stableStringify,
} from "../runner/masking-observer.mjs";
import { runtimeLoaderFromDist } from "../runner/observer-ordering.mjs";

const RUNTIME_DIR = join(process.cwd(), "node_modules", "@earendil-works", "pi-coding-agent");
const DIAG_MARKERS = ["E-7721", "cache eviction raced with write"];
const LONG_BASH = "progress: checks 1-8 finished\nsuite: 8 passed";
const SHORT_BASH = "suite: 8 passed";
const ARCHIVE_SUFFIX = "\n[cm-archive cm-0000000000000000]";
const READ_TEXT = "registry line ".repeat(30);
const DIAG_TEXT = "diagnostic: E-7721 cache eviction raced with write";
const MASKED_READ = "[cm-masked read: src/registry.py]";
const bytes = (text) => Buffer.byteLength(text, "utf8");

async function loadRuntime() {
  return runtimeLoaderFromDist(RUNTIME_DIR)();
}

/** Load a generated observer file as an ExtensionRunner extension object. */
async function loadObserverExtension(file) {
  const module = await import(pathToFileURL(file).href);
  assert.equal(typeof module.default, "function", "observer file must default-export a factory");
  const handlers = new Map();
  module.default({
    on: (type, handler) => {
      if (!handlers.has(type)) handlers.set(type, []);
      handlers.get(type).push(handler);
    },
  });
  return { path: file, resolvedPath: file, sourceInfo: "masking-observer-test", handlers, tools: new Map(), messageRenderers: new Map() };
}

function makeExtension(name, handlers) {
  return {
    path: name,
    resolvedPath: name,
    sourceInfo: "masking-observer-test-arm",
    handlers: new Map(Object.entries(handlers)),
    tools: new Map(),
    messageRenderers: new Map(),
  };
}

/** Generate observers and drive one scripted stream through the real runner. */
async function runStream({ attemptDir, arm = null, diagnosticMarkers = [], limits = null, script }) {
  const setup = generateMaskingObservers({ attemptDir, diagnosticMarkers, ...(limits ? { limits } : {}) });
  const pre = await loadObserverExtension(setup.preExtensionPath);
  const post = await loadObserverExtension(setup.postExtensionPath);
  const { ExtensionRunner, createExtensionRuntime } = await loadRuntime();
  const runner = new ExtensionRunner(arm ? [pre, arm, post] : [pre, post], createExtensionRuntime(), process.cwd(), null, null);
  for (const step of script) {
    await step(runner);
  }
  return setup;
}

const emitToolCall = (event) => (runner) => runner.emitToolCall(event);
const emitToolResult = (event) => (runner) => runner.emitToolResult(event);
const emitContext = (messages) => (runner) => runner.emitContext(messages);

function fileMode(path) {
  return statSync(path).mode & 0o777;
}

describe("masking observer generation", () => {
  test("writes two standalone 0600 extensions whose source holds no task text or attempt path", () => {
    const work = mkdtempSync(join(tmpdir(), "cm-obs-gen-"));
    try {
      const setup = generateMaskingObservers({ attemptDir: work, diagnosticMarkers: DIAG_MARKERS });
      assert.ok(setup.preExtensionPath.endsWith(join("observer", "pre.mjs")));
      assert.ok(setup.postExtensionPath.endsWith(join("observer", "post.mjs")));
      assert.equal(fileMode(setup.preExtensionPath), 0o600);
      assert.equal(fileMode(setup.postExtensionPath), 0o600);
      assert.equal(fileMode(join(work, "observer")), 0o700);
      assert.match(setup.observerSha256, /^[0-9a-f]{64}$/);
      assert.match(setup.observerWrapperSha256, /^[0-9a-f]{64}$/);
      for (const file of [setup.preExtensionPath, setup.postExtensionPath]) {
        const source = readFileSync(file, "utf8");
        assert.equal(source.includes(work), false, "no attempt path may appear in the source");
        assert.equal(source.includes(process.cwd()), false, "no repository path may appear in the source");
        for (const marker of DIAG_MARKERS) {
          assert.equal(source.includes(marker), false, "no task diagnostic text may appear in the source");
        }
        assert.equal(source.includes("python3 tests/test_suite.py"), false, "no task command may appear in the source");
      }
      assert.deepEqual(readdirSync(join(work, "observer")).sort(), ["post.mjs", "pre.mjs"]);
    } finally {
      rmSync(work, { recursive: true, force: true });
    }
  });

  test("regeneration is byte-deterministic across attempt directories with stable digests", () => {
    const first = mkdtempSync(join(tmpdir(), "cm-obs-det1-"));
    const second = mkdtempSync(join(tmpdir(), "cm-obs-det2-"));
    try {
      const a = generateMaskingObservers({ attemptDir: first, diagnosticMarkers: DIAG_MARKERS });
      const b = generateMaskingObservers({ attemptDir: second, diagnosticMarkers: DIAG_MARKERS });
      assert.equal(readFileSync(a.preExtensionPath, "utf8"), readFileSync(b.preExtensionPath, "utf8"));
      assert.equal(readFileSync(a.postExtensionPath, "utf8"), readFileSync(b.postExtensionPath, "utf8"));
      assert.equal(a.observerSha256, b.observerSha256);
      assert.equal(a.observerWrapperSha256, b.observerWrapperSha256);
    } finally {
      rmSync(first, { recursive: true, force: true });
      rmSync(second, { recursive: true, force: true });
    }
  });

  test("limit overrides may only shrink the pinned caps", () => {
    const work = mkdtempSync(join(tmpdir(), "cm-obs-limits-"));
    try {
      assert.throws(
        () => generateMaskingObservers({ attemptDir: work, limits: { maxEvents: MASKING_OBSERVER_LIMITS.maxEvents + 1 } }),
        /may not exceed the pinned cap/,
      );
      assert.throws(
        () => generateMaskingObservers({ attemptDir: work, limits: { maxLineBytes: 0 } }),
        /positive integer/,
      );
      generateMaskingObservers({ attemptDir: work, limits: { maxEvents: 4 } });
    } finally {
      rmSync(work, { recursive: true, force: true });
    }
  });

  test("diagnosticMarkersFromAssertions keeps only fileContains text", () => {
    const markers = diagnosticMarkersFromAssertions([
      { id: "a", kind: "fileContains", path: "ROOTCAUSE.md", all: ["E-7721", "cache eviction raced with write"] },
      { id: "b", kind: "command", command: "node tools/check.js" },
      { id: "c", kind: "fileContains", all: [] },
      null,
    ]);
    assert.deepEqual(markers, ["E-7721", "cache eviction raced with write"]);
  });

  test("stableStringify is key-sorted and deterministic", () => {
    assert.equal(stableStringify({ b: 1, a: [2, { z: null, y: "s" }] }), '{"a":[2,{"y":"s","z":null}],"b":1}');
  });
});

describe("masking observer neutrality", () => {
  test("observers never change events and write 0600 metrics beside their source", async () => {
    const work = mkdtempSync(join(tmpdir(), "cm-obs-neutral-"));
    try {
      const { ExtensionRunner, createExtensionRuntime } = await loadRuntime();
      const setup = generateMaskingObservers({ attemptDir: work });
      const pre = await loadObserverExtension(setup.preExtensionPath);
      const post = await loadObserverExtension(setup.postExtensionPath);
      const runner = new ExtensionRunner([pre, post], createExtensionRuntime(), process.cwd(), null, null);
      const toolResult = await runner.emitToolResult({
        type: "tool_result",
        toolCallId: "c1",
        toolName: "bash",
        input: { command: "echo hi" },
        content: [{ type: "text", text: "hi" }],
        isError: false,
      });
      assert.equal(toolResult, undefined, "observers must never modify a tool_result");
      const messages = await runner.emitContext([{ role: "user", content: [{ type: "text", text: "go" }] }]);
      assert.deepEqual(messages, [{ role: "user", content: [{ type: "text", text: "go" }] }], "observers must never modify context");
      const preMetrics = join(work, "observer", "pre-metrics.jsonl");
      const postMetrics = join(work, "observer", "post-metrics.jsonl");
      assert.ok(existsSync(preMetrics) && existsSync(postMetrics), "both observers must record");
      assert.equal(fileMode(preMetrics), 0o600);
      assert.equal(fileMode(postMetrics), 0o600);
      const instrumentation = extractMaskingInstrumentation({ attemptDir: work });
      assert.equal(instrumentation.nonTextOrderingIncidents, 0);
      assert.equal(instrumentation.secretIncidents, 0);
      assert.equal(instrumentation.semanticTransforms, 0);
    } finally {
      rmSync(work, { recursive: true, force: true });
    }
  });

  test("observers stay neutral around a mutating arm and still pair", async () => {
    const work = mkdtempSync(join(tmpdir(), "cm-obs-neutral2-"));
    try {
      const arm = makeExtension("arm", {
        tool_result: [
          async (event) => ({ content: [{ type: "text", text: `${event.content[0].text}:compressed` }] }),
        ],
      });
      const { ExtensionRunner, createExtensionRuntime } = await loadRuntime();
      const setup = generateMaskingObservers({ attemptDir: work });
      const pre = await loadObserverExtension(setup.preExtensionPath);
      const post = await loadObserverExtension(setup.postExtensionPath);
      const runner = new ExtensionRunner([pre, arm, post], createExtensionRuntime(), process.cwd(), null, null);
      const result = await runner.emitToolResult({
        type: "tool_result",
        toolCallId: "c1",
        toolName: "bash",
        input: { command: "echo hi" },
        content: [{ type: "text", text: "hi" }],
        isError: false,
      });
      assert.match(result.content[0].text, /hi:compressed$/, "the arm transform must survive the observers");
      const instrumentation = extractMaskingInstrumentation({ attemptDir: work });
      assert.equal(instrumentation.semanticTransforms, 1);
      assert.equal(instrumentation.nonTextOrderingIncidents, 0);
    } finally {
      rmSync(work, { recursive: true, force: true });
    }
  });
});

describe("masking observer extraction", () => {
  function scriptedArm() {
    return makeExtension("arm", {
      tool_result: [
        async (event) => {
          if (event.toolName === "bash") {
            return { content: [{ type: "text", text: SHORT_BASH + ARCHIVE_SUFFIX }] };
          }
          return undefined;
        },
      ],
      context: [
        async (event) => ({
          messages: event.messages.map((message) =>
            message.content[0] && message.content[0].text === READ_TEXT
              ? { ...message, content: [{ type: "text", text: MASKED_READ }] }
              : message,
          ),
        }),
      ],
    });
  }

  const SCRIPT = [
    emitToolCall({ type: "tool_call", toolCallId: "c1", toolName: "bash", input: { command: "python3 tests/test_suite.py" } }),
    emitToolResult({ type: "tool_result", toolCallId: "c1", toolName: "bash", input: { command: "python3 tests/test_suite.py" }, content: [{ type: "text", text: LONG_BASH }], isError: false }),
    emitToolCall({ type: "tool_call", toolCallId: "c2", toolName: "bash", input: { command: "python3 tests/test_suite.py" } }),
    emitToolResult({ type: "tool_result", toolCallId: "c2", toolName: "bash", input: { command: "python3 tests/test_suite.py" }, content: [{ type: "text", text: LONG_BASH }], isError: false }),
    emitToolCall({ type: "tool_call", toolCallId: "c3", toolName: "read", input: { path: "src/registry.py" } }),
    emitToolResult({ type: "tool_result", toolCallId: "c3", toolName: "read", input: { path: "src/registry.py" }, content: [{ type: "text", text: READ_TEXT }], isError: false }),
    emitToolCall({ type: "tool_call", toolCallId: "c4", toolName: "condensed_milk_retrieve", input: { id: "cm-0000000000000000" } }),
    emitToolResult({ type: "tool_result", toolCallId: "c4", toolName: "condensed_milk_retrieve", input: { id: "cm-0000000000000000" }, content: [{ type: "text", text: DIAG_TEXT }], isError: false }),
    emitToolCall({ type: "tool_call", toolCallId: "c5", toolName: "read", input: { path: "src/registry.py" } }),
    emitToolResult({ type: "tool_result", toolCallId: "c5", toolName: "read", input: { path: "src/registry.py" }, content: [{ type: "text", text: READ_TEXT }], isError: false }),
    emitContext([
      { role: "user", content: [{ type: "text", text: "do the task" }] },
      { role: "user", content: [{ type: "text", text: READ_TEXT }] },
    ]),
  ];

  test("pairs pre/post and computes byte math, transforms, retrieval, reruns, rereads, and diagnostics", async () => {
    const work = mkdtempSync(join(tmpdir(), "cm-obs-extract-"));
    try {
      await runStream({ attemptDir: work, arm: scriptedArm(), diagnosticMarkers: DIAG_MARKERS, script: SCRIPT });
      const instrumentation = extractMaskingInstrumentation({ attemptDir: work });
      const bashDelta = bytes(LONG_BASH) - bytes(SHORT_BASH) - bytes(ARCHIVE_SUFFIX);
      const expectedSemantic = 2 * bashDelta;
      const expectedHistorical = bytes(READ_TEXT) - bytes(MASKED_READ);
      // Cumulative accounting spans both surfaces: context pre bytes
      // ("do the task" plus one read history) now count in originalBytes.
      const expectedOriginal = 2 * bytes(LONG_BASH) + 3 * bytes(READ_TEXT) + bytes(DIAG_TEXT) + bytes("do the task");
      assert.equal(instrumentation.originalBytes, expectedOriginal);
      assert.equal(instrumentation.semanticBytes, expectedSemantic);
      assert.equal(instrumentation.historicalMaskedBytes, expectedHistorical);
      assert.equal(instrumentation.removedBytes, expectedSemantic + expectedHistorical);
      assert.equal(instrumentation.visibleBytes, expectedOriginal - expectedSemantic - expectedHistorical);
      assert.equal(instrumentation.semanticTransforms, 2, "both bash results were transformed");
      assert.equal(instrumentation.archiveReferences, 2);
      assert.equal(instrumentation.historicalMaskEvents, 1, "only the one context mask counts historically");
      assert.equal(instrumentation.retrievalCalls, 1);
      assert.equal(instrumentation.returnedBytes, bytes(DIAG_TEXT));
      assert.equal(instrumentation.reruns, 1);
      assert.equal(instrumentation.rereads, 1);
      assert.equal(instrumentation.diagnosticPresent, true);
      assert.equal(instrumentation.secretIncidents, 0);
      assert.equal(instrumentation.nonTextOrderingIncidents, 0);
      assert.equal(instrumentation.recoveryResult, "archive");
      assert.deepEqual(instrumentation.pairs, { total: 11, toolResult: 5, context: 1, toolCall: 5 });
    } finally {
      rmSync(work, { recursive: true, force: true });
    }
  });

  test("repeated context observations never produce negative or mismatched totals", async () => {
    const work = mkdtempSync(join(tmpdir(), "cm-obs-repeat-"));
    try {
      // The same context is observed three times and masked each time;
      // cumulative accounting must stay consistent and non-negative.
      const script = [
        emitToolCall({ type: "tool_call", toolCallId: "c1", toolName: "bash", input: { command: "run" } }),
        emitToolResult({ type: "tool_result", toolCallId: "c1", toolName: "bash", input: { command: "run" }, content: [{ type: "text", text: LONG_BASH }], isError: false }),
        emitContext([{ role: "user", content: [{ type: "text", text: READ_TEXT }] }]),
        emitContext([{ role: "user", content: [{ type: "text", text: READ_TEXT }] }]),
        emitContext([{ role: "user", content: [{ type: "text", text: READ_TEXT }] }]),
      ];
      await runStream({ attemptDir: work, arm: scriptedArm(), diagnosticMarkers: [], script });
      const instrumentation = extractMaskingInstrumentation({ attemptDir: work });
      assert.ok(instrumentation.originalBytes > 0);
      assert.ok(instrumentation.visibleBytes >= 0, "cumulative visible bytes must never go negative");
      assert.equal(
        instrumentation.originalBytes - instrumentation.visibleBytes,
        instrumentation.removedBytes,
        "removed must equal the cumulative pre minus post delta",
      );
      assert.equal(
        instrumentation.removedBytes,
        instrumentation.semanticBytes + instrumentation.historicalMaskedBytes,
        "removed must stay the sum of the two separate ledgers",
      );
      assert.equal(instrumentation.pairs.context, 3, "all three context observations must pair");
    } finally {
      rmSync(work, { recursive: true, force: true });
    }
  });

  test("historical masks count only paired context differences, never tool-result archive placeholders", async () => {
    const work = mkdtempSync(join(tmpdir(), "cm-obs-hist-"));
    try {
      const script = [
        emitToolCall({ type: "tool_call", toolCallId: "c1", toolName: "bash", input: { command: "python3 tests/test_suite.py" } }),
        emitToolResult({ type: "tool_result", toolCallId: "c1", toolName: "bash", input: { command: "python3 tests/test_suite.py" }, content: [{ type: "text", text: LONG_BASH }], isError: false }),
        emitContext([{ role: "user", content: [{ type: "text", text: "same" }] }]),
      ];
      await runStream({ attemptDir: work, arm: scriptedArm(), diagnosticMarkers: [], script });
      const instrumentation = extractMaskingInstrumentation({ attemptDir: work });
      assert.ok(instrumentation.semanticTransforms >= 1, "the arm transformed the tool result");
      assert.ok(instrumentation.archiveReferences >= 1, "the tool result gained an archive reference");
      assert.equal(instrumentation.historicalMaskEvents, 0, "context did not change; no historical masks");
      assert.equal(instrumentation.historicalMaskedBytes, 0);
    } finally {
      rmSync(work, { recursive: true, force: true });
    }
  });

  test("identical streams produce byte-identical metrics", async () => {
    const first = mkdtempSync(join(tmpdir(), "cm-obs-hash1-"));
    const second = mkdtempSync(join(tmpdir(), "cm-obs-hash2-"));
    try {
      await runStream({ attemptDir: first, arm: scriptedArm(), script: SCRIPT });
      await runStream({ attemptDir: second, arm: scriptedArm(), script: SCRIPT });
      for (const phase of ["pre", "post"]) {
        assert.equal(
          readFileSync(join(first, "observer", `${phase}-metrics.jsonl`), "utf8"),
          readFileSync(join(second, "observer", `${phase}-metrics.jsonl`), "utf8"),
          `${phase} metrics must be deterministic`,
        );
      }
    } finally {
      rmSync(first, { recursive: true, force: true });
      rmSync(second, { recursive: true, force: true });
    }
  });

  test("counts a privacy sentinel incident only when the secret stays model-visible", async () => {
    const work = mkdtempSync(join(tmpdir(), "cm-obs-sentinel-"));
    const secret = ["API", "_KEY=abcd", "1234efgh", "5678"].join("");
    try {
      const redacting = makeExtension("arm", {
        tool_result: [async () => ({ content: [{ type: "text", text: "API_KEY=[REDACTED]" }] })],
      });
      await runStream({
        attemptDir: work,
        arm: redacting,
        script: [
          emitToolResult({ type: "tool_result", toolCallId: "c1", toolName: "bash", input: { command: "printenv" }, content: [{ type: "text", text: secret }], isError: false }),
        ],
      });
      assert.equal(extractMaskingInstrumentation({ attemptDir: work }).secretIncidents, 0, "redacted secrets are not incidents");
      const other = mkdtempSync(join(tmpdir(), "cm-obs-sentinel2-"));
      try {
        await runStream({
          attemptDir: other,
          script: [
            emitToolResult({ type: "tool_result", toolCallId: "c1", toolName: "bash", input: { command: "printenv" }, content: [{ type: "text", text: secret }], isError: false }),
          ],
        });
        assert.equal(extractMaskingInstrumentation({ attemptDir: other }).secretIncidents, 1, "a visible secret is one incident");
        for (const phase of ["pre", "post"]) {
          const lines = readFileSync(join(other, "observer", `${phase}-metrics.jsonl`), "utf8");
          assert.equal(lines.includes(secret), false, "the secret value must never persist");
        }
      } finally {
        rmSync(other, { recursive: true, force: true });
      }
    } finally {
      rmSync(work, { recursive: true, force: true });
    }
  });

  test("flags non-text ordering incidents for type reorders and non-text block changes", async () => {
    const work = mkdtempSync(join(tmpdir(), "cm-obs-order-"));
    try {
      const reordering = makeExtension("arm", {
        context: [async (event) => ({ messages: [...event.messages].reverse() })],
        tool_result: [
          async (event) => ({ content: event.content.map((block) => (block.type === "image" ? { ...block, data: "BBBB" } : block)) }),
        ],
      });
      await runStream({
        attemptDir: work,
        arm: reordering,
        script: [
          emitToolResult({
            type: "tool_result",
            toolCallId: "c1",
            toolName: "bash",
            input: { command: "screenshot" },
            content: [{ type: "image", data: "AAAA" }, { type: "text", text: "caption" }],
            isError: false,
          }),
          // A message carrying a non-text block moves across a text-only
          // message: the block-type order across message positions changes.
          emitContext([
            { role: "user", content: [{ type: "text", text: "first" }] },
            { role: "user", content: [{ type: "image", data: "AAAA" }] },
          ]),
          // Swapping two same-shaped text-only messages is a text-order
          // change, not a non-text ordering incident.
          emitContext([
            { role: "user", content: [{ type: "text", text: "aa" }] },
            { role: "user", content: [{ type: "text", text: "bb" }] },
          ]),
        ],
      });
      const instrumentation = extractMaskingInstrumentation({ attemptDir: work });
      assert.equal(instrumentation.nonTextOrderingIncidents, 2);
    } finally {
      rmSync(work, { recursive: true, force: true });
    }
  });

  test("event, total-byte, and line-byte caps each emit one error marker and the extractor refuses", async () => {
    const filler = "x".repeat(200);
    const oneResult = (callId) =>
      emitToolResult({ type: "tool_result", toolCallId: callId, toolName: "bash", input: { command: "echo" }, content: [{ type: "text", text: filler }], isError: false });

    const work = mkdtempSync(join(tmpdir(), "cm-obs-bounds-"));
    try {
      await runStream({
        attemptDir: work,
        limits: { maxEvents: 3 },
        script: [oneResult("c1"), oneResult("c2"), oneResult("c3"), oneResult("c4")],
      });
      const lines = readFileSync(join(work, "observer", "pre-metrics.jsonl"), "utf8").trim().split("\n");
      assert.equal(lines.length, 4, "three records plus exactly one marker");
      assert.deepEqual(JSON.parse(lines[3]), { v: 1, phase: "pre", error: "overflow" });
      assert.throws(() => extractMaskingInstrumentation({ attemptDir: work }), /stopped early: overflow/);
    } finally {
      rmSync(work, { recursive: true, force: true });
    }

    const totalWork = mkdtempSync(join(tmpdir(), "cm-obs-bounds2-"));
    try {
      await runStream({
        attemptDir: totalWork,
        limits: { maxTotalBytes: 320 },
        script: [oneResult("c1"), oneResult("c2"), oneResult("c3")],
      });
      const lines = readFileSync(join(totalWork, "observer", "pre-metrics.jsonl"), "utf8").trim().split("\n");
      const markers = lines.filter((line) => line.includes('"error"'));
      assert.equal(markers.length, 1);
      assert.throws(() => extractMaskingInstrumentation({ attemptDir: totalWork }), /stopped early: overflow/);
    } finally {
      rmSync(totalWork, { recursive: true, force: true });
    }

    const lineWork = mkdtempSync(join(tmpdir(), "cm-obs-bounds3-"));
    try {
      await runStream({
        attemptDir: lineWork,
        limits: { maxLineBytes: 60 },
        script: [oneResult("c1")],
      });
      const lines = readFileSync(join(lineWork, "observer", "pre-metrics.jsonl"), "utf8").trim().split("\n");
      assert.equal(lines.length, 1, "a stripped record that still exceeds the cap becomes one marker");
      assert.deepEqual(JSON.parse(lines[0]), { v: 1, phase: "pre", error: "overflow" });
      assert.throws(() => extractMaskingInstrumentation({ attemptDir: lineWork }), /stopped early: overflow/);
    } finally {
      rmSync(lineWork, { recursive: true, force: true });
    }
  });

  test("refuses missing, duplicate, malformed, unmatched, and incomplete records", async () => {
    const work = mkdtempSync(join(tmpdir(), "cm-obs-refuse-"));
    try {
      await runStream({
        attemptDir: work,
        script: [
          emitToolResult({ type: "tool_result", toolCallId: "c1", toolName: "bash", input: { command: "echo a" }, content: [{ type: "text", text: "a" }], isError: false }),
          emitToolResult({ type: "tool_result", toolCallId: "c2", toolName: "bash", input: { command: "echo b" }, content: [{ type: "text", text: "b" }], isError: false }),
        ],
      });
      const observerDir = join(work, "observer");
      const prePath = join(observerDir, "pre-metrics.jsonl");
      const postPath = join(observerDir, "post-metrics.jsonl");
      const preLines = readFileSync(prePath, "utf8").trim().split("\n");
      const postLines = readFileSync(postPath, "utf8").trim().split("\n");

      const restore = () => {
        writeFileSync(prePath, `${preLines.join("\n")}\n`, { mode: 0o600 });
        writeFileSync(postPath, `${postLines.join("\n")}\n`, { mode: 0o600 });
      };

      rmSync(postPath);
      assert.throws(() => extractMaskingInstrumentation({ attemptDir: work }), /missing/);
      restore();

      writeFileSync(prePath, `${[...preLines, preLines[preLines.length - 1]].join("\n")}\n`, { mode: 0o600 });
      assert.throws(() => extractMaskingInstrumentation({ attemptDir: work }), /duplicate or regressed sequence/);
      restore();

      writeFileSync(prePath, `${[preLines[0], "not json"].join("\n")}\n`, { mode: 0o600 });
      assert.throws(() => extractMaskingInstrumentation({ attemptDir: work }), /malformed .* not valid JSON/);
      restore();

      writeFileSync(postPath, `${postLines.slice(0, 1).join("\n")}\n`, { mode: 0o600 });
      assert.throws(() => extractMaskingInstrumentation({ attemptDir: work }), /has no post record/);
      restore();

      const incomplete = JSON.parse(preLines[0]);
      delete incomplete.bytes;
      writeFileSync(prePath, `${[JSON.stringify(incomplete), ...preLines.slice(1)].join("\n")}\n`, { mode: 0o600 });
      assert.throws(() => extractMaskingInstrumentation({ attemptDir: work }), /unexpected field set/);
      restore();

      extractMaskingInstrumentation({ attemptDir: work });
    } finally {
      rmSync(work, { recursive: true, force: true });
    }
  });

  test("sums archived bytes from current attempt recovery index metadata only", async () => {
    const work = mkdtempSync(join(tmpdir(), "cm-obs-recovery-"));
    try {
      await runStream({
        attemptDir: work,
        script: [
          emitToolResult({ type: "tool_result", toolCallId: "c1", toolName: "bash", input: { command: "echo a" }, content: [{ type: "text", text: "a" }], isError: false }),
        ],
      });
      const recoveryRoot = join(work, "home", ".pi", "agent", "condensed-milk-recovery");
      const sessionOne = join(recoveryRoot, "aaaa1111");
      const sessionTwo = join(recoveryRoot, "bbbb2222");
      mkdirSync(sessionOne, { recursive: true });
      mkdirSync(sessionTwo, { recursive: true });
      writeFileSync(join(sessionOne, "index.json"), `${JSON.stringify({ v: 1, entries: { "cm-1": { bytes: 100, createdAt: 1 }, "cm-2": { bytes: 50, createdAt: 2 } }, evicted: [] })}\n`, "utf8");
      writeFileSync(join(sessionOne, "cm-1.json"), "raw archived body never read", "utf8");
      writeFileSync(join(sessionTwo, "index.json"), `${JSON.stringify({ v: 1, entries: { "cm-3": { bytes: 25, createdAt: 3 } }, evicted: [] })}\n`, "utf8");
      writeFileSync(join(recoveryRoot, "stray.txt"), "not a session", "utf8");
      const outside = mkdtempSync(join(tmpdir(), "cm-obs-recovery-out-"));
      symlinkSync(outside, join(recoveryRoot, "link-out"));
      const baseline = extractMaskingInstrumentation({ attemptDir: work });
      assert.equal(baseline.archivedBytes, 175);

      writeFileSync(join(sessionTwo, "index.json"), "{ not json", "utf8");
      assert.throws(() => extractMaskingInstrumentation({ attemptDir: work }), /recovery index/);
      writeFileSync(join(sessionTwo, "index.json"), `${JSON.stringify({ v: 1, entries: { "cm-3": { bytes: -1 } }, evicted: [] })}\n`, "utf8");
      assert.throws(() => extractMaskingInstrumentation({ attemptDir: work }), /recovery index entry bytes/);
    } finally {
      rmSync(work, { recursive: true, force: true });
    }
  });
});
