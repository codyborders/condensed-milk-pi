#!/usr/bin/env node
/**
 * Extension-boundary test for condensed_milk_retrieve registration.
 * Covers recovery registration and index.ts integration.
 */
import assert from "node:assert/strict";
import { spawnSync } from "node:child_process";
import { cpSync, existsSync, mkdirSync, mkdtempSync, readdirSync, rmSync, statSync, symlinkSync, writeFileSync } from "node:fs";
import { fileURLToPath } from "node:url";
import { dirname, join } from "node:path";
import { tmpdir } from "node:os";

const homeRoot = mkdtempSync(join(tmpdir(), "cm-recovery-home-"));
const originalHome = process.env.HOME;

const repositoryRoot = dirname(fileURLToPath(import.meta.url));
const buildRoot = mkdtempSync(join(tmpdir(), "cm-recovery-build-"));
const outputDirectory = join(buildRoot, "out");
const tscPath = join(repositoryRoot, "node_modules", "typescript", "bin", "tsc");

try {
  cpSync(join(repositoryRoot, "index.ts"), join(buildRoot, "index.ts"));
  cpSync(join(repositoryRoot, "filters"), join(buildRoot, "filters"), { recursive: true });
  cpSync(join(repositoryRoot, "tsconfig.json"), join(buildRoot, "tsconfig.json"));
  symlinkSync(join(repositoryRoot, "node_modules"), join(buildRoot, "node_modules"), "junction");
  const tsc = spawnSync(
    process.execPath,
    [tscPath, "--project", join(buildRoot, "tsconfig.json"), "--outDir", outputDirectory, "--noEmit", "false"],
    { cwd: buildRoot, encoding: "utf-8" },
  );
  if (tsc.error) throw tsc.error;
  if (tsc.status !== 0) throw new Error(`TypeScript compilation failed: ${[tsc.stdout, tsc.stderr].filter(Boolean).join("\n")}`);
  // HOME must be set before import: the extension resolves its archive
  // root from the real home directory at load time.
  process.env.HOME = homeRoot;
  const mod = await import(join(outputDirectory, "index.js"));

  const handlers = new Map();
  const tools = new Map();
  const api = {
    on(name, fn) { handlers.set(name, fn); },
    registerCommand() {},
    registerTool(tool) { tools.set(tool.name, tool); },
  };
  mod.default(api);
  const sessionStart = handlers.get("session_start");
  let savingsStatus = "";
  const ctx = {
    ui: { setStatus(key, value) { if (key === "token-savings") savingsStatus = value; } },
    sessionManager: { getSessionFile: () => "/fake/sessions/11111111-2222-3333-4444-555555555555.jsonl" },
  };
  mkdirSync(join(homeRoot, ".config"), { recursive: true });
  writeFileSync(join(homeRoot, ".config", "condensed-milk.json"), JSON.stringify({ archive: { enabled: true } }));
  await sessionStart({ reason: "startup" }, ctx);
  const recoveryRoot = join(homeRoot, ".pi", "agent", "condensed-milk-recovery");
  assert.ok(existsSync(recoveryRoot), "recovery root under ~/.pi/agent/condensed-milk-recovery");
  const dirs = readdirSync(recoveryRoot);
  assert.equal(dirs.length, 1, "one session directory");
  assert.ok(!dirs[0].includes("11111111"), "directory name hides the session file path");
  assert.equal(statSync(join(recoveryRoot, dirs[0])).mode & 0o777, 0o700, "session directory 0700");
  console.log("PASS archive store location and permissions");

  // --- tool registration ---
  const tool = tools.get("condensed_milk_retrieve");
  assert.ok(tool, "condensed_milk_retrieve registered");
  assert.equal(tool.executionMode, "sequential");
  const schema = JSON.stringify(tool.parameters);
  for (const field of ["id", "offset", "limit", "tail", "literal", "regex", "flags"]) {
    assert.ok(schema.includes(`"${field}"`), `schema includes ${field}`);
  }
  assert.equal(typeof tool.execute, "function");
  console.log("PASS tool registration (schema, sequential)");

  // --- semantic archive creation ---
  const handler = handlers.get("tool_result");
  assert.equal(typeof handler, "function");
  const longPytest = "collecting tests ...\n" + "test_a passed\n".repeat(20) + "================= 4 passed in 0.01s =================";
  const semantic = await handler(
    { toolName: "bash", toolCallId: "call-sem-1", input: { command: "pytest" }, content: [{ type: "text", text: longPytest }], isError: false },
    ctx,
  );
  assert.ok(semantic, "semantic compression applied");
  assert.ok(semantic.content[0].text.startsWith("pytest: ===="), "summary visible");
  const ref = /\[cm-archive ((?:cm-[0-9a-f]{16}|cm2-[0-9a-f]{64}))\]/.exec(semantic.content[0].text);
  assert.ok(ref, "summary carries archive reference");
  const expectedSaved = longPytest.length - semantic.content[0].text.length;
  const expectedPercent = Math.round((expectedSaved / longPytest.length) * 100);
  assert.equal(
    savingsStatus,
    `↓${expectedSaved}B 1/1 ${expectedPercent}%`,
    "status counts the visible archive reference bytes",
  );
  const archiveId = ref[1];
  const page = await tool.execute("t1", { id: archiveId, offset: 0, limit: 4096 }, undefined, undefined, ctx);
  assert.ok(page.content[0].text.includes("test_a passed"), "retrieval returns full archived output");
  assert.ok(!page.content[0].text.includes("[cm-archive"), "payload is pre-transform content");
  const again = await handler(
    { toolName: "bash", toolCallId: "call-sem-1", input: { command: "pytest" }, content: [{ type: "text", text: longPytest }], isError: false },
    ctx,
  );
  const refAgain = /\[cm-archive ((?:cm-[0-9a-f]{16}|cm2-[0-9a-f]{64}))\]/.exec(again.content[0].text);
  assert.equal(refAgain[1], archiveId, "same tool call reuses the reference");
  console.log("PASS semantic archive creation, retrieval, stable id reuse");

  // --- mixed content and failed diagnostics ---
  const mixed = await handler(
    {
      toolName: "bash",
      toolCallId: "call-mixed-1",
      input: { command: "pytest" },
      content: [
        { type: "text", text: longPytest },
        { type: "image", data: "aGVsbG8=", mimeType: "image/png" },
      ],
      isError: false,
    },
    ctx,
  );
  assert.equal(mixed.content.length, 2, "mixed block count preserved");
  assert.equal(mixed.content[1].type, "image", "non-text block order preserved");
  const mixedId = /\[cm-archive ((?:cm-[0-9a-f]{16}|cm2-[0-9a-f]{64}))\]/.exec(mixed.content[0].text)[1];
  const mixedPage = await tool.execute("t2", { id: mixedId, offset: 0, limit: 4096 }, undefined, undefined, ctx);
  assert.ok(mixedPage.content[0].text.includes("aGVsbG8="), "archive preserves non-text block data");

  const failedText = "test failure\n" + "diagnostic line\n".repeat(30);
  const failed = await handler(
    {
      toolName: "bash",
      toolCallId: "call-failed-1",
      input: { command: "pytest" },
      content: [{ type: "text", text: failedText }],
      isError: true,
    },
    ctx,
  );
  assert.equal(failed, undefined, "failed diagnostic remains unchanged");
  const nonText = await handler(
    {
      toolName: "bash",
      toolCallId: "call-image-only",
      input: { command: "pytest" },
      content: [{ type: "image", data: "aGk=", mimeType: "image/png" }],
      isError: false,
    },
    ctx,
  );
  assert.equal(nonText, undefined, "non-text-only result remains unchanged");
  console.log("PASS mixed blocks, failed diagnostics, non-text identity");

  // --- historical masking archive and stable reuse ---
  const contextHandler = handlers.get("context");
  const historicalText = "historical output\n" + "detail line\n".repeat(30);
  const historicalMessages = [
    {
      role: "assistant",
      content: [{ type: "toolCall", id: "call-history-1", name: "read", arguments: { path: "/tmp/report.txt" } }],
    },
    {
      role: "toolResult",
      toolName: "read",
      toolCallId: "call-history-1",
      content: [{ type: "text", text: historicalText }],
      isError: false,
    },
    { role: "user", content: [{ type: "text", text: "continue" }] },
    { role: "assistant", content: [{ type: "text", text: "continuing" }] },
  ];
  const context = {
    ...ctx,
    getContextUsage: () => ({ tokens: 500, contextWindow: 1000, percent: 50 }),
  };
  const masked = await contextHandler({ messages: historicalMessages }, context);
  const maskedText = masked.messages[1].content[0].text;
  const historicalRef = /\[cm-archive ((?:cm-[0-9a-f]{16}|cm2-[0-9a-f]{64}))\]/.exec(maskedText);
  assert.ok(historicalRef, "historical placeholder includes recovery reference");
  const maskedAgain = await contextHandler({ messages: historicalMessages }, context);
  assert.equal(maskedAgain.messages[1].content[0].text, maskedText, "historical reference stays stable");
  const sessionDir = join(recoveryRoot, dirs[0]);
  const entryFile = join(sessionDir, `${historicalRef[1]}.json`);
  const mtimeBefore = statSync(entryFile).mtimeMs;
  await new Promise((resolve) => setTimeout(resolve, 5));
  const maskedThird = await contextHandler({ messages: historicalMessages }, context);
  assert.equal(statSync(entryFile).mtimeMs, mtimeBefore, "repeated pass performs no live-entry rewrite or refresh");
  const historicalPage = await tool.execute("t3", { id: historicalRef[1], offset: 0, limit: 4096 }, undefined, undefined, context);
  assert.ok(historicalPage.content[0].text.includes("detail line"), "historical output is recoverable");
  console.log("PASS historical masking archive and stable reference");

  // --- archive failure is lossless ---
  const configDir = join(homeRoot, ".config");
  mkdirSync(configDir, { recursive: true });
  writeFileSync(
    join(configDir, "condensed-milk.json"),
    JSON.stringify({ archive: { enabled: true, maxEntryBytes: 64, maxAggregateBytes: 4096 } }),
  );
  await sessionStart({ reason: "new" }, ctx);
  const refused = await handler(
    { toolName: "bash", toolCallId: "call-oversize", input: { command: "pytest" }, content: [{ type: "text", text: longPytest }], isError: false },
    ctx,
  );
  assert.equal(refused, undefined, "oversize archive keeps original semantic output visible");
  console.log("PASS archive write refusal preserves original output");

  // --- session isolation and safe errors ---
  writeFileSync(join(configDir, "condensed-milk.json"), JSON.stringify({ archive: { enabled: true } }));
  const secondContext = {
    ...ctx,
    sessionManager: { getSessionFile: () => "/fake/sessions/aaaaaaaa-bbbb-cccc-dddd-eeeeeeeeeeee.jsonl" },
  };
  await sessionStart({ reason: "new" }, secondContext);
  await assert.rejects(
    () => tool.execute("t4", { id: archiveId }, undefined, undefined, secondContext),
    /archive entry not found/,
    "a different session cannot retrieve the first session archive",
  );
  await assert.rejects(
    () => tool.execute("t5", { id: "not-an-id" }, undefined, undefined, secondContext),
    /malformed archive reference/,
    "malformed ids return a safe static error",
  );
  console.log("PASS session isolation and safe retrieval errors");
} finally {
  if (originalHome === undefined) delete process.env.HOME;
  else process.env.HOME = originalHome;
  rmSync(buildRoot, { recursive: true, force: true });
  rmSync(homeRoot, { recursive: true, force: true });
}
