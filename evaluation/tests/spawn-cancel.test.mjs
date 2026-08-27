/**
 * Explicit cancellation slice of spawn process ownership
 * (evaluation/runner/spawn.mjs).
 *
 * An aborted AbortSignal must record the exact metadata
 * teardown.triggered "abort-signal" plus a stable cancellationReason
 * taken from the abort reason, tear down the whole detached group, and
 * leave no parent signal handlers behind.
 */

import { test, describe } from "node:test";
import assert from "node:assert/strict";
import { fileURLToPath } from "node:url";
import { dirname, join } from "node:path";
import { mkdtempSync, mkdirSync, readFileSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { runSubprocess } from "../runner/spawn.mjs";
import { fakePiScenario, readTreeFile, waitGone } from "./spawn-timeout.test.mjs";

const repoRoot = join(dirname(fileURLToPath(import.meta.url)), "..", "..");

describe("spawn explicit cancellation", () => {
  test("abort-signal teardown records the cancellation reason and kills the group", async () => {
    const dir = mkdtempSync(join(tmpdir(), "cm-eval-spawn-"));
    mkdirSync(join(dir, "sessions"), { recursive: true });
    const beforeSigint = process.listenerCount("SIGINT");
    const beforeSigterm = process.listenerCount("SIGTERM");
    const controller = new AbortController();
    try {
      const running = runSubprocess({
        ...fakePiScenario(dir, "timeout"),
        timeoutMs: 30_000,
        graceMs: 2_000,
        abortSignal: controller.signal,
        stdoutPath: join(dir, "out.txt"),
        stderrPath: join(dir, "err.txt"),
      });
      await new Promise((resolve) => setTimeout(resolve, 800));
      controller.abort("operator cancelled the attempt");
      const outcome = await running;
      assert.equal(outcome.timedOut, false);
      assert.equal(outcome.cancelled, true);
      assert.equal(outcome.cancellationReason, "operator cancelled the attempt");
      assert.equal(outcome.teardown.triggered, "abort-signal");
      assert.equal(outcome.teardown.graceMs, 2000);
      const tree = readTreeFile(dir);
      await waitGone(tree.pid, "fake-pi child");
      await waitGone(tree.childPid, "fake-pi grandchild");
      assert.equal(process.listenerCount("SIGINT"), beforeSigint, "SIGINT handler must be removed after settlement");
      assert.equal(process.listenerCount("SIGTERM"), beforeSigterm, "SIGTERM handler must be removed after settlement");
    } finally {
      rmSync(dir, { recursive: true, force: true });
    }
  });
});

void repoRoot;
