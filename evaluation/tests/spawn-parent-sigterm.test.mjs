/**
 * Parent SIGTERM forwarding slice of spawn process ownership
 * (evaluation/runner/spawn.mjs).
 *
 * A parent SIGTERM must record the exact metadata teardown.triggered
 * "parent-signal" with originalSignal "SIGTERM", tear down the whole
 * detached group, and remove the parent handlers after settlement.
 */

import { test, describe } from "node:test";
import assert from "node:assert/strict";
import { fileURLToPath } from "node:url";
import { dirname, join } from "node:path";
import { mkdtempSync, mkdirSync, readFileSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { runSelfSignalChild, parseRunnerResult } from "./spawn-parent-signal.test.mjs";
import { waitGone } from "./spawn-timeout.test.mjs";

const repoRoot = join(dirname(fileURLToPath(import.meta.url)), "..", "..");

describe("spawn parent SIGTERM forwarding", () => {
  test("parent SIGTERM records exact teardown metadata and cleans up handlers", async () => {
    const dir = mkdtempSync(join(tmpdir(), "cm-eval-spawn-"));
    mkdirSync(join(dir, "sessions"), { recursive: true });
    try {
      const runner = runSelfSignalChild(dir, "SIGTERM");
      const parsed = parseRunnerResult(runner.stdout || "");
      assert.equal(parsed.outcome.timedOut, false);
      assert.equal(parsed.outcome.teardown.triggered, "parent-signal", "SIGTERM must map to the parent-signal trigger");
      assert.equal(parsed.outcome.teardown.originalSignal, "SIGTERM");
      assert.equal(parsed.before.SIGTERM, 1, "library must hold exactly one SIGTERM handler during the run");
      assert.equal(parsed.after.SIGTERM, 0, "SIGTERM handler must be removed after settlement");
      assert.equal(parsed.after.SIGINT, 0, "SIGINT handler must be removed after settlement");
      const tree = JSON.parse(readFileSync(join(dir, "tree.json"), "utf8"));
      await waitGone(tree.pid, "fake-pi child");
      await waitGone(tree.childPid, "fake-pi grandchild");
    } finally {
      rmSync(dir, { recursive: true, force: true });
    }
  });
});

void repoRoot;
