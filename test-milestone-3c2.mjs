#!/usr/bin/env node
import assert from "node:assert/strict";
import { spawnSync } from "node:child_process";
import { copyFileSync, mkdtempSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";

const tmp = mkdtempSync(join(tmpdir(), "cm-3c2-"));
for (const name of ["dispatch", "log-dedup", "file-ops", "grep-grouping", "tree", "ansi-strip"]) copyFileSync(`filters/${name}.ts`, join(tmp, `${name}.ts`));
const compile = spawnSync("./node_modules/.bin/tsc", ["--target", "es2022", "--module", "esnext", "--moduleResolution", "bundler", "--skipLibCheck", "--strict", "true", "--outDir", tmp, join(tmp, "dispatch.ts"), join(tmp, "log-dedup.ts"), join(tmp, "file-ops.ts"), join(tmp, "grep-grouping.ts"), join(tmp, "tree.ts"), join(tmp, "ansi-strip.ts")], { encoding: "utf8" });
if (compile.status !== 0) { console.error(compile.stdout, compile.stderr); process.exit(1); }
const { dispatch, configureFilters } = await import(join(tmp, "dispatch.js"));
await import(join(tmp, "log-dedup.js"));
await import(join(tmp, "file-ops.js"));
await import(join(tmp, "grep-grouping.js"));
await import(join(tmp, "tree.js"));
const { stripAnsi } = await import(join(tmp, "ansi-strip.js"));
configureFilters({ ls: true, find: true, grep: true, rg: true, tree: true });
const input = [
  "2026-01-01T00:00:00.000Z worker ready",
  "2026-01-01T00:00:01.000Z worker ready",
  "2026-01-01T00:00:02.000Z worker ready",
  "unique first line",
  ...Array.from({ length: 13 }, (_, i) => `unique-${i}`),
].join("\n");
const result = dispatch({ command: "tail app.log", stdout: `${input}\n`, isError: false, toolName: "bash" });
assert.ok(result);
assert.ok(result.output.startsWith("2026-01-01T00:00:00.000Z worker ready  [x3]\nunique first line"));
const lsInput = Array.from({ length: 25 }, (_, i) => `entry ${i} [x]*.txt`).join("\n");
const lsResult = dispatch({ command: "ls", stdout: `${lsInput}\n`, isError: false, toolName: "bash" });
assert.ok(lsResult);
assert.equal(dispatch({ command: "ls", stdout: `${lsInput}\nls: missing path: No such file or directory\n`, isError: false, toolName: "bash" }), null);
const grepInput = Array.from({ length: 22 }, (_, i) => `src/path with spaces [x]*.ts:${i + 1}:match text ${i}`).join("\n");
const grepResult = dispatch({ command: "grep -rn pattern .", stdout: `${grepInput}\n`, isError: false, toolName: "bash" });
assert.ok(grepResult);
const grepDiagnostic = dispatch({ command: "grep -rn pattern .", stdout: `${grepInput}\ngrep: ./missing: No such file or directory\n`, isError: false, toolName: "bash" });
assert.equal(grepDiagnostic, null);
const treeInput = [".", "├── src", "│   └── alpha.ts", "├── node_modules", ...Array.from({ length: 20 }, (_, i) => `│   ├── package-${i}`), "├── docs", "│   └── readme.md", "1 directory, 22 files"].join("\n");
const treeResult = dispatch({ command: "tree", stdout: `${treeInput}\n`, isError: false, toolName: "bash" });
assert.ok(treeResult);
assert.equal(dispatch({ command: "tree", stdout: `${treeInput.replace("├── src", "not a branch record")}\n`, isError: false, toolName: "bash" }), null);
const findInput = Array.from({ length: 35 }, (_, i) => `./src/dir ${i}/file [${i}]*.ts`).join("\n");
const findResult = dispatch({ command: "find . -type f", stdout: `${findInput}\n`, isError: false, toolName: "bash" });
assert.ok(findResult && findResult.output.includes("./src/dir 0/file [0]*.ts") && findResult.output.includes("+20 more"));
assert.equal(dispatch({ command: "find .", stdout: `${findInput}\nfind: './missing': Permission denied\n`, isError: false, toolName: "bash" }), null);
assert.equal(stripAnsi(`${String.fromCharCode(27)}[1;2 qtext`), "text");
assert.deepEqual([stripAnsi(`${String.fromCharCode(27)}]0;title${String.fromCharCode(7)}text`), stripAnsi("ordinary text [x]*")], ["text", "ordinary text [x]*"]);
const shortListing = dispatch({ command: "ls", stdout: "one\ntwo\n", isError: false, toolName: "bash" });
const longListing = dispatch({ command: "ls -l", stdout: `${lsInput}\n`, isError: false, toolName: "bash" });
const repeatA = dispatch({ command: "tail app.log", stdout: `${input}\n`, isError: false, toolName: "bash" });
const repeatB = dispatch({ command: "tail app.log", stdout: `${input}\n`, isError: false, toolName: "bash" });
const failedLog = dispatch({ command: "tail app.log", stdout: `${input}\n`, isError: true, toolName: "bash" });
const oversizedLog = dispatch({ command: "tail app.log", stdout: Array.from({ length: 16 }, (_, i) => `unique ${i} ${"x".repeat(100)}`).join("\n"), isError: false, toolName: "bash" });
if (shortListing !== null || longListing !== null || JSON.stringify(repeatA) !== JSON.stringify(repeatB) || failedLog !== null || oversizedLog !== null) throw new Error("milestone 3C2 safety fixtures failed");
console.log("milestone 3C2 fixture checks passed");
