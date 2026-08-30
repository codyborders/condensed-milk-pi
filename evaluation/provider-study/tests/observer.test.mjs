/**
 * Provider-study observer (grown test-first).
 *
 * The generated pre/post extensions record bounded counts only. The
 * extractor pairs pre/post context records and computes the observer
 * half of the attempt-metric row.
 */

import { test } from "node:test";
import assert from "node:assert/strict";
import { mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { fileURLToPath } from "node:url";

const repoRoot = join(fileURLToPath(import.meta.url), "..", "..", "..", "..");

test("observer records and extracts tool, rerun, retrieval, and mask metrics", async () => {
  const work = mkdtempSync(join(tmpdir(), "cm-ps-observer-"));
  try {
    const { generateProviderStudyObservers, extractProviderStudyMetrics } = await import("../runner/observer.mjs");
    const setup = generateProviderStudyObservers({ attemptDir: work });
    assert.equal(setup.preExtensionPath.endsWith(join("observer", "pre.mjs")), true);
    assert.equal(setup.postExtensionPath.endsWith(join("observer", "post.mjs")), true);
    assert.match(setup.observerSha256, /^[0-9a-f]{64}$/);
    assert.match(setup.observerWrapperSha256, /^[0-9a-f]{64}$/);
    const again = generateProviderStudyObservers({ attemptDir: join(work, "second") });
    assert.equal(again.observerSha256, setup.observerSha256, "generation is deterministic");

    const handlers = {};
    const pi = { on: (event, handler) => { (handlers[event] ??= []).push(handler); } };
    const pre = await import(setup.preExtensionPath);
    const post = await import(setup.postExtensionPath);
    pre.default(pi);
    post.default(pi);
    const fire = async (event) => {
      for (const handler of handlers[event.type] ?? []) await handler(event);
    };
    const fireContext = async (event) => {
      let current = { ...event };
      for (const handler of handlers.context ?? []) {
        const result = await handler(current);
        if (result && result.messages !== undefined) current = { ...current, messages: result.messages };
      }
    };
    await fire({ type: "tool_call", toolCallId: "1", toolName: "bash", input: "python3 -m pytest tests/test_suite.py" });
    await fire({ type: "tool_call", toolCallId: "2", toolName: "bash", input: "python3 -m pytest tests/test_suite.py" });
    await fire({ type: "tool_call", toolCallId: "3", toolName: "bash", input: "npm run build" });
    await fire({ type: "tool_call", toolCallId: "4", toolName: "bash", input: "echo hi" });
    await fire({ type: "tool_call", toolCallId: "5", toolName: "read", input: "src/app.ts" });
    await fire({ type: "tool_call", toolCallId: "6", toolName: "read", input: "src/app.ts" });
    await fire({ type: "tool_call", toolCallId: "7", toolName: "condensed_milk_retrieve", input: { id: "cm-1" } });
    await fire({ type: "tool_result", toolCallId: "1", toolName: "bash", content: "suite ok [cm-archive entry-1]", isError: false });
    await fire({ type: "tool_result", toolCallId: "7", toolName: "condensed_milk_retrieve", content: "unavailable", isError: true });
    await fireContext({ type: "context", messages: [
      { role: "user", content: [{ type: "text", text: "history block one with plenty of bytes to remove here" }] },
      { role: "user", content: [{ type: "text", text: "history block two with plenty of bytes to remove here" }] },
      { role: "user", content: [{ type: "text", text: "history block three with plenty of bytes to remove here" }] },
    ] });
    await fireContext({ type: "context", messages: [
      { role: "user", content: [{ type: "text", text: "later history block one with plenty of bytes here" }] },
      { role: "user", content: [{ type: "text", text: "later history block two with plenty of bytes here" }] },
    ] });
    // The masking mutator runs between pre and post: shrink with a mask
    // marker on the first context, plain shrink on the second.
    const mutate = async (event) => {
      const calls = (mutate.count = (mutate.count ?? 0) + 1);
      if (calls % 2 === 1) {
        return { messages: event.messages.filter((_, index) => index > 0).map((message) => ({ ...message, content: [{ type: "text", text: "[cm-masked bash] removed" }] })) };
      }
      return { messages: event.messages.filter((_, index) => index > 0) };
    };
    const chained = { ...handlers };
    chained.context = [handlers.context[0], mutate, handlers.context[1]];
    handlers.context = chained.context;
    await fireContext({ type: "context", messages: [
      { role: "user", content: [{ type: "text", text: "history block one with plenty of bytes to remove here" }] },
      { role: "user", content: [{ type: "text", text: "history block two with plenty of bytes to remove here" }] },
      { role: "user", content: [{ type: "text", text: "history block three with plenty of bytes to remove here" }] },
    ] });
    await fireContext({ type: "context", messages: [
      { role: "user", content: [{ type: "text", text: "later history block one with plenty of bytes here" }] },
      { role: "user", content: [{ type: "text", text: "later history block two with plenty of bytes here" }] },
    ] });

    const metrics = extractProviderStudyMetrics({ attemptDir: work });
    assert.equal(metrics.toolCalls, 7);
    assert.equal(metrics.testReruns, 1);
    assert.equal(metrics.buildReruns, 0);
    assert.equal(metrics.shellReruns, 0);
    assert.equal(metrics.fileRereads, 1);
    assert.equal(metrics.retrievalCalls, 1);
    assert.equal(metrics.retrievalFailures, 1);
    assert.equal(metrics.archiveReferences, 1);
    assert.equal(metrics.historicalMaskEvents, 1, "a masked shrink counts as a historical mask event");
    assert.equal(metrics.compressionEvents, 1, "an unmarked shrink counts as a compression event");
  } finally {
    rmSync(work, { recursive: true, force: true });
  }
});
