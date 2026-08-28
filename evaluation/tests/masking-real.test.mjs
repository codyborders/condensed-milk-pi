/**
 * Masking real-run end-to-end tests with a fake provider and a fake Pi
 * runtime. No external provider is contacted: the credential source
 * points at a local loopback fake and the Pi runtime is a local fake
 * that loads the real generated observer extensions.
 */

import { test, describe } from "node:test";
import assert from "node:assert/strict";
import { mkdtempSync, mkdirSync, rmSync, writeFileSync, readFileSync, readdirSync, existsSync } from "node:fs";
import { tmpdir } from "node:os";
import { join, dirname } from "node:path";
import { fileURLToPath } from "node:url";
import { maskingPrepare, maskingRealRun, maskingReport } from "../runner/masking.mjs";
import { startFakeUpstream, writeCredentialSource } from "./real-attempt-fakes.mjs";

const repoRoot = join(dirname(fileURLToPath(import.meta.url)), "..", "..");

const ANSWERS = {
  "RUNS.md": "pytest: 40 passed\npytest: 40 passed\npytest: 40 passed\n",
  "BUILDS.md": "build check: 6 modules ok\nbuild check: 6 modules ok\nbuild check: 6 modules ok\n",
  "GITNOTES.md": "subject: chore: third import\ncommits: 3\ndirty: yes\n",
  "ERRORS.md": "E101: 4\nE202: 3\nE303: 4\nE404: 4\n",
  "SUMMARY.md": "fold_records: src/alpha.py\nmerge_streams: src/beta.py\nscan_edges: src/gamma.py\n",
  "FATAL.md": "2026-01-01T00:09:00Z\nwrite-ahead log corrupt beyond sector 118\n",
  "FAILURE.md": "step 37\nwidget queue overflow\n",
  "ROOTCAUSE.md": "E-7721\ncache eviction raced with write\n",
};

const FAKE_PI = `
import { readFileSync, writeFileSync, mkdirSync } from "node:fs";
import { join, dirname } from "node:path";
const argv = process.argv.slice(2);
const sessionDir = argv[argv.indexOf("--session-dir") + 1];
mkdirSync(sessionDir, { recursive: true });
writeFileSync(join(sessionDir, "record-argv.json"), JSON.stringify({ argv: process.argv, cwd: process.cwd() }, null, 2));
writeFileSync(join(sessionDir, "record-env.json"), JSON.stringify({ env: process.env }, null, 2));
const extPaths = [];
for (let index = 0; index < argv.length; index += 1) {
  if (argv[index] === "-e") extPaths.push(argv[index + 1]);
}
const handlers = {};
const pi = { on: (event, handler) => { (handlers[event] ??= []).push(handler); } };
const isObserver = (path) => path.endsWith("pre.mjs") || path.endsWith("post.mjs");
for (const extPath of extPaths) {
  if (!isObserver(extPath)) {
    // The TypeScript arm implementation cannot load under plain Node.
    // Register a behavior-neutral deterministic mutator in its slot so
    // handler order stays [pre, arm, post].
    pi.on("tool_result", async (event) => ({ content: String(event.content ?? "") + ":mut" }));
    pi.on("context", async (event) => ({ messages: event.messages }));
    continue;
  }
  try {
    const module = await import(extPath);
    module.default(pi);
  } catch (error) {
    process.stderr.write("extension load failed: " + extPath + ": " + error.message + "\\n");
  }
}
// Fire handlers with Pi ExtensionRunner chaining semantics: a
// tool_result handler may return { content }, a context handler may
// return { messages }, and later handlers observe the updated event.
const fireToolResult = async (event) => {
  let current = { ...event };
  for (const handler of handlers.tool_result ?? []) {
    const result = await handler(current);
    if (result && result.content !== undefined) current = { ...current, content: result.content };
  }
};
const fireContext = async (event) => {
  let current = { ...event };
  for (const handler of handlers.context ?? []) {
    const result = await handler(current);
    if (result && result.messages !== undefined) current = { ...current, messages: result.messages };
  }
};
const fire = async (event) => {
  for (const handler of handlers.tool_call ?? []) await handler(event);
};
const emit = (line) => process.stdout.write(JSON.stringify(line) + "\\n");
emit({ type: "session", version: 3, id: "fake-masking", timestamp: new Date().toISOString(), cwd: process.cwd() });
emit({ type: "agent_start" });
await fire({ type: "tool_call", toolCallId: "call-0", toolName: "bash", input: "python3 tests/test_suite.py" });
await fireToolResult({ type: "tool_result", toolCallId: "call-0", toolName: "bash", content: "suite: 8 passed\\n[cm-masked bash] earlier output", isError: false });
await fireContext({ type: "context", messages: [{ role: "user", content: [{ type: "text", text: "history" }] }] });
emit({ type: "message_end", message: { role: "assistant", content: [{ type: "text", text: "done" }], usage: { input: 100, output: 20, cacheWrite: 5 } } });
emit({ type: "agent_end", messages: [] });
const answers = JSON.parse(readFileSync(join(dirname(new URL(import.meta.url).pathname), "..", "answers.json"), "utf8"));
for (const [path, content] of Object.entries(answers)) {
  const target = join(process.cwd(), path);
  mkdirSync(dirname(target), { recursive: true });
  writeFileSync(target, content, "utf8");
}
process.exit(0);
`;

function makeFakeMaskingRuntime(cacheDir) {
  const runtimeDir = join(cacheDir, "fake-masking-pi");
  mkdirSync(join(runtimeDir, "dist"), { recursive: true });
  writeFileSync(
    join(runtimeDir, "package.json"),
    `${JSON.stringify({ name: "fake-masking-pi", version: "0.84.2", type: "module", engines: { node: ">=22.19.0" } }, null, 2)}\n`,
    "utf8",
  );
  writeFileSync(join(runtimeDir, "answers.json"), `${JSON.stringify(ANSWERS)}\n`, "utf8");
  writeFileSync(join(runtimeDir, "dist", "cli.js"), FAKE_PI, "utf8");
  const realDist = join(repoRoot, "node_modules", "@earendil-works", "pi-coding-agent", "dist", "index.js");
  writeFileSync(
    join(runtimeDir, "dist", "index.js"),
    `export { ExtensionRunner, createExtensionRuntime } from ${JSON.stringify(realDist)};\n`,
    "utf8",
  );
  return runtimeDir;
}

export { makeFakeMaskingRuntime };

describe("masking real run end to end", () => {
  test("executes 48 immutable paid attempts with observer pins and no re-invocation", { timeout: 600_000 }, async () => {
    const work = mkdtempSync(join(tmpdir(), "cm-masking-e2e-"));
    const upstream = await startFakeUpstream();
    try {
      const runsDir = join(work, "runs");
      const cacheDir = join(work, "cache");
      const credentialSource = join(work, "models.json");
      writeCredentialSource(credentialSource, `http://127.0.0.1:${upstream.port}`);
      const runtimeDir = makeFakeMaskingRuntime(cacheDir);
      maskingPrepare({ repoRoot, runsDir, runId: "masking-real-01", mode: "real" });
      const outcome = await maskingRealRun({
        repoRoot,
        runsDir,
        runId: "masking-real-01",
        flags: {
          "--confirm-paid": true,
          "--credential-source": credentialSource,
          "--cache-dir": cacheDir,
          "--pi-runtime": runtimeDir,
        },
      });
      assert.equal(outcome.executed, 48, `all 48 attempts must execute: ${outcome.stoppedReason ?? "ok"}`);
      assert.equal(outcome.stoppedReason, null);
      const runDir = join(runsDir, "masking-real-01");
      const run = JSON.parse(readFileSync(join(runDir, "run.json"), "utf8"));
      const profileBytes = readFileSync(join(repoRoot, "evaluation", "masking-eval-profile.json"), "utf8");
      let receipts = 0;
      for (const task of JSON.parse(readFileSync(join(repoRoot, "evaluation", "masking-task-manifest.json"), "utf8")).tasks) {
        for (const arm of ["upstream", "fork"]) {
          for (const rep of [1, 2, 3]) {
            const attemptDir = join(runDir, "attempts", task.id, arm, `attempt-${String(rep).padStart(3, "0")}`);
            const receipt = JSON.parse(readFileSync(join(attemptDir, "provider-invocation.json"), "utf8"));
            assert.equal(receipt.fake, false, `${task.id}/${arm}/${rep} must hold a paid receipt`);
            assert.equal(receipt.study, "masking");
            assert.match(receipt.piRuntime.digest, /^[0-9a-f]{64}$/);
            receipts += 1;
            const pinned = JSON.parse(readFileSync(join(attemptDir, "pinned.json"), "utf8"));
            assert.match(pinned.observerSha256, /^[0-9a-f]{64}$/, "observer digest must be pinned");
            assert.equal(pinned.profileSha256, run.profileSha256);
            const homeConfig = readFileSync(join(attemptDir, "home", ".config", "condensed-milk.json"), "utf8");
            assert.equal(homeConfig, profileBytes, "exact profile bytes in both arms");
            const instrumentation = JSON.parse(readFileSync(join(attemptDir, "instrumentation.json"), "utf8"));
            assert.equal(instrumentation.usage.input, 100);
            assert.equal(instrumentation.providerCost, null);
            assert.equal(instrumentation.correctness, true);
            assert.equal(instrumentation.status, "completed");
            assert.ok(existsSync(join(attemptDir, "observer", "pre-metrics.jsonl")), "observer metrics exist");
            assert.ok(existsSync(join(attemptDir, "observer", "post-metrics.jsonl")), "observer metrics exist");
            const argvRecord = readFileSync(join(attemptDir, "sessions", "record-argv.json"), "utf8");
            assert.equal(/masking-assertions|masking-solutions/.test(argvRecord), false, "no hidden paths in argv");
            const envRecord = readFileSync(join(attemptDir, "sessions", "record-env.json"), "utf8");
            assert.equal(/masking-assertions|masking-solutions/.test(envRecord), false, "no hidden paths in env");
            const invocationMarker = readFileSync(join(attemptDir, "invocations.jsonl"), "utf8").trim().split("\n");
            assert.equal(invocationMarker.length, 1, "exactly one invocation marker per attempt");
          }
        }
      }
      assert.equal(receipts, 48);
      // Duplicate prevention: a second execution pass skips everything.
      const again = await maskingRealRun({
        repoRoot,
        runsDir,
        runId: "masking-real-01",
        flags: {
          "--confirm-paid": true,
          "--credential-source": credentialSource,
          "--cache-dir": cacheDir,
          "--pi-runtime": runtimeDir,
        },
      });
      assert.equal(again.executed, 0, "no duplicate invocations on resume");

      // Report pass over the fake-provider run: 24 valid real pairs.
      const report = maskingReport({ repoRoot, runsDir, runId: "masking-real-01" });
      assert.equal(report.pairs.valid, 24, `real pairs must validate: ${JSON.stringify(report.pairs)}`);
      assert.equal(report.pairs.invalid, 0);
      assert.equal(report.pairs.incomplete, 0);

      // Tamper one paid receipt: the pair must invalidate.
      const tamperedPath = join(
        runsDir, "masking-real-01", "attempts", "masking-task-02", "fork", "attempt-002", "provider-invocation.json",
      );
      const tampered = JSON.parse(readFileSync(tamperedPath, "utf8"));
      tampered.armCommit = "0".repeat(40);
      writeFileSync(tamperedPath, `${JSON.stringify(tampered, null, 2)}\n`, "utf8");
      const tamperedReport = maskingReport({ repoRoot, runsDir, runId: "masking-real-01" });
      assert.equal(tamperedReport.pairs.invalid, 1);
      assert.equal(tamperedReport.pairs.valid, 23);
      assert.equal(tamperedReport.passing, false);
    } finally {
      await upstream.close();
      if (process.env.MASKING_TEST_KEEP === "1") process.stderr.write(`MASKING_TEST_WORK=${work}\n`);
      else rmSync(work, { recursive: true, force: true });
    }
  });
});
