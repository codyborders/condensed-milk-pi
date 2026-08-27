/**
 * Real provider runner tests (public boundary: evaluation/runner/cli.mjs).
 *
 * Everything here is fake-only: a loopback fake z.ai upstream HTTP server,
 * a fake Pi runtime (node cli.js shape), fixture git worktrees, and a
 * sentinel credential. No request ever leaves the loopback interface and
 * the real provider is never contacted.
 */

import { test, describe, before } from "node:test";
import assert from "node:assert/strict";
import { fileURLToPath } from "node:url";
import { dirname, join } from "node:path";
import {
  existsSync,
  mkdirSync,
  mkdtempSync,
  readdirSync,
  readFileSync,
  rmSync,
  statSync,
  writeFileSync,
} from "node:fs";
import { tmpdir, homedir } from "node:os";
import { spawn, spawnSync } from "node:child_process";
import { createHash } from "node:crypto";
import http from "node:http";
import { loadManifestFile } from "../lib/manifest.mjs";
import { loadTaskData } from "../lib/manifest.mjs";

const repoRoot = join(dirname(fileURLToPath(import.meta.url)), "..", "..");
const cli = join(repoRoot, "evaluation", "runner", "cli.mjs");
const manifest = loadManifestFile(join(repoRoot, "evaluation", "task-manifest.json"));
const UPSTREAM_COMMITS = Object.fromEntries(manifest.evaluation.arms.map((arm) => [arm.name, arm.commit]));
const SENTINEL_KEY = "sentinel-zai-key-do-not-leak-0123456789abcdef";

function sha256(text) {
  return createHash("sha256").update(text).digest("hex");
}

function runCli(args, extra = {}) {
  return spawnSync(process.execPath, [cli, ...args], {
    cwd: repoRoot,
    encoding: "utf8",
    ...extra,
  });
}

/**
 * Async CLI run: the event loop stays alive so the loopback fake
 * upstream can serve the runner's credential proxy while the CLI
 * process is still running (spawnSync would deadlock them).
 */
function runCliAsync(args, extra = {}) {
  return new Promise((resolve) => {
    const child = spawn(process.execPath, [cli, ...args], { cwd: repoRoot, ...extra });
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
}

function taskById(taskId) {
  return manifest.tasks.find((task) => task.id === taskId);
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

/** Loopback fake z.ai upstream: asserts real-key auth, streams SSE. */
function startFakeUpstream({ chunks = 3, chunkDelayMs = 20 } = {}) {
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
      res.writeHead(200, { "content-type": "text/event-stream" });
      let index = 0;
      const writeNext = () => {
        if (index >= chunks) {
          res.end();
          return;
        }
        index += 1;
        res.write(`event: stream-chunk-${index}\ndata: {"index":${index},"marker":"STREAM-CHUNK-MARKER-${index}"}\n\n`);
        setTimeout(writeNext, chunkDelayMs);
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

function writeCredentialSource(path, { apiKey = SENTINEL_KEY, baseUrl }) {
  mkdirSync(dirname(path), { recursive: true });
  writeFileSync(
    path,
    `${JSON.stringify({
      providers: {
        "z-ai": {
          api: "anthropic-messages",
          apiKey,
          baseUrl,
          displayName: "z.ai fixture",
          models: [{ id: "glm-5.1" }, { id: "glm-5.3" }],
        },
        "unrelated-provider": { api: "openai-completions", apiKey: "other-key", baseUrl: "http://127.0.0.1:9/v1" },
      },
    }, null, 2)}\n`,
    "utf8",
  );
}

const FAKE_PI_SOURCE = String.raw`
import { readFileSync, writeFileSync, mkdirSync } from "node:fs";
import { createRequire } from "node:module";
import { join, dirname } from "node:path";
import { fileURLToPath } from "node:url";
import http from "node:http";

const here = dirname(fileURLToPath(import.meta.url));
const { behavior } = JSON.parse(readFileSync(join(here, "..", "behavior.json"), "utf8"));
const solution = JSON.parse(readFileSync(join(here, "..", "solution.json"), "utf8"));
const argv = process.argv.slice(2);
const sessionDir = argv[argv.indexOf("--session-dir") + 1];
const prompt = argv[argv.length - 1];
mkdirSync(sessionDir, { recursive: true });
writeFileSync(join(sessionDir, "record-argv.json"), JSON.stringify({ argv: process.argv, cwd: process.cwd() }, null, 2));
writeFileSync(join(sessionDir, "record-env.json"), JSON.stringify({ env: process.env }, null, 2));
writeFileSync(join(sessionDir, "record-pid.json"), JSON.stringify({ pid: process.pid }, null, 2));

const models = JSON.parse(readFileSync(join(process.env.PI_CODING_AGENT_DIR, "models.json"), "utf8"));
const provider = models.providers["z-ai-eval"];
const startedAt = Date.now();

function applySolution() {
  const require = createRequire(import.meta.url);
  const { mkdirSync: mkdir, writeFileSync: write } = require("node:fs");
  const { join: j, dirname: d } = require("node:path");
  for (const file of solution.files) {
    const target = j(process.cwd(), file.path);
    mkdir(d(target), { recursive: true });
    write(target, file.content);
  }
}

function emit(line) {
  process.stdout.write(JSON.stringify(line) + "\n");
}

const body = JSON.stringify({
  model: provider.models[0].id,
  stream: true,
  max_tokens: 64,
  messages: [{ role: "user", content: prompt }],
});
const url = new URL(provider.baseUrl + "/v1/messages");

function requestUpstream() {
  return new Promise((resolve, reject) => {
    const req = http.request(url, {
      method: "POST",
      headers: {
        "content-type": "application/json",
        "x-api-key": provider.apiKey,
        "anthropic-version": "2023-06-01",
        accept: "text/event-stream",
      },
    }, (res) => {
      let bytes = 0;
      res.on("data", (chunk) => {
        bytes += chunk.length;
      });
      res.on("end", () => resolve({ status: res.statusCode, bytes }));
    });
    req.on("error", reject);
    req.end(body);
  });
}

if (behavior === "hang") {
  emit({ type: "agent_start" });
  process.on("SIGTERM", () => {});
  const child = await import("node:child_process").then((cp) =>
    cp.spawn(process.execPath, ["-e", "process.on('SIGTERM',()=>{}); setInterval(() => {}, 1000)"], { stdio: "ignore" }),
  );
  writeFileSync(join(sessionDir, "record-tree.json"), JSON.stringify({ pid: process.pid, childPid: child.pid }, null, 2));
  setInterval(() => {}, 1000);
} else {
  const upstream = await requestUpstream();
  if (behavior === "nonzero") {
    emit({ type: "agent_start" });
    applySolution();
    process.exit(3);
  }
  const message = {
    role: "assistant",
    content: [{ type: "text", text: "done" }],
    api: "anthropic-messages",
    provider: "z-ai-eval",
    model: provider.models[0].id,
    usage: { input: 1100, output: 260, cacheWrite: 40 },
    stopReason: "end_turn",
    timestamp: Date.now(),
  };
  emit({ type: "session", version: 3, id: "fake-session", timestamp: new Date(startedAt).toISOString(), cwd: process.cwd() });
  emit({ type: "agent_start" });
  emit({ type: "turn_start" });
  emit({ type: "message_end", message });
  emit({ type: "agent_end", messages: [message] });
  applySolution();
  if (behavior === "linger") {
    await new Promise((resolve) => setTimeout(resolve, 1500));
  }
  await new Promise((resolve) => setTimeout(resolve, 120));
  process.exit(0);
}
`;

/** Fake Pi 0.84.2 runtime: speaks the CLI contract the runner relies on. */
function makeFakePiRuntime(cacheDir, { behavior = "ok", solution } = {}) {
  const runtimeDir = join(cacheDir, "fake-pi-runtime");
  mkdirSync(join(runtimeDir, "dist"), { recursive: true });
  writeFileSync(
    join(runtimeDir, "package.json"),
    `${JSON.stringify({ name: "fake-pi-runtime", version: "0.84.2", type: "module", bin: { pi: "dist/cli.js" }, engines: { node: ">=22.19.0" } }, null, 2)}\n`,
    "utf8",
  );
  writeFileSync(join(runtimeDir, "behavior.json"), `${JSON.stringify({ behavior })}\n`, "utf8");
  writeFileSync(join(runtimeDir, "solution.json"), `${JSON.stringify(solution)}\n`, "utf8");
  writeFileSync(join(runtimeDir, "dist", "cli.js"), FAKE_PI_SOURCE, "utf8");
  return runtimeDir;
}

before(() => {
  assert.equal(manifest.tasks.length > 0, true, "manifest must be loaded");
});

describe("real runner CLI gate", () => {
  test("run without --confirm-paid refuses before any reservation", () => {
    const runsDir = mkdtempSync(join(tmpdir(), "cm-real-gate-"));
    const runId = "real-gate-01";
    try {
      assert.equal(runCli(["prepare", "--runs-dir", runsDir, "--run-id", runId, "--mode", "real"]).status, 0);
      const denied = runCli([
        "run", "--runs-dir", runsDir, "--run-id", runId, "--task", "task-01",
      ]);
      assert.notEqual(denied.status, 0, "run must refuse without --confirm-paid");
      assert.match(denied.stderr, /confirm-paid/, `stderr must name the gate: ${denied.stderr.slice(0, 300)}`);
      assert.equal(
        existsSync(join(runsDir, runId, "attempts")),
        false,
        "refusal must happen before any attempt directory exists",
      );
    } finally {
      rmSync(runsDir, { recursive: true, force: true });
    }
  });
});

describe("real runner attempt execution", () => {
  test("one arm executes through the loopback proxy without leaking the credential", async () => {
    const work = mkdtempSync(join(tmpdir(), "cm-real-one-"));
    const runsDir = join(work, "runs");
    const cacheDir = join(work, "cache");
    const runId = "real-one-01";
    const upstream = await startFakeUpstream();
    try {
      const credentialSource = join(work, "models.json");
      writeCredentialSource(credentialSource, { baseUrl: `http://127.0.0.1:${upstream.port}` });
      const solution = loadTaskData(repoRoot, "task-01").solution;
      const piRuntime = makeFakePiRuntime(cacheDir, { behavior: "ok", solution });
      assert.equal(runCli(["prepare", "--runs-dir", runsDir, "--run-id", runId, "--mode", "real"]).status, 0);

      const runResult = await runCliAsync([
        "run", "--runs-dir", runsDir, "--run-id", runId, "--task", "task-01", "--arm", "upstream",
        "--confirm-paid", "--credential-source", credentialSource,
        "--cache-dir", cacheDir, "--pi-runtime", piRuntime, "--timeout-ms", "60000",
      ], { timeout: 170_000 });
      assert.equal(runResult.status, 0, `run failed: ${runResult.stderr.slice(0, 800)}`);

      const attemptDir = join(runsDir, runId, "attempts", "task-01", "upstream", "attempt-001");
      const result = readJson(join(attemptDir, "result.json"));
      assert.equal(
        result.status,
        "completed",
        `attempt result: ${JSON.stringify(result.failures)}; stderr=${readFileSync(join(attemptDir, "pi-stderr.txt"), "utf8").slice(0, 400)}; stdoutHead=${readFileSync(join(attemptDir, "pi-stdout.jsonl"), "utf8").slice(0, 300)}`,
      );
      assert.equal(result.scorer.status, "passed", "fake Pi applies the hidden reference solution");
      assert.equal(readFileSync(join(attemptDir, "invocations.jsonl"), "utf8").trim().split("\n").length, 1);

      // The arm commit was materialized into the task worktree.
      const worktree = join(attemptDir, "worktree");
      assert.ok(existsSync(join(worktree, "implementation", "index.ts")), "arm implementation must exist");
      assert.equal(
        readFileSync(join(worktree, "implementation", "index.ts"), "utf8"),
        spawnSync("git", ["-C", repoRoot, "show", `${UPSTREAM_COMMITS.upstream}:index.ts`], { encoding: "utf8" }).stdout,
        "implementation/index.ts must match the pinned upstream commit",
      );

      // The proxy reached the fake upstream with the real key, never the dummy.
      assert.equal(upstream.seen.length, 1, `expected exactly one upstream request, got ${upstream.seen.length}`);
      const seen = upstream.seen[0];
      assert.equal(seen.method, "POST");
      assert.equal(seen.url, "/v1/messages");
      assert.equal(seen.headers["x-api-key"], SENTINEL_KEY, "proxy must replace dummy auth with the real key");
      assert.equal(seen.body.model, "glm-5.3-flash");
      assert.equal(seen.body.stream, true);
      assert.match(seen.body.messages[0].content, /median\(\[3, 1, 2\]\)/, "request body must carry the task prompt");

      // Proxy telemetry: status, duration, and byte counts only.
      const proxy = readJson(join(attemptDir, "proxy.json"));
      assert.equal(proxy.requests.length, 1);
      assert.equal(proxy.requests[0].status, 200);
      assert.equal(typeof proxy.requests[0].durationMs, "number");
      assert.ok(proxy.requests[0].bytesIn > 0);
      assert.ok(proxy.requests[0].bytesOut > 0);
      assert.deepEqual(proxy.rejected, []);
      assert.ok(!JSON.stringify(proxy).includes("STREAM-CHUNK-MARKER"), "proxy telemetry must not store bodies");

      // Usage aggregation and latency, nulls stay null.
      assert.equal(result.usage.input, 1100);
      assert.equal(result.usage.output, 260);
      assert.equal(result.usage.cacheRead, null);
      assert.equal(typeof result.firstEventLatencyMs, "number");
      assert.ok(typeof result.piSpawnStartedAt === "string", "the spawn instant is persisted in result.json");
      assert.ok(Number.isFinite(Date.parse(result.piSpawnStartedAt)), "piSpawnStartedAt is an ISO timestamp");
      assert.ok(result.durationMs > 0);

      // Receipt precedes spawn and names commit and model without secrets.
      const receipt = readJson(join(attemptDir, "provider-invocation.json"));
      assert.equal(receipt.fake, false);
      assert.equal(receipt.armCommit, UPSTREAM_COMMITS.upstream);
      assert.equal(receipt.model, "glm-5.3-flash");

      // The isolated models.json is gone; nonsecret home state remains.
      assert.equal(existsSync(join(attemptDir, "agent", "models.json")), false, "credential-bearing models.json must be removed");
      assert.ok(existsSync(join(attemptDir, "home", ".config", "condensed-milk.json")), "nonsecret home state must remain");
      assert.equal(readJson(join(attemptDir, "home", ".config", "condensed-milk.json")).profile, "qwen-vllm");

      // The sentinel key appears nowhere on disk, in argv, or in the child env.
      const records = collectFiles(attemptDir);
      for (const file of records) {
        assert.ok(!file.body.includes(SENTINEL_KEY), `sentinel key leaked into ${file.path}`);
      }
      const recordedEnv = readJson(join(attemptDir, "sessions", "record-env.json")).env;
      assert.ok(!JSON.stringify(recordedEnv).includes(SENTINEL_KEY), "sentinel must never enter the child environment");
      const recordedArgv = readJson(join(attemptDir, "sessions", "record-argv.json")).argv;
      assert.ok(!recordedArgv.join(" ").includes(SENTINEL_KEY));
      assert.ok(!recordedArgv.join(" ").includes(repoRoot), "argv must not reveal the evaluator repository path");
    } finally {
      await upstream.close();
      spawnSync("git", ["-C", repoRoot, "worktree", "prune"]);
      rmSync(work, { recursive: true, force: true });
    }
  });
});
