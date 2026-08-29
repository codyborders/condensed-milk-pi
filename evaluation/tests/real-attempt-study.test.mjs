/**
 * real-attempt study configuration tests.
 *
 * Optional study parameter: exact profile bytes written without
 * reserialization and checked against profileSha256, ordered extension
 * paths, explicit scorer digest, extra pins, and pin merge behavior.
 * Defaults must stay unchanged for the standard path.
 */

import { test, describe } from "node:test";
import assert from "node:assert/strict";
import { mkdtempSync, mkdirSync, readFileSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { createHash } from "node:crypto";
import {
  attemptPaths,
  prepareAttemptWorkspace,
  planRealInvocation,
  mergeCompletionPins,
} from "../runner/real-attempt.mjs";

const PROFILE_BYTES = '{\n  "schemaVersion": 1,\n  "profile": "eval-masking"\n}\n';

describe("real-attempt study configuration", () => {
  test("writes exact profile bytes without reserialization and rejects a digest mismatch", () => {
    const work = mkdtempSync(join(tmpdir(), "cm-study-"));
    try {
      const attemptDir = join(work, "attempt");
      mkdirSync(attemptDir, { recursive: true });
      const fixtureDir = join(work, "fixture");
      mkdirSync(fixtureDir, { recursive: true });
      const profileSha256 = createHash("sha256").update(PROFILE_BYTES).digest("hex");
      prepareAttemptWorkspace({
        attemptDir,
        fixtureDir,
        arm: { tracked: [], path: work },
        profile: "ignored-for-study",
        proxyBaseUrl: "http://127.0.0.1:1",
        dummyApiKey: "eval-dummy",
        study: { profileBytes: PROFILE_BYTES, profileSha256 },
      });
      const paths = attemptPaths(attemptDir);
      assert.equal(readFileSync(paths.homeConfig, "utf8"), PROFILE_BYTES);
      assert.throws(
        () =>
          prepareAttemptWorkspace({
            attemptDir: join(work, "attempt2"),
            fixtureDir,
            arm: { tracked: [], path: work },
            profile: "x",
            proxyBaseUrl: "http://127.0.0.1:1",
            dummyApiKey: "eval-dummy",
            study: { profileBytes: PROFILE_BYTES, profileSha256: "0".repeat(64) },
          }),
        /profile bytes do not match profileSha256/,
      );
    } finally {
      rmSync(work, { recursive: true, force: true });
    }
  });

  test("ordered extension paths become ordered -e argv entries with study pins and no scorer leakage", () => {
    const work = mkdtempSync(join(tmpdir(), "cm-study-"));
    try {
      const paths = attemptPaths(join(work, "attempt"));
      const plan = planRealInvocation({
        paths,
        manifest: {
          evaluation: { provider: "z-ai", model: "glm-5.3-flash", thinking: "high", piVersion: "0.84.2", tools: ["read"] },
        },
        task: { id: "task-01", prompt: "p" },
        arm: { commit: "f".repeat(40) },
        piCliPath: "/tmp/cli.js",
        study: {
          extensionPaths: ["/arm/index.ts", "/observer/obs.ts"],
          scorerSha256: "5".repeat(64),
          extraPins: { study: "masking", profileSha256: "6".repeat(64) },
        },
      });
      const first = plan.argv.indexOf("-e");
      const second = plan.argv.indexOf("-e", first + 1);
      assert.equal(plan.argv[first + 1], "/arm/index.ts");
      assert.equal(plan.argv[second + 1], "/observer/obs.ts");
      assert.equal(plan.pinned.scorerSha256, "5".repeat(64));
      assert.equal(plan.pinned.study, "masking");
      assert.equal(plan.pinned.profileSha256, "6".repeat(64));
      assert.equal(/scorer|solution|masking-assertions/.test(plan.argv.join(" ")), false);
      assert.equal(JSON.stringify(plan.env).includes("scorer"), false);
    } finally {
      rmSync(work, { recursive: true, force: true });
    }
  });

  test("completion pin merge preserves the reserved runtime pin and study pins", () => {
    const runtimePin = { digest: "8".repeat(64) };
    const merged = mergeCompletionPins(
      { schemaVersion: 1, taskId: "masking-task-01", arm: "fork", piRuntime: runtimePin },
      {
        promptSha256: "a".repeat(64),
        scorerSha256: "b".repeat(64),
        armCommit: "c".repeat(40),
        study: "masking",
        profileSha256: "d".repeat(64),
      },
    );
    assert.deepEqual(merged.piRuntime, runtimePin);
    assert.equal(merged.study, "masking");
    assert.equal(merged.profileSha256, "d".repeat(64));
    assert.equal(merged.promptSha256, "a".repeat(64));
  });

  test("default plan keeps the single standard extension and the standard scorer digest", () => {
    const work = mkdtempSync(join(tmpdir(), "cm-study-"));
    try {
      const paths = attemptPaths(join(work, "attempt"));
      const plan = planRealInvocation({
        paths,
        manifest: {
          evaluation: { provider: "z-ai", model: "glm-5.3-flash", thinking: "high", piVersion: "0.84.2", tools: ["read"] },
        },
        task: { id: "task-01", prompt: "p" },
        arm: { commit: "7".repeat(40) },
        piCliPath: "/tmp/cli.js",
      });
      assert.equal(plan.argv.filter((part) => part === "-e").length, 1);
      assert.ok(plan.argv[plan.argv.indexOf("-e") + 1].endsWith("index.ts"));
      assert.notEqual(plan.pinned.scorerSha256, "5".repeat(64));
      // Standard-path argv parity: the exact argv stays byte-identical
      // to the pre-observer standard layout, with no observer pins.
      assert.deepEqual(plan.argv, [
        process.execPath,
        "/tmp/cli.js",
        "--mode", "json",
        "-p",
        "--no-extensions",
        "-e", join(paths.implementation, "index.ts"),
        "--no-skills",
        "--no-prompt-templates",
        "--no-themes",
        "--no-context-files",
        "--offline",
        "--tools", "read",
        "--provider", "z-ai-eval",
        "--model", "glm-5.3-flash",
        "--thinking", "high",
        "--session-dir", paths.sessions,
        plan.prompt,
      ]);
      assert.equal("observerSha256" in plan.pinned, false);
      assert.equal("observerWrapperSha256" in plan.pinned, false);
    } finally {
      rmSync(work, { recursive: true, force: true });
    }
  });

  test("resolved study observers wrap the loaded extensions as [pre, extensions, post] and pin both digests", () => {
    const work = mkdtempSync(join(tmpdir(), "cm-study-obs-"));
    try {
      const attemptDir = join(work, "attempt");
      const paths = attemptPaths(attemptDir);
      const observers = {
        preExtensionPath: join(attemptDir, "observer", "pre.mjs"),
        postExtensionPath: join(attemptDir, "observer", "post.mjs"),
        observerSha256: "1".repeat(64),
        observerWrapperSha256: "2".repeat(64),
        generate: () => {},
        extract: () => {},
      };
      const plan = planRealInvocation({
        paths,
        manifest: {
          evaluation: { provider: "z-ai", model: "glm-5.3-flash", thinking: "high", piVersion: "0.84.2", tools: ["read"] },
        },
        task: { id: "task-01", prompt: "p" },
        arm: { commit: "7".repeat(40) },
        piCliPath: "/tmp/cli.js",
        // Explicit study extension paths load inside the observer sandwich.
        study: { extensionPaths: ["/elsewhere/index.ts"], observers },
      });
      const flags = plan.argv.flatMap((part, index) =>
        part === "-e" ? [plan.argv[index + 1]] : [],
      );
      assert.deepEqual(flags, [
        join(attemptDir, "observer", "pre.mjs"),
        "/elsewhere/index.ts",
        join(attemptDir, "observer", "post.mjs"),
      ]);
      assert.equal(plan.pinned.observerSha256, "1".repeat(64));
      assert.equal(plan.pinned.observerWrapperSha256, "2".repeat(64));
      // Without explicit extension paths the arm implementation loads in
      // the middle slot.
      const defaultPlan = planRealInvocation({
        paths,
        manifest: {
          evaluation: { provider: "z-ai", model: "glm-5.3-flash", thinking: "high", piVersion: "0.84.2", tools: ["read"] },
        },
        task: { id: "task-01", prompt: "p" },
        arm: { commit: "7".repeat(40) },
        piCliPath: "/tmp/cli.js",
        study: { observers },
      });
      const defaultFlags = defaultPlan.argv.flatMap((part, index) =>
        part === "-e" ? [defaultPlan.argv[index + 1]] : [],
      );
      assert.deepEqual(defaultFlags, [
        join(attemptDir, "observer", "pre.mjs"),
        join(paths.implementation, "index.ts"),
        join(attemptDir, "observer", "post.mjs"),
      ]);
    } finally {
      rmSync(work, { recursive: true, force: true });
    }
  });

  test("unresolved or malformed study observers refuse to plan", () => {
    const work = mkdtempSync(join(tmpdir(), "cm-study-obs-bad-"));
    try {
      const paths = attemptPaths(join(work, "attempt"));
      const base = {
        manifest: {
          evaluation: { provider: "z-ai", model: "glm-5.3-flash", thinking: "high", piVersion: "0.84.2", tools: ["read"] },
        },
        task: { id: "task-01", prompt: "p" },
        arm: { commit: "7".repeat(40) },
        piCliPath: "/tmp/cli.js",
      };
      assert.throws(
        () => planRealInvocation({ ...base, paths, study: { observers: { generate: () => {}, extract: () => {} } } }),
        /observer preExtensionPath must be an \.mjs path/,
      );
      assert.throws(
        () =>
          planRealInvocation({
            ...base,
            paths,
            study: {
              observers: {
                preExtensionPath: join(work, "attempt", "observer", "pre.mjs"),
                postExtensionPath: join(work, "attempt", "observer", "post.mjs"),
                observerSha256: "short",
                observerWrapperSha256: "2".repeat(64),
              },
            },
          }),
        /observer observerSha256 must be a 64-hex/,
      );
    } finally {
      rmSync(work, { recursive: true, force: true });
    }
  });
});
