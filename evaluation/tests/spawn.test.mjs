import { test, describe } from "node:test";
import assert from "node:assert/strict";
import { fileURLToPath } from "node:url";
import { dirname, join } from "node:path";
import { mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { runSubprocess } from "../runner/spawn.mjs";

const repoRoot = join(dirname(fileURLToPath(import.meta.url)), "..", "..");

describe("spawn process ownership", () => {
  test("quick child exits with code and no stale parent handlers", async () => {
    const dir = mkdtempSync(join(tmpdir(), "cm-eval-spawn-"));
    const before = process.listenerCount("SIGINT");
    try {
      const outcome = await runSubprocess({
        argv: [process.execPath, "-e", "process.exit(0)"],
        cwd: dir,
        env: { PATH: process.env.PATH ?? "/usr/bin:/bin" },
        timeoutMs: 30_000,
        stdoutPath: join(dir, "out.txt"),
        stderrPath: join(dir, "err.txt"),
      });
      assert.equal(outcome.code, 0);
      assert.equal(outcome.teardown.triggered, false, "no teardown may run for a clean exit");
      assert.equal(typeof outcome.pid, "number", "child pid must be recorded");
      assert.equal(process.listenerCount("SIGINT"), before, "SIGINT handlers must be removed after settlement");
    } finally {
      rmSync(dir, { recursive: true, force: true });
    }
  });
});
