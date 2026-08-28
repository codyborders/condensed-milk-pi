/**
 * Masking-focused study manifest loading and validation.
 *
 * Separate study from the 20-task paired evaluation: separate manifest,
 * profile bytes, scorer tree, and reports. Nothing here mutates
 * evaluation/task-manifest.json or its validators.
 */

import { readFileSync } from "node:fs";
import { join } from "node:path";
import { createHash } from "node:crypto";

export class MaskingManifestError extends Error {
  constructor(message, errors) {
    super(message);
    this.name = "MaskingManifestError";
    this.errors = errors ?? [];
  }
}

const MASKING_RUN_ID_PATTERN = /^[A-Za-z0-9][A-Za-z0-9._-]{0,127}$/;

/**
 * Path-safe masking run-id gate. Refuses traversal, separators,
 * control characters, dotfiles, and overlong ids before any run path
 * is joined. Every masking command calls this first.
 */
export function validateMaskingRunId(value) {
  if (typeof value !== "string" || !MASKING_RUN_ID_PATTERN.test(value)) {
    return {
      ok: false,
      problems: ["run id must match ^[A-Za-z0-9][A-Za-z0-9._-]{0,127}$"],
    };
  }
  return { ok: true };
}

function isPlainObject(value) {
  return (
    typeof value === "object" &&
    value !== null &&
    !Array.isArray(value) &&
    Object.getPrototypeOf(value) === Object.prototype
  );
}

/**
 * Load the study profile: the exact byte string both arms receive plus
 * its sha256 and resolved thresholds/coverage.
 */
export function loadStudyProfile(repoRoot) {
  const manifestPath = join(repoRoot, "evaluation", "masking-task-manifest.json");
  let manifestParsed;
  try {
    manifestParsed = JSON.parse(readFileSync(manifestPath, "utf8"));
  } catch (error) {
    throw new MaskingManifestError(`cannot read masking manifest ${manifestPath}: ${error.message}`);
  }
  const profileFile = manifestParsed?.evaluation?.profileFile;
  const profilePath = join(repoRoot, "evaluation", profileFile);
  let bytes;
  try {
    bytes = readFileSync(profilePath, "utf8");
  } catch (error) {
    throw new MaskingManifestError(`cannot read study profile ${profilePath}: ${error.message}`);
  }
  let parsed;
  try {
    parsed = JSON.parse(bytes);
  } catch (error) {
    throw new MaskingManifestError(`study profile ${profilePath} is not valid JSON: ${error.message}`);
  }
  const name = parsed?.profile;
  const override = parsed?.profiles?.[name];
  if (typeof name !== "string" || name.length === 0 || !isPlainObject(override)) {
    throw new MaskingManifestError(`study profile ${profilePath} has no usable profile override`);
  }
  if (!isPlainObject(parsed.filters) || [...MASKING_APPROVED_FILTER_IDS].some((id) => parsed.filters[id] !== true)) {
    throw new MaskingManifestError(`study profile ${profilePath} must enable every approved study semantic filter`);
  }
  return {
    bytes,
    sha256: createHash("sha256").update(bytes).digest("hex"),
    resolved: {
      name,
      thresholds: override.thresholds,
      coverage: override.coverage,
      effectiveContextCap: override.effectiveContextCap,
      filters: parsed.filters,
    },
  };
}

export const MASKING_STUDY_PINS = Object.freeze({
  provider: "z-ai",
  model: "glm-5.3-flash",
  upstreamCommit: "71f9e396951c42687f0c3456727b2b5c8c625da1",
  forkCommit: "fca546506e3c6b26401155a780052646a65dee38",
});

export const MASKING_APPROVED_FILTER_IDS = Object.freeze(new Set([
  "pytest",
  "git-status-porcelain",
  "git-log-verbose",
  "git-diff",
  "rg",
]));

const MASKING_THRESHOLDS = Object.freeze([0.05, 0.08, 0.12]);
const MASKING_COVERAGE = Object.freeze([0.50, 0.75, 0.90]);
const MASKING_EFFECTIVE_CONTEXT_CAP = 131_072;
const MASKING_FILLER_LINES = 400;

/**
 * Study pin identity gate: provider and model must match the pinned
 * z-ai / glm-5.3-flash identity, and the profile digest must be 64-hex
 * sha256, before any reservation is created.
 */
export function validateStudyIdentity({ provider, model, profileSha256 }) {
  const problems = [];
  if (provider !== MASKING_STUDY_PINS.provider) {
    problems.push(`provider must be ${JSON.stringify(MASKING_STUDY_PINS.provider)} (got ${JSON.stringify(provider)})`);
  }
  if (model !== MASKING_STUDY_PINS.model) {
    problems.push(`model must be ${JSON.stringify(MASKING_STUDY_PINS.model)} (got ${JSON.stringify(model)})`);
  }
  if (typeof profileSha256 !== "string" || !/^[0-9a-f]{64}$/.test(profileSha256)) {
    problems.push("profile sha256 must be a 64-hex digest");
  }
  return problems.length === 0 ? { ok: true } : { ok: false, problems };
}

/** Hidden per-task data for the masking study (separate scorer tree). */
export function loadMaskingTaskData(repoRoot, taskId) {
  const assertionsPath = join(repoRoot, "evaluation", "scorers", "masking-assertions", `${taskId}.json`);
  const solutionPath = join(repoRoot, "evaluation", "scorers", "masking-solutions", `${taskId}.json`);
  let assertions;
  let solution;
  try {
    assertions = JSON.parse(readFileSync(assertionsPath, "utf8"));
  } catch (error) {
    throw new MaskingManifestError(`cannot read masking assertions for ${taskId}: ${error.message}`);
  }
  try {
    solution = JSON.parse(readFileSync(solutionPath, "utf8"));
  } catch (error) {
    throw new MaskingManifestError(`cannot read masking solution for ${taskId}: ${error.message}`);
  }
  return { assertions: assertions.assertions, solution };
}

export function maskingScorerSha256(repoRoot, taskId) {
  const path = join(repoRoot, "evaluation", "scorers", "masking-assertions", `${taskId}.json`);
  return createHash("sha256").update(readFileSync(path)).digest("hex");
}

/**
 * Strict-enough validation for this slice: shape checks plus the task
 * threshold contract against the study profile. Rejection rules grow
 * with their failing tests.
 */
export function validateMaskingManifest(value, { profile = null } = {}) {
  const errors = [];
  if (!isPlainObject(value)) {
    return { ok: false, errors: ["masking manifest: must be a JSON object"] };
  }
  if (value.schemaVersion !== 2) {
    errors.push(`masking manifest.schemaVersion: must be exactly 2 (got ${JSON.stringify(value.schemaVersion)})`);
  }
  const evaluation = value.evaluation;
  if (!isPlainObject(evaluation)) {
    errors.push("masking manifest.evaluation: must be an object");
  } else {
    if (evaluation.provider !== MASKING_STUDY_PINS.provider) errors.push("masking manifest.evaluation.provider: must match study pin");
    if (evaluation.model !== MASKING_STUDY_PINS.model) errors.push("masking manifest.evaluation.model: must match study pin");
    if (evaluation.repetitionsPerTask !== 3) errors.push("masking manifest.evaluation.repetitionsPerTask: must be exactly 3");
    if (!Array.isArray(evaluation.tools) || !evaluation.tools.includes("condensed_milk_retrieve")) {
      errors.push("masking manifest.evaluation.tools: must pin condensed_milk_retrieve");
    }
    // The approved ordered tool list is exact.
    const approvedTools = ["read", "bash", "edit", "write", "grep", "find", "ls", "condensed_milk_retrieve"];
    if (JSON.stringify(evaluation.tools) !== JSON.stringify(approvedTools)) {
      errors.push("masking manifest.evaluation.tools: must equal the exact approved ordered list");
    }
    // Arms are exactly upstream (baseline) and fork (treatment), in order.
    const armShape = Array.isArray(evaluation.arms)
      ? evaluation.arms.map((arm) => [arm?.name, arm?.role])
      : [];
    if (JSON.stringify(armShape) !== JSON.stringify([["upstream", "baseline"], ["fork", "treatment"]])) {
      errors.push("masking manifest.evaluation.arms: must be exactly upstream/baseline then fork/treatment");
    }
    if (evaluation.piVersion !== "0.84.2") errors.push("masking manifest.evaluation.piVersion: must be exactly 0.84.2");
    if (evaluation.thinking !== "high") errors.push("masking manifest.evaluation.thinking: must be exactly high");
    if (evaluation.profileFile !== "masking-eval-profile.json") errors.push("masking manifest.evaluation.profileFile: must be exactly masking-eval-profile.json");
    if (evaluation.profile !== "eval-masking") errors.push("masking manifest.evaluation.profile: must be exactly eval-masking");
    const arms = Array.isArray(evaluation.arms) ? evaluation.arms : [];
    const commits = Object.fromEntries(arms.map((arm) => [arm?.name, arm?.commit]));
    if (commits.upstream !== MASKING_STUDY_PINS.upstreamCommit) errors.push("masking manifest.evaluation.arms.upstream.commit: must match exact pin");
    if (commits.fork !== MASKING_STUDY_PINS.forkCommit) errors.push("masking manifest.evaluation.arms.fork.commit: must match exact pin");
  }
  if (profile) {
    if (JSON.stringify(profile.thresholds) !== JSON.stringify(MASKING_THRESHOLDS)) errors.push("masking profile thresholds must be exactly [0.05, 0.08, 0.12]");
    if (JSON.stringify(profile.coverage) !== JSON.stringify(MASKING_COVERAGE)) errors.push("masking profile coverage must be exactly [0.50, 0.75, 0.90]");
    if (profile.effectiveContextCap !== MASKING_EFFECTIVE_CONTEXT_CAP) errors.push("masking profile effectiveContextCap must be exactly 131072");
  }
  if (!Array.isArray(value.tasks) || value.tasks.length !== 8) {
    errors.push(`masking manifest.tasks: must contain exactly 8 tasks`);
    return { ok: false, errors };
  }
  const firstProfileThreshold = profile?.thresholds?.[0];
  value.tasks.forEach((task, index) => {
    const where = `masking manifest.tasks[${index}]`;
    const masking = task?.masking;
    if (!isPlainObject(masking)) {
      errors.push(`${where}.masking: must be an object`);
      return;
    }
    if (
      typeof masking.threshold !== "number" ||
      !Number.isFinite(masking.threshold) ||
      masking.threshold !== 0.05
    ) {
      errors.push(`${where}.masking.threshold: must be exactly 0.05`);
    } else if (profile && (typeof firstProfileThreshold !== "number" || masking.threshold < firstProfileThreshold)) {
      errors.push(
        `${where}.masking.threshold: must be at or above the profile's first threshold ${JSON.stringify(firstProfileThreshold)}`,
      );
    }
    if (!Array.isArray(masking.filterIds)) {
      errors.push(`${where}.masking.filterIds: must be an array`);
    } else {
      const ids = masking.filterIds;
      if (ids.some((id) => typeof id !== "string" || !MASKING_APPROVED_FILTER_IDS.has(id))) {
        errors.push(`${where}.masking.filterIds: contains an unapproved filter id`);
      }
      if (new Set(ids).size !== ids.length) errors.push(`${where}.masking.filterIds: entries must be unique`);
    }
    const fixture = task?.fixture;
    const generated = isPlainObject(fixture) && Array.isArray(fixture.generate) ? fixture.generate : [];
    const expectedFillerPath = `context/${task.id}.log`;
    const filler = generated.find((entry) => entry?.path === expectedFillerPath);
    if (
      !isPlainObject(filler) ||
      filler.template !== "log-lines" ||
      filler.count !== MASKING_FILLER_LINES ||
      !Number.isSafeInteger(filler.seed)
    ) {
      errors.push(`${where}.fixture.generate: must include ${expectedFillerPath} with 400 deterministic log lines`);
    }
  });
  if (errors.length > 0) return { ok: false, errors };
  return { ok: true, value };
}

/** Load and validate the checked-in masking manifest plus profile. */
export function loadMaskingManifestFile(repoRoot) {
  const path = join(repoRoot, "evaluation", "masking-task-manifest.json");
  let parsed;
  try {
    parsed = JSON.parse(readFileSync(path, "utf8"));
  } catch (error) {
    throw new MaskingManifestError(`cannot read masking manifest ${path}: ${error.message}`);
  }
  const profile = loadStudyProfile(repoRoot);
  const result = validateMaskingManifest(parsed, { profile: profile.resolved });
  if (!result.ok) {
    throw new MaskingManifestError(`invalid masking manifest ${path}`, result.errors);
  }
  return { manifest: result.value, profile };
}
