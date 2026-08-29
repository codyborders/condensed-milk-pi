/**
 * Provider-study real paid execution (grown test-first).
 *
 * Fake-only: a loopback fake z-ai upstream, a sentinel credential
 * source, and a fake Pi runtime. The real provider is never contacted.
 */

import { test, describe } from "node:test";
import assert from "node:assert/strict";
import { existsSync, mkdirSync, mkdtempSync, readdirSync, readFileSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { dirname, join } from "node:path";
import { fileURLToPath } from "node:url";
import { providerStudyCli } from "../runner/cli.mjs";
import { providerStudyFreeze } from "../runner/freeze.mjs";
import { providerStudyConditionalGate } from "../runner/paid.mjs";
import { providerStudySchedule } from "../runner/schedule.mjs";
import { providerStudyPublishCompletion } from "../runner/reserve.mjs";
import { providerStudyArmConfig } from "../runner/arms.mjs";
import { loadProviderStudyTaskData } from "../runner/manifest.mjs";
import { startFakeUpstream, writeCredentialSource, SENTINEL_KEY } from "../../tests/real-attempt-fakes.mjs";

const repoRoot = join(fileURLToPath(import.meta.url), "..", "..", "..", "..");

describe("provider-study paid run", () => {
  test("a freeze lock whose evaluator source digest differs refuses before any reservation", async () => {
    const setup = await paidSetup("cm-ps-paid-srcfreeze-");
    try {
      const lock = JSON.parse(readFileSync(setup.freezeLock, "utf8"));
      lock.digests.evaluator.sourceSha256 = "0".repeat(64);
      const tampered = join(setup.work, "tampered-freeze-lock.json");
      writeFileSync(tampered, `${JSON.stringify(lock, null, 2)}\n`, "utf8");
      const tamperedFlags = setup.runFlags.map((flag, index) =>
        setup.runFlags[index - 1] === "--freeze-lock" ? tampered : flag,
      );
      const run = await runCli(setup.runsRoot, tamperedFlags);
      assert.notEqual(run.code, 0);
      assert.match(run.stderr, /evaluator changed|evaluator source changed|frozen input evaluator|supplied freeze lock differs/);
      const attemptsRoot = join(setup.runsRoot, "development", "attempts");
      assert.equal(existsSync(attemptsRoot) ? readdirSync(attemptsRoot).length : 0, 0, "no slot may be reserved");
    } finally {
      await setup.upstream.close();
      rmSync(setup.work, { recursive: true, force: true });
    }
  });

  test("attempt timeout overrides are rejected before any reservation", async () => {
    const runsRoot = mkdtempSync(join(tmpdir(), "cm-ps-timeout-refusal-"));
    try {
      const run = await providerStudyCli(
        [
          "run", "--phase", "development", "--runs-root", runsRoot,
          "--confirm-paid", "--credential-source", "/nonexistent/models.json", "--timeout-ms", "1",
        ],
        { repoRoot },
      );
      assert.notEqual(run.code, 0);
      assert.match(run.stderr, /refuses --timeout-ms|timeout is frozen/);
      assert.equal(existsSync(join(runsRoot, "development", "attempts")), false);
    } finally {
      rmSync(runsRoot, { recursive: true, force: true });
    }
  });

  test("paid roots inside the repository are rejected before any reservation", async () => {
    const insideRoot = join(repoRoot, "evaluation", "provider-study", ".paid-inside-repo-test");
    mkdirSync(insideRoot, { recursive: true });
    try {
      const run = await providerStudyCli(
        [
          "run", "--phase", "development", "--runs-root", insideRoot,
          "--confirm-paid", "--credential-source", "/nonexistent/models.json",
        ],
        { repoRoot },
      );
      assert.notEqual(run.code, 0);
      assert.match(run.stderr, /inside the repository|outside this repository/);
      const judge = await providerStudyCli(
        [
          "judge-run", "--phase", "development", "--runs-root", insideRoot,
          "--confirm-paid", "--credential-source", "/nonexistent/models.json",
        ],
        { repoRoot },
      );
      assert.notEqual(judge.code, 0);
      assert.match(judge.stderr, /inside the repository|outside this repository/);
    } finally {
      rmSync(insideRoot, { recursive: true, force: true });
    }
  });
});

/**
 * Fake Pi 0.84.2 runtime for the provider study: loads every -e
 * extension in argv order (the real observer .mjs files and the real
 * neutral retrieval stub; TypeScript arm slots register a
 * behavior-neutral mutator), fires a fixed event script, applies the
 * hidden solution, and emits two assistant messages with provider
 * usage including an unknown numeric token field.
 */
const FAKE_PI = String.raw`
import { readFileSync, writeFileSync, mkdirSync } from "node:fs";
import { join, dirname } from "node:path";
import { fileURLToPath } from "node:url";
import http from "node:http";
const argv = process.argv.filter((_, index) => index > 1);
const sessionDir = argv[argv.indexOf("--session-dir") + 1];
mkdirSync(sessionDir, { recursive: true });
writeFileSync(join(sessionDir, "record-argv.json"), JSON.stringify({ argv: process.argv, cwd: process.cwd() }, null, 2));
const extPaths = [];
for (let index = 0; index < argv.length; index += 1) {
  if (argv[index] === "-e") extPaths.push(argv[index + 1]);
}
const handlers = {};
const tools = [];
const pi = {
  on: (event, handler) => { (handlers[event] ??= []).push(handler); },
  registerTool: (tool) => { tools.push(tool.name); },
};
let contextCalls = 0;
for (const extPath of extPaths) {
  if (extPath.endsWith(".mjs")) {
    const module = await import(extPath);
    if (typeof module.default === "function") module.default(pi);
  } else {
    pi.on("context", async (event) => {
      contextCalls += 1;
      if (contextCalls % 2 === 1) {
        return { messages: event.messages.filter((_, index) => index > 0).map((message) => ({ ...message, content: [{ type: "text", text: "[cm-masked bash] earlier output removed" }] })) };
      }
      return { messages: event.messages.filter((_, index) => index > 0) };
    });
  }
}
const fire = async (event) => {
  for (const handler of handlers[event.type] ?? []) await handler(event);
};
const fireContext = async (event) => {
  let current = { ...event };
  for (const handler of handlers.context ?? []) {
    const result = await handler(current);
    if (result && result.messages !== undefined) current = { ...current, messages: result.messages };
  }
};
const emit = (line) => process.stdout.write(JSON.stringify(line) + "\n");
emit({ type: "session", version: 3, id: "provider-study-fake", timestamp: new Date().toISOString(), cwd: process.cwd() });
emit({ type: "agent_start" });
await fire({ type: "tool_call", toolCallId: "call-1", toolName: "bash", input: "python3 -m pytest tests/test_suite.py" });
await fire({ type: "tool_call", toolCallId: "call-2", toolName: "bash", input: "python3 -m pytest tests/test_suite.py" });
await fire({ type: "tool_call", toolCallId: "call-3", toolName: "bash", input: "npm run build" });
await fire({ type: "tool_call", toolCallId: "call-4", toolName: "bash", input: "echo hi" });
await fire({ type: "tool_call", toolCallId: "call-5", toolName: "read", input: "src/app.ts" });
await fire({ type: "tool_call", toolCallId: "call-6", toolName: "read", input: "src/app.ts" });
await fire({ type: "tool_call", toolCallId: "call-7", toolName: "condensed_milk_retrieve", input: { id: "cm-1" } });
await fire({ type: "tool_result", toolCallId: "call-1", toolName: "bash", content: "suite ok [cm-archive entry-1]", isError: false });
await fire({ type: "tool_result", toolCallId: "call-7", toolName: "condensed_milk_retrieve", content: "unavailable", isError: true });
await fireContext({ type: "context", messages: [
  { role: "user", content: [{ type: "text", text: "history block one with plenty of bytes to remove" }] },
  { role: "user", content: [{ type: "text", text: "history block two with plenty of bytes to remove" }] },
  { role: "user", content: [{ type: "text", text: "history block three with plenty of bytes to remove" }] },
] });
await fireContext({ type: "context", messages: [
  { role: "user", content: [{ type: "text", text: "later history block one with plenty of bytes" }] },
  { role: "user", content: [{ type: "text", text: "later history block two with plenty of bytes" }] },
] });
emit({ type: "message_end", message: { role: "assistant", content: [{ type: "text", text: "turn one" }], usage: { input: 1000, output: 200, cacheRead: 50, cacheWrite: 30, reasoningTokens: 7 } } });
emit({ type: "message_end", message: { role: "assistant", content: [{ type: "text", text: "turn two" }], usage: { input: 60, output: 10, reasoningTokens: 3 } } });
emit({ type: "agent_end", messages: [] });
const solution = JSON.parse(readFileSync(join(dirname(fileURLToPath(import.meta.url)), "..", "solution.json"), "utf8"));
const models = JSON.parse(readFileSync(join(process.env.PI_CODING_AGENT_DIR, "models.json"), "utf8"));
const provider = models.providers["z-ai-eval"];
const requestUpstream = () => new Promise((resolve, reject) => {
  const body = JSON.stringify({ model: provider.models[0].id, stream: true, max_tokens: 64, messages: [{ role: "user", content: "provider-study fake" }] });
  const req = http.request(new URL(provider.baseUrl + "/v1/messages"), {
    method: "POST",
    headers: { "content-type": "application/json", "x-api-key": provider.apiKey, accept: "text/event-stream" },
  }, (res) => {
    res.on("data", () => {});
    res.on("end", () => resolve(res.statusCode));
  });
  req.on("error", reject);
  req.end(body);
});
const upstreamStatus = await requestUpstream();
if (upstreamStatus !== 200) {
  process.stderr.write("upstream rejected with " + upstreamStatus + "\n");
  process.exit(4);
}
for (const file of solution.files) {
  const target = join(process.cwd(), file.path);
  mkdirSync(join(target, ".."), { recursive: true });
  writeFileSync(target, file.content);
}
await new Promise((resolve) => setTimeout(resolve, 150));
process.exit(0);
`;

/** Build the fake Pi runtime directory for --pi-runtime. */
function makeFakePiRuntime(cacheDir, solution) {
  const runtimeDir = join(cacheDir, "fake-provider-study-pi");
  mkdirSync(join(runtimeDir, "dist"), { recursive: true });
  writeFileSync(
    join(runtimeDir, "package.json"),
    `${JSON.stringify({ name: "fake-provider-study-pi", version: "0.84.2", type: "module", engines: { node: ">=22.19.0" } }, null, 2)}\n`,
    "utf8",
  );
  writeFileSync(join(runtimeDir, "solution.json"), `${JSON.stringify(solution)}\n`, "utf8");
  writeFileSync(join(runtimeDir, "dist", "cli.js"), FAKE_PI, "utf8");
  const realDist = join(repoRoot, "node_modules", "@earendil-works", "pi-coding-agent", "dist", "index.js");
  writeFileSync(
    join(runtimeDir, "dist", "index.js"),
    `export { ExtensionRunner, createExtensionRuntime } from ${JSON.stringify(realDist)};\n`,
    "utf8",
  );
  return runtimeDir;
}

/** Common paid-fixture setup: temp root, freeze lock, prepare, fake runtime. */
async function paidSetup(prefix) {
  const work = mkdtempSync(join(tmpdir(), prefix));
  const runsRoot = join(work, "runs");
  const cacheDir = join(work, "cache");
  const upstream = await startFakeUpstream();
  const credentialSource = join(work, "models.json");
  writeCredentialSource(credentialSource, `http://127.0.0.1:${upstream.port}`);
  const freezeLock = join(work, "freeze-lock.json");
  providerStudyFreeze(repoRoot, { lockPath: freezeLock });
  const { solution } = loadProviderStudyTaskData(repoRoot, "development", "task-01");
  const piRuntime = makeFakePiRuntime(cacheDir, solution);
  const prepare = await providerStudyCli(
    ["prepare", "--phase", "development", "--run-id", "paid-1", "--runs-root", runsRoot],
    { repoRoot },
  );
  assert.equal(prepare.code, 0, prepare.stderr);
  const runFlags = [
    "--confirm-paid",
    "--credential-source", credentialSource,
    "--cache-dir", cacheDir,
    "--pi-runtime", piRuntime,
    "--freeze-lock", freezeLock,
  ];
  return { work, runsRoot, cacheDir, upstream, credentialSource, freezeLock, piRuntime, runFlags };
}

function runCli(runsRoot, extra, phase = "development") {
  return providerStudyCli(["run", "--phase", phase, "--runs-root", runsRoot, ...extra], { repoRoot });
}

/** Fabricate a complete preallocated root with a chosen delta pattern. */
function fabricateCompleteRoot(runsRoot, mode) {
  const schedule = providerStudySchedule(repoRoot, "development");
  for (const [taskIndex, task] of schedule.tasks.entries()) {
    for (const block of task.blocks) {
      for (const arm of block.arms) {
        const attemptDir = join(runsRoot, "development", "attempts", task.taskId, arm, `attempt-${String(block.rep).padStart(3, "0")}`);
        mkdirSync(attemptDir, { recursive: true });
        const base = 1000 + ((block.rep * 7) % 13);
        const delta = mode === "inconclusive" ? (taskIndex % 2 === 0 ? 10 : -10) : 50;
        const tokens = arm === "remediated-defaults" ? base + delta : base;
        writeFileSync(
          join(attemptDir, "result.json"),
          `${JSON.stringify({
            schemaVersion: 1,
            study: "provider-study",
            phase: "development",
            taskId: task.taskId,
            arm,
            rep: block.rep,
            status: "completed",
            deterministicResult: true,
            usage: { input: tokens, output: 10, cacheRead: null, cacheWrite: null },
            totalProviderTokens: tokens,
          }, null, 2)}\n`,
          "utf8",
        );
        providerStudyPublishCompletion(attemptDir);
      }
    }
  }
}

describe("provider-study conditional gate", () => {
  test("the gate requires repetitions 6-10 only for an inconclusive primary interval", () => {
    const inconclusive = mkdtempSync(join(tmpdir(), "cm-ps-gate-inc-"));
    const conclusive = mkdtempSync(join(tmpdir(), "cm-ps-gate-con-"));
    try {
      fabricateCompleteRoot(inconclusive, "inconclusive");
      fabricateCompleteRoot(conclusive, "conclusive");
      const inc = providerStudyConditionalGate(repoRoot, inconclusive, "development");
      assert.equal(inc.complete, true);
      assert.equal(inc.required, true, "an interval including zero must require repetitions 6-10");
      const con = providerStudyConditionalGate(repoRoot, conclusive, "development");
      assert.equal(con.complete, true);
      assert.equal(con.required, false, "a conclusive interval must not require repetitions 6-10");
      const empty = mkdtempSync(join(tmpdir(), "cm-ps-gate-empty-"));
      try {
        const gate = providerStudyConditionalGate(repoRoot, empty, "development");
        assert.equal(gate.complete, false, "an empty root is not complete");
        assert.equal(gate.required, false);
      } finally {
        rmSync(empty, { recursive: true, force: true });
      }
    } finally {
      rmSync(inconclusive, { recursive: true, force: true });
      rmSync(conclusive, { recursive: true, force: true });
    }
  });

  test("conditional slots execute only through --conditional after the gate passes", { timeout: 300_000 }, async () => {
    const setup = await paidSetup("cm-ps-paid-cond-");
    try {
      fabricateCompleteRoot(setup.runsRoot, "inconclusive");
      assert.equal(providerStudyConditionalGate(repoRoot, setup.runsRoot, "development").required, true);

      // Without --conditional the run skips everything and never reserves a
      // repetition-6 slot.
      const plain = await runCli(setup.runsRoot, [...setup.runFlags, "--task", "task-01"]);
      const plainBody = JSON.parse(plain.stdout);
      assert.equal(plainBody.executed, 0);
      assert.equal(plainBody.conditional.executed, 0);
      assert.equal(existsSync(join(setup.runsRoot, "development", "attempts", "task-01", "none", "attempt-006")), false);

      const conditional = await runCli(setup.runsRoot, [...setup.runFlags, "--task", "task-01", "--conditional"]);
      assert.equal(conditional.code, 0, conditional.stderr);
      const body = JSON.parse(conditional.stdout);
      assert.equal(body.conditional.required, true);
      assert.equal(body.conditional.executed, 20, `all four arms at reps 6-10 for task-01: ${body.stoppedReason ?? "ok"}`);
      for (const arm of ["none", "upstream", "remediated-defaults", "remediated-archive"]) {
        for (const rep of [6, 7, 8, 9, 10]) {
          const resultPath = join(setup.runsRoot, "development", "attempts", "task-01", arm, `attempt-${String(rep).padStart(3, "0")}`, "result.json");
          assert.equal(existsSync(resultPath), true, `${arm}/${rep} conditional result`);
        }
      }

      // A conclusive root refuses the conditional extension entirely.
      const conclusiveRoot = mkdtempSync(join(tmpdir(), "cm-ps-cond-refuse-"));
      try {
        fabricateCompleteRoot(conclusiveRoot, "conclusive");
        const prepare = await providerStudyCli(["prepare", "--phase", "development", "--run-id", "paid-1", "--runs-root", conclusiveRoot], { repoRoot });
        assert.equal(prepare.code, 0, prepare.stderr);
        const refused = await runCli(conclusiveRoot, [...setup.runFlags, "--task", "task-01", "--conditional"]);
        const refusedBody = JSON.parse(refused.stdout);
        assert.equal(refusedBody.conditional.executed, 0);
        assert.equal(refusedBody.conditional.required, false);
        assert.equal(existsSync(join(conclusiveRoot, "development", "attempts", "task-01", "none", "attempt-006")), false);
      } finally {
        rmSync(conclusiveRoot, { recursive: true, force: true });
      }
    } finally {
      await setup.upstream.close();
      rmSync(setup.work, { recursive: true, force: true });
    }
  });
});

describe("provider-study paid execution", () => {
  test("executes one task across four arms with arm extension loading, metrics, and credential isolation", { timeout: 420_000 }, async () => {
    const setup = await paidSetup("cm-ps-paid-e2e-");
    try {
      const run = await runCli(setup.runsRoot, [...setup.runFlags, "--task", "task-01"]);
      assert.equal(run.code, 0, run.stderr);
      const body = JSON.parse(run.stdout);
      assert.equal(body.executed, 20, `all 20 slots must execute: ${body.stoppedReason ?? "ok"}`);
      assert.equal(body.conditional.required, false);

      for (const arm of ["none", "upstream", "remediated-defaults", "remediated-archive"]) {
        for (const rep of [1, 2, 3, 4, 5]) {
          const attemptDir = join(setup.runsRoot, "development", "attempts", "task-01", arm, `attempt-${String(rep).padStart(3, "0")}`);
          const result = JSON.parse(readFileSync(join(attemptDir, "result.json"), "utf8"));
          assert.equal(result.status, "completed", `${arm}/${rep} status`);
          assert.equal(result.study, "provider-study");
          assert.equal(result.phase, "development");
          assert.equal(result.arm, arm);
          assert.equal(result.rep, rep);
          assert.equal(result.deterministicResult, true, `${arm}/${rep} hidden scorer must pass`);
          assert.equal(result.qualityScore, null);
          assert.equal(result.qualityScoreSource, "judge-pending");
          assert.equal(result.usage.input, 1060);
          assert.equal(result.usage.output, 210);
          assert.equal(result.usage.cacheRead, 50);
          assert.equal(result.usage.cacheWrite, 30);
          assert.equal(result.usage.reasoningTokens, 10, "unknown numeric token fields must survive and sum");
          assert.equal(result.totalProviderTokens, 1360, "the total sums every provider token category");
          assert.equal(result.peakContextTokens, 1080);
          assert.equal(result.modelRequests, 1, "modelRequests is proxy-authoritative: the fake Pi made exactly one provider request");
          assert.equal(result.assistantCompletions, 2, "assistant completion count stays separate from proxy requests");
          assert.equal(result.proxyRequestCount, 1);
          assert.deepEqual(result.proxyStatusCounts, { "200": 1 });
          assert.equal(result.proxyFailedRequestCount, 0);
          assert.equal(result.proxyRejectedCount, 0);
          assert.equal(result.providerTrafficAnomaly, true, "the proxy count disagrees with completions and the mismatch is flagged");
          assert.equal(typeof result.wallTimeMs, "number");
          assert.equal(typeof result.firstEventLatencyMs, "number");
          assert.equal(result.toolCalls, 7);
          assert.equal(result.shellReruns, 0);
          assert.equal(result.testReruns, 1);
          assert.equal(result.buildReruns, 0);
          assert.equal(result.fileRereads, 1);
          assert.equal(result.retrievalCalls, 1);
          assert.equal(result.retrievalFailures, 1);
          assert.equal(result.archiveReferences >= 1, true);
          assert.equal(result.historicalMaskEvents >= 0, true);
          assert.deepEqual(result.failures, [], "failures stay separate and empty on success");

          const argvRecord = JSON.parse(readFileSync(join(attemptDir, "sessions", "record-argv.json"), "utf8"));
          const extensions = [];
          for (let index = 0; index < argvRecord.argv.length; index += 1) {
            if (argvRecord.argv[index] === "-e") extensions.push(argvRecord.argv[index + 1]);
          }
          assert.equal(extensions[0].endsWith(join("observer", "pre.mjs")), true, "pre observer loads first");
          assert.equal(extensions[extensions.length - 1].endsWith(join("observer", "post.mjs")), true, "post observer loads last");
          const neutral = extensions.filter((path) => path.endsWith("neutral-retrieval.mjs"));
          const implementations = extensions.filter((path) => path.endsWith("index.ts"));
          if (arm === "none") {
            assert.equal(neutral.length, 1, "none loads only the neutral stub");
            assert.equal(implementations.length, 0, "none must not load any production extension");
          } else if (arm === "upstream") {
            assert.equal(neutral.length, 1, "upstream loads the neutral stub");
            assert.equal(implementations.length, 1, "upstream loads its pinned index.ts");
          } else {
            assert.equal(neutral.length, 0, "remediated arms load no neutral stub");
            assert.equal(implementations.length, 1, "remediated arms load their pinned implementation");
          }
          for (const path of extensions) {
            assert.equal(path.startsWith(attemptDir), true, `extension ${path} must live inside the attempt tree`);
          }
          if (arm !== "none") {
            assert.equal(
              existsSync(join(attemptDir, "worktree", "implementation", "node_modules", "proper-lockfile", "package.json")),
              true,
              `${arm} receives the frozen production dependency tree`,
            );
            assert.equal(
              existsSync(join(attemptDir, "worktree", "implementation", "node_modules", "typebox", "package.json")),
              true,
              `${arm} receives the frozen typebox package`,
            );
          }

          const config = providerStudyArmConfig(repoRoot, arm);
          const homeConfig = readFileSync(join(attemptDir, "home", ".config", "condensed-milk.json"), "utf8");
          assert.equal(homeConfig, config.bytes, `${arm} must receive its exact config bytes`);

          const markers = readFileSync(join(attemptDir, "invocations.jsonl"), "utf8").trim().split("\n");
          assert.equal(markers.length, 1, "exactly one invocation marker: no paid retry");

          const pinned = JSON.parse(readFileSync(join(attemptDir, "pinned.json"), "utf8"));
          assert.equal(pinned.study, "provider-study");
          assert.match(pinned.armIdentitySha256, /^[0-9a-f]{64}$/);
          assert.match(pinned.observerSha256, /^[0-9a-f]{64}$/);
          assert.match(pinned.planSha256, /^[0-9a-f]{64}$/);
        }
      }

      assert.ok(setup.upstream.seen.length >= 20);
      for (const seen of setup.upstream.seen) {
        assert.equal(seen.headers["x-api-key"], SENTINEL_KEY);
      }

      const leaks = [];
      const walk = (dir) => {
        for (const entry of readdirSync(dir, { withFileTypes: true })) {
          const path = join(dir, entry.name);
          if (entry.isDirectory()) {
            walk(path);
            continue;
          }
          let text = "";
          try {
            text = readFileSync(path, "utf8");
          } catch {
            continue;
          }
          if (text.includes(SENTINEL_KEY) || text.includes(setup.credentialSource)) leaks.push(path);
        }
      };
      walk(setup.runsRoot);
      assert.deepEqual(leaks, [], "no artifact may persist the credential path or key");

      const before = setup.upstream.seen.length;
      const again = await runCli(setup.runsRoot, [...setup.runFlags, "--task", "task-01"]);
      assert.equal(again.code, 0, again.stderr);
      const againBody = JSON.parse(again.stdout);
      assert.equal(againBody.executed, 0);
      assert.equal(setup.upstream.seen.length, before, "completed slots are never re-invoked");
    } finally {
      await setup.upstream.close();
      rmSync(setup.work, { recursive: true, force: true });
    }
  });
});
