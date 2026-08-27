/**
 * Offline Pi-runtime validation of the generated eval model config
 * (boundary: evaluation/runner/real-attempt.mjs buildEvalProviderModels
 * plus the isolated Pi 0.84.2 runtime from evaluation/runner/real-runtime.mjs).
 *
 * The generated glm-5.3-flash provider entry must load and validate in
 * the real pinned Pi CLI, offline, listing the pinned 1M context and
 * 65536-token output limit.
 */

import { test, describe } from "node:test";
import assert from "node:assert/strict";
import { fileURLToPath } from "node:url";
import { dirname, join } from "node:path";
import { mkdirSync, mkdtempSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { spawnSync } from "node:child_process";
import { loadManifestFile } from "../lib/manifest.mjs";
import { SAFE_TEMPLATE } from "./real-attempt-models.test.mjs";

const repoRoot = join(dirname(fileURLToPath(import.meta.url)), "..", "..");

describe("offline Pi validation of the eval model config", () => {
  test("the generated config passes isolated real Pi 0.84.2 offline list-models", { timeout: 240_000 }, async () => {
    const work = mkdtempSync(join(tmpdir(), "cm-eval-models-pi-"));
    try {
      const attempt = await import(join(repoRoot, "evaluation", "runner", "real-attempt.mjs"));
      const runtime = await import(join(repoRoot, "evaluation", "runner", "real-runtime.mjs"));
      const manifest = loadManifestFile(join(repoRoot, "evaluation", "task-manifest.json"));
      const cliPath = runtime.materializePiRuntime({ repoRoot, manifest, cacheRoot: join(work, "cache") }).cliPath;
      const agentDir = join(work, "agent");
      mkdirSync(agentDir, { recursive: true });
      const config = attempt.buildEvalProviderModels({
        proxyBaseUrl: "http://127.0.0.1:1",
        template: SAFE_TEMPLATE,
        dummyApiKey: "offline-eval-dummy",
      });
      writeFileSync(join(agentDir, "models.json"), `${JSON.stringify(config, null, 2)}\n`, "utf8");
      const result = spawnSync(process.execPath, [cliPath, "--offline", "--list-models"], {
        encoding: "utf8",
        timeout: 60_000,
        env: { PATH: process.env.PATH, HOME: work, PI_CODING_AGENT_DIR: agentDir },
      });
      assert.equal(result.status, 0, `offline list-models failed: ${(result.stderr || "").slice(0, 500)}`);
      assert.match(
        result.stdout,
        /z-ai-eval\s+glm-5\.3-flash\s+1M\s+65\.5K\s+yes\s+yes/,
        `the pinned row must validate and list: ${result.stdout}`,
      );
    } finally {
      rmSync(work, { recursive: true, force: true });
    }
  });
});
