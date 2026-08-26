#!/usr/bin/env node
import assert from "node:assert/strict";
import { mkdtempSync, readFileSync, rmSync, writeFileSync } from "node:fs";
import { spawnSync } from "node:child_process";
import { join } from "node:path";
import { tmpdir } from "node:os";

const tmp = mkdtempSync(join(tmpdir(), "cm-history-"));
writeFileSync(join(tmp, "context-compress.ts"), readFileSync("filters/context-compress.ts", "utf8"));
writeFileSync(join(tmp, "profiles.ts"), readFileSync("filters/profiles.ts", "utf8"));
const tsc = spawnSync("./node_modules/.bin/tsc", [
  "--target", "es2022", "--module", "esnext", "--moduleResolution", "bundler",
  "--skipLibCheck", "--strict", "false", "--noImplicitAny", "false", "--outDir", tmp,
  join(tmp, "context-compress.ts"),
], { encoding: "utf8" });
if (tsc.status !== 0) {
  console.error(tsc.stdout, tsc.stderr);
  process.exit(1);
}
const { compressStaleToolResults, emptyUserConfig, resolveRules } = await import(join(tmp, "context-compress.js"));
const opts = { rules: resolveRules(emptyUserConfig()), thresholds: [1], coverage: [1], contextUsage: 1, previousCutoff: 0, zoneEntered: -1 };
const image = { type: "image", data: "keep-image", mimeType: "image/png" };
const custom = { type: "custom", payload: { keep: true } };
const messages = [
  { role: "user", content: [{ type: "text", text: "turn" }] },
  { role: "toolResult", toolName: "bash", isError: false, details: { command: "printf output" }, content: [
    { type: "text", text: "x".repeat(140) }, image, custom, { type: "text", text: "trailing text" },
  ] },
];
const original = JSON.stringify(messages);
const result = compressStaleToolResults(messages, opts);
assert.ok(result);
assert.deepEqual(result.messages[1].content, [
  { type: "text", text: "[cm-masked bash] printf output" }, image, custom, { type: "text", text: "" },
]);
assert.equal(JSON.stringify(messages), original);
console.log("PASS bash mixed block preservation");
rmSync(tmp, { recursive: true, force: true });
