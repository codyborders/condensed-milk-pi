/**
 * Timeout teardown slice of spawn process ownership
 * (evaluation/runner/spawn.mjs).
 *
 * The runner owns the detached process group: on timeout it sends
 * SIGTERM to the group; fake-pi and its grandchild must both be gone.
 */

import { test, describe } from "node:test";
import assert from "node:assert/strict";
import { fileURLToPath } from "node:url";
import { dirname, join } from "node:path";
import { mkdtempSync, mkdirSync, readFileSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { runSubprocess } from "../runner/spawn.mjs";

const repoRoot = join(dirname(fileURLToPath(import.meta.url)), "..", "..");
const fakePi = join(repoRoot, "evaluation", "runner", "fake-pi.mjs");

/** Poll until kill(pid, 0) throws: the pid is reaped or gone. */
export async function waitGone(pid, label, timeoutMs = 10_000) {
  const deadline = Date.now() + timeoutMs;
  while (Date.now() < deadline) {
    try {
      process.kill(pid, 0);
    } catch {
      return true;
    }
    await new Promise((resolve) => setTimeout(resolve, 100));
  }
  assert.fail(`${label} pid ${pid} still alive after teardown`);
}

/** Build a fake-pi scenario plus spawn inputs for one behavior. */
export function fakePiScenario(dir, behavior) {
  const scenarioPath = join(dir, "scenario.json");
  writeFileSync(
    scenarioPath,
    `${JSON.stringify({ taskId: "spawn-test", arm: "upstream", attempt: 1, behavior })}\n`,
    "utf8",
  );
  return {
    argv: [process.execPath, fakePi, "--session-dir", dir, "prompt"],
    cwd: dir,
    env: {
      PATH: process.env.PATH ?? "/usr/bin:/bin",
      HOME: dir,
      FAKE_PI_SCENARIO: scenarioPath,
      FAKE_PI_INVOCATIONS: join(dir, "invocations.jsonl"),
      FAKE_PI_TREE: join(dir, "tree.json"),
    },
  };
}

export function readTreeFile(dir) {
  return JSON.parse(readFileSync(join(dir, "tree.json"), "utf8"));
}

describe("spawn timeout teardown", () => {
  test("timeout SIGTERMs the whole group: fake-pi child and grandchild are gone", async () => {
    const dir = mkdtempSync(join(tmpdir(), "cm-eval-spawn-"));
    mkdirSync(join(dir, "sessions"), { recursive: true });
    const before = process.listenerCount("SIGINT");
    try {
      const outcome = await runSubprocess({
        ...fakePiScenario(dir, "timeout"),
        timeoutMs: 1_500,
        graceMs: 2_000,
        stdoutPath: join(dir, "out.txt"),
        stderrPath: join(dir, "err.txt"),
      });
      assert.equal(outcome.timedOut, true);
      assert.equal(outcome.teardown.triggered, "timeout");
      assert.equal(outcome.teardown.escalatedToSigkill, false, "fake-pi must die on SIGTERM within grace");
      assert.equal(outcome.teardown.outcome, "sigterm");
      const tree = readTreeFile(dir);
      assert.ok(typeof tree.pid === "number", "fake-pi must record its pid");
      assert.ok(typeof tree.childPid === "number", "fake-pi must record the grandchild pid");
      await waitGone(tree.pid, "fake-pi child");
      await waitGone(tree.childPid, "fake-pi grandchild");
      assert.equal(process.listenerCount("SIGINT"), before);
    } finally {
      rmSync(dir, { recursive: true, force: true });
    }
  });
});
