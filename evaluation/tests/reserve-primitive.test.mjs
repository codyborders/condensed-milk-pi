/**
 * Immutable reservation primitive tests (cli.mjs).
 *
 * reserveAttemptPrimitive accepts an explicit fixture directory,
 * validated fixture identity, explicit pins, a repetition attempt
 * number, and paid identity. Attempt slots claim atomically. The
 * standard reserveAttempt stays a wrapper over the primitive.
 */

import { test, describe } from "node:test";
import assert from "node:assert/strict";
import { mkdtempSync, mkdirSync, readFileSync, rmSync, writeFileSync, existsSync, readdirSync } from "node:fs";
import { tmpdir } from "node:os";
import { join, dirname } from "node:path";
import { fileURLToPath } from "node:url";
import { generateFixture } from "../lib/fixtures.mjs";
import { loadManifestFile } from "../lib/manifest.mjs";
import { reserveAttemptPrimitive, reserveAttempt } from "../runner/cli.mjs";

const repoRoot = join(dirname(fileURLToPath(import.meta.url)), "..", "..");
const standardManifest = loadManifestFile(join(repoRoot, "evaluation", "task-manifest.json"));

function fixtureFor(task, dir) {
  const fixtureDir = join(dir, `${task.id}-fixture`);
  generateFixture({ repoRoot, task, outDir: fixtureDir });
  return fixtureDir;
}

describe("reserveAttemptPrimitive", () => {
  test("claims attempt-002 and attempt-003 immutably with explicit fixture and pins", () => {
    const work = mkdtempSync(join(tmpdir(), "cm-reserve-"));
    try {
      const runDir = join(work, "run");
      mkdirSync(runDir, { recursive: true });
      writeFileSync(join(runDir, "run.json"), JSON.stringify({ runId: "reserve-run", mode: "real" }), "utf8");
      const task = standardManifest.tasks[0];
      const fixtureDir = fixtureFor(task, work);
      const identity = { contentSha256: "a".repeat(64), gitStateSha256: "b".repeat(64) };
      const pins = {
        promptSha256: "c".repeat(64),
        scorerSha256: "d".repeat(64),
        profileSha256: "e".repeat(64),
        fixtureContentSha256: identity.contentSha256,
        fixtureGitStateSha256: identity.gitStateSha256,
        armCommit: "fca546506e3c6b26401155a780052646a65dee38",
      };
      const paid = {
        fake: false,
        provider: "z-ai",
        model: "glm-5.3-flash",
        armCommit: pins.armCommit,
        piRuntime: { digest: "1".repeat(64) },
      };
      for (const attempt of [2, 3]) {
        const claim = reserveAttemptPrimitive({
          runDir,
          runId: "reserve-run",
          taskId: task.id,
          arm: "fork",
          attempt,
          fixtureDir,
          fixtureIdentity: identity,
          pins,
          paidIdentity: paid,
        });
        assert.equal(claim.claimed, true, `attempt ${attempt} must claim`);
        const attemptDir = claim.attemptDir;
        assert.ok(attemptDir.endsWith(`attempt-${String(attempt).padStart(3, "0")}`));
        const receipt = JSON.parse(readFileSync(join(attemptDir, "provider-invocation.json"), "utf8"));
        assert.equal(receipt.fake, false);
        assert.equal(receipt.provider, "z-ai");
        assert.equal(receipt.model, "glm-5.3-flash");
        assert.equal(receipt.piRuntime.digest, "1".repeat(64));
        assert.equal(receipt.attempt, attempt);
        const pinned = JSON.parse(readFileSync(join(attemptDir, "pinned.json"), "utf8"));
        assert.equal(pinned.profileSha256, pins.profileSha256);
        assert.equal(pinned.fixtureContentSha256, identity.contentSha256);
        assert.equal(pinned.piRuntime.digest, "1".repeat(64));
        const before = JSON.parse(readFileSync(join(attemptDir, "fixture-before.json"), "utf8"));
        assert.equal(before.contentSha256, identity.contentSha256);
        const duplicate = reserveAttemptPrimitive({
          runDir,
          runId: "reserve-run",
          taskId: task.id,
          arm: "fork",
          attempt,
          fixtureDir,
          fixtureIdentity: identity,
          pins,
          paidIdentity: paid,
        });
        assert.equal(duplicate.claimed, false, "a second claim of the same slot must refuse");
      }
      const armDir = join(runDir, "attempts", task.id, "fork");
      assert.deepEqual(readdirSync(armDir).sort(), ["attempt-002", "attempt-003"]);
    } finally {
      rmSync(work, { recursive: true, force: true });
    }
  });

  test("standard reserveAttempt stays available as the wrapper", () => {
    assert.equal(typeof reserveAttempt, "function");
  });
});
