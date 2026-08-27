/**
 * Runner integration of the final repository collector
 * (evaluation/runner/cli.mjs + evaluation/runner/collect.mjs).
 *
 * Every attempt must collect its final worktree state before terminal
 * completion: final-state/ artifacts, final-state.json with artifact
 * hashes, a journal event, and result.collection. A collection error
 * must set the attempt status to collection-error and prevent
 * auto-selection of attempt-001. The error path uses a git shim that
 * passes guard-time commands but fails collector-time commands.
 */

import { test, describe } from "node:test";
import assert from "node:assert/strict";
import { fileURLToPath } from "node:url";
import { dirname, join } from "node:path";
import { chmodSync, existsSync, mkdirSync, mkdtempSync, readFileSync, readdirSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { spawnSync } from "node:child_process";
import { runCli, journalEvents } from "./runner.test.mjs";

const repoRoot = join(dirname(fileURLToPath(import.meta.url)), "..", "..");
const cli = join(repoRoot, "evaluation", "runner", "cli.mjs");

describe("runner collects final state before terminal completion", () => {
  test("dry-run persists collection artifacts and a collection error blocks auto-selection", () => {
    const runsDir = mkdtempSync(join(tmpdir(), "cm-eval-collect-cli-"));
    try {
      // Success path: collection lands next to the terminal artifacts.
      assert.equal(runCli(["prepare", "--runs-dir", runsDir, "--run-id", "run-col-01"]).status, 0);
      assert.equal(
        runCli(["dry-run", "--runs-dir", runsDir, "--run-id", "run-col-01", "--task", "task-01", "--arm", "upstream"]).status,
        0,
      );
      const attemptDir = join(runsDir, "run-col-01", "attempts", "task-01", "upstream", "attempt-001");
      const result = JSON.parse(readFileSync(join(attemptDir, "result.json"), "utf8"));
      assert.equal(result.collection.status, "collected", `collection must be recorded: ${JSON.stringify(result.collection)}`);
      for (const name of ["porcelain-v2.txt", "staged.patch", "unstaged.patch", "ls-files.txt"]) {
        assert.ok(existsSync(join(attemptDir, "final-state", name)), `artifact ${name} must exist`);
      }
      const finalState = JSON.parse(readFileSync(join(attemptDir, "final-state.json"), "utf8"));
      assert.equal(finalState.status, "collected");
      assert.equal(finalState.artifacts.length, 4);
      for (const artifact of finalState.artifacts) {
        assert.match(artifact.sha256, /^[0-9a-f]{64}$/);
      }
      assert.ok(
        journalEvents(join(runsDir, "run-col-01")).some((event) => event.type === "attempt-collected" && event.status === "collected"),
        "journal must record collection",
      );

      // Error path: a git shim fails collector commands only.
      const shimDir = join(runsDir, "shim");
      mkdirSync(shimDir, { recursive: true });
      const realGit = spawnSync("which", ["git"], { encoding: "utf8" }).stdout.trim();
      writeFileSync(
        join(shimDir, "git"),
        `#!/usr/bin/env node
import { spawnSync } from "node:child_process";
const argv = process.argv.slice(2);
if (argv.includes("--porcelain=v2") || argv.includes("--binary") || argv[0] === "ls-files") {
  process.stderr.write("shim: collector command refused\\n");
  process.exit(128);
}
const run = spawnSync(${JSON.stringify(realGit)}, argv, { stdio: "inherit" });
process.exit(run.status ?? 1);
`,
        "utf8",
      );
      chmodSync(join(shimDir, "git"), 0o755);
      assert.equal(runCli(["prepare", "--runs-dir", runsDir, "--run-id", "run-col-02"]).status, 0);
      const dryError = spawnSync(process.execPath, [
        cli, "dry-run", "--runs-dir", runsDir, "--run-id", "run-col-02",
        "--task", "task-01", "--arm", "upstream",
      ], {
        cwd: repoRoot,
        encoding: "utf8",
        timeout: 120_000,
        env: { ...process.env, PATH: `${shimDir}:${process.env.PATH}` },
      });
      assert.equal(dryError.status, 0, `shim dry-run failed: ${(dryError.stderr || "").slice(0, 400)}`);
      const errorAttemptDir = join(runsDir, "run-col-02", "attempts", "task-01", "upstream", "attempt-001");
      const errorResult = JSON.parse(readFileSync(join(errorAttemptDir, "result.json"), "utf8"));
      assert.equal(errorResult.status, "collection-error", "collection error must set the attempt status");
      assert.equal(errorResult.collection.status, "error");
      assert.ok(errorResult.collection.errors.length >= 1, "collection errors must persist");
      const errorFinalState = JSON.parse(readFileSync(join(errorAttemptDir, "final-state.json"), "utf8"));
      assert.equal(errorFinalState.status, "error");
      const snapshot = JSON.parse(readFileSync(join(runsDir, "run-col-02", "snapshot.json"), "utf8"));
      assert.equal(snapshot.attempts["task-01:upstream:1"].status, "collection-error");
      assert.equal(snapshot.selection["task-01:upstream"], undefined, "collection-error must prevent auto-selection");
      assert.equal(runCli(["report", "--runs-dir", runsDir, "--run-id", "run-col-02"]).status, 0);
      const summary = JSON.parse(readFileSync(join(runsDir, "run-col-02", "summary.json"), "utf8"));
      assert.equal(summary.selection["task-01:upstream"], undefined, "report must not select a collection-error attempt");
      assert.equal(summary.slots.completed, 0);
      void readdirSync;
    } finally {
      rmSync(runsDir, { recursive: true, force: true });
    }
  });
});
