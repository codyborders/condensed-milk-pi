import { test } from "node:test";
import assert from "node:assert/strict";
import { spawnSync } from "node:child_process";
import { mkdtempSync, readFileSync, rmSync, symlinkSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { fileURLToPath } from "node:url";
import { dirname } from "node:path";

const directory = dirname(fileURLToPath(import.meta.url));

test("benchmark output replaces destination atomically instead of following symlinks", () => {
  const root = mkdtempSync(join(tmpdir(), "cm-benchmark-atomic-"));
  const target = join(root, "target.json");
  const output = join(root, "result.json");
  try {
    writeFileSync(target, "sentinel\n");
    symlinkSync(target, output);
    const result = spawnSync(process.execPath, ["--expose-gc", "--import", "tsx", join(directory, "context-hook.mjs"), "--output", output], { encoding: "utf8", timeout: 30_000 });
    assert.equal(result.status, 0, result.stderr);
    assert.equal(readFileSync(target, "utf8"), "sentinel\n");
  } finally {
    rmSync(root, { recursive: true, force: true });
  }
});
