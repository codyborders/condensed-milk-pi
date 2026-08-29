/**
 * Real provider attempt execution (grown test-first).
 *
 * The real path materializes pinned arm worktrees and the pinned Pi
 * runtime outside the source repository, starts a parent-owned loopback
 * credential proxy, and executes each reserved attempt exactly once.
 * Validation order is fail-closed: task, arm, credential source, cache,
 * runtime, and exact pinned commits are all verified before any attempt
 * is reserved, so a refusal never spends a paid call.
 */

import { existsSync, readFileSync, renameSync, writeFileSync } from "node:fs";
import { homedir } from "node:os";
import { dirname, join } from "node:path";
import { loadManifestFile } from "../lib/manifest.mjs";
import { fixturesCacheRoot } from "../lib/cache.mjs";
import { hashTree, gitStateHash } from "../lib/fixtures.mjs";
import { scorerDefinitionSha256 } from "../lib/scorer.mjs";
import { appendJournal, writeSnapshot } from "./state.mjs";
import { loadProviderCredential } from "./real-credentials.mjs";
import { verifyArmWorktree, materializePiRuntime, verifyNodeEngine } from "./real-runtime.mjs";
import { computeRuntimeDigest } from "./runtime-digest.mjs";
import { executeRealAttempt } from "./real-attempt.mjs";
import { buildAttemptPrompt, sha256Text } from "./prompt.mjs";
import { reserveAttempt, snapshotAfter, maybeSelectCompletion } from "./cli.mjs";

function fail(message, code = 2) {
  process.stderr.write(`cli: ${message}\n`);
  return code;
}

/** Incremental run progress goes to stderr; stdout stays one final JSON line. */
function progress(line) {
  process.stderr.write(`run: ${line}\n`);
}

/**
 * Map any exception after a real reservation to a safe error category.
 * Only the category string is ever recorded: raw messages, paths, and
 * key material never reach artifacts, journals, or reports.
 */
function safeErrorCategory(error) {
  const message = String(error?.message ?? "");
  if (/credential/i.test(message) && !/proxy|url/i.test(message)) return "credential";
  if (/proxy|url/i.test(message)) return "credential-proxy";
  if (/spawn/i.test(message)) return "spawn";
  if (/scorer/i.test(message)) return "scorer";
  if (/collect/i.test(message)) return "collection";
  if (/worktree|workspace|fixture/i.test(message)) return "workspace";
  if (/runtime/i.test(message)) return "runtime";
  return "unknown";
}

/**
 * Print the one final JSON line and pick the runner exit: 0 for a run
 * that finished its plan, 5 when an infrastructure failure stopped it.
 */
function finishStoppedRun({ runId, tasks, armFilter, outcomes, stopped }) {
  const executed = outcomes.filter((outcome) => outcome.status !== "skipped-existing").length;
  const skipped = outcomes.length - executed;
  process.stdout.write(
    `${JSON.stringify({
      runId,
      tasks: tasks.map((task) => task.id),
      slots: { planned: tasks.length * (armFilter ? 1 : 2), executed, skipped },
      outcomes,
      stopped,
      infrastructureFailed: stopped !== null,
    })}\n`,
  );
  return stopped !== null ? 5 : 0;
}

function defaultCacheRoot() {
  const base = process.env.XDG_CACHE_HOME
    ?? (process.platform === "darwin" ? join(homedir(), "Library", "Caches") : join(homedir(), ".cache"));
  return join(base, "condensed-milk-eval");
}

/**
 * Resolve the Pi CLI: an explicit --pi-runtime (version-checked, digest
 * computed over the declared runtime root) or the pinned copy plus its
 * manifest digest.
 */
function resolvePiCli({ flags, manifest, repoRoot, cacheRoot }) {
  const override = flags["--pi-runtime"];
  if (override) {
    let pkg;
    try {
      pkg = JSON.parse(readFileSync(join(override, "package.json"), "utf8"));
    } catch {
      return { error: `--pi-runtime ${override} has no readable package.json; refusing` };
    }
    if (pkg.version !== manifest.evaluation.piVersion) {
      return { error: `--pi-runtime version ${pkg.version} does not match the pinned ${manifest.evaluation.piVersion}; refusing` };
    }
    const cliPath = join(override, "dist", "cli.js");
    if (!existsSync(cliPath)) {
      return { error: `--pi-runtime ${override} has no dist/cli.js; refusing` };
    }
    let runtimeManifest;
    try {
      runtimeManifest = computeRuntimeDigest({ runtimeDir: override });
    } catch (error) {
      return { error: `--pi-runtime digest computation refused: ${error.message}` };
    }
    return { cliPath, runtimeDir: override, runtimeManifest };
  }
  const { cliPath, runtimeManifest } = materializePiRuntime({ repoRoot, manifest, cacheRoot });
  return { cliPath, runtimeDir: dirname(dirname(cliPath)), runtimeManifest };
}

/**
 * Persist the runtime manifest digest plus its schema into run.json.
 * Atomic (tmp + rename) and called under the run lock. The first
 * pre-reservation call stores the manifest. A later call with an
 * identical manifest keeps the original run.json bytes untouched. Any
 * difference refuses before reservation and preserves the original
 * bytes.
 */
export function persistRuntimePin(runDir, runtimeManifest) {
  const runPath = join(runDir, "run.json");
  const run = JSON.parse(readFileSync(runPath, "utf8"));
  const existing = run.piRuntime;
  if (existing) {
    const identical = ["schemaVersion", "algorithm", "entryCount", "digest"].every(
      (field) => existing[field] === runtimeManifest[field],
    );
    if (!identical) {
      throw new Error("pi runtime manifest differs from the pinned run.json manifest; refusing to resume");
    }
    return;
  }
  const next = { ...run, piRuntime: runtimeManifest };
  const temporary = `${runPath}.tmp-${process.pid}`;
  writeFileSync(temporary, `${JSON.stringify(next, null, 2)}\n`, "utf8");
  renameSync(temporary, runPath);
}

function safeScorerStatus(attemptDir) {
  try {
    return JSON.parse(readFileSync(join(attemptDir, "scorer.json"), "utf8")).status ?? null;
  } catch {
    return null;
  }
}

/**
 * Shared pre-reservation preflight for paid runs. Accepts an explicit
 * manifest so a second study can reuse the identical fail-closed
 * ordering: timeout flag, credential load, exact arm worktrees, Pi
 * runtime resolution, runtime pin persistence, node engine check.
 * Returns { ok: true, ... } or { ok: false, error, code }. Never
 * reserves an attempt.
 */
export function runPaidPreflight({ flags, manifest, repoRoot, runDir, armFilter = null, armNames = null, verifyObserverOrdering = null, implementationPolicy = "standard" }) {
  let timeoutMs = manifest.evaluation.timeoutMsPerAttempt;
  if (flags["--timeout-ms"] !== undefined) {
    const raw = flags["--timeout-ms"];
    const parsed = typeof raw === "string" && /^\d+$/.test(raw) ? Number(raw) : Number.NaN;
    if (!Number.isSafeInteger(parsed) || parsed < 1) {
      return {
        ok: false,
        error: `--timeout-ms must be a positive finite integer of milliseconds; refusing before reservation (got ${JSON.stringify(raw)})`,
        code: 2,
      };
    }
    timeoutMs = parsed;
  }
  const credentialSourcePath = flags["--credential-source"];
  if (!credentialSourcePath) {
    return { ok: false, error: "run needs --credential-source PATH (the z-ai provider models.json)", code: 2 };
  }
  // Fail-closed ordering: the credential resolves and every pinned arm
  // verifies before the first attempt slot is claimed.
  try {
    loadProviderCredential({ sourcePath: credentialSourcePath });
  } catch (error) {
    return { ok: false, error: `credential source refused: ${error.message}`, code: 2 };
  }
  const cacheRoot = flags["--cache-dir"] ?? defaultCacheRoot();
  const preflightArms = armNames ?? ["upstream", "fork"];
  const armInfos = {};
  for (const armName of preflightArms) {
    if (armFilter && armName !== armFilter) continue;
    const arm = manifest.evaluation.arms.find((entry) => entry.name === armName);
    try {
      armInfos[armName] = verifyArmWorktree({ repoRoot, arm, cacheRoot, implementationPolicy });
    } catch (error) {
      return { ok: false, error: `arm ${armName} refused: ${error.message}`, code: 4 };
    }
  }
  const pi = resolvePiCli({ flags, manifest, repoRoot, cacheRoot });
  if (pi.error) {
    return { ok: false, error: pi.error, code: 2 };
  }
  // Durable runtime integrity pin: the manifest digest of the exact
  // executable bytes lands in run.json before any attempt is reserved.
  try {
    persistRuntimePin(runDir, pi.runtimeManifest);
  } catch (error) {
    return { ok: false, error: `persisting the pi runtime pin in run.json failed: ${error.message}`, code: 4 };
  }
  // Node engine preflight: the isolated Pi runtime's declared minimum
  // must be satisfied by this process before any slot is reserved.
  try {
    verifyNodeEngine({ runtimeDir: pi.runtimeDir });
  } catch (error) {
    return { ok: false, error: `node engine preflight refused: ${error.message}`, code: 4 };
  }
  // Observer ordering verification (optional callback) runs after the
  // runtime and node checks and strictly before any reservation. A
  // throw must leave the run with zero attempts.
  if (typeof verifyObserverOrdering === "function") {
    try {
      verifyObserverOrdering({ pi, runDir, cacheRoot });
    } catch (error) {
      return {
        ok: false,
        error: `observer ordering preflight refused: ${error.message}`,
        code: 4,
      };
    }
  }
  return { ok: true, timeoutMs, credentialSourcePath, cacheRoot, armInfos, pi };
}

export async function runRealArms({ flags, runsDir, runId, runDir, run, repoRoot }) {
  void runsDir;
  void runDir;
  const manifest = loadManifestFile(join(repoRoot, "evaluation", "task-manifest.json"));
  if (flags["--task"] && flags["--all"]) {
    return fail("--task and --all are mutually exclusive");
  }
  if (flags["--all"] && flags["--arm"]) {
    return fail("--arm is allowed only with exactly one --task (canary diagnosis), not with --all");
  }
  if (flags["--arm"] && Array.isArray(flags["--task"])) {
    return fail("--arm is allowed only with exactly one --task (canary diagnosis)");
  }
  const taskIds = flags["--all"] === true
    ? manifest.tasks.map((task) => task.id)
    : Array.isArray(flags["--task"])
      ? flags["--task"]
      : [flags["--task"]];
  if (!flags["--all"] && !flags["--task"]) {
    return fail("run needs --task <id> for real execution");
  }
  for (const id of taskIds) {
    if (!manifest.tasks.some((task) => task.id === id)) {
      return fail(`unknown task ${id}`);
    }
  }
  const tasks = manifest.tasks.filter((task) => taskIds.includes(task.id));
  const armFilter = flags["--arm"];
  if (armFilter !== undefined && armFilter !== "upstream" && armFilter !== "fork") {
    return fail("--arm must be upstream or fork");
  }
  // Shared fail-closed preflight (timeout, credential, arm worktrees,
  // Pi runtime, runtime pin, node engine) with the standard manifest.
  const preflight = runPaidPreflight({ flags, manifest, repoRoot, runDir, armFilter });
  if (!preflight.ok) {
    return fail(preflight.error, preflight.code);
  }
  const { timeoutMs, credentialSourcePath, armInfos, pi } = preflight;

  const outcomes = [];
  for (const task of tasks) {
    const arms = armFilter ? [armFilter] : run.armOrder[task.id];
    for (const armName of arms) {
      const claim = reserveAttempt({
      runDir,
      runId,
      taskId: task.id,
      arm: armName,
      attempt: 1,
      real: {
        armCommit: armInfos[armName].commit,
        model: manifest.evaluation.model,
        provider: manifest.evaluation.provider,
        piRuntime: pi.runtimeManifest,
      },
    });
    if (claim.refused) {
      return claim.exit;
    }
    if (!claim.claimed) {
      outcomes.push({ taskId: task.id, arm: armName, attempt: 1, status: "skipped-existing" });
      progress(`${task.id}/${armName} attempt-001 skipped: slot already completed or reserved`);
      continue;
    }
    progress(`${task.id}/${armName} attempt-001 reserved`);
    let outcome;
    try {
      outcome = await executeRealAttempt({
        repoRoot,
        manifest,
        task,
        arm: armName,
        armInfo: armInfos[armName],
        attemptDir: claim.attemptDir,
        fixtureDir: join(fixturesCacheRoot(repoRoot), task.id),
        credentialSourcePath,
        piCliPath: pi.cliPath,
        piRuntimePin: pi.runtimeManifest,
        timeoutMs,
        identity: { runId, attempt: 1 },
      });
    } catch (error) {
      const category = safeErrorCategory(error);
      const resultPath = join(claim.attemptDir, "result.json");
      if (!existsSync(resultPath)) {
        writeFileSync(
          resultPath,
          `${JSON.stringify({
            schemaVersion: 1,
            runId,
            attempt: 1,
            taskId: task.id,
            arm: armName,
            status: "infrastructure-error",
            error: { category },
            failures: [`infrastructure error (${category})`],
          }, null, 2)}\n`,
          "utf8",
        );
      }
      appendJournal(runDir, { type: "attempt-finished", taskId: task.id, arm: armName, attempt: 1, status: "infrastructure-error", reason: category });
      writeSnapshot(runDir, snapshotAfter(runDir, task.id, armName, 1, "infrastructure-error"));
      outcomes.push({ taskId: task.id, arm: armName, attempt: 1, status: "infrastructure-error" });
      progress(`${task.id}/${armName} attempt-001 infrastructure-error (${category}); stopping remaining arms and tasks`);
      return finishStoppedRun({ runId, tasks, armFilter, outcomes, stopped: { taskId: task.id, arm: armName, attempt: 1, status: "infrastructure-error", reason: category } });
    }
    const scorerStatus = safeScorerStatus(claim.attemptDir);
    appendJournal(runDir, { type: "attempt-finished", taskId: task.id, arm: armName, attempt: 1, status: outcome.status });
    writeSnapshot(runDir, snapshotAfter(runDir, task.id, armName, 1, outcome.status));
    maybeSelectCompletion({ runDir, taskId: task.id, arm: armName, attempt: 1, status: outcome.status, scorerStatus });
    outcomes.push(outcome);
    progress(`${task.id}/${armName} attempt-001 ${outcome.status} (scorer ${scorerStatus ?? "unknown"})`);
    // Infrastructure stops: a collection error or a scorer error ends the
    // run; a plain task failure (exit nonzero, scorer failed) continues.
    if (outcome.status === "collection-error") {
      return finishStoppedRun({
        runId,
        tasks,
        armFilter,
        outcomes,
        stopped: { taskId: task.id, arm: armName, attempt: 1, status: "collection-error", reason: "collection-error" },
      });
    }
    if (scorerStatus === "scorer-error") {
      return finishStoppedRun({
        runId,
        tasks,
        armFilter,
        outcomes,
        stopped: { taskId: task.id, arm: armName, attempt: 1, status: outcome.status, reason: "scorer-error" },
      });
    }
  }
  }
  return finishStoppedRun({ runId, tasks, armFilter, outcomes, stopped: null });
}

/**
 * Planning-only run: validate the selection and every selected task's
 * prompt and fixture bytes, then print the ordered plan (tasks, arms,
 * commits, prompt hashes, fixture hashes, model, profile, Pi
 * version). Read-only: no credential, no lock, no spawn, no attempts.
 */
export async function planRealRun({ flags, runId, runDir, run, repoRoot }) {
  const manifest = loadManifestFile(join(repoRoot, "evaluation", "task-manifest.json"));
  if (flags["--task"] && flags["--all"]) {
    return fail("--task and --all are mutually exclusive");
  }
  const taskIds = flags["--all"] === true
    ? manifest.tasks.map((task) => task.id)
    : Array.isArray(flags["--task"])
      ? flags["--task"]
      : [flags["--task"]];
  if (!flags["--all"] && !flags["--task"]) {
    return fail("run needs --task <id> (repeatable for several tasks) or --all");
  }
  for (const id of taskIds) {
    if (!manifest.tasks.some((task) => task.id === id)) {
      return fail(`unknown task ${id}`);
    }
  }
  const tasks = manifest.tasks.filter((task) => taskIds.includes(task.id));
  const armFilter = flags["--arm"];
  const timeout = flags["--timeout-ms"] !== undefined ? Number(flags["--timeout-ms"]) : manifest.evaluation.timeoutMsPerAttempt;
  const armCommits = Object.fromEntries(manifest.evaluation.arms.map((arm) => [arm.name, arm.commit]));
  const entries = [];
  for (const task of tasks) {
    const fixtureDir = join(fixturesCacheRoot(repoRoot), task.id);
    if (!existsSync(join(fixtureDir, ".git"))) {
      return fail(`fixture for ${task.id} is missing from the cache; regenerate with: npm run evaluation:fixtures`, 4);
    }
    entries.push({
      taskId: task.id,
      arms: (armFilter ? [armFilter] : run.armOrder[task.id]).map((arm) => ({ arm, commit: armCommits[arm] })),
      promptSha256: sha256Text(buildAttemptPrompt(task.prompt)),
      scorerSha256: scorerDefinitionSha256(repoRoot, task.id),
      fixture: { contentSha256: hashTree(fixtureDir), gitStateSha256: gitStateHash(fixtureDir) },
    });
  }
  process.stdout.write(
    `${JSON.stringify({
      schemaVersion: 1,
      runId,
      mode: run.mode,
      planOnly: true,
      provider: manifest.evaluation.provider,
      model: manifest.evaluation.model,
      thinking: manifest.evaluation.thinking,
      profile: manifest.evaluation.profile,
      piVersion: manifest.evaluation.piVersion,
      timeoutMs: timeout,
      armCommits,
      tasks: entries,
    })}\n`,
  );
  return 0;
}
