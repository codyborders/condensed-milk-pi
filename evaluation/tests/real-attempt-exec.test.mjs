/**
 * Real attempt execution tests
 * (boundary: evaluation/runner/real-attempt.mjs executeRealAttempt).
 *
 * Fake-only: a loopback fake z.ai upstream, a sentinel credential, and
 * a fake Pi CLI runtime. The real provider is never contacted.
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
const TASK = manifest.tasks.find((entry) => entry.id === "task-01");

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

/** Loopback fake z.ai upstream: verifies auth, streams SSE. */
function startFakeUpstream({ mode = "ok" } = {}) {
  const seen = [];
  const server = http.createServer((req, res) => {
    let body = "";
    req.on("data", (chunk) => {
      body += chunk;
    });
    req.on("end", () => {
      let parsed = null;
      try {
        parsed = JSON.parse(body);
      } catch {
        parsed = null;
      }
      seen.push({ method: req.method, url: req.url, headers: req.headers, body: parsed });
      if (req.method !== "POST" || req.url !== "/v1/messages") {
        res.writeHead(404, { "content-type": "application/json" });
        res.end(JSON.stringify({ error: "not the anthropic messages endpoint" }));
        return;
      }
      if (mode === "reject") {
        res.writeHead(401, { "content-type": "application/json" });
        res.end(JSON.stringify({ error: "unauthorized", marker: "UPSTREAM-ERROR-MARKER" }));
        return;
      }
      res.writeHead(200, { "content-type": "text/event-stream" });
      let index = 0;
      const writeNext = () => {
        if (index >= 3) {
          res.end();
          return;
        }
        index += 1;
        res.write(`event: stream-chunk-${index}\ndata: {"index":${index},"marker":"STREAM-CHUNK-MARKER-${index}"}\n\n`);
        setTimeout(writeNext, 10);
      };
      writeNext();
    });
  });
  return new Promise((resolve) => {
    server.listen(0, "127.0.0.1", () => {
      resolve({
        port: server.address().port,
        seen,
        close: () => new Promise((done) => server.close(() => done())),
      });
    });
  });
}

function writeCredentialSource(path, baseUrl) {
  mkdirSync(dirname(path), { recursive: true });
  writeFileSync(
    path,
    `${JSON.stringify({
      providers: {
        "z-ai": {
          api: "anthropic-messages",
          apiKey: SENTINEL_KEY,
          baseUrl,
          models: [{ id: "glm-5.3" }],
        },
        "unrelated-provider": { apiKey: "other-key", baseUrl: "http://127.0.0.1:9/v1" },
      },
    }, null, 2)}\n`,
    "utf8",
  );
}

const FAKE_PI_SOURCE = String.raw`
import { readFileSync, writeFileSync, mkdirSync } from "node:fs";
import { join, dirname } from "node:path";
import { fileURLToPath } from "node:url";
import http from "node:http";
import { spawn } from "node:child_process";

const here = dirname(fileURLToPath(import.meta.url));
const { behavior } = JSON.parse(readFileSync(join(here, "..", "behavior.json"), "utf8"));
const solution = JSON.parse(readFileSync(join(here, "..", "solution.json"), "utf8"));
const argv = process.argv.slice(2);
const sessionDir = argv[argv.indexOf("--session-dir") + 1];
const prompt = argv[argv.length - 1];
mkdirSync(sessionDir, { recursive: true });
writeFileSync(join(sessionDir, "record-argv.json"), JSON.stringify({ argv: process.argv, cwd: process.cwd() }, null, 2));
writeFileSync(join(sessionDir, "record-env.json"), JSON.stringify({ env: process.env }, null, 2));

const models = JSON.parse(readFileSync(join(process.env.PI_CODING_AGENT_DIR, "models.json"), "utf8"));
const provider = models.providers["z-ai-eval"];
const emit = (line) => process.stdout.write(JSON.stringify(line) + "\n");
const applySolution = () => {
  for (const file of solution.files) {
    const target = join(process.cwd(), file.path);
    mkdirSync(dirname(target), { recursive: true });
    writeFileSync(target, file.content);
  }
};

function requestUpstream() {
  return new Promise((resolve, reject) => {
    const body = JSON.stringify({ model: provider.models[0].id, stream: true, max_tokens: 64, messages: [{ role: "user", content: prompt }] });
    const req = http.request(new URL(provider.baseUrl + "/v1/messages"), {
      method: "POST",
      headers: { "content-type": "application/json", "x-api-key": provider.apiKey, accept: "text/event-stream" },
    }, (res) => {
      let bytes = 0;
      res.on("data", (chunk) => { bytes += chunk.length; });
      res.on("end", () => resolve({ status: res.statusCode, bytes }));
    });
    req.on("error", reject);
    req.end(body);
  });
}

if (behavior === "hang") {
  emit({ type: "agent_start" });
  process.on("SIGTERM", () => {});
  const child = spawn(process.execPath, ["-e", "process.on('SIGTERM',()=>{}); setInterval(() => {}, 1000)"], { stdio: "ignore" });
  writeFileSync(join(sessionDir, "record-tree.json"), JSON.stringify({ pid: process.pid, childPid: child.pid }, null, 2));
  setInterval(() => {}, 1000);
} else {
  const upstream = await requestUpstream();
  if (upstream.status !== 200) {
    process.stderr.write("upstream rejected with " + upstream.status + "\n");
    process.exit(4);
  }
  const first = { role: "assistant", content: [{ type: "text", text: "turn one" }], usage: { input: 1100, output: 260, cacheWrite: 40 } };
  const second = { role: "assistant", content: [{ type: "text", text: "turn two" }], usage: { input: 50, output: 10 } };
  emit({ type: "session", version: 3, id: "fake-session", timestamp: new Date().toISOString(), cwd: process.cwd() });
  emit({ type: "agent_start" });
  emit({ type: "message_end", message: first });
  emit({ type: "message_end", message: second });
  emit({ type: "agent_end", messages: [first, second] });
  applySolution();
  await new Promise((resolve) => setTimeout(resolve, 120));
  if (behavior === "nonzero") process.exit(3);
  process.exit(0);
}
`;

/** Fake Pi 0.84.2 runtime: speaks the CLI contract the runner relies on. */
function makeFakePiRuntime(cacheDir, { behavior = "ok", solution }) {
  const runtimeDir = join(cacheDir, "fake-pi-runtime");
  mkdirSync(join(runtimeDir, "dist"), { recursive: true });
  writeFileSync(
    join(runtimeDir, "package.json"),
    `${JSON.stringify({ name: "fake-pi-runtime", version: "0.84.2", type: "module", engines: { node: ">=22.19.0" } }, null, 2)}\n`,
    "utf8",
  );
  writeFileSync(join(runtimeDir, "behavior.json"), `${JSON.stringify({ behavior })}\n`, "utf8");
  writeFileSync(join(runtimeDir, "solution.json"), `${JSON.stringify(solution)}\n`, "utf8");
  writeFileSync(join(runtimeDir, "dist", "cli.js"), FAKE_PI_SOURCE, "utf8");
  return join(runtimeDir, "dist", "cli.js");
}

describe("real attempt execution", () => {
  test("executes one attempt through the credential proxy and writes terminal artifacts", { timeout: 120_000 }, async () => {
    const work = mkdtempSync(join(tmpdir(), "cm-real-exec-"));
    const upstream = await startFakeUpstream();
    try {
      const credentialSource = join(work, "models.json");
      writeCredentialSource(credentialSource, `http://127.0.0.1:${upstream.port}`);
      const { verifyArmWorktree } = await import(join(repoRoot, "evaluation", "runner", "real-runtime.mjs"));
      const armInfo = verifyArmWorktree({ repoRoot, arm: UPSTREAM_ARM, cacheRoot: join(work, "cache") });
      const { solution } = loadTaskData(repoRoot, TASK.id);
      const piCliPath = makeFakePiRuntime(join(work, "cache"), { behavior: "ok", solution });
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
        fixtureDir: FIXTURE_DIR,
        credentialSourcePath: credentialSource,
        piCliPath,
        timeoutMs: 60_000,
      });
      assert.equal(outcome.status, "completed");
      assert.equal(outcome.taskId, TASK.id);
      assert.equal(outcome.arm, "upstream");

      // Exactly one streaming upstream request through the proxy.
      assert.equal(upstream.seen.length, 1);
      const seen = upstream.seen[0];
      assert.equal(seen.headers["x-api-key"], SENTINEL_KEY, "the proxy must swap the dummy key for the real one");
      assert.equal(seen.body.model, "glm-5.3-flash");
      assert.equal(seen.body.stream, true);
      assert.match(
        seen.body.messages[0].content,
        /Do not use the network\./,
        "the request must carry the no-network rule",
      );
      assert.match(
        seen.body.messages[0].content,
        /Work only inside the current repository\./,
        "the request must carry the current-repository rule",
      );
      assert.match(seen.body.messages[0].content, /median\(\[3, 1, 2\]\)/, "the request carries the task prompt");

      const result = readJson(join(attemptDir, "result.json"));
      assert.equal(result.status, "completed");
      assert.equal(result.exit.code, 0);
      assert.equal(result.exit.timedOut, false);
      assert.equal(result.scorer.status, "passed", `scorer: ${JSON.stringify(result.scorer)}`);
      assert.deepEqual(result.usage, { input: 1150, output: 270, cacheRead: null, cacheWrite: 40 }, "usage aggregates every assistant message_end");
      assert.equal(typeof result.firstEventLatencyMs, "number");
      assert.ok(typeof result.piSpawnStartedAt === "string", "the spawn instant is persisted in result.json");
      assert.ok(Number.isFinite(Date.parse(result.piSpawnStartedAt)), "piSpawnStartedAt is an ISO timestamp");
      assert.ok(result.durationMs > 0);
      assert.deepEqual(result.failures, []);

      // Proxy stats persisted without bodies or key material.
      const proxy = readJson(join(attemptDir, "proxy.json"));
      assert.equal(proxy.requests.length, 1);
      assert.equal(proxy.requests[0].status, 200);
      assert.equal(typeof proxy.requests[0].durationMs, "number");
      assert.ok(proxy.requests[0].bytesIn > 0);
      assert.ok(proxy.requests[0].bytesOut > 0);
      assert.deepEqual(proxy.rejected, []);
      const proxyFlat = JSON.stringify(proxy);
      assert.ok(!proxyFlat.includes("STREAM-CHUNK-MARKER"), "proxy telemetry must not store bodies");
      assert.ok(!proxyFlat.includes(SENTINEL_KEY), "proxy telemetry must not store the key");

      // Pinned metadata matches the planner pins.
      const pinned = readJson(join(attemptDir, "pinned.json"));
      const { buildAttemptPrompt } = await import(join(repoRoot, "evaluation", "runner", "real-attempt.mjs"));
      assert.equal(pinned.promptSha256, sha256(buildAttemptPrompt(TASK.prompt)), "the pin covers the combined prompt");
      assert.equal(pinned.armCommit, UPSTREAM_ARM.commit);
      assert.equal(pinned.piVersion, manifest.evaluation.piVersion);

      // The credential-bearing models.json is deleted; home state remains.
      assert.equal(existsSync(join(attemptDir, "agent", "models.json")), false, "models.json must be removed after the run");
      assert.equal(readJson(join(attemptDir, "home", ".config", "condensed-milk.json")).profile, "qwen-vllm");

      // Final git state collected.
      const finalState = readJson(join(attemptDir, "final-state.json"));
      assert.equal(finalState.status, "collected");
      assert.ok(existsSync(join(attemptDir, "final-state", "porcelain-v2.txt")));
      const porcelain = readFileSync(join(attemptDir, "final-state", "porcelain-v2.txt"), "utf8");
      assert.ok(porcelain.includes("stats.py"), "agent work must be visible to collection");
      assert.ok(!porcelain.includes("implementation"), "scaffolding stays invisible to git");

      // One invocation marker line.
      const invocations = readFileSync(join(attemptDir, "invocations.jsonl"), "utf8").trim().split("\n");
      assert.equal(invocations.length, 1);

      // The sentinel key appears nowhere under the attempt directory.
      for (const file of collectFiles(attemptDir)) {
        assert.ok(!file.body.includes(SENTINEL_KEY), `sentinel key leaked into ${file.path}`);
      }
      const recordedEnv = readJson(join(attemptDir, "sessions", "record-env.json")).env;
      const envKeys = Object.keys(recordedEnv).filter((key) => key !== "__CF_USER_TEXT_ENCODING");
      assert.deepEqual(
        envKeys.sort(),
        ["HOME", "PATH", "PI_CODING_AGENT_DIR", "TMPDIR"],
        "the child saw exactly the allowlisted environment",
      );
      const recordedArgv = readJson(join(attemptDir, "sessions", "record-argv.json")).argv;
      assert.ok(!recordedArgv.join(" ").includes(repoRoot), "argv must not reveal the evaluator repository path");
      assert.equal(recordedArgv[recordedArgv.length - 1], buildAttemptPrompt(TASK.prompt), "the combined prompt is the final argv entry");
    } finally {
      await upstream.close();
      spawnSync("git", ["-C", repoRoot, "worktree", "prune"]);
      rmSync(work, { recursive: true, force: true });
    }
  });
});
