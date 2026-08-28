/**
 * Completed pinned.json retention tests (masking real run).
 *
 * The completion rewrite must retain repetition plus fixture content
 * and Git-state digests, profile, observer and wrapper digests, study,
 * and the runtime pin. Driven by the fake-provider fake-runtime path.
 */

import { test, describe } from "node:test";
import assert from "node:assert/strict";
import { mkdtempSync, rmSync, readFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join, dirname } from "node:path";
import { fileURLToPath } from "node:url";
import { maskingPrepare, maskingRealRun } from "../runner/masking.mjs";
import { startFakeUpstream, writeCredentialSource } from "./real-attempt-fakes.mjs";
import { makeFakeMaskingRuntime } from "./masking-real.test.mjs";

const repoRoot = join(dirname(fileURLToPath(import.meta.url)), "..", "..");

describe("masking real completion pins", () => {
  test("completed pinned.json retains repetition, fixture, profile, observer, and runtime pins", { timeout: 300_000 }, async () => {
    const work = mkdtempSync(join(tmpdir(), "cm-pins-"));
    const upstream = await startFakeUpstream();
    try {
      const runsDir = join(work, "runs");
      const cacheDir = join(work, "cache");
      const credentialSource = join(work, "models.json");
      writeCredentialSource(credentialSource, `http://127.0.0.1:${upstream.port}`);
      const fakeRuntime = makeFakeMaskingRuntime(cacheDir);
      maskingPrepare({ repoRoot, runsDir, runId: "pins-run", mode: "real" });
      const outcome = await maskingRealRun({
        repoRoot,
        runsDir,
        runId: "pins-run",
        flags: {
          "--confirm-paid": true,
          "--credential-source": credentialSource,
          "--cache-dir": cacheDir,
          "--pi-runtime": fakeRuntime,
        },
      });
      assert.equal(outcome.executed, 48, outcome.stoppedReason ?? "ok");
      const runDir = join(runsDir, "pins-run");
      for (const arm of ["upstream", "fork"]) {
        for (const rep of [1, 2, 3]) {
          const pinned = JSON.parse(
            readFileSync(join(runDir, "attempts", "masking-task-01", arm, `attempt-${String(rep).padStart(3, "0")}`, "pinned.json"), "utf8"),
          );
          assert.equal(pinned.rep, rep, "completed pinned.json must retain the repetition");
          assert.match(pinned.fixtureContentSha256, /^[0-9a-f]{64}$/, "fixture content digest must survive the rewrite");
          assert.match(pinned.fixtureGitStateSha256, /^[0-9a-f]{64}$/, "fixture Git-state digest must survive the rewrite");
          assert.match(pinned.observerSha256, /^[0-9a-f]{64}$/, "observer digest must survive the rewrite");
          assert.match(pinned.observerWrapperSha256, /^[0-9a-f]{64}$/, "observer wrapper digest must survive the rewrite");
          assert.equal(pinned.study, "masking");
          assert.match(pinned.implementationSha256, /^[0-9a-f]{64}$/, "implementation digest must survive the rewrite");
          assert.match(pinned.piRuntime.digest, /^[0-9a-f]{64}$/, "runtime pin must survive the rewrite");
          const runPins = JSON.parse(readFileSync(join(runDir, "run.json"), "utf8"));
          assert.match(runPins.armImplementationSha256[arm], /^[0-9a-f]{64}$/, "run.json must persist arm implementation digests after preflight");
          assert.equal(pinned.implementationSha256, runPins.armImplementationSha256[arm], "each paid pin must match its arm digest");
          const promptLib = await import("../runner/prompt.mjs");
          const manifest = JSON.parse(readFileSync(join(repoRoot, "evaluation", "masking-task-manifest.json"), "utf8"));
          assert.equal(
            pinned.promptSha256,
            promptLib.sha256Text(promptLib.buildAttemptPrompt(manifest.tasks[0].prompt)),
            "reservation prompt hash must match the real invocation prompt hash",
          );
          const instrumentation = JSON.parse(
            readFileSync(join(runDir, "attempts", "masking-task-01", arm, `attempt-${String(rep).padStart(3, "0")}`, "instrumentation.json"), "utf8"),
          );
          assert.match(instrumentation.digests.profile, /^[0-9a-f]{64}$/, "instrumentation must record the profile digest");
          assert.match(instrumentation.digests.observer, /^[0-9a-f]{64}$/, "instrumentation must record the observer digest");
          assert.match(instrumentation.digests.observerWrapper, /^[0-9a-f]{64}$/, "instrumentation must record the observer wrapper digest");
          assert.match(instrumentation.digests.runtime, /^[0-9a-f]{64}$/, "instrumentation must record the runtime digest");
          assert.equal(instrumentation.activatedFilterIds.length >= 0, true);
        }
      }
    } finally {
      await upstream.close();
      rmSync(work, { recursive: true, force: true });
    }
  });
});
