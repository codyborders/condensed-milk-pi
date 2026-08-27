/**
 * Real attempt invocation planner tests
 * (boundary: evaluation/runner/real-attempt.mjs planRealInvocation).
 *
 * Fake-only: the planner is pure metadata. It must pin the exact Pi
 * argv and environment without disclosing evaluator paths or any key.
 */

import { test, describe } from "node:test";
import assert from "node:assert/strict";
import { fileURLToPath } from "node:url";
import { dirname, join } from "node:path";
import { mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { createHash } from "node:crypto";
import { loadManifestFile } from "../lib/manifest.mjs";

const repoRoot = join(dirname(fileURLToPath(import.meta.url)), "..", "..");
const manifest = loadManifestFile(join(repoRoot, "evaluation", "task-manifest.json"));
const SENTINEL_KEY = "sentinel-zai-key-do-not-leak-0123456789abcdef";
const UPSTREAM_ARM = manifest.evaluation.arms.find((arm) => arm.name === "upstream");

function sha256(text) {
  return createHash("sha256").update(text).digest("hex");
}

describe("real attempt invocation planner", () => {
  test("pins exact argv, allowlisted env, combined prompt hash, and metadata without evaluator paths or secrets", async () => {
    const work = mkdtempSync(join(tmpdir(), "cm-attempt-plan-"));
    try {
      const { attemptPaths, planRealInvocation, buildAttemptPrompt, EVAL_PROVIDER_ID, EVAL_MODEL_ID } = await import(
        join(repoRoot, "evaluation", "runner", "real-attempt.mjs")
      );
      const attemptDir = join(work, "attempt-001");
      const paths = attemptPaths(attemptDir);
      const piCliPath = join(work, "fake-pi", "dist", "cli.js");
      const task = manifest.tasks.find((entry) => entry.id === "task-01");
      const prompt = buildAttemptPrompt(task.prompt);
      const plan = planRealInvocation({ paths, manifest, task, arm: UPSTREAM_ARM, piCliPath });

      assert.equal(plan.argv[0], process.execPath, "Pi runs under the runner's node executable");
      assert.equal(plan.argv[1], piCliPath);
      assert.deepEqual(plan.argv.slice(2), [
        "--mode", "json",
        "-p",
        "--no-extensions",
        "-e", join(paths.implementation, "index.ts"),
        "--no-skills",
        "--no-prompt-templates",
        "--no-themes",
        "--no-context-files",
        "--offline",
        "--tools", manifest.evaluation.tools.join(","),
        "--provider", "z-ai-eval",
        "--model", "glm-5.3-flash",
        "--thinking", "high",
        "--session-dir", paths.sessions,
        prompt,
      ], "the Pi argv is exactly the pinned invocation with the combined prompt");
      assert.match(prompt, /Do not use the network\./);
      assert.match(prompt, /Work only inside the current repository\./);

      assert.deepEqual(
        Object.keys(plan.env).sort(),
        ["HOME", "PATH", "PI_CODING_AGENT_DIR", "TMPDIR"],
        "the child environment is a fixed allowlist",
      );
      assert.equal(plan.env.HOME, paths.home);
      assert.equal(plan.env.TMPDIR, paths.tmp);
      assert.equal(plan.env.PI_CODING_AGENT_DIR, paths.agent);
      assert.ok(plan.env.PATH.length > 0, "the sanitized PATH stays usable");
      for (const entry of plan.env.PATH.split(":")) {
        assert.ok(!entry.startsWith(repoRoot), `PATH entry ${entry} must not disclose the evaluator repository`);
      }

      assert.equal(plan.cwd, paths.worktree);
      assert.equal(plan.stdoutPath, paths.stdout);
      assert.equal(plan.stderrPath, paths.stderr);
      assert.equal(plan.sessionDir, paths.sessions);
      assert.equal(plan.prompt, prompt);
      assert.equal(plan.promptSha256, sha256(prompt), "the hash covers the exact combined prompt");
      assert.deepEqual(plan.pinned, {
        promptSha256: sha256(prompt),
        scorerSha256: "29b54352a156f55a69dcbda4c31552e2f2660a07290763a213892530e270fdfd",
        provider: manifest.evaluation.provider,
        model: manifest.evaluation.model,
        thinking: manifest.evaluation.thinking,
        piVersion: manifest.evaluation.piVersion,
        armCommit: UPSTREAM_ARM.commit,
        tools: manifest.evaluation.tools,
      });
      assert.equal(EVAL_PROVIDER_ID, "z-ai-eval");
      assert.equal(EVAL_MODEL_ID, "glm-5.3-flash");

      const flat = JSON.stringify(plan);
      assert.ok(!flat.includes(repoRoot), "the plan must not disclose the evaluator repository path");
      assert.ok(!flat.includes("scorers"), "the plan must not disclose scorer paths");
      assert.ok(!flat.includes("fixtures"), "the plan must not disclose fixture cache paths");
      assert.ok(!flat.includes(SENTINEL_KEY), "the plan must never contain key material");
      assert.ok(!flat.includes("eval-dummy-key"), "even the dummy key stays out of argv and env");
    } finally {
      rmSync(work, { recursive: true, force: true });
    }
  });
});
