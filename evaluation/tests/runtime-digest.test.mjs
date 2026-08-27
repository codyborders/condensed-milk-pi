/**
 * Runtime manifest digest tests
 * (boundary: evaluation/runner/runtime-digest.mjs).
 *
 * Scope:
 * - cyclic symlinks inside a declared runtime root are refused rather
 *   than traversed forever or silently accepted.
 */

import { test, describe } from "node:test";
import assert from "node:assert/strict";
import { fileURLToPath } from "node:url";
import { dirname, join } from "node:path";
import { mkdirSync, mkdtempSync, rmSync, symlinkSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { computeRuntimeDigest } from "../runner/runtime-digest.mjs";

const repoRoot = join(dirname(fileURLToPath(import.meta.url)), "..", "..");

describe("runtime manifest digest", () => {
  test("cyclic symlinks are rejected", () => {
    const work = mkdtempSync(join(tmpdir(), "cm-digest-cycle-"));
    try {
      mkdirSync(join(work, "dist"), { recursive: true });
      writeFileSync(join(work, "dist", "cli.js"), "console.log(1)\n", "utf8");
      symlinkSync("../dist/b", join(work, "dist", "a"));
      symlinkSync("../dist/a", join(work, "dist", "b"));
      symlinkSync("dist", join(work, "loop"));
      assert.throws(
        () => computeRuntimeDigest({ runtimeDir: work }),
        /cyclic/,
        "a runtime tree with cyclic links must be refused as cyclic",
      );
    } finally {
      rmSync(work, { recursive: true, force: true });
    }
  });
});
