#!/usr/bin/env node
/**
 * Check handler test from outside repository working directory.
 * This exercises its command-line boundary after dependencies are installed.
 */
import assert from "node:assert/strict";
import { existsSync, mkdtempSync, rmSync } from "node:fs";
import { spawnSync } from "node:child_process";
import { dirname, join } from "node:path";
import { tmpdir } from "node:os";
import { fileURLToPath } from "node:url";

const repositoryRoot = dirname(fileURLToPath(import.meta.url));
const localTypeScript = join(repositoryRoot, "node_modules", "typescript", "bin", "tsc");
const localNodeTypes = join(repositoryRoot, "node_modules", "@types", "node", "package.json");
assert.ok(existsSync(localTypeScript), `missing repository-local TypeScript: ${localTypeScript}`);
assert.ok(existsSync(localNodeTypes), `missing repository-local @types/node: ${localNodeTypes}`);
const workingDirectory = mkdtempSync(join(tmpdir(), "cm-handler-smoke-"));

try {
  const result = spawnSync(process.execPath, [join(repositoryRoot, "test-handler.mjs")], {
    cwd: workingDirectory,
    encoding: "utf8",
  });
  assert.equal(result.error, undefined, result.error?.message);
  assert.equal(result.status, 0, `${result.stdout}\n${result.stderr}`);
  assert.match(result.stdout, /PASS failed multi-block env redaction \+ diagnostics/);
  console.log("PASS handler test from different working directory");
} finally {
  rmSync(workingDirectory, { recursive: true, force: true });
}
