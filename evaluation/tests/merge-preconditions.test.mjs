/**
 * Task-10 merge precondition tests.
 *
 * Scope:
 * - the fixture generator sets a repository-local Git identity before
 *   constructing the declared failed merge (never only `git -c`);
 * - every declared merge precondition (MERGE_HEAD against the intended
 *   branch head, unmerged index stages 1/2/3 for the declared conflict
 *   path, conflict markers, unmerged status) is validated;
 * - removing any single precondition fails validation;
 * - generation fails before cache publication when the declared
 *   preconditions do not materialize.
 */

import { test, describe } from "node:test";
import assert from "node:assert/strict";
import { fileURLToPath } from "node:url";
import { dirname, join } from "node:path";
import { existsSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { spawnSync } from "node:child_process";
import { publishFixtureCache } from "../lib/cache.mjs";
import { generateFixture, validateFixturePostconditions } from "../lib/fixtures.mjs";
import { loadManifestFile } from "../lib/manifest.mjs";

const repoRoot = join(dirname(fileURLToPath(import.meta.url)), "..", "..");
const manifest = loadManifestFile(join(repoRoot, "evaluation", "task-manifest.json"));

const CONFLICT_PATH = "src/merge-driver.js";

export function task10() {
  return manifest.tasks.find((task) => task.id === "task-10");
}

export function tempDir() {
  return mkdtempSync(join(tmpdir(), "cm-eval-merge-pre-"));
}

export function git(cwd, argv) {
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
  return result.stdout.trim();
}

export function freshFixture(dir) {
  const fixtureDir = join(dir, "f");
  generateFixture({ repoRoot, task: task10(), outDir: fixtureDir });
  return fixtureDir;
}

describe("task-10 merge construction", () => {
  test("sets a repository-local git identity before the merge", () => {
    const dir = tempDir();
    try {
      const fixtureDir = freshFixture(dir);
      assert.equal(git(fixtureDir, ["config", "--local", "user.name"]), "Eval Fixture");
      assert.equal(git(fixtureDir, ["config", "--local", "user.email"]), "fixture@example.invalid");
    } finally {
      rmSync(dir, { recursive: true, force: true });
    }
  });

  test("MERGE_HEAD pointing at the wrong commit fails validation", () => {
    const dir = tempDir();
    try {
      const fixtureDir = freshFixture(dir);
      const masterHead = git(fixtureDir, ["rev-parse", "refs/heads/master"]);
      writeFileSync(join(fixtureDir, ".git", "MERGE_HEAD"), `${masterHead}\n`, "utf8");
      const validation = validateFixturePostconditions({ task: task10(), fixtureDir });
      assert.equal(validation.ok, false, "a MERGE_HEAD that is not the feature head must fail");
      assert.ok(
        validation.errors.some((error) => error.includes("MERGE_HEAD") && error.includes("feature")),
        `errors must name the intended branch: ${JSON.stringify(validation.errors)}`,
      );
    } finally {
      rmSync(dir, { recursive: true, force: true });
    }
  });

  test("resolving the index removes the unmerged stages and status and fails validation", () => {
    const dir = tempDir();
    try {
      const fixtureDir = freshFixture(dir);
      git(fixtureDir, ["add", CONFLICT_PATH]);
      const validation = validateFixturePostconditions({ task: task10(), fixtureDir });
      assert.equal(validation.ok, false, "a resolved index must fail");
      assert.ok(
        validation.errors.some((error) => error.includes(CONFLICT_PATH) && /stage/i.test(error)),
        `errors must name the missing stages: ${JSON.stringify(validation.errors)}`,
      );
      assert.ok(
        validation.errors.some((error) => error.includes(CONFLICT_PATH) && /unmerged status/i.test(error)),
        `errors must name the missing unmerged status: ${JSON.stringify(validation.errors)}`,
      );
    } finally {
      rmSync(dir, { recursive: true, force: true });
    }
  });

  test("stripping conflict markers fails validation even with the index still unmerged", () => {
    const dir = tempDir();
    try {
      const fixtureDir = freshFixture(dir);
      const marked = readFileSync(join(fixtureDir, CONFLICT_PATH), "utf8");
      const stripped = marked
        .split("\n")
        .filter((line) => !line.startsWith("<<<<<<<") && !line.startsWith("=======") && !line.startsWith(">>>>>>>"))
        .join("\n");
      writeFileSync(join(fixtureDir, CONFLICT_PATH), stripped, "utf8");
      const validation = validateFixturePostconditions({ task: task10(), fixtureDir });
      assert.equal(validation.ok, false, "missing conflict markers must fail");
      assert.ok(
        validation.errors.some((error) => error.includes(CONFLICT_PATH) && /conflict markers/i.test(error)),
        `errors must name the missing markers: ${JSON.stringify(validation.errors)}`,
      );
    } finally {
      rmSync(dir, { recursive: true, force: true });
    }
  });

  test("removing any single marker kind alone fails validation", () => {
    const dir = tempDir();
    const separators = [
      ["=======", "middle separator"],
      [">>>>>>>", "closing marker"],
    ];
    try {
      for (const [marker, label] of separators) {
        const fixtureDir = freshFixture(dir);
        const marked = readFileSync(join(fixtureDir, CONFLICT_PATH), "utf8");
        const mutilated = marked
          .split("\n")
          .filter((line) => !line.startsWith(marker))
          .join("\n");
        writeFileSync(join(fixtureDir, CONFLICT_PATH), mutilated, "utf8");
        const validation = validateFixturePostconditions({ task: task10(), fixtureDir });
        assert.equal(validation.ok, false, `missing ${label} alone must fail`);
        assert.ok(
          validation.errors.some((error) => error.includes(CONFLICT_PATH) && /conflict markers/i.test(error)),
          `errors must name the missing ${label}: ${JSON.stringify(validation.errors)}`,
        );
        rmSync(fixtureDir, { recursive: true, force: true });
      }
    } finally {
      rmSync(dir, { recursive: true, force: true });
    }
  });

  test("generation fails before cache publication when declared conflicts do not materialize", () => {
    const dir = tempDir();
    try {
      const synthetic = structuredClone(task10());
      synthetic.fixture.git.post = [
        { argv: ["git", "merge", "feature"], expectFailure: true, conflictPaths: ["src/declared-conflict.js"] },
      ];
      assert.throws(
        () => generateFixture({ repoRoot, task: synthetic, outDir: join(dir, "f") }),
        /src\/declared-conflict\.js/,
        "generation must fail and name the unmet declared conflict path",
      );

      const cacheRoot = join(dir, "cache");
      assert.throws(
        () => publishFixtureCache({ repoRoot, task: synthetic, cacheRoot }),
        /src\/declared-conflict\.js/,
        "publication must fail on the same precondition",
      );
      assert.equal(
        existsSync(join(cacheRoot, synthetic.id)),
        false,
        "nothing may be published when a merge precondition is missing",
      );
    } finally {
      rmSync(dir, { recursive: true, force: true });
    }
  });
});
