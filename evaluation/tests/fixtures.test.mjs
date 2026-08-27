/**
 * Fixture generation tests.
 *
 * Scope:
 * - fixtures are generated deterministically from manifest data only:
 *   regenerating a task yields a byte-identical tree, and both evaluation
 *   arms start from byte-identical worktrees with identical git history.
 */

import { test, describe } from "node:test";
import assert from "node:assert/strict";
import { fileURLToPath } from "node:url";
import { dirname, join } from "node:path";
import { mkdtempSync, readdirSync, readFileSync, rmSync, statSync, existsSync } from "node:fs";
import { tmpdir } from "node:os";
import { spawnSync, spawn } from "node:child_process";
import { generateFixture, hashTree, prepareArmWorktree } from "../lib/fixtures.mjs";
import { loadManifestFile } from "../lib/manifest.mjs";

const repoRoot = join(dirname(fileURLToPath(import.meta.url)), "..", "..");
const manifest = loadManifestFile(join(repoRoot, "evaluation", "task-manifest.json"));

export function tempDir() {
  return mkdtempSync(join(tmpdir(), "cm-eval-fixtures-"));
}

export function taskById(id) {
  return manifest.tasks.find((task) => task.id === id);
}

export function gitOutput(cwd, argv) {
  return spawnSync("git", argv, { cwd, encoding: "utf8" }).stdout.trim();
}

describe("deterministic fixture generation", () => {
  test("regeneration is byte-identical and both arms start identical", () => {
    const task = taskById("task-01");
    const dirA = tempDir();
    const dirB = tempDir();
    try {
      generateFixture({ repoRoot, task, outDir: join(dirA, "a") });
      generateFixture({ repoRoot, task, outDir: join(dirB, "b") });
      assert.equal(hashTree(join(dirA, "a")), hashTree(join(dirB, "b")));

      const upstream = prepareArmWorktree({ repoRoot, task, arm: "upstream", parentDir: dirA });
      const fork = prepareArmWorktree({ repoRoot, task, arm: "fork", parentDir: dirB });
      assert.equal(hashTree(join(upstream, "worktree")), hashTree(join(fork, "worktree")));
      assert.equal(
        gitOutput(join(upstream, "worktree"), ["rev-parse", "HEAD"]),
        gitOutput(join(fork, "worktree"), ["rev-parse", "HEAD"]),
      );
    } finally {
      rmSync(dirA, { recursive: true, force: true });
      rmSync(dirB, { recursive: true, force: true });
    }
  });

  test("all 20 tasks generate with realistic long-form sizes", () => {
    const dir = tempDir();
    try {
      const sizes = new Map();
      for (const task of manifest.tasks) {
        const outDir = join(dir, task.id);
        generateFixture({ repoRoot, task, outDir });
        sizes.set(task.id, treeBytes(outDir));
      }
      for (const task of manifest.tasks) {
        if (task.scale === "long") {
          assert.ok(
            sizes.get(task.id) >= 300_000,
            `${task.id} must generate at least 300KB of fixture content, got ${sizes.get(task.id)}`,
          );
        } else {
          assert.ok(sizes.get(task.id) < 300_000, `${task.id} standard fixture should stay small`);
        }
      }
      const longIds = manifest.tasks.filter((task) => task.scale === "long").map((task) => task.id);
      assert.deepEqual(longIds, ["task-16", "task-17"]);
      assert.equal(readdirSync(join(dir, "task-16", "src", "gen")).length, 45);
      assert.equal(readdirSync(join(dir, "task-17", "src", "services")).length, 60);
      const logSize = statSync(join(dir, "task-16", "data", "server.log")).size;
      assert.ok(logSize >= 500_000, `task-16 log must be large, got ${logSize}`);
    } finally {
      rmSync(dir, { recursive: true, force: true });
    }
  });

  test("task-09 fixture starts with staged, unstaged, and untracked changes", () => {
    const dir = tempDir();
    try {
      generateFixture({ repoRoot, task: taskById("task-09"), outDir: join(dir, "f") });
      const status = gitOutput(join(dir, "f"), ["status", "--porcelain"]);
      assert.ok(status.includes("M  README.md"), "README fix must be staged");
      assert.ok(status.includes("M  lib/util.js"), "util fix must be staged");
      assert.ok(status.includes(" M src/app.js"), "app experiment must be unstaged");
      assert.ok(status.includes("?? tmp/"), "stray tmp files must be untracked");
    } finally {
      rmSync(dir, { recursive: true, force: true });
    }
  });

  test("task-10 fixture starts mid-merge with conflict markers", () => {
    const dir = tempDir();
    try {
      generateFixture({ repoRoot, task: taskById("task-10"), outDir: join(dir, "f") });
      const mergeFile = readFileSync(join(dir, "f", "src", "merge-driver.js"), "utf8");
      assert.ok(mergeFile.includes("<<<<<<<"), "conflict markers must be present");
      assert.ok(
        existsSync(join(dir, "f", ".git", "MERGE_HEAD")),
        "merge must be in progress",
      );
    } finally {
      rmSync(dir, { recursive: true, force: true });
    }
  });

  test("git history and identity fixtures start as declared", () => {
    const dir = tempDir();
    try {
      generateFixture({ repoRoot, task: taskById("task-11"), outDir: join(dir, "t11") });
      assert.equal(gitOutput(join(dir, "t11"), ["rev-list", "--count", "HEAD"]), "5");
      const bugCommit = gitOutput(join(dir, "t11"), [
        "log",
        "--format=%H",
        "--grep=^fix: tighten age boundary handling$",
      ]);
      assert.equal(bugCommit, "681d1dbfe0cfdc0c9ddcd82539cd416489d55ee3");

      generateFixture({ repoRoot, task: taskById("task-12"), outDir: join(dir, "t12") });
      const identity = spawnSync("git", ["config", "--local", "user.email"], {
        cwd: join(dir, "t12"),
        encoding: "utf8",
        env: { PATH: process.env.PATH, GIT_CONFIG_GLOBAL: "/dev/null", GIT_CONFIG_NOSYSTEM: "1" },
      });
      assert.notEqual(identity.status, 0, "task-12 must start without a local identity");
    } finally {
      rmSync(dir, { recursive: true, force: true });
    }
  });

  test("every task starts failing its primary suite", () => {
    const dir = tempDir();
    try {
      for (const task of manifest.tasks) {
        generateFixture({ repoRoot, task, outDir: join(dir, task.id) });
      }
      const suites = [
        ["task-01", ["python3", "tests/test_stats.py"]],
        ["task-02", ["python3", "tests/test_cart.py"]],
        ["task-03", ["python3", "tests/test_inventory.py"]],
        ["task-04", ["python3", "tests/test_shellargs.py"]],
        ["task-05", ["node", join(repoRoot, "node_modules", "typescript", "bin", "tsc"), "-p", "."]],
        ["task-06", ["node", "tests/test_url_utils.js"]],
        ["task-08", ["node", "tests/test_kv_cache.js"]],
        ["task-10", ["node", "tests/test_merge_driver.js"]],
        ["task-11", ["python3", "tests/test_validate.py"]],
        ["task-13", ["node", "build.js"]],
        ["task-15", ["node", "tests/test_config_loader.js"]],
        ["task-16", ["python3", "tests/test_pipeline.py"]],
        ["task-17", ["node", "tests/test_aggregate.js"]],
        ["task-18", ["python3", "tests/test_normalizer.py"]],
        ["task-19", ["node", "tests/test_env_loader.js"]],
        ["task-20", ["python3", "tests/test_rates.py"]],
        ["task-20", ["node", "tests/test_stats.js"]],
      ];
      for (const [taskId, argv] of suites) {
        const result = spawnSync(argv[0], argv.slice(1), {
          cwd: join(dir, taskId),
          encoding: "utf8",
          env: { PATH: process.env.PATH, GIT_CONFIG_GLOBAL: "/dev/null", GIT_CONFIG_NOSYSTEM: "1" },
        });
        assert.notEqual(result.status, 0, `${taskId} must fail ${argv.join(" ")} before any fix`);
      }
      const entries14 = readFileSync(join(dir, "task-14", "config", "entries.json"), "utf8");
      assert.ok(
        entries14.includes('"retries": "many"'),
        "task-14 must start with the invalid retries entry",
      );
      const prices07 = readFileSync(join(dir, "task-07", "src", "prices.js"), "utf8");
      assert.equal(
        prices07.split("padStart").length - 1,
        2,
        "task-07 must start with the duplicated padding logic",
      );
    } finally {
      rmSync(dir, { recursive: true, force: true });
    }
  });
  test("concurrent cache regeneration never corrupts or fails", async () => {
    const repoCli = join(repoRoot, "evaluation", "runner", "cli.mjs");
    const before = hashTree(join(repoRoot, "evaluation", "cache", "fixtures", "task-01"));
    const procs = [
      spawn(process.execPath, [repoCli, "fixtures"], { stdio: "pipe" }),
      spawn(process.execPath, [repoCli, "fixtures"], { stdio: "pipe" }),
    ];
    const codes = await Promise.all(
      procs.map((child) => new Promise((resolve) => child.on("close", (code) => resolve(code)))),
    );
    assert.deepEqual(codes, [0, 0], `both concurrent regenerations must succeed, got ${codes.join(",")}`);
    const after = hashTree(join(repoRoot, "evaluation", "cache", "fixtures", "task-01"));
    assert.equal(after, before, "published cache hash must stay identical");
  });
});

function treeBytes(dir) {
  let total = 0;
  const stack = [""];
  while (stack.length > 0) {
    const prefix = stack.pop();
    for (const name of readdirSync(join(dir, prefix))) {
      if (name === ".git") continue;
      const relative = prefix ? `${prefix}/${name}` : name;
      const absolute = join(dir, relative);
      if (statSync(absolute).isDirectory()) {
        stack.push(relative);
      } else {
        total += statSync(absolute).size;
      }
    }
  }
  return total;
}
