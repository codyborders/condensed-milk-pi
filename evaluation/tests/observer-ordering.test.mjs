/**
 * Exact-runtime observer ordering tests.
 *
 * verifyObserverOrdering chains pre/mutator/post handlers through the
 * real ExtensionRunner and runtime exports. The cached variant stores
 * only digest-keyed passing records.
 */

import { test, describe } from "node:test";
import assert from "node:assert/strict";
import { mkdtempSync, rmSync, existsSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import {
  verifyObserverOrdering,
  verifyObserverOrderingCached,
  runtimeLoaderFromDist,
} from "../runner/observer-ordering.mjs";
import { createRequire } from "node:module";

const runtimeDir = join(process.cwd(), "node_modules", "@earendil-works", "pi-coding-agent");

describe("observer ordering", () => {
  test("verifies tool_result and context chaining with the real runtime exports", async () => {
    const result = await verifyObserverOrdering({ loadRuntime: runtimeLoaderFromDist(runtimeDir) });
    assert.deepEqual(result.checked, ["tool_result", "context"]);
  });
});
