/**
 * Shared paid preflight tests (real.mjs).
 *
 * runPaidPreflight accepts an explicit manifest and preserves the
 * fail-closed ordering: paid flags, timeout, credential load, arm
 * worktrees, Pi runtime resolution, runtime pin persistence, node
 * engine check. A refusal returns before anything is reserved.
 */

import { test, describe } from "node:test";
import assert from "node:assert/strict";
import { mkdtempSync, rmSync, mkdirSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join, dirname } from "node:path";
import { fileURLToPath } from "node:url";
import { runPaidPreflight } from "../runner/real.mjs";
import { loadManifestFile } from "../lib/manifest.mjs";

const repoRoot = join(dirname(fileURLToPath(import.meta.url)), "..", "..");

function fakeCredentialSource(dir) {
  const path = join(dir, "models.json");
  mkdirSync(dir, { recursive: true });
  writeFileSync(
    path,
    JSON.stringify({
      providers: {
        "z-ai": {
          api: "anthropic-messages",
          apiKey: "test-key-not-real",
          baseUrl: "https://api.z.ai/api/anthropic",
          models: [{ id: "glm-5.3-flash" }],
        },
      },
    }),
    "utf8",
  );
  return path;
}

describe("runPaidPreflight", () => {
  test("refuses a missing credential source before any reservation work", () => {
    const runsDir = mkdtempSync(join(tmpdir(), "cm-preflight-"));
    try {
      const manifest = loadManifestFile(join(repoRoot, "evaluation", "task-manifest.json"));
      const outcome = runPaidPreflight({
        flags: {},
        manifest,
        repoRoot,
        runDir: join(runsDir, "run"),
        runId: "preflight-run",
      });
      assert.equal(outcome.ok, false);
      assert.match(outcome.error, /credential-source/);
      assert.equal(typeof outcome.code, "number");
    } finally {
      rmSync(runsDir, { recursive: true, force: true });
    }
  });

  test("refuses an unreadable credential source with an explicit manifest", () => {
    const runsDir = mkdtempSync(join(tmpdir(), "cm-preflight-"));
    try {
      const manifest = loadManifestFile(join(repoRoot, "evaluation", "task-manifest.json"));
      const outcome = runPaidPreflight({
        flags: { "--credential-source": join(runsDir, "missing.json") },
        manifest,
        repoRoot,
        runDir: join(runsDir, "run"),
        runId: "preflight-run",
      });
      assert.equal(outcome.ok, false);
      assert.match(outcome.error, /credential source refused/);
    } finally {
      rmSync(runsDir, { recursive: true, force: true });
    }
  });

  test("accepts an explicit manifest with a valid credential file", () => {
    const runsDir = mkdtempSync(join(tmpdir(), "cm-preflight-"));
    try {
      const runDir = join(runsDir, "run");
      mkdirSync(runDir, { recursive: true });
      writeFileSync(join(runDir, "run.json"), JSON.stringify({ runId: "preflight-run", mode: "real" }), "utf8");
      const manifest = loadManifestFile(join(repoRoot, "evaluation", "task-manifest.json"));
      const credentialSource = fakeCredentialSource(join(runsDir, "creds"));
      const outcome = runPaidPreflight({
        flags: { "--credential-source": credentialSource, "--cache-dir": join(runsDir, "cache") },
        manifest,
        repoRoot,
        runDir: join(runsDir, "run"),
        runId: "preflight-run",
      });
      if (!outcome.ok) {
        assert.fail(`expected preflight success, got: ${outcome.error}`);
      }
      assert.ok(outcome.armInfos.upstream && outcome.armInfos.fork);
      assert.match(outcome.pi.cliPath, /cli\.js$/);
      assert.equal(outcome.timeoutMs, manifest.evaluation.timeoutMsPerAttempt);
    } finally {
      rmSync(runsDir, { recursive: true, force: true });
    }
  });
});
