/**
 * Cached observer-ordering record tests (red slice: the cached variant
 * must store only digest-keyed passing records and reuse them).
 */

import { test, describe } from "node:test";
import assert from "node:assert/strict";
import { mkdtempSync, rmSync, existsSync, readFileSync, writeFileSync, mkdirSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { verifyObserverOrderingCached } from "../runner/observer-ordering.mjs";
import { createRequire } from "node:module";

const runtimeDir = join(process.cwd(), "node_modules", "@earendil-works", "pi-coding-agent");

describe("cached observer ordering", () => {
  test("stores one digest-keyed passing record and reuses it; non-passing cache refuses", async () => {
    const cacheDir = mkdtempSync(join(tmpdir(), "cm-ordering-cache-"));
    try {
      const runtimeManifest = { digest: "2".repeat(64) };
      const first = await verifyObserverOrderingCached({ runtimeDir, runtimeManifest, cacheDir });
      assert.equal(first.cached, false);
      const recordPath = join(cacheDir, "observer-ordering", `${"2".repeat(64)}.json`);
      assert.ok(existsSync(recordPath));
      const record = JSON.parse(readFileSync(recordPath, "utf8"));
      assert.equal(record.passing, true);
      const second = await verifyObserverOrderingCached({ runtimeDir, runtimeManifest, cacheDir });
      assert.equal(second.cached, true);
      const poisonedDir = join(cacheDir, "observer-ordering");
      writeFileSync(
        join(poisonedDir, `${"3".repeat(64)}.json`),
        `${JSON.stringify({ passing: false, digest: "3".repeat(64) })}\n`,
        "utf8",
      );
      await assert.rejects(
        () => verifyObserverOrderingCached({ runtimeDir, runtimeManifest: { digest: "3".repeat(64) }, cacheDir }),
        /non-passing/,
      );
    } finally {
      rmSync(cacheDir, { recursive: true, force: true });
    }
  });
});
