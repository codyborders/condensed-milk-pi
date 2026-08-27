/**
 * Real multi-task orchestration tests (public boundary:
 * evaluation/runner/cli.mjs run -> real.mjs).
 *
 * Everything here is fake-only and offline: a loopback fake z.ai
 * upstream, a scenario-driven fake Pi runtime, fixture git worktrees,
 * and a sentinel credential. No request ever leaves the loopback
 * interface and the real provider is never contacted.
 *
 * Contract under test (grown one slice at a time):
 * - run --all --confirm-paid executes every pending task pair
 *   sequentially; repeated --task flags select several tasks in
 *   manifest order; --task and --all are mutually exclusive.
 * - --arm is allowed only with exactly one --task (canary diagnosis).
 * - Before the first reservation the runner validates credential
 *   source, timeout, Pi runtime, both exact arm roots, every selected
 *   task, prompt hashes, fixture postconditions, and equal
 *   fixture-before hashes. A validation failure reserves nothing.
 * - --plan-only validates and prints the plan (ordered tasks/arms,
 *   commits, prompt hashes, fixture hashes, model, profile, Pi
 *   version) without --confirm-paid and without creating attempts.
 * - Execution continues after task failure but stops on
 *   infrastructure failure, credential proxy failure, reservation
 *   refusal, or collection error. Arms never run concurrently.
 * - A completed or reserved slot is skipped without respawn.
 * - Progress streams to stderr, final JSON to stdout, and the final
 *   exit is nonzero when infrastructure failed. Task scorer failure
 *   alone never fails the runner.
 */

import { test, describe } from "node:test";
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
import { tmpdir } from "node:os";
import { spawn, spawnSync } from "node:child_process";
import http from "node:http";
import { loadManifestFile } from "../lib/manifest.mjs";

const repoRoot = join(dirname(fileURLToPath(import.meta.url)), "..", "..");
const cli = join(repoRoot, "evaluation", "runner", "cli.mjs");
const manifest = loadManifestFile(join(repoRoot, "evaluation", "task-manifest.json"));
const SENTINEL_KEY = "sentinel-zai-key-do-not-leak-0123456789abcdef";
export { SENTINEL_KEY };

function runCli(args, extra = {}) {
  return spawnSync(process.execPath, [cli, ...args], {
    cwd: repoRoot,
    encoding: "utf8",
    timeout: 240_000,
    ...extra,
  });
}

/**
 * Async CLI run: the event loop stays alive so the loopback fake
 * upstream can serve the runner's credential proxy while the CLI
 * process is still running (spawnSync would deadlock them).
 */
export function runCliAsync(args, extra = {}) {
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

export function readJson(path) {
  return JSON.parse(readFileSync(path, "utf8"));
}

export function journalEvents(runDir) {
  return readFileSync(join(runDir, "journal.jsonl"), "utf8")
    .split("\n")
    .filter((line) => line.trim().length > 0)
    .map((line) => JSON.parse(line));
}

export function collectFiles(directory) {
  const out = [];
  for (const name of readdirSync(directory)) {
    const path = join(directory, name);
    if (statSync(path).isDirectory()) out.push(...collectFiles(path));
    else out.push({ path, body: readFileSync(path, "utf8") });
  }
  return out;
}

/** Loopback fake z.ai upstream: asserts real-key auth, streams SSE. */
function startFakeUpstream() {
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
        if (index >= 3) {
          res.end();
          return;
        }
        index += 1;
        res.write(`event: stream-chunk-${index}\ndata: {"index":${index}}\n\n`);
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

/**
 * Scenario-driven fake Pi 0.84.2 runtime: each scenario matches a
 * substring of the attempt prompt and carries a behavior plus the
 * hidden reference solution. Behaviors: ok (complete), nonzero (task
 * failure), corrupt-git (delete the worktree .git/HEAD after the
 * events so final collection fails).
 */
const FAKE_PI_SCENARIO_SOURCE = String.raw`
import { readFileSync, writeFileSync, mkdirSync, rmSync } from "node:fs";
import { join, dirname } from "node:path";
import { fileURLToPath } from "node:url";
import http from "node:http";

const here = dirname(fileURLToPath(import.meta.url));
const config = JSON.parse(readFileSync(join(here, "..", "scenarios.json"), "utf8"));
const argv = process.argv.slice(2);
const sessionDir = argv[argv.indexOf("--session-dir") + 1];
const prompt = argv[argv.length - 1];
mkdirSync(sessionDir, { recursive: true });
writeFileSync(join(sessionDir, "record-argv.json"), JSON.stringify({ argv: process.argv, cwd: process.cwd() }, null, 2));
writeFileSync(join(sessionDir, "record-env.json"), JSON.stringify({ env: process.env }, null, 2));

const scenario = config.scenarios.find((entry) => prompt.includes(entry.match))
  ?? { behavior: "ok", solution: { files: [], commands: [] } };
const models = JSON.parse(readFileSync(join(process.env.PI_CODING_AGENT_DIR, "models.json"), "utf8"));
const provider = models.providers["z-ai-eval"];
const startedAt = Date.now();

function applySolution() {
  for (const file of scenario.solution.files) {
    const target = join(process.cwd(), file.path);
    mkdirSync(dirname(target), { recursive: true });
    writeFileSync(target, file.content);
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

const upstream = await new Promise((resolve, reject) => {
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

if (scenario.behavior === "nonzero") {
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
if (scenario.behavior === "corrupt-git") {
  rmSync(join(process.cwd(), ".git", "HEAD"), { force: true });
}
await new Promise((resolve) => setTimeout(resolve, 120));
process.exit(0);
`;

/** Fake Pi 0.84.2 runtime driven by per-task scenarios. */
export function makeScenarioPiRuntime(cacheDir, scenarios) {
  const runtimeDir = join(cacheDir, "fake-pi-runtime");
  mkdirSync(join(runtimeDir, "dist"), { recursive: true });
  writeFileSync(
    join(runtimeDir, "package.json"),
    `${JSON.stringify({ name: "fake-pi-runtime", version: "0.84.2", type: "module", bin: { pi: "dist/cli.js" }, engines: { node: ">=22.19.0" } }, null, 2)}\n`,
    "utf8",
  );
  writeFileSync(join(runtimeDir, "scenarios.json"), `${JSON.stringify({ scenarios })}\n`, "utf8");
  writeFileSync(join(runtimeDir, "dist", "cli.js"), FAKE_PI_SCENARIO_SOURCE, "utf8");
  return runtimeDir;
}

/** One scenario per task, keyed by a distinctive prompt substring. */
function scenarioForTask(taskId, behavior = "ok") {
  const task = manifest.tasks.find((entry) => entry.id === taskId);
  const solution = JSON.parse(
    readFileSync(join(repoRoot, "evaluation", "scorers", "solutions", `${taskId}.json`), "utf8"),
  );
  return { match: task.prompt.slice(0, 60), behavior, solution };
}

export function prepareRealRun(runsDir, runId) {
  const prepared = runCli(["prepare", "--runs-dir", runsDir, "--run-id", runId, "--mode", "real"]);
  assert.equal(prepared.status, 0, `prepare failed: ${prepared.stderr}`);
}

/** A ready-to-use fake environment: upstream, credential, Pi runtime. */
export async function withFakeEnvironment(prefix, taskIds, fn) {
  const work = mkdtempSync(join(tmpdir(), prefix));
  const runsDir = join(work, "runs");
  const cacheDir = join(work, "cache");
  const upstream = await startFakeUpstream();
  try {
    const credentialSource = join(work, "models.json");
    writeCredentialSource(credentialSource, { baseUrl: `http://127.0.0.1:${upstream.port}` });
    const piRuntime = makeScenarioPiRuntime(cacheDir, taskIds.map((taskId) => scenarioForTask(taskId)));
    return await fn({ work, runsDir, cacheDir, upstream, credentialSource, piRuntime });
  } finally {
    await upstream.close();
    spawnSync("git", ["-C", repoRoot, "worktree", "prune"]);
    rmSync(work, { recursive: true, force: true });
  }
}

describe("real multi-task selection flags", () => {
  test("--task together with --all must refuse before any reservation", async () => {
    await withFakeEnvironment("cm-multi-excl-", ["task-01"], async ({ runsDir, cacheDir, credentialSource, piRuntime }) => {
      const runId = "multi-excl-01";
      prepareRealRun(runsDir, runId);
      const runResult = await runCliAsync([
        "run", "--runs-dir", runsDir, "--run-id", runId,
        "--task", "task-01", "--all",
        "--confirm-paid", "--credential-source", credentialSource,
        "--cache-dir", cacheDir, "--pi-runtime", piRuntime, "--timeout-ms", "60000",
      ], { timeout: 240_000 });
      assert.notEqual(runResult.status, 0, "--task with --all must refuse");
      assert.match(runResult.stderr, /mutually exclusive/, `refusal must name the rule: ${runResult.stderr.slice(0, 300)}`);
      assert.equal(existsSync(join(runsDir, runId, "attempts")), false, "the refusal must reserve nothing");
    });
  });

  test("--arm with several selected tasks must refuse before any reservation", async () => {
    await withFakeEnvironment("cm-multi-arm-", ["task-01", "task-02"], async ({ runsDir, cacheDir, credentialSource, piRuntime }) => {
      const runId = "multi-arm-01";
      prepareRealRun(runsDir, runId);
      const runResult = await runCliAsync([
        "run", "--runs-dir", runsDir, "--run-id", runId,
        "--task", "task-01", "--task", "task-02", "--arm", "fork",
        "--confirm-paid", "--credential-source", credentialSource,
        "--cache-dir", cacheDir, "--pi-runtime", piRuntime, "--timeout-ms", "60000",
      ], { timeout: 240_000 });
      assert.notEqual(runResult.status, 0, "--arm with several tasks must refuse");
      assert.match(
        runResult.stderr,
        /--arm is allowed only with exactly one --task/,
        `refusal must name the rule: ${runResult.stderr.slice(0, 300)}`,
      );
      assert.equal(existsSync(join(runsDir, runId, "attempts")), false, "the refusal must reserve nothing");
    });
  });
});
