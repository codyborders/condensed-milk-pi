/**
 * Node engine preflight tests
 * (boundary: evaluation/runner/real-runtime.mjs verifyNodeEngine).
 *
 * Before any reservation, the runner reads the isolated Pi runtime's
 * engines.node and verifies the Node that will spawn Pi satisfies the
 * minimum. Conservative: only plain >= numeric minimums are honored;
 * anything else refuses. Fake inputs only; no attempt is ever made.
 */

import { test, describe } from "node:test";
import assert from "node:assert/strict";
import { fileURLToPath } from "node:url";
import { dirname, join } from "node:path";
import { existsSync, mkdirSync, mkdtempSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { spawn, spawnSync } from "node:child_process";

const repoRoot = join(dirname(fileURLToPath(import.meta.url)), "..", "..");
const REAL_PI_RUNTIME = join(repoRoot, "node_modules", "@earendil-works", "pi-coding-agent");
const cli = join(repoRoot, "evaluation", "runner", "cli.mjs");

function makeRuntime(work, enginesNode) {
  const runtimeDir = join(work, "runtime");
  mkdirSync(join(runtimeDir, "dist"), { recursive: true });
  writeFileSync(
    join(runtimeDir, "package.json"),
    `${JSON.stringify({ name: "fake-pi-runtime", version: "0.84.2", ...(enginesNode === undefined ? {} : { engines: { node: enginesNode } }) }, null, 2)}\n`,
    "utf8",
  );
  writeFileSync(join(runtimeDir, "dist", "cli.js"), "// fake\n", "utf8");
  return runtimeDir;
}

describe("node engine preflight", () => {
  test("a fake Node v20.19.5 input refuses against the isolated Pi runtime's declared minimum", async () => {
    const work = mkdtempSync(join(tmpdir(), "cm-engine-"));
    try {
      const { verifyNodeEngine } = await import(join(repoRoot, "evaluation", "runner", "real-runtime.mjs"));
      assert.equal(typeof verifyNodeEngine, "function", "verifyNodeEngine must be exported");
      assert.throws(
        () => verifyNodeEngine({ runtimeDir: REAL_PI_RUNTIME, nodeVersion: "v20.19.5" }),
        (error) => {
          assert.match(error.message, /below the pi runtime minimum/i);
          assert.match(error.message, />=22\.19\.0/, "the refusal names the declared minimum");
          assert.ok(!error.message.includes(work), "the refusal must not leak local paths");
          return true;
        },
        "a Node below the runtime minimum must refuse",
      );
    } finally {
      rmSync(work, { recursive: true, force: true });
    }
  });

  test("a run whose Pi runtime demands a newer Node refuses before any reservation", { timeout: 120_000 }, () => {
    const work = mkdtempSync(join(tmpdir(), "cm-engine-cli-"));
    const runsDir = join(work, "runs");
    const cacheDir = join(work, "cache");
    const runId = "engine-refuse-01";
    try {
      const prepared = spawnSync(process.execPath, [cli, "prepare", "--runs-dir", runsDir, "--run-id", runId, "--mode", "real"], { encoding: "utf8" });
      assert.equal(prepared.status, 0, `prepare failed: ${prepared.stderr}`);
      const credentialSource = join(work, "models.json");
      mkdirSync(work, { recursive: true });
      writeFileSync(
        credentialSource,
        `${JSON.stringify({ providers: { "z-ai": { apiKey: "sentinel-zai-key-do-not-leak-0123456789abcdef", baseUrl: "http://127.0.0.1:9" } } }, null, 2)}\n`,
        "utf8",
      );
      const runtimeDir = makeRuntime(work, ">=99.0.0");
      const run = spawnSync(process.execPath, [
        cli, "run", "--runs-dir", runsDir, "--run-id", runId, "--task", "task-01", "--arm", "upstream",
        "--confirm-paid", "--credential-source", credentialSource,
        "--cache-dir", cacheDir, "--pi-runtime", runtimeDir, "--timeout-ms", "60000",
      ], { cwd: repoRoot, encoding: "utf8", timeout: 110_000 });
      assert.notEqual(run.status, 0, "an unsatisfied engine minimum must refuse the run");
      assert.match(run.stderr, /node \S+ is below the pi runtime minimum/i, `refusal must name the engine rule: ${run.stderr.slice(0, 300)}`);
      assert.equal(
        existsSync(join(runsDir, runId, "attempts")),
        false,
        "the engine preflight must refuse before any attempt is reserved",
      );
    } finally {
      spawnSync("git", ["-C", repoRoot, "worktree", "prune"]);
      rmSync(work, { recursive: true, force: true });
    }
  });

  test("the running Node satisfies the real isolated Pi runtime's declared minimum", async () => {
    const { verifyNodeEngine } = await import(join(repoRoot, "evaluation", "runner", "real-runtime.mjs"));
    const check = verifyNodeEngine({ runtimeDir: REAL_PI_RUNTIME, nodeVersion: "v25.8.2" });
    assert.equal(check.minimum, "22.19.0", "the declared Pi 0.84.2 minimum is honored");
    assert.equal(
      typeof verifyNodeEngine({ runtimeDir: REAL_PI_RUNTIME }).nodeVersion,
      "string",
      "the default input is the running process version",
    );
  });

  test("a run without --pi-runtime preflights the materialized pinned runtime, not a missing package", { timeout: 240_000 }, async () => {
    const work = mkdtempSync(join(tmpdir(), "cm-engine-materialized-"));
    const runsDir = join(work, "runs");
    const cacheDir = join(work, "cache");
    const runId = "engine-materialized-01";
    try {
      const prepared = spawnSync(process.execPath, [cli, "prepare", "--runs-dir", runsDir, "--run-id", runId, "--mode", "real"], { encoding: "utf8" });
      assert.equal(prepared.status, 0, `prepare failed: ${prepared.stderr}`);
      const credentialSource = join(work, "models.json");
      writeFileSync(
        credentialSource,
        `${JSON.stringify({ providers: { "z-ai": { apiKey: "sentinel-zai-key-do-not-leak-0123456789abcdef", baseUrl: "http://127.0.0.1:9" } } }, null, 2)}\n`,
        "utf8",
      );
      // No --pi-runtime: the runner materializes the pinned runtime and must
      // preflight THAT package's engines.node. The dead loopback upstream keeps
      // the run offline; the attempt may fail, but never at the engine preflight.
      const run = await new Promise((resolve) => {
        const child = spawn(process.execPath, [
          cli, "run", "--runs-dir", runsDir, "--run-id", runId, "--task", "task-01", "--arm", "upstream",
          "--confirm-paid", "--credential-source", credentialSource,
          "--cache-dir", cacheDir, "--timeout-ms", "20000",
        ], { cwd: repoRoot });
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
      assert.equal(
        /node engine preflight refused/.test(run.stderr),
        false,
        `the materialized pinned runtime must satisfy the preflight: ${run.stderr.slice(0, 300)}`,
      );
      assert.equal(
        existsSync(join(runsDir, runId, "attempts", "task-01", "upstream", "attempt-001", "provider-invocation.json")),
        true,
        "the run must get past the preflight and reserve the attempt",
      );
    } finally {
      spawnSync("git", ["-C", repoRoot, "worktree", "prune"]);
      rmSync(work, { recursive: true, force: true });
    }
  });
});
