/**
 * Preflight observer-ordering integration (red slice: a failing
 * verifyObserverOrdering callback must refuse before reservation).
 */

import { test, describe } from "node:test";
import assert from "node:assert/strict";
import { mkdtempSync, mkdirSync, rmSync, writeFileSync, existsSync } from "node:fs";
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

describe("preflight observer ordering", () => {
  test("a failing ordering callback refuses before any attempts directory exists", () => {
    const runsDir = mkdtempSync(join(tmpdir(), "cm-preflight-ordering-"));
    try {
      const runDir = join(runsDir, "run");
      mkdirSync(runDir, { recursive: true });
      writeFileSync(join(runDir, "run.json"), JSON.stringify({ runId: "ordering-run", mode: "real" }), "utf8");
      const manifest = loadManifestFile(join(repoRoot, "evaluation", "task-manifest.json"));
      const outcome = runPaidPreflight({
        flags: {
          "--credential-source": fakeCredentialSource(join(runsDir, "creds")),
          "--cache-dir": join(runsDir, "cache"),
        },
        manifest,
        repoRoot,
        runDir,
        runId: "ordering-run",
        verifyObserverOrdering: () => {
          throw new Error("ordering failed in test");
        },
      });
      assert.equal(outcome.ok, false);
      assert.match(outcome.error, /observer ordering preflight refused/);
      assert.equal(existsSync(join(runDir, "attempts")), false, "no reservation may exist");
    } finally {
      rmSync(runsDir, { recursive: true, force: true });
    }
  });
});
