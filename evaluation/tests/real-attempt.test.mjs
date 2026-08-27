/**
 * Real attempt module tests (boundary: evaluation/runner/real-attempt.mjs).
 *
 * Fake-only: a sentinel credential, a loopback fake z.ai upstream, and a
 * fake Pi CLI runtime. The real provider is never contacted.
 */

import { test, describe } from "node:test";
import assert from "node:assert/strict";
import { fileURLToPath } from "node:url";
import { dirname, join } from "node:path";
import {
  existsSync,
  mkdirSync,
  mkdtempSync,
  readFileSync,
  readdirSync,
  rmSync,
  statSync,
  writeFileSync,
} from "node:fs";
import { tmpdir } from "node:os";
import { spawnSync } from "node:child_process";
import { createHash } from "node:crypto";
import http from "node:http";
import { loadManifestFile, loadTaskData } from "../lib/manifest.mjs";

const repoRoot = join(dirname(fileURLToPath(import.meta.url)), "..", "..");
const manifest = loadManifestFile(join(repoRoot, "evaluation", "task-manifest.json"));
const SENTINEL_KEY = "sentinel-zai-key-do-not-leak-0123456789abcdef";
const UPSTREAM_ARM = manifest.evaluation.arms.find((arm) => arm.name === "upstream");
const FIXTURE_DIR = join(repoRoot, "evaluation", "cache", "fixtures", "task-01");

function sha256(text) {
  return createHash("sha256").update(text).digest("hex");
}

function readJson(path) {
  return JSON.parse(readFileSync(path, "utf8"));
}

function collectFiles(directory) {
  const out = [];
  for (const name of readdirSync(directory)) {
    const path = join(directory, name);
    if (statSync(path).isDirectory()) out.push(...collectFiles(path));
    else out.push({ path, body: readFileSync(path, "utf8") });
  }
  return out;
}

describe("real attempt workspace", () => {
  test("builds the isolated workspace with dummy credential config and hidden implementation", { timeout: 60_000 }, async () => {
    const work = mkdtempSync(join(tmpdir(), "cm-attempt-ws-"));
    try {
      const attemptDir = join(work, "attempt-001");
      mkdirSync(attemptDir, { recursive: true });
      const { prepareAttemptWorkspace, verifyArmWorktree } = await Promise.all([
        import(join(repoRoot, "evaluation", "runner", "real-attempt.mjs")),
        import(join(repoRoot, "evaluation", "runner", "real-runtime.mjs")),
      ]).then(([attempt, runtime]) => ({ ...attempt, ...runtime }));
      const arm = verifyArmWorktree({ repoRoot, arm: UPSTREAM_ARM, cacheRoot: join(work, "cache") });
      const template = {
        id: "glm-5.3",
        cost: { input: 1.5, output: 6, cacheRead: 0.2, cacheWrite: 2 },
        compat: { allowEmptySignature: true },
        thinkingLevelMap: { high: "think" },
        samplingParams: { temperature: 0.7 },
      };
      const paths = prepareAttemptWorkspace({
        attemptDir,
        fixtureDir: FIXTURE_DIR,
        arm,
        profile: manifest.evaluation.profile,
        proxyBaseUrl: "http://127.0.0.1:1",
        template,
        dummyApiKey: "eval-dummy-key",
      });

      const models = readJson(paths.agentModels);
      const provider = models.providers["z-ai-eval"];
      assert.equal(provider.baseUrl, "http://127.0.0.1:1");
      assert.equal(provider.apiKey, "eval-dummy-key");
      assert.equal(provider.api, "anthropic-messages");
      assert.equal(provider.models[0].id, "glm-5.3-flash");
      assert.equal(provider.models[0].maxTokens, 65536, "the eval model must pin a 65536 output limit");
      assert.equal(provider.models[0].reasoning, true);
      assert.deepEqual(provider.models[0].input, ["text", "image"]);
      assert.equal(provider.models[0].contextWindow, 1000000);
      assert.deepEqual(provider.models[0].compat, { allowEmptySignature: true }, "template compat is copied");
      assert.deepEqual(provider.models[0].thinkingLevelMap, { high: "think" });
      assert.deepEqual(provider.models[0].samplingParams, { temperature: 0.7 });
      assert.ok(!JSON.stringify(models).includes("cost"), "no cost claims may be written");
      assert.ok(!JSON.stringify(models).includes(SENTINEL_KEY));
      assert.equal(statSync(paths.agentModels).mode & 0o777, 0o600, "models.json must be mode 0600");

      assert.equal(readJson(paths.homeConfig).profile, "qwen-vllm");

      assert.equal(
        readFileSync(join(paths.worktree, "implementation", "index.ts"), "utf8"),
        spawnSync("git", ["-C", repoRoot, "show", `${UPSTREAM_ARM.commit}:index.ts`], { encoding: "utf8" }).stdout,
      );
      const porcelain = spawnSync("git", ["-C", paths.worktree, "status", "--porcelain"], { encoding: "utf8" }).stdout;
      assert.ok(!porcelain.includes("implementation"), "the scaffolding must stay invisible to the fixture git");
      assert.equal(existsSync(join(paths.worktree, "stats.py")), true, "fixture files must be present");
    } finally {
      spawnSync("git", ["-C", repoRoot, "worktree", "prune"]);
      rmSync(work, { recursive: true, force: true });
    }
  });
});
