/**
 * Observer ordering runtime contract (observer-ordering.mjs).
 *
 * verifyObserverOrdering needs a runtime that exports ExtensionRunner
 * and createExtensionRuntime. A runtime without those exports must
 * refuse instead of passing.
 */

import { test } from "node:test";
import assert from "node:assert/strict";
import { verifyObserverOrdering } from "../runner/observer-ordering.mjs";

test("a runtime without the extension exports refuses ordering verification", async () => {
  assert.equal(typeof verifyObserverOrdering, "function", "verifyObserverOrdering must exist");
  await assert.rejects(
    () => verifyObserverOrdering({ loadRuntime: async () => ({}) }),
    /resolved runtime does not export ExtensionRunner and createExtensionRuntime/,
  );
});
