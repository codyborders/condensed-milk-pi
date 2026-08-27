import { test } from "node:test";
import assert from "node:assert/strict";
import { readFileSync, rmSync, mkdtempSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { spawnSync } from "node:child_process";
import { fileURLToPath } from "node:url";
import { dirname } from "node:path";

const directory = dirname(fileURLToPath(import.meta.url));

test("benchmark output records provenance hashes and writes requested file", () => {
  const root = mkdtempSync(join(tmpdir(), "cm-benchmark-output-"));
  const output = join(root, "result.json");
  try {
    const result = spawnSync(process.execPath, ["--expose-gc", "--import", "tsx", join(directory, "context-hook.mjs"), "--output", output], { encoding: "utf8", timeout: 30_000 });
    assert.equal(result.status, 0, result.stderr);
    const report = JSON.parse(readFileSync(output, "utf8"));
    assert.match(report.targetCommit, /^[0-9a-f]{40}$/);
    assert.match(report.implementationModuleSha256, /^[0-9a-f]{64}$/);
    assert.match(report.harnessSha256, /^[0-9a-f]{64}$/);
    assert.equal(report.inputHashes.length, report.measurements.length);
    assert.equal(report.outputHashes.length, report.measurements.length);
  } finally {
    rmSync(root, { recursive: true, force: true });
  }
});
