/**
 * Real attempt latency tests
 * (boundary: evaluation/runner/real-attempt.mjs executeRealAttempt timing).
 *
 * Fake-only: the first-event latency must be measured from the instant
 * immediately before the Pi process spawn, not from fixture
 * preparation. The fake Pi timestamps its first stdout event, and the
 * test makes workspace preparation deliberately expensive so a
 * preparation-based clock would be visible in the reported latency.
 */

import { test, describe } from "node:test";
import assert from "node:assert/strict";
import { fileURLToPath } from "node:url";
import { dirname, join } from "node:path";
import { cpSync, mkdirSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { spawnSync } from "node:child_process";
import http from "node:http";
import { loadManifestFile, loadTaskData } from "../lib/manifest.mjs";

const repoRoot = join(dirname(fileURLToPath(import.meta.url)), "..", "..");
const manifest = loadManifestFile(join(repoRoot, "evaluation", "task-manifest.json"));
const SENTINEL_KEY = "sentinel-zai-key-do-not-leak-latency-0123456789";
const UPSTREAM_ARM = manifest.evaluation.arms.find((arm) => arm.name === "upstream");
const FIXTURE_DIR = join(repoRoot, "evaluation", "cache", "fixtures", "task-01");
const TASK = manifest.tasks.find((entry) => entry.id === "task-01");
const JUNK_FILES = 6000;

function startFakeUpstream() {
  const server = http.createServer((req, res) => {
    let body = "";
    req.on("data", (chunk) => {
      body += chunk;
    });
    req.on("end", () => {
      res.writeHead(200, { "content-type": "text/event-stream" });
      res.end("event: done\ndata: {}\n\n");
    });
  });
  return new Promise((resolve) => {
    server.listen(0, "127.0.0.1", () => {
      resolve({ port: server.address().port, close: () => new Promise((done) => server.close(() => done())) });
    });
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

const FAKE_PI_SOURCE = String.raw`
import { writeFileSync, mkdirSync } from "node:fs";
import { join } from "node:path";
const argv = process.argv.slice(2);
const sessionDir = argv[argv.indexOf("--session-dir") + 1];
mkdirSync(sessionDir, { recursive: true });
const message = { role: "assistant", content: [{ type: "text", text: "turn one" }], usage: { input: 100, output: 10 } };
process.stdout.write(JSON.stringify({ type: "session", version: 3, id: "fake-session", timestamp: new Date().toISOString() }) + "\n");
process.stdout.write(JSON.stringify({ type: "message_end", message }) + "\n");
writeFileSync(join(sessionDir, "done.txt"), "done\n");
process.exit(0);
`;

function makeFakePiRuntime(cacheDir, solution) {
  const runtimeDir = join(cacheDir, "fake-pi-runtime");
  mkdirSync(join(runtimeDir, "dist"), { recursive: true });
  writeFileSync(
    join(runtimeDir, "package.json"),
    `${JSON.stringify({ name: "fake-pi-runtime", version: "0.84.2", type: "module", engines: { node: ">=22.19.0" } }, null, 2)}\n`,
    "utf8",
  );
  writeFileSync(join(runtimeDir, "behavior.json"), `${JSON.stringify({ behavior: "ok" })}\n`, "utf8");
  writeFileSync(join(runtimeDir, "solution.json"), `${JSON.stringify(solution)}\n`, "utf8");
  writeFileSync(join(runtimeDir, "dist", "cli.js"), FAKE_PI_SOURCE, "utf8");
  return join(runtimeDir, "dist", "cli.js");
}

describe("real attempt first-event latency", () => {
  test("first-event latency is measured from the spawn instant, not fixture preparation", { timeout: 180_000 }, async () => {
    const work = mkdtempSync(join(tmpdir(), "cm-real-latency-"));
    const upstream = await startFakeUpstream();
    try {
      // Deliberately expensive fixture: thousands of extra files make
      // workspace preparation take seconds, far beyond any spawn window.
      const heavyFixture = join(work, "heavy-fixture");
      cpSync(FIXTURE_DIR, heavyFixture, { recursive: true, dot: true });
      mkdirSync(join(heavyFixture, "junk"), { recursive: true });
      const payload = "x".repeat(64);
      for (let index = 0; index < JUNK_FILES; index += 1) {
        writeFileSync(join(heavyFixture, "junk", `j-${index}.txt`), payload, "utf8");
      }

      const credentialSource = join(work, "models.json");
      writeCredentialSource(credentialSource, `http://127.0.0.1:${upstream.port}`);
      const { verifyArmWorktree } = await import(join(repoRoot, "evaluation", "runner", "real-runtime.mjs"));
      const armInfo = verifyArmWorktree({ repoRoot, arm: UPSTREAM_ARM, cacheRoot: join(work, "cache") });
      const { solution } = loadTaskData(repoRoot, TASK.id);
      const piCliPath = makeFakePiRuntime(join(work, "cache"), solution);
      const attemptDir = join(work, "runs", "attempt-001");
      mkdirSync(attemptDir, { recursive: true });

      const { executeRealAttempt } = await import(join(repoRoot, "evaluation", "runner", "real-attempt.mjs"));
      const outcome = await executeRealAttempt({
        repoRoot,
        manifest,
        task: TASK,
        arm: "upstream",
        armInfo,
        attemptDir,
        fixtureDir: heavyFixture,
        credentialSourcePath: credentialSource,
        piCliPath,
        timeoutMs: 120_000,
      });
      assert.equal(outcome.status, "completed");

      const result = JSON.parse(readFileSync(join(attemptDir, "result.json"), "utf8"));
      assert.ok(typeof result.piSpawnStartedAt === "string", "result must persist piSpawnStartedAt");
      const spawnStart = Date.parse(result.piSpawnStartedAt);
      assert.ok(Number.isFinite(spawnStart), `piSpawnStartedAt must be an ISO timestamp: ${result.piSpawnStartedAt}`);

      const marker = JSON.parse(readFileSync(join(attemptDir, "invocations.jsonl"), "utf8").trim().split("\n")[0]);
      assert.equal(marker.piSpawnStartedAt, result.piSpawnStartedAt, "the invocation marker records the same spawn instant");

      const firstLine = readFileSync(join(attemptDir, "pi-stdout.jsonl"), "utf8").split("\n", 1)[0];
      const firstEvent = JSON.parse(firstLine);
      const windowMs = Date.parse(firstEvent.timestamp) - spawnStart;
      assert.ok(Number.isFinite(windowMs), "the first event carries a parseable timestamp");
      assert.ok(
        result.firstEventLatencyMs <= windowMs + 250,
        `firstEventLatencyMs ${result.firstEventLatencyMs} must not include fixture preparation (window ${windowMs}ms)`,
      );
      assert.ok(
        result.firstEventLatencyMs >= windowMs - 250,
        `firstEventLatencyMs ${result.firstEventLatencyMs} must cover the spawn-to-first-event window ${windowMs}ms`,
      );
      assert.ok(result.durationMs >= result.firstEventLatencyMs, "the attempt duration covers the latency window");
    } finally {
      await upstream.close();
      spawnSync("git", ["-C", repoRoot, "worktree", "prune"]);
      rmSync(work, { recursive: true, force: true });
    }
  });
});
