/**
 * Runtime pin resume tests
 * (boundary: evaluation/runner/real.mjs run + persistRuntimePin).
 *
 * Public seam: the `run` CLI. The first pre-reservation call stores the
 * runtime manifest in run.json. A resumed invocation with mutated
 * runtime bytes must refuse before reservation, keep run.json bytes,
 * and never contact the provider again.
 */

import { test, describe } from "node:test";
import assert from "node:assert/strict";
import { fileURLToPath } from "node:url";
import { dirname, join } from "node:path";
import { appendFileSync, mkdirSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { spawnSync } from "node:child_process";
import http from "node:http";
import { spawn } from "node:child_process";
import { loadManifestFile, loadTaskData } from "../lib/manifest.mjs";

const repoRoot = join(dirname(fileURLToPath(import.meta.url)), "..", "..");
const manifest = loadManifestFile(join(repoRoot, "evaluation", "task-manifest.json"));

/**
 * Asynchronous CLI runner: spawnSync would block this process's event
 * loop, so the in-process fake upstream could never answer the child
 * and seen.length stayed zero. This helper keeps the loop free, drains
 * both output streams, and resolves with the exit status.
 */
function runCli(args, { timeoutMs = 240_000 } = {}) {
  return new Promise((resolve, reject) => {
    const child = spawn(process.execPath, [join(repoRoot, "evaluation", "runner", "cli.mjs"), ...args], {
      stdio: ["ignore", "pipe", "pipe"],
    });
    let stdout = "";
    let stderr = "";
    let settled = false;
    const timer = setTimeout(() => {
      child.kill("SIGKILL");
    }, timeoutMs);
    child.stdout.on("data", (chunk) => {
      stdout += chunk;
    });
    child.stderr.on("data", (chunk) => {
      stderr += chunk;
    });
    child.on("error", (error) => {
      if (settled) return;
      settled = true;
      clearTimeout(timer);
      reject(error);
    });
    child.on("close", (code) => {
      if (settled) return;
      settled = true;
      clearTimeout(timer);
      resolve({ status: code, stdout, stderr });
    });
  });
}

function startFakeUpstream(seen) {
  const server = http.createServer((req, res) => {
    seen.push(req.url);
    res.writeHead(200, { "content-type": "text/event-stream" });
    res.end("event: done\ndata: {}\n\n");
  });
  return new Promise((resolve) => {
    server.listen(0, "127.0.0.1", () => {
      resolve({ port: server.address().port, close: () => new Promise((done) => server.close(() => done())) });
    });
  });
}

const FAKE_PI = [
  'import { readFileSync, writeFileSync, mkdirSync } from "node:fs";',
  'import { join, dirname } from "node:path";',
  'import { fileURLToPath } from "node:url";',
  'import http from "node:http";',
  'const here = dirname(fileURLToPath(import.meta.url));',
  'const solution = JSON.parse(readFileSync(join(here, "..", "solution.json"), "utf8"));',
  'const argv = process.argv.slice(2);',
  'const sessionDir = argv[argv.indexOf("--session-dir") + 1];',
  'const prompt = argv[argv.length - 1];',
  'mkdirSync(sessionDir, { recursive: true });',
  'const models = JSON.parse(readFileSync(join(process.env.PI_CODING_AGENT_DIR, "models.json"), "utf8"));',
  'const provider = models.providers["z-ai-eval"];',
  'const emit = (line) => process.stdout.write(JSON.stringify(line) + "\\n");',
  'const applySolution = () => {',
  '  for (const file of solution.files) {',
  '    const target = join(process.cwd(), file.path);',
  '    mkdirSync(dirname(target), { recursive: true });',
  '    writeFileSync(target, file.content);',
  '  }',
  '};',
  'const upstream = await new Promise((resolve, reject) => {',
  '  const body = JSON.stringify({ model: provider.models[0].id, stream: true, max_tokens: 64, messages: [{ role: "user", content: prompt }] });',
  '  const req = http.request(new URL(provider.baseUrl + "/v1/messages"), { method: "POST", headers: { "content-type": "application/json", "x-api-key": provider.apiKey, accept: "text/event-stream" } }, (res) => {',
  '    let bytes = 0;',
  '    res.on("data", (chunk) => { bytes += chunk.length; });',
  '    res.on("end", () => resolve({ status: res.statusCode, bytes }));',
  '  });',
  '  req.on("error", reject);',
  '  req.end(body);',
  '});',
  'if (upstream.status !== 200) { process.stderr.write("upstream rejected with " + upstream.status + "\\n"); process.exit(4); }',
  'const first = { role: "assistant", content: [{ type: "text", text: "turn one" }], usage: { input: 1100, output: 260, cacheWrite: 40 } };',
  'emit({ type: "session", version: 3, id: "fake-session", timestamp: new Date().toISOString(), cwd: process.cwd() });',
  'emit({ type: "agent_start" });',
  'emit({ type: "message_end", message: first });',
  'emit({ type: "agent_end", messages: [first] });',
  'applySolution();',
  'process.exit(0);',
  "",
].join("\n");

describe("runtime pin resume", () => {
  test("identical resume is accepted and a changed runtime digest refuses before reservation", { timeout: 300_000 }, async () => {
    const work = mkdtempSync(join(tmpdir(), "cm-runtime-resume-"));
    const seen = [];
    const upstream = await startFakeUpstream(seen);
    try {
      const runsDir = join(work, "runs");
      const cacheDir = join(work, "cache");
      const runId = "pin-resume-01";
      const credentialSource = join(work, "models.json");
      mkdirSync(dirname(credentialSource), { recursive: true });
      writeFileSync(
        credentialSource,
        `${JSON.stringify({ providers: { "z-ai": { api: "anthropic-messages", apiKey: "sentinel", baseUrl: `http://127.0.0.1:${upstream.port}`, models: [{ id: "glm-5.3" }] } } }, null, 2)}\n`,
        "utf8",
      );
      const runtimeDir = join(cacheDir, "fake-pi-runtime");
      mkdirSync(join(runtimeDir, "dist"), { recursive: true });
      writeFileSync(join(runtimeDir, "package.json"), `${JSON.stringify({ name: "fake", version: "0.84.2", type: "module", engines: { node: ">=22.19.0" } })}\n`, "utf8");
      writeFileSync(join(runtimeDir, "behavior.json"), `${JSON.stringify({ behavior: "ok" })}\n`, "utf8");
      const { solution } = loadTaskData(repoRoot, "task-01");
      writeFileSync(join(runtimeDir, "solution.json"), `${JSON.stringify(solution)}\n`, "utf8");
      writeFileSync(join(runtimeDir, "dist", "cli.js"), FAKE_PI, "utf8");

      const runArgs = [
        "run", "--runs-dir", runsDir, "--run-id", runId, "--task", "task-01", "--arm", "upstream",
        "--confirm-paid", "--credential-source", credentialSource, "--cache-dir", cacheDir,
        "--pi-runtime", runtimeDir, "--timeout-ms", "60000",
      ];
      const prepare = await runCli(["prepare", "--runs-dir", runsDir, "--run-id", runId, "--mode", "real"]);
      assert.equal(prepare.status, 0, `prepare failed: ${prepare.stderr.slice(0, 400)}`);
      const first = await runCli(runArgs);
      assert.equal(first.status, 0, `first run failed: ${first.stderr.slice(0, 400)}`);

      const runJsonPath = join(runsDir, runId, "run.json");
      const stored = JSON.parse(readFileSync(runJsonPath, "utf8"));
      assert.ok(stored.piRuntime && stored.piRuntime.schemaVersion === 1, "run.json stores the runtime manifest");
      assert.match(stored.piRuntime.digest, /^[0-9a-f]{64}$/);
      const bytesAfterFirst = readFileSync(runJsonPath);

      const identical = await runCli(runArgs);
      assert.equal(identical.status, 0, `identical resume must be accepted: ${identical.stderr.slice(0, 400)}`);
      assert.deepEqual(readFileSync(runJsonPath), bytesAfterFirst, "an identical resume keeps run.json bytes");
      assert.equal(seen.length, 1, "no new provider call on identical resume");

      appendFileSync(join(runtimeDir, "dist", "cli.js"), "// tampered\n", "utf8");
      const refused = await runCli(runArgs);
      assert.notEqual(refused.status, 0, "a changed runtime digest must refuse");
      assert.match(refused.stderr, /refus/i, `refusal must be explained: ${refused.stderr.slice(0, 300)}`);
      assert.deepEqual(readFileSync(runJsonPath), bytesAfterFirst, "the refused resume preserves run.json bytes");
      assert.equal(seen.length, 1, "the refusal spends no provider call");
    } finally {
      await upstream.close();
      spawnSync("git", ["-C", repoRoot, "worktree", "prune"]);
      rmSync(work, { recursive: true, force: true });
    }
  });
});
