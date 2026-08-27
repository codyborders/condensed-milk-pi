import { test } from "node:test";
import assert from "node:assert/strict";
import { spawnSync } from "node:child_process";
import { fileURLToPath } from "node:url";
import { dirname, join } from "node:path";

const directory = dirname(fileURLToPath(import.meta.url));

test("pinned benchmark rejects a worktree at the wrong commit before running cases", () => {
  const result = spawnSync(process.execPath, ["--import", "tsx", join(directory, "context-hook.mjs"), "--implementation-root", join(directory, ".."), "--expected-commit", "0000000000000000000000000000000000000000"], {
    cwd: join(directory, ".."),
    encoding: "utf8",
    timeout: 10_000,
  });
  assert.notEqual(result.status, 0);
  assert.match(result.stderr, /expected commit|clean Git worktree/i);
});
