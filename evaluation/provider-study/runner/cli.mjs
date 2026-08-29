#!/usr/bin/env node
/**
 * Four-arm provider study CLI — public boundary (growing test-first).
 *
 * The credential path arrives only as the --credential-source flag, is
 * used only inside the paid preflight, and is never persisted to run
 * metadata, journals, receipts, or reports.
 */

import { existsSync, mkdirSync, writeFileSync } from "node:fs";
import { dirname, join } from "node:path";
import { fileURLToPath, pathToFileURL } from "node:url";
import { providerStudySchedule, providerStudyPlanHash, providerStudyPlannedSlots } from "./schedule.mjs";
import { loadProviderStudyManifestFile } from "./manifest.mjs";
import { providerStudyReadCompletedResult, providerStudySlotPath } from "./reserve.mjs";

function planSha256Of(repoRoot, phase) {
  return providerStudyPlanHash(repoRoot, phase);
}
import { providerStudyDryRun, providerStudyRunsRoot } from "./study.mjs";

export const PROVIDER_STUDY_CLI_USAGE = `usage: cli.mjs <command> [flags]
  validate | freeze | plan | status
  fixtures --phase P [--holdout-key-source PATH]
  dry-run --phase P [--task id] [--runs-root DIR] [--holdout-key-source PATH]
  prepare --phase P --run-id ID [--runs-root DIR]
  run --phase P --confirm-paid --credential-source PATH [--holdout-key-source PATH]
  judge-export --phase P [--holdout-key-source PATH]
  judge-run --phase P --confirm-paid --credential-source PATH
  judge-import --phase P | report --phase P
  seal-holdout --private-tasks PATH --holdout-key-source PATH`;

function parseFlags(argv) {
  const flags = {};
  for (let index = 0; index < argv.length; index += 1) {
    const token = argv[index];
    if (token.startsWith("--")) {
      const next = argv[index + 1];
      if (next !== undefined && !next.startsWith("--")) {
        flags[token] = flags[token] === undefined ? next : [].concat(flags[token], next);
        index += 1;
      } else {
        flags[token] = true;
      }
    }
  }
  return flags;
}

function requirePhase(flags) {
  const phase = flags["--phase"] ?? "development";
  if (phase !== "development" && phase !== "holdout") {
    throw new Error(`--phase must be development or holdout (got ${JSON.stringify(phase)})`);
  }
  return phase;
}

/** Public CLI entry: returns { code, stdout, stderr } and never throws. */
export async function providerStudyCli(argv, { repoRoot }) {
  const command = argv[0];
  const flags = parseFlags(argv.filter((_, index) => index > 0));
  try {
    if (command === "dry-run") {
      const phase = requirePhase(flags);
      const runsRoot = typeof flags["--runs-root"] === "string" ? flags["--runs-root"] : providerStudyRunsRoot();
      const taskIds = flags["--task"] === undefined ? null : [].concat(flags["--task"]);
      const result = await providerStudyDryRun({
        repoRoot,
        runsRoot,
        phase,
        taskIds,
        keySourcePath: typeof flags["--holdout-key-source"] === "string" ? flags["--holdout-key-source"] : null,
      });
      return { code: 0, stdout: `${JSON.stringify(result)}\n`, stderr: "" };
    }
    if (command === "prepare") {
      const phase = requirePhase(flags);
      const runId = flags["--run-id"];
      if (typeof runId !== "string" || runId.length === 0) {
        return { code: 2, stdout: "", stderr: "prepare needs --run-id X\n" };
      }
      const runsRoot = typeof flags["--runs-root"] === "string" ? flags["--runs-root"] : providerStudyRunsRoot();
      const phaseRoot = join(runsRoot, phase);
      const lockPath = join(phaseRoot, "phase-lock.json");
      if (existsSync(lockPath)) {
        return { code: 3, stdout: "", stderr: `phase lock already exists at ${lockPath}; refusing to overwrite\n` };
      }
      const runPath = join(phaseRoot, "run.json");
      if (existsSync(runPath)) {
        return { code: 3, stdout: "", stderr: `run metadata already exists at ${runPath}; refusing to overwrite\n` };
      }
      mkdirSync(phaseRoot, { recursive: true });
      const plan = providerStudySchedule(repoRoot, phase);
      const planSha256 = planSha256Of(repoRoot, phase);
      writeFileSync(
        lockPath,
        `${JSON.stringify({ schemaVersion: 1, study: "provider-study", phase, runId, plan }, null, 2)}\n`,
        "utf8",
      );
      writeFileSync(
        runPath,
        `${JSON.stringify({ schemaVersion: 1, study: "provider-study", phase, runId, planSha256, createdAt: new Date().toISOString() }, null, 2)}\n`,
        "utf8",
      );
      return { code: 0, stdout: `${JSON.stringify({ phase, runId, phaseRoot })}\n`, stderr: "" };
    }
    if (command === "plan") {
      const phase = requirePhase(flags);
      const schedule = providerStudySchedule(repoRoot, phase);
      return {
        code: 0,
        stdout: `${JSON.stringify({ schemaVersion: 1, study: "provider-study", phase, planSha256: planSha256Of(repoRoot, phase), tasks: schedule.tasks.map((task) => ({ taskId: task.taskId, blocks: task.blocks })) })}\n`,
        stderr: "",
      };
    }
    if (command === "status") {
      const runsRoot = typeof flags["--runs-root"] === "string" ? flags["--runs-root"] : providerStudyRunsRoot();
      const status = {};
      for (const phase of ["development", "holdout"]) {
        const loaded = loadProviderStudyManifestFile(repoRoot, { phase });
        let completedSlots = 0;
        for (const slot of providerStudyPlannedSlots(repoRoot, phase)) {
          if (providerStudyReadCompletedResult(providerStudySlotPath(runsRoot, phase, slot.taskId, slot.arm, slot.rep)) !== null) {
            completedSlots += 1;
          }
        }
        void loaded;
        status[phase] = { completedSlots };
      }
      return { code: 0, stdout: `${JSON.stringify({ schemaVersion: 1, runsRoot, ...status })}\n`, stderr: "" };
    }
    if (command === "seal-holdout") {
      const privateTasksPath = flags["--private-tasks"];
      const keySourcePath = flags["--holdout-key-source"];
      if (typeof privateTasksPath !== "string" || typeof keySourcePath !== "string") {
        return { code: 2, stdout: "", stderr: "seal-holdout needs --private-tasks PATH and --holdout-key-source PATH\n" };
      }
      const { providerStudySealHoldout } = await import("./seal.mjs");
      const sealed = await providerStudySealHoldout({ repoRoot, privateTasksPath, keySourcePath });
      return { code: 0, stdout: `${JSON.stringify(sealed)}\n`, stderr: "" };
    }
    if (command === "freeze") {
      const { providerStudyFreeze, providerStudyFreezeLockPath } = await import("./freeze.mjs");
      const lock = providerStudyFreeze(repoRoot);
      return { code: 0, stdout: `${JSON.stringify({ written: lock.written, path: providerStudyFreezeLockPath(repoRoot) })}\n`, stderr: "" };
    }
    if (command === "fixtures") {
      const phase = requirePhase(flags);
      if (phase !== "holdout") {
        return { code: 0, stdout: `${JSON.stringify({ phase, note: "development fixtures come from the shared evaluation fixture cache" })}\n`, stderr: "" };
      }
      const loaded = loadProviderStudyManifestFile(repoRoot, { phase });
      const { publishFixtureCache } = await import("../../lib/cache.mjs");
      const { withHoldoutTasks } = await import("./holdout.mjs");
      const runsRoot = typeof flags["--runs-root"] === "string" ? flags["--runs-root"] : providerStudyRunsRoot();
      const result = await withHoldoutTasks({
        repoRoot,
        runsRoot,
        command: "fixtures",
        keySourcePath: typeof flags["--holdout-key-source"] === "string" ? flags["--holdout-key-source"] : null,
        taskIds: loaded.tasks.map((task) => task.id),
        fn: async ({ tasks, privateDir }) => {
          const cacheRoot = join(privateDir, "fixtures");
          for (const task of tasks.values()) publishFixtureCache({ repoRoot, task, cacheRoot });
          return { phase, taskCount: tasks.size, verified: true };
        },
      });
      return { code: 0, stdout: `${JSON.stringify(result)}\n`, stderr: "" };
    }
    if (command === "report") {
      const phase = requirePhase(flags);
      const runsRoot = typeof flags["--runs-root"] === "string" ? flags["--runs-root"] : providerStudyRunsRoot();
      const label = typeof flags["--label"] === "string"
        ? flags["--label"]
        : `run-${new Date().toISOString().replace(/[^0-9]/g, "").substring(0, 14)}`;
      const { providerStudyReport } = await import("./report.mjs");
      const report = providerStudyReport({ repoRoot, runsRoot, phase, label });
      return { code: 0, stdout: `${JSON.stringify(report)}\n`, stderr: "" };
    }
    if (command === "judge-export") {
      const phase = requirePhase(flags);
      const runsRoot = typeof flags["--runs-root"] === "string" ? flags["--runs-root"] : providerStudyRunsRoot();
      const { providerStudyJudgeExport } = await import("./judge.mjs");
      const exported = await providerStudyJudgeExport({
        repoRoot,
        runsRoot,
        phase,
        keySourcePath: typeof flags["--holdout-key-source"] === "string" ? flags["--holdout-key-source"] : null,
      });
      return { code: 0, stdout: `${JSON.stringify(exported)}\n`, stderr: "" };
    }
    if (command === "validate") {
      const problems = [];
      const phases = {};
      for (const phase of ["development", "holdout"]) {
        try {
          const loaded = loadProviderStudyManifestFile(repoRoot, { phase });
          phases[phase] = {
            tasks: loaded.tasks.length,
            seed: loaded.seed,
            planSha256: planSha256Of(repoRoot, phase),
          };
        } catch (error) {
          problems.push(`${phase}: ${error.message}`);
          phases[phase] = { tasks: 0, seed: null, planSha256: null };
        }
      }
      const { providerStudyFreezeMatches } = await import("./freeze.mjs");
      const freeze = providerStudyFreezeMatches(repoRoot);
      if (!freeze.ok) problems.push(...freeze.problems);
      const body = { schemaVersion: 1, study: "provider-study", ok: problems.length === 0, phases, freeze, ...(problems.length > 0 ? { problems } : {}) };
      return { code: problems.length === 0 ? 0 : 4, stdout: `${JSON.stringify(body)}\n`, stderr: "" };
    }
    if (command === "judge-run" && flags["--confirm-paid"] !== true) {
      return { code: 2, stdout: "", stderr: "judge-run needs --confirm-paid; refusing before any reservation\n" };
    }
    if (command === "run" && flags["--confirm-paid"] !== true) {
      return { code: 2, stdout: "", stderr: "run needs --confirm-paid for provider execution; refusing before any reservation\n" };
    }
    if (command === "run") {
      const phase = requirePhase(flags);
      const { providerStudyPaidRun } = await import("./paid.mjs");
      const result = await providerStudyPaidRun({ repoRoot, phase, flags });
      return { code: 0, stdout: `${JSON.stringify(result)}\n`, stderr: "" };
    }
    if (command === "judge-run") {
      const phase = requirePhase(flags);
      const { providerStudyJudgeRun } = await import("./judge.mjs");
      const result = await providerStudyJudgeRun({ repoRoot, phase, flags });
      return { code: 0, stdout: `${JSON.stringify(result)}\n`, stderr: "" };
    }
    if (command === "judge-import") {
      const phase = requirePhase(flags);
      const runsRoot = typeof flags["--runs-root"] === "string" ? flags["--runs-root"] : providerStudyRunsRoot();
      const { providerStudyJudgeImportFromScores } = await import("./judge.mjs");
      const result = providerStudyJudgeImportFromScores({ runsRoot, phase });
      return { code: 0, stdout: `${JSON.stringify(result)}\n`, stderr: "" };
    }
    return { code: 2, stdout: "", stderr: `${PROVIDER_STUDY_CLI_USAGE}\n` };
  } catch (error) {
    return { code: 4, stdout: "", stderr: `provider-study ${command ?? ""}: ${error.message}\n` };
  }
}

const isMain = process.argv[1] !== undefined
  && import.meta.url === pathToFileURL(process.argv[1]).href;
if (isMain) {
  const repoRoot = join(dirname(fileURLToPath(import.meta.url)), "..", "..", "..");
  const result = await providerStudyCli(process.argv.filter((_, index) => index > 1), { repoRoot });
  process.stdout.write(result.stdout);
  process.stderr.write(result.stderr);
  process.exit(result.code);
}
