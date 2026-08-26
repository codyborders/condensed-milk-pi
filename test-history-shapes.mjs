#!/usr/bin/env node
import assert from "node:assert/strict";
import { mkdtempSync, readFileSync, rmSync, writeFileSync } from "node:fs";
import { spawnSync } from "node:child_process";
import { join } from "node:path";
import { tmpdir } from "node:os";

const tmp = mkdtempSync(join(tmpdir(), "cm-history-shapes-"));
writeFileSync(join(tmp, "context-compress.ts"), readFileSync("filters/context-compress.ts", "utf8"));
writeFileSync(join(tmp, "profiles.ts"), readFileSync("filters/profiles.ts", "utf8"));
const tsc = spawnSync("./node_modules/.bin/tsc", ["--target", "es2022", "--module", "esnext", "--moduleResolution", "bundler", "--skipLibCheck", "--strict", "false", "--noImplicitAny", "false", "--outDir", tmp, join(tmp, "context-compress.ts")], { encoding: "utf8" });
if (tsc.status !== 0) { console.error(tsc.stdout, tsc.stderr); process.exit(1); }
const { compressStaleToolResults, emptyUserConfig, resolveRules } = await import(join(tmp, "context-compress.js"));
const opts = { rules: resolveRules(emptyUserConfig()), thresholds: [1], coverage: [1], contextUsage: 1, previousCutoff: 0, zoneEntered: -1 };
const long = "x".repeat(140);
const user = { role: "user", content: [{ type: "text", text: "turn" }] };
const image = { type: "image", data: "image" };
const custom = { type: "custom", data: { keep: true } };
const readMessages = [user, { role: "toolResult", toolName: "read", isError: false, details: { path: "/tmp/file.txt" }, content: [{ type: "text", text: long }, image, custom] }];
const read = compressStaleToolResults(readMessages, opts);
assert.deepEqual(read.messages[1].content, [{ type: "text", text: "[cm-masked read] /tmp/file.txt (1 lines, 140B)" }, image, custom]);
const textFree = [user, { role: "toolResult", toolName: "bash", isError: false, details: { command: "echo image" }, content: [image, custom] }, { role: "toolResult", toolName: "bash", isError: false, details: { command: "echo long" }, content: [{ type: "text", text: long }] }];
const before = JSON.stringify(textFree[1]);
const textFreeResult = compressStaleToolResults(textFree, opts);
assert.equal(JSON.stringify(textFreeResult.messages[1]), before);
const deterministic = [user, { role: "toolResult", toolName: "bash", isError: false, details: { command: "echo stable" }, content: [{ type: "text", text: long }, image, custom] }];
assert.equal(JSON.stringify(compressStaleToolResults(deterministic, opts)), JSON.stringify(compressStaleToolResults(deterministic, opts)));

const failedBash = { role: "toolResult", toolName: "bash", isError: true, details: { command: "git add file.txt" }, content: [{ type: "text", text: long }] };
const successfulBash = { role: "toolResult", toolName: "bash", isError: false, details: { command: "echo successful" }, content: [{ type: "text", text: long }] };
const failedBashMessages = [user, failedBash, successfulBash];
const failedBashOriginal = JSON.stringify(failedBashMessages[1]);
const failedBashResult = compressStaleToolResults(failedBashMessages, opts);
assert.ok(failedBashResult);
assert.equal(JSON.stringify(failedBashResult.messages[1]), failedBashOriginal);
assert.equal(failedBashResult.messages[2].content[0].text, "[cm-masked bash] echo successful");

const failedRead = { role: "toolResult", toolName: "read", isError: true, details: { path: "/tmp/failed.txt" }, content: [{ type: "text", text: long }] };
const successfulRead = { role: "toolResult", toolName: "read", isError: false, details: { path: "/tmp/successful.txt" }, content: [{ type: "text", text: long }] };
const failedReadMessages = [user, failedRead, successfulRead];
const failedReadOriginal = JSON.stringify(failedReadMessages[1]);
const failedReadResult = compressStaleToolResults(failedReadMessages, opts);
assert.ok(failedReadResult);
assert.equal(JSON.stringify(failedReadResult.messages[1]), failedReadOriginal);
assert.equal(failedReadResult.messages[2].content[0].text, "[cm-masked read] /tmp/successful.txt (1 lines, 140B)");

const failedInvalidatorMessages = [
  user,
  { role: "toolResult", toolName: "bash", isError: false, details: { command: "git status" }, content: [{ type: "text", text: long }] },
  { role: "toolResult", toolName: "bash", isError: true, details: { command: "git add file.txt" }, content: [{ type: "text", text: long }] },
];
const failedInvalidatorOpts = { ...opts, coverage: [0.5] };
const failedInvalidatorResult = compressStaleToolResults(failedInvalidatorMessages, failedInvalidatorOpts);
assert.equal(failedInvalidatorResult, null);

console.log("PASS read preservation, text-free identity, deterministic historical masking, failed-result preservation");
rmSync(tmp, { recursive: true, force: true });
