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

describe("runner fixture guard", () => {
  test("altered fixture cache entry refuses dry-run before any attempt is created", () => {
    const runsDir = mkdtempSync(join(tmpdir(), "cm-eval-runner-guard-"));
    const runDir = join(runsDir, "run-guard-01");
    const mergeHead = join(repoRoot, "evaluation", "cache", "fixtures", "task-10", ".git", "MERGE_HEAD");
    const saved = existsSync(mergeHead) ? readFileSync(mergeHead) : null;
    try {
      assert.ok(existsSync(mergeHead), "fixture cache must exist (run evaluation:fixtures first)");
      assert.equal(runCli(["prepare", "--runs-dir", runsDir, "--run-id", "run-guard-01"]).status, 0);
      rmSync(mergeHead);
      const dry = runCli(["dry-run", "--runs-dir", runsDir, "--run-id", "run-guard-01", "--task", "task-10", "--arm", "upstream"]);
      assert.notEqual(dry.status, 0, "altered fixture must be refused");
      assert.ok((dry.stderr || "").includes("fixture"), `stderr must explain: ${(dry.stderr || "").slice(0, 300)}`);
      assert.equal(existsSync(join(runDir, "attempts", "task-10", "upstream", "attempt-001")), false, "refusal must precede reservation");
    } finally {
      if (saved !== null) writeFileSync(mergeHead, saved);
      rmSync(runsDir, { recursive: true, force: true });
    }
  });
});
