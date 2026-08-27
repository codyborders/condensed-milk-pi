import { test, describe } from "node:test";
import assert from "node:assert/strict";
import { fileURLToPath } from "node:url";
import { dirname, join } from "node:path";
import { mkdtempSync, existsSync, readFileSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { spawnSync } from "node:child_process";

const repoRoot = join(dirname(fileURLToPath(import.meta.url)), "..", "..");
const cli = join(repoRoot, "evaluation", "runner", "cli.mjs");

function runCli(args) {
  return spawnSync(process.execPath, [cli, ...args], { cwd: repoRoot, encoding: "utf8", timeout: 120_000 });
}

describe("pair fixture-before guard", () => {
  test("arms of one pair must start from identical fixture bytes", () => {
    const runsDir = mkdtempSync(join(tmpdir(), "cm-eval-pair-guard-"));
    const runDir = join(runsDir, "run-pair-01");
    const readmePath = join(repoRoot, "evaluation", "cache", "fixtures", "task-09", "README.md");
    const saved = existsSync(readmePath) ? readFileSync(readmePath, "utf8") : null;
    try {
      assert.ok(saved !== null, "fixture cache must exist for task-09 (run evaluation:fixtures first)");
      assert.equal(runCli(["prepare", "--runs-dir", runsDir, "--run-id", "run-pair-01"]).status, 0);
      const first = runCli(["dry-run", "--runs-dir", runsDir, "--run-id", "run-pair-01", "--task", "task-09", "--arm", "upstream"]);
      assert.equal(first.status, 0, `first arm must run: ${first.stderr.slice(0, 300)}`);
      const firstAttempt = join(runDir, "attempts", "task-09", "upstream", "attempt-001");
      const before = JSON.parse(readFileSync(join(firstAttempt, "fixture-before.json"), "utf8"));
      assert.equal(typeof before.contentSha256, "string");
      assert.equal(typeof before.gitStateSha256, "string");

      writeFileSync(readmePath, `${saved}tampered pair bytes\n`, "utf8");
      const second = runCli(["dry-run", "--runs-dir", runsDir, "--run-id", "run-pair-01", "--task", "task-09", "--arm", "fork"]);
      assert.notEqual(second.status, 0, "diverged fixture must refuse the pair");
      assert.ok((second.stderr || "").includes("pair"), `stderr must name the pair refusal: ${(second.stderr || "").slice(0, 300)}`);
      assert.equal(
        existsSync(join(runDir, "attempts", "task-09", "fork", "attempt-001")),
        false,
        "pair refusal must happen before reservation of the second arm",
      );
    } finally {
      if (saved !== null) writeFileSync(readmePath, saved, "utf8");
      rmSync(runsDir, { recursive: true, force: true });
    }
  });
});
