/**
 * Grace-escalation slice of spawn process ownership
 * (evaluation/runner/spawn.mjs).
 *
 * A group that ignores SIGTERM must receive SIGKILL after the fixed
 * grace period. fake-pi behavior "ignore-term" ignores SIGTERM and
 * spawns a grandchild so both must die via SIGKILL.
 */

import { test, describe } from "node:test";
import assert from "node:assert/strict";
import { fileURLToPath } from "node:url";
import { dirname, join } from "node:path";
import { mkdtempSync, mkdirSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { runSubprocess } from "../runner/spawn.mjs";
import { fakePiScenario, readTreeFile, waitGone } from "./spawn-timeout.test.mjs";

const repoRoot = join(dirname(fileURLToPath(import.meta.url)), "..", "..");

describe("spawn grace escalation", () => {
  test("grace expiry escalates to SIGKILL for a SIGTERM-ignoring group", async () => {
    const dir = mkdtempSync(join(tmpdir(), "cm-eval-spawn-"));
    mkdirSync(join(dir, "sessions"), { recursive: true });
    try {
      const outcome = await runSubprocess({
        ...fakePiScenario(dir, "ignore-term"),
        timeoutMs: 700,
        graceMs: 500,
        stdoutPath: join(dir, "out.txt"),
        stderrPath: join(dir, "err.txt"),
      });
      assert.equal(outcome.timedOut, true);
      assert.equal(outcome.teardown.escalatedToSigkill, true, "grace expiry must send SIGKILL to the group");
      assert.equal(outcome.teardown.outcome, "sigterm-then-sigkill");
      assert.ok(["SIGKILL", "SIGTERM"].includes(outcome.signal), `unexpected exit signal ${outcome.signal}`);
      const tree = readTreeFile(dir);
      await waitGone(tree.pid, "ignore-term child");
      await waitGone(tree.childPid, "ignore-term grandchild");
    } finally {
      rmSync(dir, { recursive: true, force: true });
    }
  });
});

void repoRoot;
