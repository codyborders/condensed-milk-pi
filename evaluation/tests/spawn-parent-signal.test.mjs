/**
 * Parent-signal forwarding slice of spawn process ownership
 * (evaluation/runner/spawn.mjs).
 *
 * While a subprocess runs, the library owns parent SIGINT: the signal
 * must be recorded with the exact metadata teardown.triggered
 * "parent-signal" and originalSignal "SIGINT", the whole detached
 * group must be torn down, and the parent handler must be removed
 * after settlement. The self-signal runs in a disposable runner child
 * so the test process is never endangered.
 */

import { test, describe } from "node:test";
import assert from "node:assert/strict";
import { fileURLToPath } from "node:url";
import { dirname, join } from "node:path";
import { mkdtempSync, mkdirSync, readFileSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { spawnSync } from "node:child_process";
import { waitGone } from "./spawn-timeout.test.mjs";

const repoRoot = join(dirname(fileURLToPath(import.meta.url)), "..", "..");
const fakePi = join(repoRoot, "evaluation", "runner", "fake-pi.mjs");
const spawnPath = join(repoRoot, "evaluation", "runner", "spawn.mjs");

/**
 * Run a disposable node child that starts a hanging fake-pi subprocess
 * through runSubprocess, then delivers `signal` to itself. Prints one
 * RESULT JSON line with the outcome plus leftover listener counts.
 */
export function runSelfSignalChild(dir, signal) {
  const scenarioPath = join(dir, "scenario.json");
  writeFileSync(
    scenarioPath,
    `${JSON.stringify({ taskId: "spawn-test", arm: "upstream", attempt: 1, behavior: "timeout" })}\n`,
    "utf8",
  );
  const script =
    `(async () => {` +
    `  const { runSubprocess } = await import(${JSON.stringify(spawnPath)});` +
    `  const running = runSubprocess({` +
    `    argv: [process.execPath, ${JSON.stringify(fakePi)}, "--session-dir", ${JSON.stringify(join(dir, "sessions"))}, "prompt"],` +
    `    cwd: ${JSON.stringify(dir)},` +
    `    env: { PATH: process.env.PATH, HOME: ${JSON.stringify(dir)}, FAKE_PI_SCENARIO: ${JSON.stringify(scenarioPath)}, FAKE_PI_INVOCATIONS: ${JSON.stringify(join(dir, "invocations.jsonl"))}, FAKE_PI_TREE: ${JSON.stringify(join(dir, "tree.json"))} },` +
    `    timeoutMs: 30000, graceMs: 2000,` +
    `    stdoutPath: ${JSON.stringify(join(dir, "out.txt"))}, stderrPath: ${JSON.stringify(join(dir, "err.txt"))},` +
    `  });` +
    `  await new Promise((resolve) => setTimeout(resolve, 800));` +
    `  const before = { SIGINT: process.listenerCount("SIGINT"), SIGTERM: process.listenerCount("SIGTERM") };` +
    `  process.kill(process.pid, ${JSON.stringify(signal)});` +
    `  const outcome = await running;` +
    `  const after = { SIGINT: process.listenerCount("SIGINT"), SIGTERM: process.listenerCount("SIGTERM") };` +
    `  process.stdout.write("RESULT " + JSON.stringify({ outcome, before, after }));` +
    `})().catch((error) => { process.stdout.write("RUNNER-ERROR " + error.message); });`;
  return spawnSync(process.execPath, ["-e", script], { cwd: dir, encoding: "utf8", timeout: 60_000 });
}

export function parseRunnerResult(text) {
  assert.ok(text.includes("RESULT "), `runner output: ${text.slice(0, 400)}`);
  return JSON.parse(text.slice(text.indexOf("RESULT ") + 7));
}

describe("spawn parent signal forwarding", () => {
  test("parent SIGINT records exact teardown metadata and cleans up handlers", async () => {
    const dir = mkdtempSync(join(tmpdir(), "cm-eval-spawn-"));
    mkdirSync(join(dir, "sessions"), { recursive: true });
    try {
      const runner = runSelfSignalChild(dir, "SIGINT");
      const parsed = parseRunnerResult(runner.stdout || "");
      assert.equal(parsed.outcome.timedOut, false);
      assert.equal(parsed.outcome.teardown.triggered, "parent-signal", "SIGINT must map to the parent-signal trigger");
      assert.equal(parsed.outcome.teardown.originalSignal, "SIGINT");
      assert.equal(parsed.outcome.teardown.graceMs, 2000, "the configured grace period must be recorded");
      assert.equal(parsed.before.SIGINT, 1, "library must hold exactly one SIGINT handler during the run");
      assert.equal(parsed.after.SIGINT, 0, "SIGINT handler must be removed after settlement");
      assert.equal(parsed.after.SIGTERM, 0, "SIGTERM handler must be removed after settlement");
      const tree = JSON.parse(readFileSync(join(dir, "tree.json"), "utf8"));
      await waitGone(tree.pid, "fake-pi child");
      await waitGone(tree.childPid, "fake-pi grandchild");
    } finally {
      rmSync(dir, { recursive: true, force: true });
    }
  });
});
