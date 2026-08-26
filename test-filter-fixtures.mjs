#!/usr/bin/env node
/**
 * Deterministic dispatch fixtures for pytest, Python traceback, tsc, and linter filters.
 */
import { spawnSync } from "node:child_process";
import { mkdtempSync, readFileSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";

const tmp = mkdtempSync(join(tmpdir(), "cm-filter-fixtures-"));
for (const name of ["dispatch", "pytest", "python-traceback", "tsc", "test-runners", "build", "install", "linter"]) {
  writeFileSync(join(tmp, `${name}.ts`), readFileSync(`filters/${name}.ts`, "utf8"));
}
const compile = spawnSync("./node_modules/.bin/tsc", [
  "--target", "es2022", "--module", "esnext", "--moduleResolution", "bundler",
  "--skipLibCheck", "--strict", "false", "--noImplicitAny", "false",
  "--outDir", tmp,
  ...["dispatch", "pytest", "python-traceback", "tsc", "test-runners", "build", "install", "linter"].map((name) => join(tmp, `${name}.ts`)),
], { encoding: "utf8" });
if (compile.status !== 0) {
  console.error(compile.stdout, compile.stderr);
  process.exit(1);
}
for (const name of ["pytest", "python-traceback", "tsc", "test-runners", "build", "install", "linter"]) await import(join(tmp, `${name}.js`));
const { dispatch, configureFilters, registeredFilters } = await import(join(tmp, "dispatch.js"));
configureFilters({
  "npm-test": true,
  "vitest": true,
  "jest": true,
  "mocha": true,
  "cargo-build": true,
  "npm-install": true,
});

let failures = 0;
function check(name, condition, detail = "") {
  if (condition) console.log(`  PASS  ${name}`);
  else { console.error(`  FAIL  ${name}${detail ? ` — ${detail}` : ""}`); failures++; }
}
function run(command, stdout, isError = false) {
  return dispatch({ command, stdout, isError, toolName: "bash" });
}

const earlyPassLateFail = [
  " RUN v3.0.0 /workspace",
  " PASS first.test.ts (2 tests) 4ms",
  " Test Files 1 passed (1)",
  " Tests 2 passed (2)",
  " FAIL second.test.ts",
  " Tests 1 failed, 2 passed (3)",
  " Tests: 2 passed, 1 failed, 3 total",
  " stderr diagnostic line",
  " another diagnostic line",
  " final diagnostic line",
  "",
].join("\n");
check("test runner does not summarize early pass before later failure", run("vitest", earlyPassLateFail) === null);

const cargoWarning = [
  "   Compiling app v1.0.0",
  "   Compiling dep1 v1.0.0",
  "   Compiling dep2 v1.0.0",
  "   Compiling dep3 v1.0.0",
  "   Compiling dep4 v1.0.0",
  "   Compiling dep5 v1.0.0",
  "warning: unused variable: value",
  "    Finished `dev` profile [unoptimized + debuginfo] target(s) in 1.20s",
].join("\n");
check("build warning is not summarized as success", run("cargo build", cargoWarning) === null);

const installOutput = [
  "npm http fetch GET 200 https://registry.npmjs.org/example",
  "Resolving dependencies",
  "Downloading example",
  "Progress: 25%",
  "Progress: 50%",
  "Progress: 75%",
  "added 3 packages in 1s",
  "audited 4 packages",
  "npm notice done",
  "npm notice complete",
].join("\n");
check("install filter declines variable package-manager output", run("npm install", installOutput) === null);

const pytestSummary = "================ 4 passed, 2 skipped in 0.10s ================";
const pytestResult = run("pytest", `${"collecting ...\n".repeat(8)}${pytestSummary}\n`);
check("pytest preserves exact terminal summary", pytestResult?.output === `pytest: ${pytestSummary}`, JSON.stringify(pytestResult));

configureFilters({ python: true });
const traceback = `Traceback (most recent call last):\n  File "/workspace/frame1.py", line 10, in call1\n    value = 1\n  File "/workspace/frame2.py", line 11, in call2\n    value = 2\n  File "/workspace/frame3.py", line 12, in call3\n    value = 3\n  File "/workspace/frame4.py", line 13, in call4\n    value = 4\n  File "/workspace/frame5.py", line 14, in call5\n    value = 5\nValueError: decisive message\n`;
const tracebackResult = run("python script.py", traceback);
check("traceback keeps selected frame fields and count", tracebackResult !== null &&
  tracebackResult.output.includes("/workspace/frame1.py\", line 10") &&
  tracebackResult.output.includes("/workspace/frame5.py\", line 14") &&
  tracebackResult.output.includes("1 frames omitted") &&
  tracebackResult.output.includes("ValueError: decisive message"), JSON.stringify(tracebackResult));
const malformedTraceback = `Traceback (most recent call last):\n  File "x.py", line nope\nValueError: bad\n${"context output\\n".repeat(8)}`;
check("malformed traceback passes through", run("python script.py", malformedTraceback) === null);

configureFilters({ tsc: true });
const unknownTsc = "compilation completed without diagnostics\n".repeat(8);
check("unrecognized tsc output passes through", run("tsc", unknownTsc) === null);
const watchDiagnostics = Array.from({ length: 12 }, (_, index) =>
  `src/watch${index}.ts(1,1): error TS1234: bad`,
).join("\n");
check("tsc watch command passes through", run("tsc --watch", `${watchDiagnostics}\nFound 12 errors.\n`) === null);

const linterFilters = registeredFilters().filter(({ id }) =>
  ["eslint", "npx-eslint", "pnpm-eslint", "ruff", "ruff-check", "pylint", "mypy", "flake8", "black", "prettier", "npx-prettier", "cargo-clippy", "golangci-lint"].includes(id),
);
check("linter filters are default off", linterFilters.length > 0 && linterFilters.every(({ enabled }) => !enabled));
configureFilters({ eslint: true, prettier: true, black: true });
const linterLines = Array.from({ length: 20 }, (_, index) =>
  `/workspace/project/components/very-long-directory-name/diagnostic-file-${index}.ts:${index + 1}:${index + 2}: ${index % 2 === 0 ? "error" : "warning"}: message-${index} with complete detail [rule-${index % 4}]`,
);
const linterFixture = `${linterLines.join("\n")}\n`;
const linterResult = run("eslint", linterFixture);
check("linter rejects unparsed diagnostic line", run("eslint", `${linterFixture}FATAL unparsed footer\n`) === null);
check("linter short output passes through", run("eslint", `${linterLines.slice(0, 2).join("\n")}\n`) === null);
check("linter unknown output passes through", run("eslint", `${linterFixture}unknown producer output\n`) === null);
check("linter retains first ten complete diagnostics with exact omission count", linterResult !== null &&
  linterLines.slice(0, 10).every((line) => linterResult.output.split("\n").includes(line)) &&
  !linterResult.output.includes(linterLines[10]) &&
  linterResult.output.includes("+10 more diagnostics") &&
  linterResult.output.length < linterFixture.length, JSON.stringify(linterResult));
check("linter output is deterministic", linterResult !== null && run("eslint", linterFixture)?.output === linterResult.output);
check("linter declines missing severity or rule", run("eslint", `${linterLines.slice(0, 5).join("\n")}\n/workspace/a.ts:1:2: message without severity or rule\n`) === null);
check("linter watch output passes through", run("eslint --watch", linterFixture) === null);
check("formatter-only output passes through", run("prettier", linterFixture) === null && run("black", linterFixture) === null);
check("linter footer mismatch passes through", run("eslint", `${linterFixture}Found 20 problems.\n`) === null);
check("mixed producer linter output passes through", run("eslint && echo done", linterFixture) === null);
check("linter error event passes through", run("eslint", linterFixture, true) === null);

if (failures > 0) process.exit(1);
console.log("filter fixture checks passed");
