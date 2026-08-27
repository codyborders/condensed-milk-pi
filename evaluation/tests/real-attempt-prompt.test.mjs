/**
 * Combined attempt prompt tests
 * (boundary: evaluation/runner/real-attempt.mjs prompt construction).
 *
 * The real Pi prompt must be the checked-in attempt-prompt.md rules
 * followed by the task prompt. The persisted SHA-256 must cover the
 * exact combined prompt.
 */

import { test, describe } from "node:test";
import assert from "node:assert/strict";
import { fileURLToPath } from "node:url";
import { dirname, join } from "node:path";
import { mkdirSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { createHash } from "node:crypto";
import { loadManifestFile } from "../lib/manifest.mjs";

const repoRoot = join(dirname(fileURLToPath(import.meta.url)), "..", "..");
const manifest = loadManifestFile(join(repoRoot, "evaluation", "task-manifest.json"));
const UPSTREAM_ARM = manifest.evaluation.arms.find((arm) => arm.name === "upstream");
const TASK = manifest.tasks.find((entry) => entry.id === "task-01");

function sha256(text) {
  return createHash("sha256").update(text).digest("hex");
}

describe("combined attempt prompt", () => {
  test("the planner prompt is attempt-prompt.md rules plus the task prompt, hashed exactly", async () => {
    const work = mkdtempSync(join(tmpdir(), "cm-prompt-plan-"));
    try {
      const module = await import(join(repoRoot, "evaluation", "runner", "real-attempt.mjs"));
      const { buildAttemptPrompt, planRealInvocation, attemptPaths } = module;
      assert.equal(typeof buildAttemptPrompt, "function", "buildAttemptPrompt must be exported");

      const rules = readFileSync(join(repoRoot, "evaluation", "runner", "attempt-prompt.md"), "utf8");
      const expectedPrompt = `${rules}${TASK.prompt}`;
      assert.equal(buildAttemptPrompt(TASK.prompt), expectedPrompt, "the combined prompt is rules then task text");

      const paths = attemptPaths(join(work, "attempt-001"));
      const plan = planRealInvocation({
        paths,
        manifest,
        task: TASK,
        arm: UPSTREAM_ARM,
        piCliPath: join(work, "fake-pi", "dist", "cli.js"),
      });
      assert.equal(plan.prompt, expectedPrompt);
      assert.equal(plan.argv[plan.argv.length - 1], expectedPrompt, "the combined prompt is the final argv entry");
      assert.match(plan.prompt, /Do not use the network\./);
      assert.match(plan.prompt, /Work only inside the current repository\./);
      assert.match(plan.prompt, /median\(\[3, 1, 2\]\)/);
      assert.equal(plan.promptSha256, sha256(expectedPrompt), "the hash covers the exact combined prompt");
      assert.equal(plan.pinned.promptSha256, sha256(expectedPrompt));
    } finally {
      rmSync(work, { recursive: true, force: true });
    }
  });

  test("reservation pins the combined prompt hash in pinned.json", async () => {
    const work = mkdtempSync(join(tmpdir(), "cm-prompt-reserve-"));
    const runDir = join(work, "run-01");
    try {
      mkdirSync(runDir, { recursive: true });
      writeFileSync(
        join(runDir, "run.json"),
        `${JSON.stringify({ runId: "run-01", mode: "dry-run", armOrder: {} }, null, 2)}\n`,
        "utf8",
      );
      const cliModule = await import(join(repoRoot, "evaluation", "runner", "cli.mjs"));
      const claim = cliModule.reserveAttempt({ runDir, runId: "run-01", taskId: TASK.id, arm: "upstream", attempt: 1 });
      assert.equal(claim.claimed, true, "reservation must succeed with the fixture cache present");
      const pinned = JSON.parse(readFileSync(join(claim.attemptDir, "pinned.json"), "utf8"));
      const rules = readFileSync(join(repoRoot, "evaluation", "runner", "attempt-prompt.md"), "utf8");
      assert.equal(
        pinned.promptSha256,
        sha256(`${rules}${TASK.prompt}`),
        "reservation must pin the combined prompt hash",
      );
    } finally {
      rmSync(work, { recursive: true, force: true });
    }
  });
});
