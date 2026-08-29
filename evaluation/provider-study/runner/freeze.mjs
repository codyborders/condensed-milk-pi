/**
 * Provider-study freeze lock.
 *
 * Binds every study input before production edits: both phase
 * manifests, every hidden holdout scorer and solution, the arm
 * identity hashes (which already cover the config profiles and the
 * neutral retrieval stub), both phase plan hashes, the phase seeds,
 * and the frozen provider/model/Pi pins. The lock is written once with
 * no-overwrite semantics; any later mismatch refuses before a
 * reservation exists.
 */

import { existsSync, readFileSync, readdirSync, statSync, writeFileSync } from "node:fs";
import { createHash } from "node:crypto";
import { join } from "node:path";
import { spawnSync } from "node:child_process";
import { loadProviderStudyManifestFile, PROVIDER_STUDY_PINS } from "./manifest.mjs";
import { providerStudyPlanHash } from "./schedule.mjs";
import { providerStudyArmIdentityMap, NEUTRAL_RETRIEVAL_EXTENSION, stableJson } from "./arms.mjs";
import { providerStudyJudgeRubricSha256 } from "./judge.mjs";
import { computeRuntimeDigest } from "../../runner/runtime-digest.mjs";
import { holdoutBundleEnvelopeSha256, readHoldoutBundleEnvelope } from "./holdout.mjs";
import { providerStudyDependenciesSha256 } from "./dependencies.mjs";

export function providerStudyFreezeLockPath(repoRoot) {
  return join(repoRoot, "evaluation", "provider-study", "freeze-lock.json");
}

function sha256File(path) {
  return createHash("sha256").update(readFileSync(path)).digest("hex");
}

/** Sorted relative paths of every regular file under one directory. */
function walkRelative(root, prefix = "") {
  const files = [];
  if (!existsSync(root)) return files;
  for (const entry of readdirSync(root, { withFileTypes: true })) {
    const relative = prefix.length === 0 ? entry.name : `${prefix}/${entry.name}`;
    if (entry.isDirectory()) {
      files.push(...walkRelative(join(root, entry.name), relative));
      continue;
    }
    if (entry.isFile() && statSync(join(root, entry.name)).isFile()) files.push(relative);
  }
  return files.sort();
}

/**
 * Directory digest: sha256 over `count:path:sha256` lines for every
 * regular file in sorted relative-path order. Deterministic across
 * processes and platforms for identical trees.
 */
function sha256Directory(root) {
  const lines = walkRelative(root).map(
    (relative) => `${relative}:${sha256File(join(root, relative))}`,
  );
  return createHash("sha256").update(`${lines.length}\n${lines.join("\n")}\n`).digest("hex");
}

/** Directory digest over every *.mjs file directly inside one directory. */
function sha256MjsDir(root) {
  const files = walkRelative(root).filter((relative) => relative.endsWith(".mjs") && !relative.includes("/"));
  const lines = files.map((relative) => `${relative}:${sha256File(join(root, relative))}`);
  return createHash("sha256").update(`${lines.length}\n${lines.join("\n")}\n`).digest("hex");
}

/** The evaluator git state: HEAD commit, its clean tree digest, or a refusal. */
function evaluatorGitState(repoRoot) {
  const run = (args) => spawnSync("git", ["-C", repoRoot, ...args], { encoding: "utf8" });
  const commit = run(["rev-parse", "HEAD"]);
  if (commit.status !== 0 || typeof commit.stdout !== "string") {
    throw new Error(`evaluator git state is unavailable: ${commit.stderr?.trim() ?? "rev-parse HEAD failed"}`);
  }
  const tree = run(["rev-parse", "HEAD^{tree}"]);
  if (tree.status !== 0 || typeof tree.stdout !== "string") {
    throw new Error(`evaluator git tree digest is unavailable: ${tree.stderr?.trim() ?? "rev-parse HEAD^{tree} failed"}`);
  }
  return { commit: commit.stdout.trim(), headTree: tree.stdout.trim() };
}

/**
 * The Pi runtime digest pin: the manifest digest of the pinned
 * @earendil-works/pi-coding-agent package installed in node_modules.
 * Paid preflights must resolve the exact same executable bytes.
 */
function piRuntimeSha256(repoRoot) {
  const runtimeDir = join(repoRoot, "node_modules", "@earendil-works", "pi-coding-agent");
  if (!existsSync(runtimeDir)) return null;
  return computeRuntimeDigest({ runtimeDir }).digest;
}

/** Collect the current digests for both phases. */
export function providerStudyFreezeDigests(repoRoot) {
  const development = loadProviderStudyManifestFile(repoRoot, { phase: "development" });
  const holdout = loadProviderStudyManifestFile(repoRoot, { phase: "holdout" });
  const holdoutScorerSha256 = Object.fromEntries(holdout.tasks.map((task) => [task.id, task.scorerSha256]));
  const holdoutSolutionSha256 = Object.fromEntries(holdout.tasks.map((task) => [task.id, task.solutionSha256]));
  const holdoutFixtureSha256 = Object.fromEntries(holdout.tasks.map((task) => [task.id, task.fixtureSha256]));
  const holdoutEnvelope = readHoldoutBundleEnvelope(repoRoot);
  const holdoutEnvelopeSha256 = holdoutBundleEnvelopeSha256(holdoutEnvelope);
  if (holdoutEnvelopeSha256 !== holdout.manifest.bundle.bundleSha256) {
    throw new Error("encrypted holdout bundle digest differs from the public manifest; refusing to freeze");
  }
  const providerStudyRoot = join(repoRoot, "evaluation", "provider-study");
  const git = evaluatorGitState(repoRoot);
  const components = {
    runnerModulesSha256: sha256MjsDir(join(providerStudyRoot, "runner")),
    neutralStubSha256: sha256File(NEUTRAL_RETRIEVAL_EXTENSION),
    runtimeModulesSha256: sha256MjsDir(join(repoRoot, "evaluation", "runner")),
    libModulesSha256: sha256MjsDir(join(repoRoot, "evaluation", "lib")),
    developmentScorersSha256: sha256Directory(join(repoRoot, "evaluation", "scorers")),
    taskManifestSha256: sha256File(join(repoRoot, "evaluation", "task-manifest.json")),
    packageLockSha256: sha256File(join(repoRoot, "package-lock.json")),
    runtimeDependenciesSha256: providerStudyDependenciesSha256(repoRoot),
    developmentManifestSha256: development.sha256,
    holdoutManifestSha256: holdout.sha256,
    profilesSha256: sha256Directory(join(providerStudyRoot, "profiles")),
    protocolSha256: sha256File(join(providerStudyRoot, "protocol.md")),
    holdoutBundleFileSha256: sha256File(join(providerStudyRoot, "holdout.enc")),
    holdoutEnvelopeSha256,
    judgeRubricSha256: providerStudyJudgeRubricSha256(),
    statsCodeSha256: createHash("sha256")
      .update(sha256File(join(repoRoot, "evaluation", "runner", "masking-stats.mjs")))
     .update(sha256File(join(providerStudyRoot, "runner", "stats.mjs")))
      .digest("hex"),
    piRuntimeSha256: piRuntimeSha256(repoRoot),
  };
  const evaluator = {
    ...git,
    sourceSha256: createHash("sha256").update(stableJson(components)).digest("hex"),
  };
  return {
    schemaVersion: 1,
    pins: {
      provider: PROVIDER_STUDY_PINS.provider,
      model: PROVIDER_STUDY_PINS.model,
      thinking: PROVIDER_STUDY_PINS.thinking,
      piVersion: PROVIDER_STUDY_PINS.piVersion,
      tools: PROVIDER_STUDY_PINS.tools,
      timeoutMsPerAttempt: PROVIDER_STUDY_PINS.timeoutMsPerAttempt,
      repetitionsPreallocated: PROVIDER_STUDY_PINS.repetitionsPreallocated,
      conditionalRepetitions: PROVIDER_STUDY_PINS.conditionalRepetitions,
      noPaidRetry: PROVIDER_STUDY_PINS.noPaidRetry,
    },
    evaluator,
    ...components,
    seeds: { development: development.seed, holdout: holdout.seed },
    developmentManifestSha256: development.sha256,
    holdoutManifestSha256: holdout.sha256,
    holdoutScorerSha256,
    holdoutSolutionSha256,
    holdoutFixtureSha256,
    armIdentitySha256: providerStudyArmIdentityMap(repoRoot),
    planSha256: {
      development: providerStudyPlanHash(repoRoot, "development"),
      holdout: providerStudyPlanHash(repoRoot, "holdout"),
    },
  };
}

/** Write the freeze lock once; an existing lock is never replaced. */
export function providerStudyFreeze(repoRoot, { lockPath = null } = {}) {
  const path = lockPath ?? providerStudyFreezeLockPath(repoRoot);
  if (existsSync(path)) {
    return { written: false, path, digests: JSON.parse(readFileSync(path, "utf8")).digests };
  }
  const digests = providerStudyFreezeDigests(repoRoot);
  writeFileSync(
    path,
    `${JSON.stringify({
      schemaVersion: 1,
      study: "provider-study",
      frozenAt: new Date().toISOString(),
      digests,
    }, null, 2)}\n`,
    "utf8",
  );
  return { written: true, path, digests };
}

/** Compare the lock against the current inputs; report every mismatch. */
function evaluatorCommitIsAncestor(repoRoot, commit) {
  if (typeof commit !== "string" || !/^[0-9a-f]{40}$/.test(commit)) return false;
  const result = spawnSync("git", ["-C", repoRoot, "merge-base", "--is-ancestor", commit, "HEAD"], { encoding: "utf8" });
  return result.status === 0;
}

export function providerStudyFreezeMatches(repoRoot, { lock = null, lockPath = null } = {}) {
  const path = lockPath ?? providerStudyFreezeLockPath(repoRoot);
  if (!existsSync(path)) {
    return { ok: false, problems: ["freeze lock is missing; run provider-study freeze before any execution"] };
  }
  const stored = lock ?? JSON.parse(readFileSync(path, "utf8")).digests;
  const current = providerStudyFreezeDigests(repoRoot);
  const problems = [];
  for (const key of Object.keys(current)) {
    if (key === "evaluator") continue;
    if (JSON.stringify(stored[key]) !== JSON.stringify(current[key])) {
      problems.push(`frozen input ${key} changed since the freeze`);
    }
  }
  if (stored?.evaluator?.sourceSha256 !== current.evaluator.sourceSha256) {
    problems.push("frozen evaluator source changed since the freeze");
  }
  if (!evaluatorCommitIsAncestor(repoRoot, stored?.evaluator?.commit)) {
    problems.push("frozen evaluator commit is not an ancestor of the current checkout");
  }
  return { ok: problems.length === 0, problems };
}
