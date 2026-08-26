#!/usr/bin/env node
/**
 * v1.9.0 regression (ADR-030): compound-command stdout must not be
 * collapsed by per-command prefix filters.
 *
 * Bug reproduced by user:
 *   `cd X && git init -b main && git add -A && git status --short | head -10
 *    && echo ... && git status --short | wc -l`
 * Combined stdout got routed to the git-status filter, which returned
 * "on unknown: clean" — hiding all real output.
 *
 * Two defenses covered:
 *   L1 — dispatch skips per-command filters when compound has >=2
 *         non-silent segments.
 *   L2 — git-status filter refuses to compress when detectFormat
 *         cannot find a confident marker.
 */
import { spawnSync } from "node:child_process";
import { mkdtempSync, writeFileSync, readFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";

const tmp = mkdtempSync(join(tmpdir(), "cm-compound-"));
// Copy filters dir so relative imports work.
spawnSync("cp", ["-r", "filters", tmp]);

const tsc = spawnSync("npx", ["-y", "-p", "typescript@5.9", "tsc",
  "--target", "es2022",
  "--module", "esnext",
  "--moduleResolution", "bundler",
  "--skipLibCheck",
  "--strict", "false",
  "--noImplicitAny", "false",
  "--outDir", join(tmp, "out"),
  "--rootDir", join(tmp, "filters"),
  ...["dispatch", "git-status", "git-diff", "git-log", "git-mutations",
      "ansi-strip", "json-schema", "pytest", "git-status",
      "file-ops", "tree", "env", "python-traceback", "log-dedup",
      "tsc", "linter", "grep-grouping", "build", "test-runners", "install"
  ].map((m) => join(tmp, "filters", `${m}.ts`)),
], { encoding: "utf-8" });
if (tsc.status !== 0) {
  console.error(tsc.stdout); console.error(tsc.stderr); process.exit(1);
}

// Import dispatch.js (filters self-register via top-level side effects when
// imported by index.ts; here we import them explicitly).
for (const m of ["git-status", "git-diff", "git-log", "git-mutations",
                 "pytest", "file-ops", "tree", "env", "python-traceback",
                 "log-dedup", "tsc", "linter", "grep-grouping",
                 "build", "test-runners", "install"]) {
  await import(join(tmp, "out", `${m}.js`));
}
const { dispatch, registeredFilters, configureFilters, configureGlobalFilters, configureProjectFilters, registerContentFallback, registerFilter } = await import(join(tmp, "out", "dispatch.js"));

let fails = 0;
function check(name, pass, detail = "") {
  if (pass) console.log(`  PASS  ${name}`);
  else { console.error(`  FAIL  ${name}${detail ? " — " + detail : ""}`); fails++; }
}

// Safety contract: failed command output must not enter semantic filters.
let failedResult;
try {
  failedResult = dispatch({
    command: "pytest",
    stdout: "================ 4 passed in 0.1s ================",
    isError: true,
    toolName: "bash",
  });
} catch {
  failedResult = undefined;
}
check("failed output passes through", failedResult === null);
const contextResult = dispatch({ command: "pytest", stdout: "================ 4 passed in 0.1s ================\n".repeat(20), isError: false, toolName: "bash", details: { exitCode: 0 } });
check("structured FilterContext dispatches", contextResult !== null);
const failedSummary = "================ FAILURES ================\nFAILED test_example.py::test_bad\n".repeat(10);
check("pytest failure format passes through", dispatch({ command: "pytest", stdout: failedSummary, isError: false, toolName: "bash" }) === null);
const buildResult = dispatch("npm run build", "Compiling source files\n".repeat(30));
check("build filter disabled by default", buildResult === null);
check("stable filter IDs exposed", typeof registeredFilters === "function" && registeredFilters().some((f) => f.id === "pytest"));
if (typeof configureFilters === "function") configureFilters({ pytest: false });
check("per-filter disable works", dispatch("pytest", "================ 4 passed in 0.1s ================\n".repeat(20)) === null);
check("global config API exists", typeof configureGlobalFilters === "function");
check("project config API exists", typeof configureProjectFilters === "function");
if (typeof registerContentFallback === "function") registerContentFallback("test", () => ({ output: "compressed", category: "fast" }));
check("content fallbacks disabled", dispatch("unknown && unknown", "output\n".repeat(30)) === null);
check("tsc filter disabled by default", dispatch("tsc", "error TS1234: bad\n".repeat(20)) === null);
if (typeof configureGlobalFilters === "function") configureGlobalFilters({ tsc: true });
const validTscDiagnostics = Array.from({ length: 20 }, (_, index) =>
  `src/file-${index}.ts(1,1): error TS1234: bad`,
).join("\n") + "\nFound 20 errors.\n";
check("global config enables risky filter", dispatch("tsc", validTscDiagnostics) !== null);

// Case 1: user's exact repro — compound command with git status at the end,
// preceded by a bd update + echo producing combined stdout.
const compoundCmd =
  "cd /home/tomooshi/Repositories/mojo-template-pi-dev && " +
  "bd update mojo-template-pi-dev-kco2 --claim 2>&1 | tail -1; " +
  "echo \"===SEP===\"; " +
  "cd /home/tomooshi/Repositories/coding-obsidian && " +
  "git status 2>&1 | head -10";

const combinedStdout = [
  "✓ Updated issue: mojo-template-pi-dev-kco2",
  "===SEP===",
  "On branch main",
  "",
  "No commits yet",
  "",
  "Changes to be committed:",
  "  (use \"git rm --cached <file>...\" to unstage)",
  "\tnew file:   CLAUDE.md",
  "\tnew file:   CURRICULUM.md",
].join("\n");

const r1 = dispatch(compoundCmd, combinedStdout);
check(
  "Case 1: compound (bd + git status) — no 'on unknown: clean' collapse",
  r1 === null || !r1.output.includes("on unknown: clean"),
  `result=${JSON.stringify(r1)}`,
);

// Case 2: lone `git status --short` with many files still compresses
// (confident-detection fallback via multiple v1-format lines).
const manyFiles = Array.from({length: 30}, (_, i) => `A  src/module_${i}/file_with_long_name.ts`);
manyFiles.push(" M daily/2026-04-21.md");
manyFiles.push(" M templates/daily.md");
const plainStatusShort = manyFiles.join("\n");
const r2 = dispatch("git status --short", plainStatusShort);
check(
  "Case 2: lone `git status --short` with many files compresses via v1 format",
  r2 !== null && /\d+ staged/.test(r2.output),
  `in=${plainStatusShort.length} result=${JSON.stringify(r2)}`,
);

// Case 3: legitimate `cd repo && git status` (one non-silent segment) still
// compresses. Uses plain format with branch header.
const plainStatus = [
  "On branch main",
  "Changes to be committed:",
  "\tmodified:   src/foo.ts",
  "\tnew file:   src/bar.ts",
  "",
  "Untracked files:",
  "\tsrc/baz.ts",
].join("\n");
const r3 = dispatch("cd /repo && git status", plainStatus);
check(
  "Case 3: plain `cd repo && git status` passes through",
  r3 === null,
  `result=${JSON.stringify(r3)}`,
);
check("plain git status disabled by default", dispatch("git status", plainStatus) === null);

// Case 4: non-git-status input with a single coincidental v1-looking line
// must NOT be falsely identified.
const coincidental = [
  "Initialized empty Git repository in /tmp/foo/.git/",
  "A  path",           // one v1-looking line buried in non-git output
  "Other output line",
  "More random output to pad length over MIN_MASK_LENGTH (80 bytes).",
  "Still more filler bytes to ensure dispatch doesn't early-return small.",
].join("\n");
const r4 = dispatch("git status", coincidental);
check(
  "Case 4: coincidental v1-looking line alone doesn't trigger compression",
  r4 === null,
  `result=${JSON.stringify(r4)}`,
);

// Case 5: separators inside quotes are arguments, not compound operators.
const quotedSeparatorCommand = "git status --short --pathspec-from-file='foo;bar'";
const r5 = dispatch(quotedSeparatorCommand, plainStatusShort);
check(
  "Case 5: quoted separator keeps one semantic producer",
  r5 !== null,
  `result=${JSON.stringify(r5)}`,
);

check(
  "Case 6: unsupported pipe chain declines semantic dispatch",
  dispatch("git status --short | grep foo", plainStatusShort) === null,
);

registerFilter("quoted-probe", (_input, command) => ({ output: command, category: "fast" }));
configureFilters({ "quoted-probe": true });
const quotedPipeCommand = 'quoted-probe "literal | head -1"';
const quotedPipeResult = dispatch(quotedPipeCommand, "padding output ".repeat(10));
check(
  "Case 7: quoted pipe stays in command",
  quotedPipeResult?.output === quotedPipeCommand,
  `result=${JSON.stringify(quotedPipeResult)}`,
);
const quotedRedirectCommand = 'quoted-probe "2>&1"';
const quotedRedirectResult = dispatch(quotedRedirectCommand, "padding output ".repeat(10));
check(
  "Case 8: quoted redirect stays in command",
  quotedRedirectResult?.output === quotedRedirectCommand,
  `result=${JSON.stringify(quotedRedirectResult)}`,
);
const quotedSpacesCommand = 'quoted-probe "hello  world"';
const quotedSpacesResult = dispatch(quotedSpacesCommand, "padding output ".repeat(10));
check(
  "Case 9: quoted value spaces stay in command",
  quotedSpacesResult?.output === quotedSpacesCommand,
  `result=${JSON.stringify(quotedSpacesResult)}`,
);

const escapedSeparatorResult = dispatch("git status --short --pathspec-from-file=foo\\;bar", plainStatusShort);
check(
  "Case 10: escaped separator stays in command",
  escapedSeparatorResult !== null,
  `result=${JSON.stringify(escapedSeparatorResult)}`,
);

const envAssignmentOutput = Array.from({ length: 10 }, () =>
  ["API_KEY=secret value", "SHELL=/bin/sh"].join("\n"),
).join("\n");
const envAssignmentResult = dispatch("API_KEY=\"secret value\" env 2>&1", envAssignmentOutput);
check(
  "Case 11: spaced env assignment and redirect still match env",
  envAssignmentResult?.output.includes("API_KEY=[REDACTED]") === true,
  `result=${JSON.stringify(envAssignmentResult)}`,
);

check(
  "Case 12: unbalanced quotes decline semantic dispatch",
  dispatch('git status --short --pathspec-from-file="unterminated', plainStatusShort) === null,
);

check(
  "Case 13: command substitution declines semantic dispatch",
  dispatch('git status --short --pathspec-from-file="$(date)"', plainStatusShort) === null,
);
check(
  "Case 14: backticks decline semantic dispatch",
  dispatch("git status --short --pathspec-from-file=`date`", plainStatusShort) === null,
);
check(
  "Case 15: process substitution declines semantic dispatch",
  dispatch("git status --short <(printf x)", plainStatusShort) === null,
);
check(
  "Case 16: multiple output producers decline semantic dispatch",
  dispatch("git status --short && echo done", plainStatusShort) === null,
);
check(
  "Case 17: unsupported redirect declines semantic dispatch",
  dispatch("git status --short > out.txt", plainStatusShort) === null,
);
check(
  "Case 18: assignment-only segment stays silent",
  dispatch("FOO=bar && git status --short", plainStatusShort) !== null,
);
check(
  "Case 19: OR with silent fallback keeps one producer",
  dispatch("git status --short || true", plainStatusShort) !== null,
);

// v1.10.1 blocker 2: environment-secrets is a privacy boundary, not a
// compression preference. No configuration surface — global, direct, or
// project — may disable it. Attempts produce an actionable warning and
// the filter stays enabled and keeps redacting.
const envEnabled = () => registeredFilters().find((f) => f.id === "environment-secrets")?.enabled;
const globalDisableWarns = configureGlobalFilters({ "environment-secrets": false });
check("global config cannot disable environment-secrets (warns)",
  globalDisableWarns.some((w) => /cannot be disabled/.test(w)) === true, JSON.stringify(globalDisableWarns));
check("environment-secrets still enabled after global disable attempt",
  envEnabled() === true, JSON.stringify(registeredFilters().find((f) => f.id === "environment-secrets")));
check("env redaction still active after global disable attempt",
  dispatch({ command: "env", stdout: "DB_PASSWORD=hunter2000\nSHELL=/bin/zsh", isError: false, toolName: "bash" })?.output.includes("DB_PASSWORD=[REDACTED]") === true);
const directDisableWarns = configureFilters({ "environment-secrets": false });
check("direct configureFilters cannot disable environment-secrets (warns)",
  directDisableWarns.some((w) => /cannot be disabled/.test(w)) === true, JSON.stringify(directDisableWarns));
check("environment-secrets still enabled after direct disable attempt",
  envEnabled() === true);
const projectDisableWarns = configureProjectFilters({ "environment-secrets": false });
check("project config cannot disable environment-secrets (warns)",
  projectDisableWarns.some((w) => /cannot be disabled/.test(w)) === true, JSON.stringify(projectDisableWarns));
check("environment-secrets still enabled after project disable attempt",
  envEnabled() === true);
// Global config keeps controlling every non-privacy default.
check("global config still disables non-privacy filters",
  configureGlobalFilters({ tsc: false }).length === 0 && dispatch("tsc", validTscDiagnostics) === null);
check("global config still enables default-off filters",
  configureGlobalFilters({ tsc: true }).length === 0 && dispatch("tsc", validTscDiagnostics) !== null);
if (fails > 0) {
  console.error(`\nFAIL — ${fails} case(s) failed.`);
  process.exit(1);
}
console.log("\nPASS — compound-command dispatch guard + git-status confident detection.");
