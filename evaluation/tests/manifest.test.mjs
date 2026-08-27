/**
 * Manifest contract tests.
 *
 * Scope: schemaVersion 2 manifests are validated strictly. The checked-in
 * evaluation/task-manifest.json must be a valid manifest with exactly 20
 * deterministic tasks and the fixed evaluation pins.
 */

import { test, describe } from "node:test";
import assert from "node:assert/strict";
import { fileURLToPath } from "node:url";
import { dirname, join } from "node:path";
import { validateManifest, loadManifestFile, loadTaskData } from "../lib/manifest.mjs";

const repoRoot = join(dirname(fileURLToPath(import.meta.url)), "..", "..");
const manifestPath = join(repoRoot, "evaluation", "task-manifest.json");
import { readFileSync } from "node:fs";

export function makeTask(number) {
  const id = `task-${String(number).padStart(2, "0")}`;
  return {
    number,
    id,
    category: "python",
    scale: "standard",
    title: `Deterministic task ${number}`,
    prompt: `Fix the failing check for ${id}.`,
    fixture: {
      files: [{ path: "README.md", content: `fixture ${id}\n` }],
      generate: [],
      mutations: [],
      git: {
        author: { name: "Eval Fixture", email: "fixture@example.invalid" },
        startDate: "2026-01-01T00:00:00Z",
        commits: [{ message: "chore: import fixture", paths: ["all"] }],
        post: [],
      },
    },
  };
}

export function makeValidManifest() {
  return {
    schemaVersion: 2,
    evaluation: {
      provider: "z-ai",
      model: "glm-5.3-flash",
      thinking: "high",
      profile: "qwen-vllm",
      piVersion: "0.84.2",
      tools: ["read", "bash", "edit", "write", "grep", "find", "ls"],
      timeoutMsPerAttempt: 3600000,
      arms: [
        {
          name: "upstream",
          role: "baseline",
          commit: "71f9e396951c42687f0c3456727b2b5c8c625da1",
        },
        {
          name: "fork",
          role: "treatment",
          commit: "85e9af185c2a6416ea37791cf5d08e57c399c0e0",
        },
      ],
    },
    tasks: Array.from({ length: 20 }, (_, index) => makeTask(index + 1)),
  };
}

describe("strict manifest rejection", () => {
  test("accepts a valid manifest", () => {
    const result = validateManifest(makeValidManifest());
    assert.equal(result.ok, true, JSON.stringify(result.errors ?? []));
    assert.equal(result.value.tasks.length, 20);
  });

  test("rejects wrong schemaVersion", () => {
    for (const schemaVersion of [1, 3, "2", null]) {
      const manifest = makeValidManifest();
      manifest.schemaVersion = schemaVersion;
      const result = validateManifest(manifest);
      assert.equal(result.ok, false, `schemaVersion=${String(schemaVersion)} must fail`);
      assert.ok(result.errors.some((error) => error.includes("schemaVersion")));
    }
  });

  test("rejects unknown top-level and evaluation keys", () => {
    const extraTop = makeValidManifest();
    extraTop.evaluationStatus = "not-run";
    assert.equal(validateManifest(extraTop).ok, false);

    const extraEval = makeValidManifest();
    extraEval.evaluation.extraPin = "x";
    const result = validateManifest(extraEval);
    assert.equal(result.ok, false);
    assert.ok(result.errors.some((error) => error.includes("extraPin")));
  });

  test("rejects task counts other than exactly 20", () => {
    const nineteen = makeValidManifest();
    nineteen.tasks.pop();
    assert.equal(validateManifest(nineteen).ok, false);

    const twentyOne = makeValidManifest();
    twentyOne.tasks.push(makeTask(21));
    assert.equal(validateManifest(twentyOne).ok, false);
  });

  test("rejects malformed task entries", () => {
    const duplicate = makeValidManifest();
    duplicate.tasks[4].id = duplicate.tasks[3].id;
    assert.equal(validateManifest(duplicate).ok, false);

    const renumbered = makeValidManifest();
    renumbered.tasks[6].number = 99;
    assert.equal(validateManifest(renumbered).ok, false);

    const extraKey = makeValidManifest();
    extraKey.tasks[0].status = "not-run";
    assert.equal(validateManifest(extraKey).ok, false);

    const badCategory = makeValidManifest();
    badCategory.tasks[0].category = "vibes";
    assert.equal(validateManifest(badCategory).ok, false);

    const badScale = makeValidManifest();
    badScale.tasks[0].scale = "huge";
    assert.equal(validateManifest(badScale).ok, false);

    const emptyPrompt = makeValidManifest();
    emptyPrompt.tasks[0].prompt = "   ";
    assert.equal(validateManifest(emptyPrompt).ok, false);

    const missingTasks = makeValidManifest();
    delete missingTasks.tasks;
    assert.equal(validateManifest(missingTasks).ok, false);
  });

  test("rejects unsafe or malformed fixture specs", () => {
    for (const badPath of ["/etc/passwd", "../escape.txt", "a/../../b", ".git/config", ""]) {
      const manifest = makeValidManifest();
      manifest.tasks[0].fixture.files[0].path = badPath;
      const result = validateManifest(manifest);
      assert.equal(result.ok, false, `path=${JSON.stringify(badPath)} must fail`);
    }

    const badTemplate = makeValidManifest();
    badTemplate.tasks[0].fixture.generate = [
      { path: "gen/x.py", template: "magic", count: 2, seed: 1 },
    ];
    assert.equal(validateManifest(badTemplate).ok, false);

    const shellPost = makeValidManifest();
    shellPost.tasks[0].fixture.git.post = [
      { argv: ["sh", "-c", "rm -rf /"], expectFailure: false },
    ];
    assert.equal(validateManifest(shellPost).ok, false);

    const stringArgv = makeValidManifest();
    stringArgv.tasks[0].fixture.git.post = [{ argv: "git status", expectFailure: false }];
    assert.equal(validateManifest(stringArgv).ok, false);

    const extraFixtureKey = makeValidManifest();
    extraFixtureKey.tasks[0].fixture.solutions = "inline";
    assert.equal(validateManifest(extraFixtureKey).ok, false);

    const badMutation = makeValidManifest();
    badMutation.tasks[0].fixture.mutations = [{ path: "README.md", from: "a", to: 3 }];
    assert.equal(validateManifest(badMutation).ok, false);
  });

  test("manifest carries no credential source or developer paths", () => {
    const raw = readFileSync(manifestPath, "utf8");
    assert.ok(!raw.includes("credentialSource"), "credentialSource must not be committed");
    assert.ok(!raw.includes("/Users/"), "developer-specific paths must not be committed");
  });

  test("rejects invalid evaluation pins", () => {
    const badCommit = makeValidManifest();
    badCommit.evaluation.arms[0].commit = "71f9e39";
    assert.equal(validateManifest(badCommit).ok, false);

    const badThinking = makeValidManifest();
    badThinking.evaluation.thinking = "ultra";
    assert.equal(validateManifest(badThinking).ok, false);

    const dupTools = makeValidManifest();
    dupTools.evaluation.tools = ["read", "read"];
    assert.equal(validateManifest(dupTools).ok, false);

    const badArms = makeValidManifest();
    badArms.evaluation.arms = [badArms.evaluation.arms[0]];
    assert.equal(validateManifest(badArms).ok, false);

    const badTimeout = makeValidManifest();
    badTimeout.evaluation.timeoutMsPerAttempt = 0;
    assert.equal(validateManifest(badTimeout).ok, false);

    const badPiVersion = makeValidManifest();
    badPiVersion.evaluation.piVersion = "latest";
    assert.equal(validateManifest(badPiVersion).ok, false);

    const emptyProvider = makeValidManifest();
    emptyProvider.evaluation.provider = "";
    assert.equal(validateManifest(emptyProvider).ok, false);
  });
});

describe("checked-in task-manifest.json", () => {
  test("loads and validates with exactly 20 tasks and the fixed pins", () => {
    const manifestPath = join(repoRoot, "evaluation", "task-manifest.json");
    const manifest = loadManifestFile(manifestPath);
    assert.equal(manifest.schemaVersion, 2);
    assert.equal(manifest.tasks.length, 20);
    assert.equal(manifest.evaluation.provider, "z-ai");
    assert.equal(manifest.evaluation.model, "glm-5.3-flash");
    assert.equal(manifest.evaluation.thinking, "high");
    assert.equal(manifest.evaluation.profile, "qwen-vllm");
    assert.equal(manifest.evaluation.piVersion, "0.84.2");
    assert.deepEqual(
      manifest.evaluation.arms.map((arm) => arm.commit),
      [
        "71f9e396951c42687f0c3456727b2b5c8c625da1",
        "85e9af185c2a6416ea37791cf5d08e57c399c0e0",
      ],
    );
    const categories = new Set(manifest.tasks.map((task) => task.category));
    for (const required of [
      "python",
      "typescript",
      "javascript",
      "git",
      "build",
      "cache",
      "parser",
    ]) {
      assert.ok(categories.has(required), `missing category ${required}`);
    }
    const longTasks = manifest.tasks.filter((task) => task.scale === "long");
    assert.ok(longTasks.length >= 2, "need at least two long tool-heavy tasks");
  });

  test("hidden scorer data exists and prompts never leak it", () => {
    const manifest = loadManifestFile(join(repoRoot, "evaluation", "task-manifest.json"));
    for (const task of manifest.tasks) {
      const taskData = loadTaskData(repoRoot, task.id);
      assert.ok(taskData.assertions.length > 0, `${task.id} needs assertions`);
      assert.ok(taskData.solution.files.length + taskData.solution.commands.length > 0, `${task.id} needs a solution`);
      const needles = collectNeedles(taskData.assertions);
      for (const needle of needles) {
        assert.ok(
          !task.prompt.includes(needle),
          `${task.id} prompt leaks assertion needle: ${JSON.stringify(needle)}`,
        );
      }
      for (const file of taskData.solution.files) {
        assert.ok(
          !task.prompt.includes(file.content),
          `${task.id} prompt embeds solution file content`,
        );
      }
    }
  });
});

function collectNeedles(assertions) {
  const needles = new Set();
  for (const assertion of assertions) {
    for (const key of ["equals", "needle"]) {
      if (typeof assertion[key] === "string" && assertion[key].length >= 4) {
        needles.add(assertion[key]);
      }
    }
    for (const key of ["all", "stdoutContains"]) {
      if (Array.isArray(assertion[key])) {
        for (const entry of assertion[key]) {
          if (typeof entry === "string" && entry.length >= 4) needles.add(entry);
        }
      }
    }
  }
  return [...needles];
}
