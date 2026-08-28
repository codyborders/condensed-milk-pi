#!/usr/bin/env node
import assert from "node:assert/strict";
import { cpSync, mkdirSync, mkdtempSync, rmSync, writeFileSync } from "node:fs";
import { spawnSync } from "node:child_process";
import { join, resolve } from "node:path";
import { tmpdir } from "node:os";

const root = resolve(".");
const build = mkdtempSync(join(tmpdir(), "cm-config-reload-build-"));
const fixtureRoot = mkdtempSync(join(tmpdir(), "cm-config-reload-fixture-"));
cpSync(join(root, "index.ts"), join(build, "index.ts"));
cpSync(join(root, "filters"), join(build, "filters"), { recursive: true });
mkdirSync(join(build, "node_modules/@earendil-works/pi-coding-agent"), { recursive: true });
writeFileSync(join(build, "node_modules/@earendil-works/pi-coding-agent/package.json"), '{"type":"module"}');
writeFileSync(join(build, "node_modules/@earendil-works/pi-coding-agent/index.js"), "export {};\n");
writeFileSync(join(build, "node_modules/@earendil-works/pi-coding-agent/index.d.ts"), "export interface ExtensionAPI { on: Function; registerCommand: Function; registerTool: Function; }\n");
mkdirSync(join(build, "node_modules/typebox"), { recursive: true });
writeFileSync(join(build, "node_modules/typebox/package.json"), '{"type":"module","exports":"./index.js"}');
writeFileSync(join(build, "node_modules/typebox/index.d.ts"), "export declare const Type: any;\n");
writeFileSync(join(build, "node_modules/typebox/index.js"), 'export const Type = { Object: (spec) => ({ type: "object", properties: spec }), String: (d = {}) => ({ type: "string", ...d }), Integer: (d = {}) => ({ type: "integer", ...d }), Optional: (s) => s };\n');
const tsc = spawnSync(resolve("node_modules/.bin/tsc"), [
  "--target", "es2022", "--module", "esnext", "--moduleResolution", "bundler",
  "--skipLibCheck", "--strict", "false", "--outDir", join(build, "out"), join(build, "index.ts"),
], { encoding: "utf8" });
if (tsc.status !== 0) {
  console.error(tsc.stdout, tsc.stderr);
  process.exit(1);
}
const extensionPath = join(build, "out/index.js");
const dispatchPath = join(build, "out/filters/dispatch.js");
const runnerPath = join(build, "run.mjs");
writeFileSync(runnerPath, `
import { mkdirSync, rmSync, writeFileSync } from "node:fs";
import { join } from "node:path";
import extension from ${JSON.stringify(extensionPath)};
import { registeredFilters, registeredCommands } from ${JSON.stringify(dispatchPath)};
const handlers = new Map();
const api = { on(name, fn) { handlers.set(name, fn); }, registerCommand() {}, registerTool() {} };
const home = process.env.CM_HOME;
const cwdA = process.env.CM_CWD_A;
const cwdB = process.env.CM_CWD_B;
const globalPath = join(home, ".config", "condensed-milk.json");
const projectPath = join(cwdA, "condensed-milk.config.json");
mkdirSync(join(home, ".config"), { recursive: true });
writeFileSync(globalPath, JSON.stringify({ jsonSchemaCommands: ["curl"], filters: { "json-schema": true } }));
writeFileSync(projectPath, JSON.stringify({ filters: { "git-log-verbose": false } }));
process.chdir(cwdA);
extension(api);
const sessionStart = handlers.get("session_start");
if (process.env.CM_MALFORMED === "1") {
  mkdirSync(join(home, ".pi/agent"), { recursive: true });
  writeFileSync(join(home, ".pi/agent/condensed-milk-config.json"), "{malformed");
  try {
    await sessionStart({ reason: "malformed-current-session" }, { ui: { setStatus() {} } });
  } catch (error) {
    console.error(error instanceof Error ? error.message : String(error));
    process.exit(0);
  }
  throw new Error("malformed current-session rules unexpectedly succeeded");
}
const snapshot = () => ({
  json: registeredFilters().filter((filter) => filter.id === "json-schema"),
  gitLog: registeredFilters().find((filter) => filter.id === "git-log-verbose")?.enabled,
});
await sessionStart({ reason: "startup" }, { ui: { setStatus() {} } });
const sessionA = snapshot();
writeFileSync(globalPath, JSON.stringify({}));
process.chdir(cwdB);
await sessionStart({ reason: "new-directory" }, { ui: { setStatus() {} } });
const sessionB = snapshot();
writeFileSync(join(cwdA, "condensed-milk.config.json"), JSON.stringify({ filters: { "git-log-verbose": false } }));
process.chdir(cwdA);
await sessionStart({ reason: "project-override" }, { ui: { setStatus() {} } });
const sessionWithProject = snapshot();
rmSync(projectPath);
await sessionStart({ reason: "project-removed" }, { ui: { setStatus() {} } });
const sessionAfterRemoval = snapshot();
console.log(JSON.stringify({ sessionA, sessionB, sessionWithProject, sessionAfterRemoval, commands: registeredCommands() }));
`);

const home = mkdtempSync(join(fixtureRoot, "home-"));
const cwdA = mkdtempSync(join(fixtureRoot, "cwd-a-"));
const cwdB = mkdtempSync(join(fixtureRoot, "cwd-b-"));
const result = spawnSync(process.execPath, [runnerPath], {
  cwd: root,
  env: { ...process.env, HOME: home, CM_HOME: home, CM_CWD_A: cwdA, CM_CWD_B: cwdB },
  encoding: "utf8",
});
assert.equal(result.status, 0, result.stderr);
const output = JSON.parse(result.stdout.trim());
assert.equal(output.sessionA.json.length, 1, "session A did not register current JSON command");
assert.equal(output.sessionA.json[0].enabled, true, "session A did not enable JSON filter");
assert.equal(output.sessionA.gitLog, false, "session A did not apply project override");
assert.equal(output.sessionB.json.length, 0, "session B retained stale dynamic JSON command");
assert.equal(output.sessionB.gitLog, false, "session B restored safe git-log default");
assert.equal(output.sessionWithProject.gitLog, false, "project override did not apply after reload");
assert.equal(output.sessionAfterRemoval.gitLog, false, "removing project file did not restore safe default");
assert.equal(output.sessionAfterRemoval.json.length, 0, "removed global JSON command remained registered");

const malformed = spawnSync(process.execPath, [runnerPath], {
  cwd: root,
  env: { ...process.env, HOME: home, CM_HOME: home, CM_CWD_A: cwdA, CM_CWD_B: cwdB, CM_MALFORMED: "1" },
  encoding: "utf8",
});
assert.equal(malformed.status, 0, malformed.stderr);
assert.match(malformed.stderr, /invalid JSON in rules config/);
assert.match(malformed.stderr, /condensed-milk-config\.json/);

rmSync(build, { recursive: true, force: true });
rmSync(fixtureRoot, { recursive: true, force: true });
console.log("Config reload tests passed.");
