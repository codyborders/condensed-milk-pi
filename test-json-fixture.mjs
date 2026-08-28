#!/usr/bin/env node
/**
 * Focused json-schema allowlist fixture (lossy-output boundary).
 * Slice A: global-only explicit command allowlist — validation with
 * actionable warnings, registration under stable ID json-schema,
 * default off, and no behavior change from registration alone.
 */
import { spawnSync } from "node:child_process";
import { mkdtempSync, mkdirSync, readFileSync, writeFileSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";

const tmp = mkdtempSync(join(tmpdir(), "cm-json-"));
for (const name of ["dispatch", "json-schema"]) {
  writeFileSync(join(tmp, `${name}.ts`), readFileSync(`filters/${name}.ts`, "utf8"));
}
const compile = spawnSync("./node_modules/.bin/tsc", [
  "--target", "es2022", "--module", "esnext", "--moduleResolution", "bundler",
  "--skipLibCheck", "--strict", "false", "--noImplicitAny", "false",
  "--outDir", tmp,
  ...["dispatch", "json-schema"].map((name) => join(tmp, `${name}.ts`)),
], { encoding: "utf8" });
if (compile.status !== 0) {
  console.error(compile.stdout, compile.stderr);
  process.exit(1);
}
const { registerJsonSchemaConfig } = await import(join(tmp, "json-schema.js"));
const { dispatch, registeredFilters } = await import(join(tmp, "dispatch.js"));

let failures = 0;
function check(name, condition, detail = "") {
  if (condition) console.log(`  PASS  ${name}`);
  else { console.error(`  FAIL  ${name}${detail ? ` — ${detail}` : ""}`); failures++; }
}

// Validation: non-array config value is rejected with an actionable warning.
const notArrayWarnings = registerJsonSchemaConfig("curl");
check("non-array jsonSchemaCommands rejected", Array.isArray(notArrayWarnings) && notArrayWarnings.length === 1 && /array/.test(notArrayWarnings[0]), JSON.stringify(notArrayWarnings));

// Validation: empty and non-string entries warn; valid entries register.
const mixedWarnings = registerJsonSchemaConfig(["", 5, "curl"]);
check("empty entry warns", mixedWarnings.some((w) => /empty/.test(w)), JSON.stringify(mixedWarnings));
check("non-string entry warns", mixedWarnings.some((w) => /string/.test(w)), JSON.stringify(mixedWarnings));

// Registration: allowed prefix registers under stable ID json-schema, off by default.
const specs = registeredFilters();
const curlSpec = specs.find((f) => f.command === "curl");
check("curl registered under json-schema ID", curlSpec?.id === "json-schema", JSON.stringify(specs.filter((f) => f.id === "json-schema")));
check("json-schema default off", curlSpec?.enabled === false, JSON.stringify(curlSpec));

// Registration alone changes no behavior: large JSON still passes through.
const bigJson = JSON.stringify({
  users: Array.from({ length: 20 }, (_, i) => ({ id: i, name: `user-${i}`, email: `u${i}@example.com` })),
  total: 20, page: 1, per_page: 20, next: null,
});
check("registered-but-disabled curl still passes JSON through",
  dispatch({ command: "curl https://api.example.com/users", stdout: bigJson, isError: false, toolName: "bash" }) === null);

// Slice B: explicit global enable turns on extraction for allowlisted
// commands only; other commands and prefix lookalikes stay untouched.
const { configureFilters, configureProjectFilters } = await import(join(tmp, "dispatch.js"));
configureFilters({ "json-schema": true });
const enabled = dispatch({ command: "curl https://api.example.com/users", stdout: bigJson, isError: false, toolName: "bash" });
check("enabled allowlisted curl gets schema extraction",
  enabled !== null && enabled.output.length < bigJson.length && enabled.output.startsWith("JSON object"),
  JSON.stringify(enabled));
check("cat without allowlist still passes JSON through",
  dispatch({ command: "cat data.json", stdout: bigJson, isError: false, toolName: "bash" }) === null);
check("unknown command still passes JSON through",
  dispatch({ command: "my-cli fetch --all", stdout: bigJson, isError: false, toolName: "bash" }) === null);
check("prefix boundary: curlfoo does not match curl",
  dispatch({ command: "curlfoo https://x", stdout: bigJson, isError: false, toolName: "bash" }) === null);

// Heterogeneous array: every observed type represented, values omitted.
const hetJson = JSON.stringify({
  items: [1, "two", null, true, { id: 7 }, [1, 2]],
  meta: Array.from({ length: 30 }, (_, i) => `sk-live-SECRETVALUE${i}`).join(","),
  secret_number: 42,
});
const het = dispatch({ command: "curl https://api.example.com/het", stdout: hetJson, isError: false, toolName: "bash" });
const hetOut = het?.output ?? "";
check("heterogeneous array: every observed type represented",
  hetOut.includes("number") && hetOut.includes("string") && hetOut.includes("null") && hetOut.includes("boolean") && hetOut.includes("object"),
  JSON.stringify(hetOut));
check("array length preserved", hetOut.includes("array(6)"), JSON.stringify(hetOut));
check("object key shapes preserved", hetOut.includes('"id": number') && hetOut.includes('"secret_number": number'), JSON.stringify(hetOut));
check("scalar values omitted (no value text in output)", !hetOut.includes("SECRETVALUE") && !hetOut.includes("two") && !hetOut.includes("42"), JSON.stringify(hetOut));
check("deterministic output", hetOut === (dispatch({ command: "curl https://api.example.com/het", stdout: hetJson, isError: false, toolName: "bash" })?.output ?? "<null>"));

// Declines: malformed, uncertain, and not-shorter input pass through.
check("malformed JSON declines", dispatch({ command: "curl https://x", stdout: "{ not json " + "x".repeat(100), isError: false, toolName: "bash" }) === null);
check("top-level scalar JSON declines", dispatch({ command: "curl https://x", stdout: JSON.stringify("just a string".repeat(8)), isError: false, toolName: "bash" }) === null);
const compact20 = JSON.stringify(Object.fromEntries(Array.from({ length: 20 }, (_, i) => [String.fromCharCode(97 + i), i])));
check("schema longer than input declines", dispatch({ command: "curl https://x", stdout: compact20, isError: false, toolName: "bash" }) === null, `len=${compact20.length}`);
check("failed JSON command output passes through", dispatch({ command: "curl https://x", stdout: hetJson, isError: true, toolName: "bash" }) === null);

// Project config cannot enable the default-off allowlist filter.
configureFilters({ "json-schema": false });
const projectWarnings = configureProjectFilters({ "json-schema": true });
check("project config cannot enable json-schema",
  projectWarnings.some((w) => /cannot enable/.test(w) && /json-schema/.test(w)) &&
  registeredFilters().find((f) => f.id === "json-schema")?.enabled === false,
  JSON.stringify(projectWarnings));
check("project-enabled attempt still passes JSON through",
  dispatch({ command: "curl https://api.example.com/users", stdout: bigJson, isError: false, toolName: "bash" }) === null);

// Integration (subprocess, HOME + cwd overridden): index.ts loads
// jsonSchemaCommands from the GLOBAL config only; project config cannot
// register or enable the allowlist.
const repoRoot = process.cwd();
const tsxBin = join(repoRoot, "node_modules", ".bin", "tsx");
const probeCode = `
import tokenCompressor from ${JSON.stringify(join(repoRoot, "index.ts"))};
import { dispatch, registeredFilters, registeredCommands } from ${JSON.stringify(join(repoRoot, "filters/dispatch.ts"))};
tokenCompressor({ on: () => ({}), registerCommand: () => {}, registerTool: () => {} });
const specs = registeredFilters().filter((f) => f.id === "json-schema");
const bigJson = JSON.stringify({ users: Array.from({ length: 20 }, (_, i) => ({ id: i, name: "user-" + i })), total: 20, page: 1 });
console.log(JSON.stringify({
  specs: specs.map((s) => ({ command: s.command, enabled: s.enabled })),
  catRegistered: registeredCommands().includes("cat"),
  curlCompressed: dispatch({ command: "curl https://api.example.com/users", stdout: bigJson, isError: false, toolName: "bash" }) !== null,
}));
`;
function runIndexProbe(homeDir, projDir) {
  const res = spawnSync(tsxBin, ["--eval", probeCode], {
    cwd: projDir,
    encoding: "utf8",
    env: { ...process.env, HOME: homeDir },
  });
  const line = res.stdout.split("\n").find((l) => l.trim().startsWith("{"));
  return { parsed: line ? JSON.parse(line) : null, stderr: res.stderr };
}
const home1 = mkdtempSync(join(tmpdir(), "cm-home1-"));
mkdirSync(join(home1, ".config"), { recursive: true });
writeFileSync(join(home1, ".config", "condensed-milk.json"), JSON.stringify({ jsonSchemaCommands: ["curl"], filters: { "json-schema": true } }));
const globalEnabled = runIndexProbe(home1, home1);
check("index.ts: global jsonSchemaCommands + filters enable wires extraction",
  globalEnabled.parsed?.specs?.length === 1 && globalEnabled.parsed.specs[0].command === "curl" &&
  globalEnabled.parsed.specs[0].enabled === true && globalEnabled.parsed.curlCompressed === true,
  JSON.stringify(globalEnabled));
rmSync(home1, { recursive: true, force: true });
const home2 = mkdtempSync(join(tmpdir(), "cm-home2-"));
mkdirSync(join(home2, ".config"), { recursive: true });
writeFileSync(join(home2, ".config", "condensed-milk.json"), JSON.stringify({ jsonSchemaCommands: ["curl"] }));
const proj2 = mkdtempSync(join(tmpdir(), "cm-proj2-"));
writeFileSync(join(proj2, "condensed-milk.config.json"), JSON.stringify({ jsonSchemaCommands: ["cat"], filters: { "json-schema": true } }));
const projectAttempt = runIndexProbe(home2, proj2);
check("index.ts: project config cannot register or enable json-schema",
  projectAttempt.parsed?.catRegistered === false &&
  projectAttempt.parsed?.specs?.every((s) => s.enabled === false) === true &&
  projectAttempt.parsed?.curlCompressed === false &&
  /cannot enable/.test(projectAttempt.stderr),
  JSON.stringify(projectAttempt));
rmSync(home2, { recursive: true, force: true });
rmSync(proj2, { recursive: true, force: true });

if (failures > 0) {
  console.error(`\nFAIL — ${failures} json-schema check(s) failed.`);
  process.exit(1);
}
console.log("json-schema fixture checks passed");
