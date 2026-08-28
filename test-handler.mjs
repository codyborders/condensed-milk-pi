#!/usr/bin/env node
import assert from "node:assert/strict";
import { spawnSync } from "node:child_process";
import { cpSync, mkdtempSync, rmSync, symlinkSync } from "node:fs";
import { fileURLToPath } from "node:url";
import { dirname, join } from "node:path";
import { tmpdir } from "node:os";

const repositoryRoot = dirname(fileURLToPath(import.meta.url));
const temporaryRoot = mkdtempSync(join(tmpdir(), "cm-handler-"));
const outputDirectory = join(temporaryRoot, "out");
const tscPath = join(repositoryRoot, "node_modules", "typescript", "bin", "tsc");

try {
  cpSync(join(repositoryRoot, "index.ts"), join(temporaryRoot, "index.ts"));
  cpSync(join(repositoryRoot, "filters"), join(temporaryRoot, "filters"), { recursive: true });
  cpSync(join(repositoryRoot, "tsconfig.json"), join(temporaryRoot, "tsconfig.json"));
  symlinkSync(join(repositoryRoot, "node_modules"), join(temporaryRoot, "node_modules"), "junction");

  const tsc = spawnSync(
    process.execPath,
    [tscPath, "--project", join(temporaryRoot, "tsconfig.json"), "--outDir", outputDirectory, "--noEmit", "false"],
    { cwd: temporaryRoot, encoding: "utf8" },
  );
  if (tsc.error) throw tsc.error;
  if (tsc.status !== 0) {
    const diagnostics = [tsc.stdout, tsc.stderr].filter(Boolean).join("\n");
    throw new Error(`TypeScript compilation failed${diagnostics ? `:\n${diagnostics}` : ""}`);
  }

  const mod = await import(join(outputDirectory, "index.js"));
  const handlers = new Map();
  const fakeApi = { on(name, fn) { handlers.set(name, fn); }, registerCommand() {}, registerTool() {} };
  mod.default(fakeApi);
  const handler = handlers.get("tool_result");
  assert.equal(typeof handler, "function");
  const blocks = [{ type: "text", text: String.fromCharCode(27) + "[31mAPI_KEY=" + "secret".repeat(30) + String.fromCharCode(27) + "[0m" }, { type: "image", data: "keep" }, { type: "text", text: "API_TOKEN=" + "token".repeat(30) }];
  const result = await handler({ toolName: "bash", input: { command: "env" }, content: blocks, isError: false }, { ui: {} });
  assert.equal(result.content[1].type, "image");
  assert.deepEqual(result.content[1], blocks[1]);
  assert.equal(result.content[0].type, "text");
  assert.equal(result.content[2].type, "text");

  const multiText = [
    { type: "text", text: String.fromCharCode(27) + "[31mAPI_KEY=" + "secret".repeat(30) + String.fromCharCode(27) + "[0m" },
    { type: "text", text: "API_TOKEN=" + "token".repeat(30) },
  ];
  const multiResult = await handler(
    { toolName: "bash", input: { command: "env" }, content: multiText, isError: false },
    { ui: {} },
  );
  // v1.10.1: multi-text env output redacts in every text block (the old
  // assertion here codified the leak — ANSI strip only, secrets intact).
  assert.deepEqual(multiResult.content, [
    { type: "text", text: "API_KEY=[REDACTED]" },
    { type: "text", text: "API_TOKEN=[REDACTED]" },
  ]);
  console.log("PASS mixed tool-result block preservation");

  // ---------------------------------------------------------------------
  // v1.10.1 blocker 1: a bash result with multiple text blocks must still
  // get environment redaction (privacy boundary). Current code only strips
  // ANSI per block when textBlockCount !== 1, so secrets split across text
  // blocks reach the model verbatim.
  // ---------------------------------------------------------------------
  const mixedBlocks = [
    { type: "text", text: "SHELL=/bin/zsh\nAPI_TOKEN=" + "tok".repeat(25) + "\nPATH=/usr/local/bin:/usr/bin:/bin" },
    { type: "image", data: "iVBORw0KGgoAAAANSUhEUg==", mimeType: "image/png" },
    { type: "text", text: "DB_PASSWORD=hunter2000\nnot an assignment line\nEDITOR=vim" },
    // Semantic non-privacy filters must not process partial blocks: this
    // pytest terminal summary must stay byte-identical here (the
    // single-block path would compress it).
    { type: "text", text: "================  4 passed in 0.1s  ================\n".repeat(20) },
  ];
  const mixedResult = await handler(
    { toolName: "bash", input: { command: "env" }, content: mixedBlocks, isError: false },
    { ui: {} },
  );
  assert.deepEqual(mixedResult.content.map((b) => b.type), ["text", "image", "text", "text"]);
  assert.deepEqual(mixedResult.content[0], {
    type: "text",
    text: "SHELL=/bin/zsh\nAPI_TOKEN=[REDACTED]\nPATH=/usr/local/bin:/usr/bin:/bin",
  });
  assert.deepEqual(mixedResult.content[1], mixedBlocks[1]);
  assert.deepEqual(mixedResult.content[2], {
    type: "text",
    text: "DB_PASSWORD=[REDACTED]\nnot an assignment line\nEDITOR=vim",
  });
  assert.deepEqual(mixedResult.content[3], mixedBlocks[3]);
  assert.ok(!JSON.stringify(mixedResult.content).includes("hunter2000"));
  assert.ok(!JSON.stringify(mixedResult.content).includes("tok".repeat(25)));

  console.log("PASS multi-block environment redaction");

  // ANSI-colored secret in a multi-block result: strip ANSI first, then
  // redact. Image payload and block order stay untouched.
  const ESC = String.fromCharCode(27);
  const ansiMixed = [
    { type: "text", text: ESC + "[31mAPI_KEY=" + "secret".repeat(30) + ESC + "[0m" },
    { type: "image", data: "keep" },
    { type: "text", text: "API_TOKEN=" + "token".repeat(30) },
  ];
  const ansiMixedResult = await handler(
    { toolName: "bash", input: { command: "env" }, content: ansiMixed, isError: false },
    { ui: {} },
  );
  assert.deepEqual(ansiMixedResult.content.map((b) => b.type), ["text", "image", "text"]);
  assert.deepEqual(ansiMixedResult.content[1], ansiMixed[1]);
  assert.deepEqual(ansiMixedResult.content[0], { type: "text", text: "API_KEY=[REDACTED]" });
  assert.deepEqual(ansiMixedResult.content[2], { type: "text", text: "API_TOKEN=[REDACTED]" });
  assert.ok(!JSON.stringify(ansiMixedResult.content).includes("secret".repeat(30)));
  assert.ok(!JSON.stringify(ansiMixedResult.content).includes("token".repeat(30)));

  console.log("PASS ansi multi-block redaction");

  // Failed multi-text env output still redacts and preserves diagnostics.
  const failedBlocks = [
    { type: "text", text: "env: invalid option -- z\nusage: env [OPTION]... [-] [NAME=VALUE]... [COMMAND [ARG]...]\nAWS_SECRET_ACCESS_KEY=AKIAIOSFODNN7EXAMPLE" },
    { type: "image", data: "keep2" },
    { type: "text", text: "Try env --help for more information.\nDB_PASSWORD=hunter2000" },
  ];
  const failedResult = await handler(
    { toolName: "bash", input: { command: "env" }, content: failedBlocks, isError: true },
    { ui: {} },
  );
  assert.equal(failedResult.isError, true);
  assert.deepEqual(failedResult.content[0], {
    type: "text",
    text: "env: invalid option -- z\nusage: env [OPTION]... [-] [NAME=VALUE]... [COMMAND [ARG]...]\nAWS_SECRET_ACCESS_KEY=[REDACTED]",
  });
  assert.deepEqual(failedResult.content[1], failedBlocks[1]);
  assert.deepEqual(failedResult.content[2], {
    type: "text",
    text: "Try env --help for more information.\nDB_PASSWORD=[REDACTED]",
  });
  assert.ok(!JSON.stringify(failedResult.content).includes("AKIAIOSFODNN7EXAMPLE"));
  assert.ok(!JSON.stringify(failedResult.content).includes("hunter2000"));

  console.log("PASS failed multi-block env redaction + diagnostics");
} finally {
  rmSync(temporaryRoot, { recursive: true, force: true });
}
