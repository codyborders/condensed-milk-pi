#!/usr/bin/env node
import assert from "node:assert/strict";
import { cpSync, mkdirSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from "node:fs";
import { spawnSync } from "node:child_process";
import { join, resolve } from "node:path";
import { tmpdir } from "node:os";

const root = resolve(".");
const build = mkdtempSync(join(tmpdir(), "cm-rules-build-"));
const fixtureRoot = mkdtempSync(join(tmpdir(), "cm-rules-fixture-"));
cpSync(join(root, "index.ts"), join(build, "index.ts"));
cpSync(join(root, "filters"), join(build, "filters"), { recursive: true });
mkdirSync(join(build, "node_modules/@earendil-works/pi-coding-agent"), { recursive: true });
writeFileSync(join(build, "node_modules/@earendil-works/pi-coding-agent/package.json"), '{"type":"module"}');
writeFileSync(join(build, "node_modules/@earendil-works/pi-coding-agent/index.js"), "export {};\n");
writeFileSync(join(build, "node_modules/@earendil-works/pi-coding-agent/index.d.ts"), "export interface ExtensionAPI { on: Function; registerCommand: Function; }\n");
const tsc = spawnSync(resolve("node_modules/.bin/tsc"), [
  "--target", "es2022", "--module", "esnext", "--moduleResolution", "bundler",
  "--skipLibCheck", "--strict", "false", "--outDir", join(build, "out"), join(build, "index.ts"),
], { encoding: "utf8" });
if (tsc.status !== 0) {
  console.error(tsc.stdout, tsc.stderr);
  process.exit(1);
}
const extensionPath = join(build, "out/index.js");
const runnerPath = join(build, "run.mjs");
writeFileSync(runnerPath, `
import extension from ${JSON.stringify(extensionPath)};
const handlers = new Map();
const api = { on(name, fn) { handlers.set(name, fn); }, registerCommand() {} };
extension(api);
if (process.env.CM_RUN_CONTEXT === "1") {
  const long = "x".repeat(200);
  const read = (path) => ({ role: "toolResult", toolName: "read", isError: false, details: { path }, content: [{ type: "text", text: long }] });
  const messages = [
    { role: "user", content: [{ type: "text", text: "turn" }] },
    read("global.txt"),
    read("/project-ref/file.txt"),
    read("README.md"),
    read("ordinary.txt"),
    { role: "user", content: [{ type: "text", text: "end" }] },
  ];
  const result = await handlers.get("context")({ messages }, { getContextUsage: () => ({ tokens: 1, contextWindow: 1 }) });
  process.stdout.write(JSON.stringify(result));
}
`);

function run(name, setup, env = {}) {
  const home = mkdtempSync(join(fixtureRoot, `${name}-home-`));
  const cwd = mkdtempSync(join(fixtureRoot, `${name}-cwd-`));
  mkdirSync(join(home, ".pi/agent"), { recursive: true });
  setup({ home, cwd });
  const result = spawnSync(process.execPath, [runnerPath], {
    cwd,
    env: { ...process.env, HOME: home, CM_RUN_CONTEXT: env.context ? "1" : "0" },
    encoding: "utf8",
  });
  return { ...result, home, cwd };
}

const globalConfig = (home, value) => writeFileSync(join(home, ".pi/agent/condensed-milk-config.json"), value);
const projectConfig = (cwd, value) => writeFileSync(join(cwd, "condensed-milk.config.json"), value);
const assertFailure = (name, setup, snippets) => {
  const result = run(name, setup);
  assert.notEqual(result.status, 0, `${name} unexpectedly started`);
  const output = `${result.stdout}${result.stderr}`;
  for (const snippet of snippets) assert.match(output, snippet, `${name}: missing ${snippet}`);
};

const valid = run("valid-merge", ({ home, cwd }) => {
  globalConfig(home, JSON.stringify({ referenceBasenames: ["global.txt"] }));
  projectConfig(cwd, JSON.stringify({ referencePathSubstrings: ["/project-ref/"] }));
}, { context: true });
assert.equal(valid.status, 0, valid.stderr);
const resolved = JSON.parse(valid.stdout);
const texts = resolved.messages.map((message) => message.content?.[0]?.text ?? "");
assert.equal(texts[1].length, 200, "global basename rule was not merged");
assert.equal(texts[2].length, 200, "project substring rule was not merged");
assert.equal(texts[3].length, 200, "default basename rule was not retained");
assert.match(texts[4], /^\[cm-masked read\]/, "ordinary file was not masked");
assert.deepEqual(resolved.messages, JSON.parse(run("deterministic", ({ home, cwd }) => {
  globalConfig(home, JSON.stringify({ referenceBasenames: ["global.txt"] }));
  projectConfig(cwd, JSON.stringify({ referencePathSubstrings: ["/project-ref/"] }));
}, { context: true }).stdout).messages, "resolved behavior was not deterministic");

assertFailure("malformed-json", ({ home }) => globalConfig(home, "{\"referenceBasenames\":["), [/rules config/ , /condensed-milk-config\.json/]);
assertFailure("root-array", ({ home }) => globalConfig(home, "[]"), [/rules config/, /condensed-milk-config\.json/]);
assertFailure("wrong-basename-array", ({ cwd }) => projectConfig(cwd, JSON.stringify({ referenceBasenames: ["ok", 4] })), [/referenceBasenames/, /condensed-milk\.config\.json/]);
assertFailure("wrong-substring-array", ({ cwd }) => projectConfig(cwd, JSON.stringify({ referencePathSubstrings: "nope" })), [/referencePathSubstrings/, /condensed-milk\.config\.json/]);
assertFailure("wrong-rule-object", ({ cwd }) => projectConfig(cwd, JSON.stringify({ invalidationRules: ["nope"] })), [/invalidationRules\[0\]/, /invalidator/, /condensed-milk\.config\.json/]);
assertFailure("missing-rule-field", ({ cwd }) => projectConfig(cwd, JSON.stringify({ invalidationRules: [{ invalidator: "git status" }] })), [/invalidationRules\[0\]\.invalidated/, /condensed-milk\.config\.json/]);
assertFailure("wrong-disable-defaults", ({ cwd }) => projectConfig(cwd, JSON.stringify({ disableDefaults: "yes" })), [/disableDefaults/, /condensed-milk\.config\.json/]);
assertFailure("invalid-regex", ({ cwd }) => projectConfig(cwd, JSON.stringify({ invalidationRules: [{ invalidator: "(", invalidated: "ok" }] })), [/invalid regex/, /condensed-milk\.config\.json/, /invalidationRules\[0\]\.invalidator/]);
assertFailure("read-failure", ({ cwd }) => mkdirSync(join(cwd, "condensed-milk.config.json")), [/cannot read rules config/, /condensed-milk\.config\.json/]);

rmSync(build, { recursive: true, force: true });
rmSync(fixtureRoot, { recursive: true, force: true });
console.log("Rules configuration validation tests passed.");
