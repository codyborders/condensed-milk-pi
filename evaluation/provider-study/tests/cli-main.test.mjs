/**
 * Provider-study CLI executable entry (grown test-first).
 *
 * The npm scripts invoke cli.mjs directly, so the module needs a main
 * entry that prints stdout/stderr and exits with the command code.
 */

import { test } from "node:test";
import assert from "node:assert/strict";
import { execFileSync } from "node:child_process";
import { dirname, join } from "node:path";
import { fileURLToPath } from "node:url";

const repoRoot = join(fileURLToPath(import.meta.url), "..", "..", "..", "..");
const cliPath = join(repoRoot, "evaluation", "provider-study", "runner", "cli.mjs");

test("cli.mjs runs as a script and prints one JSON line with the right exit code", () => {
  const stdout = execFileSync(process.execPath, [cliPath, "plan", "--phase", "development"], { encoding: "utf8" });
  const body = JSON.parse(stdout.trim());
  assert.equal(body.phase, "development");
  assert.equal(body.tasks.length, 12);
});
