#!/usr/bin/env node
import assert from "node:assert/strict";
import { cpSync, mkdirSync, mkdtempSync, readFileSync, writeFileSync } from "node:fs";
import { spawnSync } from "node:child_process";
import { join } from "node:path";
import { tmpdir } from "node:os";

const tmp = mkdtempSync(join(tmpdir(), "cm-tracker-"));
cpSync("index.ts", join(tmp, "index.ts"));
cpSync("filters", join(tmp, "filters"), { recursive: true });
mkdirSync(join(tmp, "node_modules/@earendil-works/pi-coding-agent"), { recursive: true });
writeFileSync(join(tmp, "node_modules/@earendil-works/pi-coding-agent/package.json"), '{"type":"module"}');
writeFileSync(join(tmp, "node_modules/@earendil-works/pi-coding-agent/index.js"), "export {};\n");
writeFileSync(join(tmp, "node_modules/@earendil-works/pi-coding-agent/index.d.ts"), "export interface ExtensionAPI { on: Function; registerCommand: Function; registerTool: Function; }\n");
mkdirSync(join(tmp, "node_modules/typebox"), { recursive: true });
writeFileSync(join(tmp, "node_modules/typebox/package.json"), '{"type":"module","exports":"./index.js"}');
writeFileSync(join(tmp, "node_modules/typebox/index.d.ts"), "export declare const Type: any;\n");
writeFileSync(join(tmp, "node_modules/typebox/index.js"), 'export const Type = { Object: (spec) => ({ type: "object", properties: spec }), String: (d = {}) => ({ type: "string", ...d }), Integer: (d = {}) => ({ type: "integer", ...d }), Optional: (s) => s };\n');
const tsc = spawnSync("npx", ["-y", "-p", "typescript@5.9", "tsc", "--target", "es2022", "--module", "esnext", "--moduleResolution", "bundler", "--skipLibCheck", "--strict", "false", "--outDir", join(tmp, "out"), join(tmp, "index.ts")], { encoding: "utf8" });
if (tsc.status !== 0) { console.error(tsc.stdout, tsc.stderr); process.exit(1); }
const mod = await import(join(tmp, "out/index.js"));
const handlers = new Map();
const fakeApi = { on(name, fn) { handlers.set(name, fn); }, registerCommand(name, spec) { handlers.set(name, spec.handler); }, registerTool() {} };
mod.default(fakeApi);
const contextHandler = handlers.get("context");
const statsHandler = handlers.get("compress-stats");
const readMessages = Array.from({ length: 12000 }, (_, i) => ({
  role: "toolResult", toolName: "read", isError: false,
  details: { path: `/tmp/history-${i}.txt` },
  content: [{ type: "text", text: "x".repeat(120) }],
}));
const bashMessages = Array.from({ length: 12000 }, (_, i) => ({
  role: "toolResult", toolName: "bash", isError: false,
  details: { command: `printf command-${i}` },
  content: [{ type: "text", text: "x".repeat(120) }],
}));
const messages = [...readMessages, ...bashMessages];
await contextHandler({ messages }, { getContextUsage: () => ({ tokens: 100, contextWindow: 100 }), ui: {} });
const shown = [];
await statsHandler([], { ui: { notify(text) { shown.push(text); } } });
const report = shown.join("\n");
const trackedMatch = report.match(/Currently tracked: (\d+) reads, (\d+) bashes/);
const uniqueMatch = report.match(/Unique masks: (\d+) reads, (\d+) bashes/);
const trackedReads = Number(trackedMatch?.[1]);
const trackedBashes = Number(trackedMatch?.[2]);
const uniqueReads = Number(uniqueMatch?.[1]);
const uniqueBashes = Number(uniqueMatch?.[2]);
assert.ok(trackedReads <= 10000, `active read tracker exceeded bound: ${trackedReads}`);
assert.ok(trackedBashes <= 10000, `active bash tracker exceeded bound: ${trackedBashes}`);
assert.ok(uniqueReads <= 10000, `ever-masked read tracker exceeded bound: ${uniqueReads}`);
assert.ok(uniqueBashes <= 10000, `ever-masked bash tracker exceeded bound: ${uniqueBashes}`);
console.log("PASS historical tracker bounds");
