import { test, describe } from "node:test";
import assert from "node:assert/strict";
import { mkdtempSync, mkdirSync, readFileSync, rmSync, writeFileSync } from "node:fs";
import { join } from "node:path";
import { tmpdir } from "node:os";
import { buildAggregateReports } from "../runner/report.mjs";

function writeJson(path, value) { writeFileSync(path, `${JSON.stringify(value, null, 2)}\n`, "utf8"); }
function makeAttempt(runDir, taskId, arm, result, stdout) {
  const dir = join(runDir, "attempts", taskId, arm, "attempt-001");
  mkdirSync(dir, { recursive: true });
  writeJson(join(dir, "result.json"), result);
  writeJson(join(dir, "fixture-before.json"), { contentSha256: "fixture", gitStateSha256: "git" });
  writeJson(join(dir, "pinned.json"), { promptSha256: "prompt", scorerSha256: "scorer", provider: "z-ai", model: "model", thinking: "high", piVersion: "0.84.2", armCommit: `${arm}-commit` });
  // Synthetic paid receipt exactly as a real reservation would pin it.
  writeJson(join(dir, "provider-invocation.json"), { schemaVersion: 1, runId: "synthetic", taskId, arm, attempt: 1, fake: false, armCommit: `${arm}-commit`, reservedAt: "1970-01-01T00:00:00.000Z" });
  writeJson(join(runDir, "run.json"), { runId: "synthetic", mode: "real", armOrder: {} });
  writeFileSync(join(dir, "pi-stdout.jsonl"), stdout, "utf8");
  writeJson(join(dir, "proxy.json"), { requests: [{ status: 200 }], rejected: [] });
}

describe("aggregate real-run report", () => {
  test("uses selected valid pair and emits private-content-free metrics", () => {
    const runDir = mkdtempSync(join(tmpdir(), "cm-report-pair-"));
    try {
      const base = (arm) => ({ status: "completed", attempt: 1, durationMs: arm === "upstream" ? 100 : 160, firstEventLatencyMs: 10, usage: { input: 10, output: 3, cacheRead: null, cacheWrite: null }, scorer: { status: arm === "upstream" ? "passed" : "failed", passedCount: arm === "upstream" ? 4 : 3, totalCount: 4 }, failures: [] });
      makeAttempt(runDir, "task-01", "upstream", base("upstream"), `${JSON.stringify({ type: "tool_execution_start", args: { secret: "TOOL-SECRET" } })}\n`);
      makeAttempt(runDir, "task-01", "fork", base("fork"), `${JSON.stringify({ type: "tool_execution_end", isError: true, result: "TOOL-SECRET" })}\nnot-json [cm-masked secret]\n`);
      const result = buildAggregateReports({ runDir, runId: "synthetic", run: { mode: "real" }, selection: { "task-01:upstream": 1, "task-01:fork": 1 }, manifest: { tasks: [{ id: "task-01" }], evaluation: { arms: [{ name: "upstream", commit: "upstream-commit" }, { name: "fork", commit: "fork-commit" }] } } });
      assert.equal(result.summary.pairs.valid, 1);
      assert.deepEqual(result.summary.pairs.outcomes, { bothPass: 0, upstreamOnly: 1, forkOnly: 0, bothFail: 0 });
      assert.equal(result.summary.arms.fork.jsonl.malformed, 1);
      assert.equal(result.summary.arms.fork.proxy.requests, 1);
      assert.equal(result.summary.arms.fork.staticMaskPlaceholders, 1);
      assert.equal(result.summary.pairs.rows[0].durationDeltaMs, 60);
      assert.equal(result.summary.pairs.rows[0].scorerSha256, "scorer");
      const upstreamPinned = join(runDir, "attempts", "task-01", "upstream", "attempt-001", "pinned.json");
      const forkPinned = join(runDir, "attempts", "task-01", "fork", "attempt-001", "pinned.json");
      writeJson(upstreamPinned, { promptSha256: null, scorerSha256: null, armCommit: "upstream-commit" });
      writeJson(forkPinned, { promptSha256: null, scorerSha256: null, armCommit: "fork-commit" });
      assert.equal(buildAggregateReports({ runDir, runId: "synthetic", run: { mode: "real" }, selection: { "task-01:upstream": 1, "task-01:fork": 1 }, manifest: { tasks: [{ id: "task-01" }], evaluation: { arms: [{ name: "upstream", commit: "upstream-commit" }, { name: "fork", commit: "fork-commit" }] } } }).summary.pairs.valid, 0);
      for (const name of ["summary.json", "summary.md", "pairs.csv", "failures.json", "artifact-index.json"]) assert.equal(readFileSync(join(runDir, name), "utf8").includes("TOOL-SECRET"), false, `${name} leaked raw tool content`);
    } finally { rmSync(runDir, { recursive: true, force: true }); }
  });

  test("indexes collected git state under final-state and only expected relative paths", () => {
    const runDir = mkdtempSync(join(tmpdir(), "cm-report-artifacts-"));
    try {
      const artifacts = [
        { name: "porcelain-v2", file: "porcelain-v2.txt", bytes: 3, sha256: "a" },
        { name: "staged.patch", file: "staged.patch", bytes: 4, sha256: "b" },
        { name: "unstaged.patch", file: "unstaged.patch", bytes: 5, sha256: "c" },
        { name: "ls-files", file: "ls-files.txt", bytes: 6, sha256: "d" },
        { name: "tampered", file: "../evil.txt", bytes: 1, sha256: "e" },
        { name: "tampered-abs", file: "/etc/hosts", bytes: 1, sha256: "f" },
      ];
      const result = (arm) => ({ status: "completed", attempt: 1, durationMs: 100, firstEventLatencyMs: 10, usage: { input: 10, output: 3, cacheRead: null, cacheWrite: null }, scorer: { status: "passed", passedCount: 4, totalCount: 4 }, failures: [], collection: { status: "collected", errors: [], artifacts } });
      makeAttempt(runDir, "task-01", "upstream", result("upstream"), "");
      makeAttempt(runDir, "task-01", "fork", result("fork"), "");
      for (const arm of ["upstream", "fork"]){
        const finalState = join(runDir, "attempts", "task-01", arm, "attempt-001", "final-state");
        mkdirSync(finalState, { recursive: true });
        for (const file of ["porcelain-v2.txt", "staged.patch", "unstaged.patch", "ls-files.txt"]) {
          writeFileSync(join(finalState, file), `${arm}-${file}\n`, "utf8");
        }
      }
      writeFileSync(join(runDir, "evil.txt"), "ESCAPED-CONTENT\n", "utf8");
      buildAggregateReports({ runDir, runId: "synthetic", run: { mode: "real" }, selection: { "task-01:upstream": 1, "task-01:fork": 1 }, manifest: { tasks: [{ id: "task-01" }], evaluation: { arms: [{ name: "upstream", commit: "upstream-commit" }, { name: "fork", commit: "fork-commit" }] } } });
      const index = JSON.parse(readFileSync(join(runDir, "artifact-index.json"), "utf8"));
      const files = index.artifacts.map((entry) => entry.file);
      for (const arm of ["upstream", "fork"]) {
        for (const file of ["porcelain-v2.txt", "staged.patch", "unstaged.patch", "ls-files.txt"]) {
          const expected = join("attempts", "task-01", arm, "attempt-001", "final-state", file);
          assert.ok(files.includes(expected), `artifact index must include ${expected}; got ${JSON.stringify(files)}`);
        }
        assert.ok(files.includes(join("attempts", "task-01", arm, "attempt-001", "result.json")), "attempt-level files stay indexed");
      }
      assert.equal(files.filter((file) => file.includes("evil") || file.includes("hosts") || file.split("/").includes("..")).length, 0, `no traversal or absolute paths: ${JSON.stringify(files)}`);
      assert.equal(readFileSync(join(runDir, "artifact-index.json"), "utf8").includes("ESCAPED-CONTENT"), false, "index must not hash escaped files");
    } finally { rmSync(runDir, { recursive: true, force: true }); }
  });

  test("pairs with differing runtime pins across arms or against run.json are invalid", () => {
    const runDir = mkdtempSync(join(tmpdir(), "cm-report-runtime-pin-"));
    try {
      const pinA = { schemaVersion: 1, algorithm: "sha256", entryCount: 3, digest: "a".repeat(64) };
      const pinB = { schemaVersion: 1, algorithm: "sha256", entryCount: 4, digest: "b".repeat(64) };
      const result = (arm) => ({ status: "completed", attempt: 1, durationMs: 100, firstEventLatencyMs: 10, usage: { input: 10, output: 3, cacheRead: null, cacheWrite: null }, scorer: { status: "passed", passedCount: 4, totalCount: 4 }, failures: [], collection: { status: "collected", errors: [], artifacts: [] } });
      const manifestFixture = { tasks: [{ id: "task-01" }], evaluation: { arms: [{ name: "upstream", commit: "upstream-commit" }, { name: "fork", commit: "fork-commit" }] } };
      const build = (upstreamPin, forkPin, runPin) => {
        makeAttempt(runDir, "task-01", "upstream", result("upstream"), "");
        makeAttempt(runDir, "task-01", "fork", result("fork"), "");
        if (upstreamPin || forkPin) {
          for (const [arm, pin] of [["upstream", upstreamPin], ["fork", forkPin]]) {
            if (!pin) continue;
            const pinnedPath = join(runDir, "attempts", "task-01", arm, "attempt-001", "pinned.json");
            const pinned = JSON.parse(readFileSync(pinnedPath, "utf8"));
            pinned.piRuntime = pin;
            writeJson(pinnedPath, pinned);
            // The receipt pins the same runtime digest as pinned.json.
            const receiptPath = join(runDir, "attempts", "task-01", arm, "attempt-001", "provider-invocation.json");
            const receipt = JSON.parse(readFileSync(receiptPath, "utf8"));
            receipt.piRuntime = pin;
            writeJson(receiptPath, receipt);
          }
        }
        writeJson(join(runDir, "run.json"), { runId: "synthetic", mode: "real", armOrder: {}, ...(runPin ? { piRuntime: runPin } : {}) });
        return buildAggregateReports({ runDir, runId: "synthetic", run: { mode: "real" }, selection: { "task-01:upstream": 1, "task-01:fork": 1 }, manifest: manifestFixture });
      };

      const matching = build(pinA, pinA, pinA);
      assert.equal(matching.summary.pairs.valid, 1, `matching runtime pins stay valid: ${JSON.stringify(matching.summary.pairs)}`);

      const crossArm = build(pinA, pinB, pinA);
      assert.equal(crossArm.summary.pairs.valid, 0, "differing pinned digests across arms must invalidate the pair");
      assert.equal(crossArm.summary.pairs.invalid, 1);

      const againstRun = build(pinA, pinA, pinB);
      assert.equal(againstRun.summary.pairs.valid, 0, "a pinned digest differing from run.json must invalidate the pair");
      assert.equal(againstRun.summary.pairs.invalid, 1);

      const missingOne = build(pinA, null, pinA);
      assert.equal(missingOne.summary.pairs.valid, 0, "one arm missing the runtime pin while run.json pins it must invalidate the pair");
    } finally { rmSync(runDir, { recursive: true, force: true }); }
  });
});
