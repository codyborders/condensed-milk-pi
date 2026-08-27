/**
 * Real-run infrastructure failure stop tests
 * (public boundary: evaluation/runner/cli.mjs run -> real.mjs).
 *
 * Fake-only and offline: a sentinel credential whose upstream base URL
 * cannot even form a proxy target makes the first reserved attempt fail
 * as an infrastructure error. Contract: every exception after a real
 * slot reservation becomes a terminal infrastructure-error result with
 * a safe error category, terminal journal state, no auto-selection, the
 * remaining arms and tasks never spawn, and the runner exits nonzero.
 * Collection-error and scorer-error stop the run the same way; a plain
 * task failure does not.
 */

import { test, describe } from "node:test";
import assert from "node:assert/strict";
import { fileURLToPath } from "node:url";
import { dirname, join } from "node:path";
import { existsSync, mkdirSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { spawn, spawnSync } from "node:child_process";
import { SENTINEL_KEY, readJson, journalEvents, makeScenarioPiRuntime, prepareRealRun } from "./real-multi.test.mjs";

const repoRoot = join(dirname(fileURLToPath(import.meta.url)), "..", "..");
const cli = join(repoRoot, "evaluation", "runner", "cli.mjs");

function runCliAsync(args, extra = {}) {
  return new Promise((resolve) => {
    const child = spawn(process.execPath, [cli, ...args], { cwd: repoRoot, ...extra });
    let stdout = "";
    let stderr = "";
    child.stdout.on("data", (chunk) => {
      stdout += chunk;
    });
    child.stderr.on("data", (chunk) => {
      stderr += chunk;
    });
    child.on("error", (error) => resolve({ status: 1, stdout, stderr: `${stderr}${error.message}` }));
    child.on("close", (code) => resolve({ status: code, stdout, stderr }));
  });
}

function writeCredentialSource(path, baseUrl) {
  mkdirSync(dirname(path), { recursive: true });
  writeFileSync(
    path,
    `${JSON.stringify({
      providers: {
        "z-ai": { api: "anthropic-messages", apiKey: SENTINEL_KEY, baseUrl, models: [{ id: "glm-5.3" }] },
      },
    }, null, 2)}\n`,
    "utf8",
  );
}

describe("real run infrastructure failure stop", () => {
  test("first arm infrastructure failure prevents the second arm spawn and leaves a terminal artifact", { timeout: 240_000 }, async () => {
    const work = mkdtempSync(join(tmpdir(), "cm-infra-stop-"));
    const runsDir = join(work, "runs");
    const cacheDir = join(work, "cache");
    const runId = "infra-stop-01";
    try {
      prepareRealRun(runsDir, runId);
      const runDir = join(runsDir, runId);
      const armOrder = readJson(join(runDir, "run.json")).armOrder["task-01"];
      const [firstArm, secondArm] = armOrder;
      // The base URL parses as a provider config but cannot become a proxy
      // upstream target, so the proxy setup fails after the slot is reserved.
      const credentialSource = join(work, "models.json");
      writeCredentialSource(credentialSource, "not-a-valid-upstream-url");
      const piRuntime = makeScenarioPiRuntime(cacheDir, []);

      const runResult = await runCliAsync([
        "run", "--runs-dir", runsDir, "--run-id", runId, "--task", "task-01",
        "--confirm-paid", "--credential-source", credentialSource,
        "--cache-dir", cacheDir, "--pi-runtime", piRuntime, "--timeout-ms", "60000",
      ], { timeout: 230_000 });
      assert.notEqual(runResult.status, 0, "an infrastructure failure must exit the runner nonzero");
      assert.match(runResult.stderr, /infrastructure/i, `progress must name the infrastructure stop: ${runResult.stderr.slice(0, 300)}`);

      const summary = JSON.parse(runResult.stdout.trim().split("\n").pop());
      assert.equal(summary.infrastructureFailed, true);
      assert.equal(summary.stopped.taskId, "task-01");
      assert.equal(summary.stopped.arm, firstArm);
      assert.equal(summary.stopped.status, "infrastructure-error");
      assert.equal(summary.outcomes.length, 1, "the second arm must never run");
      assert.equal(summary.outcomes[0].status, "infrastructure-error");

      const attemptDir = join(runDir, "attempts", "task-01", firstArm, "attempt-001");
      const result = readJson(join(attemptDir, "result.json"));
      assert.equal(result.status, "infrastructure-error", "the failure leaves a terminal artifact");
      assert.equal(typeof result.error.category, "string", "the artifact carries a safe error category");
      assert.ok(result.error.category.length > 0);
      assert.ok(!JSON.stringify(result).includes(SENTINEL_KEY), "the terminal artifact must not carry key material");
      assert.equal(existsSync(join(attemptDir, "invocations.jsonl")), false, "no Pi invocation may happen");

      const events = journalEvents(runDir);
      const finished = events.filter((event) => event.type === "attempt-finished");
      assert.equal(finished.length, 1, "exactly one terminal journal entry");
      assert.equal(finished[0].status, "infrastructure-error");
      assert.equal(
        events.some((event) => event.type === "attempt-reserved" && event.taskId === "task-01" && event.arm === secondArm),
        false,
        "the second arm must never be reserved",
      );
      assert.equal(existsSync(join(runDir, "attempts", "task-01", secondArm)), false, "no second arm directory");
      const snapshot = readJson(join(runDir, "snapshot.json"));
      assert.equal(snapshot.attempts[`task-01:${firstArm}:1`].status, "infrastructure-error");
      assert.equal(snapshot.selection[`task-01:${firstArm}`], undefined, "infrastructure-error never auto-selects");
    } finally {
      spawnSync("git", ["-C", repoRoot, "worktree", "prune"]);
      rmSync(work, { recursive: true, force: true });
    }
  });
});
