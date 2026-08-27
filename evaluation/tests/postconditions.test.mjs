/**
 * Fixture postcondition validation tests.
 *
 * Scope:
 * - a generated fixture must match its declared initial conditions
 *   (staged, unstaged, untracked, merge-in-progress) before any attempt
 *   may reserve against it.
 */

import { test, describe } from "node:test";
import assert from "node:assert/strict";
import { fileURLToPath } from "node:url";
import { dirname, join } from "node:path";
import { mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { spawnSync } from "node:child_process";
import { generateFixture, validateFixturePostconditions } from "../lib/fixtures.mjs";
import { loadManifestFile } from "../lib/manifest.mjs";

const repoRoot = join(dirname(fileURLToPath(import.meta.url)), "..", "..");
const manifest = loadManifestFile(join(repoRoot, "evaluation", "task-manifest.json"));

function taskById(id) {
  return manifest.tasks.find((task) => task.id === id);
}

function git(cwd, argv) {
  const result = spawnSync("git", argv, {
    cwd,
    encoding: "utf8",
    env: {
      PATH: process.env.PATH ?? "/usr/bin:/bin",
      GIT_CONFIG_GLOBAL: "/dev/null",
      GIT_CONFIG_NOSYSTEM: "1",
      HOME: cwd,
    },
  });
  if (result.status !== 0) {
    throw new Error(`git ${argv.join(" ")} failed: ${result.stderr}`);
  }
  return result.stdout;
}

describe("fixture postcondition validation", () => {
  test("task-09 accepts the declared staged/unstaged/untracked state and rejects an unstaged alteration", () => {
    const dir = mkdtempSync(join(tmpdir(), "cm-eval-postcond-"));
    try {
      const fixtureDir = join(dir, "f");
      generateFixture({ repoRoot, task: taskById("task-09"), outDir: fixtureDir });
      const valid = validateFixturePostconditions({ task: taskById("task-09"), fixtureDir });
      assert.equal(valid.ok, true, `declared state must validate: ${JSON.stringify(valid.errors)}`);

      git(fixtureDir, ["reset", "-q"]);
      const altered = validateFixturePostconditions({ task: taskById("task-09"), fixtureDir });
      assert.equal(altered.ok, false, "unstaging a declared staged fix must invalidate the fixture");
      assert.ok(
        altered.errors.some((error) => error.includes("README.md")),
        `errors must name the unstaged path: ${JSON.stringify(altered.errors)}`,
      );
    } finally {
      rmSync(dir, { recursive: true, force: true });
    }
  });
});
