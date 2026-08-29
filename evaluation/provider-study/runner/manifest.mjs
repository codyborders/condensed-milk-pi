/**
 * Provider-study manifest loading (grown test-first).
 *
 * The development manifest references exactly 12 existing exposed
 * general tasks under one frozen evaluation block.
 */

import { readFileSync } from "node:fs";
import { createHash } from "node:crypto";
import { join } from "node:path";
import { stableJson } from "./arms.mjs";

export const PROVIDER_STUDY_PHASES = Object.freeze(["development", "holdout"]);
export const PROVIDER_STUDY_ARM_NAMES = Object.freeze([
  "none",
  "upstream",
  "remediated-defaults",
  "remediated-archive",
]);

/** Frozen shared execution pins, identical for every arm and phase. */
export const PROVIDER_STUDY_PINS = Object.freeze({
  provider: "z-ai",
  model: "glm-5.3-flash",
  thinking: "high",
  piVersion: "0.84.2",
  tools: Object.freeze(["read", "bash", "edit", "write", "grep", "find", "ls", "condensed_milk_retrieve"]),
  timeoutMsPerAttempt: 3_600_000,
  repetitionsPreallocated: 5,
  conditionalRepetitions: Object.freeze([6, 7, 8, 9, 10]),
  noPaidRetry: true,
});

export function providerStudyManifestPath(repoRoot, phase) {
  return join(repoRoot, "evaluation", "provider-study", phase === "development" ? "development-manifest.json" : "holdout-manifest.json");
}

/** Holdout coverage contract: the 8 holdout tasks must cover this exact set. */
export const HOLDOUT_COVERAGE_TAGS = Object.freeze([
  "noisy-tests",
  "typescript-build-failures",
  "git-status-large-diffs",
  "repeated-reads",
  "search",
  "repetitive-logs",
  "successful-failed-commands",
  "long-masking-pressure",
  "exact-warnings-paths",
  "archive-recovery",
  "multi-step-implementation",
]);

/** All holdout task ids from the holdout manifest, in manifest order. */
export function holdoutTaskIds(repoRoot) {
  return JSON.parse(readFileSync(providerStudyManifestPath(repoRoot, "holdout"), "utf8")).tasks.map((task) => task.id);
}

/**
 * Validate one phase manifest against the frozen pins. Development must
 * reference exactly 12 distinct existing general tasks. Returns
 * { ok, errors } and never throws.
 */
export function validateProviderStudyManifest(value, { phase = "development", generalTaskIds = null } = {}) {
  const errors = [];
  const where = `provider-study ${phase} manifest`;
  if (typeof value !== "object" || value === null || Array.isArray(value)) {
    return { ok: false, errors: [`${where}: must be a JSON object`] };
  }
  if (value.schemaVersion !== 1) errors.push(`${where}.schemaVersion: must be exactly 1`);
  if (value.study !== "provider-study") errors.push(`${where}.study: must be exactly "provider-study"`);
  if (value.phase !== phase) errors.push(`${where}.phase: must be exactly ${JSON.stringify(phase)}`);
  const evaluation = value.evaluation;
  if (typeof evaluation !== "object" || evaluation === null || Array.isArray(evaluation)) {
    errors.push(`${where}.evaluation: must be an object`);
  } else {
    for (const [field, expected] of [
      ["provider", PROVIDER_STUDY_PINS.provider],
      ["model", PROVIDER_STUDY_PINS.model],
      ["thinking", PROVIDER_STUDY_PINS.thinking],
      ["piVersion", PROVIDER_STUDY_PINS.piVersion],
      ["repetitionsPreallocated", PROVIDER_STUDY_PINS.repetitionsPreallocated],
      ["noPaidRetry", PROVIDER_STUDY_PINS.noPaidRetry],
    ]) {
      if (evaluation[field] !== expected) {
        errors.push(`${where}.evaluation.${field}: must be exactly ${JSON.stringify(expected)}`);
      }
    }
    if (JSON.stringify(evaluation.conditionalRepetitions) !== JSON.stringify([...PROVIDER_STUDY_PINS.conditionalRepetitions])) {
      errors.push(`${where}.evaluation.conditionalRepetitions: must be exactly [6,7,8,9,10]`);
    }
    if (JSON.stringify(evaluation.tools) !== JSON.stringify(PROVIDER_STUDY_PINS.tools)) {
      errors.push(`${where}.evaluation.tools: must equal the exact frozen ordered tool list`);
    }
    if (evaluation.timeoutMsPerAttempt !== PROVIDER_STUDY_PINS.timeoutMsPerAttempt) {
      errors.push(`${where}.evaluation.timeoutMsPerAttempt: must be exactly ${PROVIDER_STUDY_PINS.timeoutMsPerAttempt}`);
    }
    if (typeof evaluation.seed !== "string" || evaluation.seed.length === 0) {
      errors.push(`${where}.evaluation.seed: must be a non-empty string`);
    }
  }
  if (!Array.isArray(value.tasks)) {
    errors.push(`${where}.tasks: must be an array`);
    return { ok: errors.length === 0, errors };
  }
  if (phase === "development") {
    if (value.tasks.length !== 12) errors.push(`${where}.tasks: development must reference exactly 12 existing general tasks`);
    const ids = new Set();
    for (const task of value.tasks) {
      const id = task?.id;
      if (typeof id !== "string" || id.length === 0) {
        errors.push(`${where}.tasks: every task needs a string id`);
        continue;
      }
      if (ids.has(id)) errors.push(`${where}.tasks: duplicate task id ${id}`);
      ids.add(id);
      if (Array.isArray(generalTaskIds) && !generalTaskIds.includes(id)) {
        errors.push(`${where}.tasks: ${id} is not an exposed general task`);
      }
    }
    return { ok: errors.length === 0, errors };
  }
  if (value.tasks.length !== 8) errors.push(`${where}.tasks: holdout must define exactly 8 new tasks`);
  const bundle = value.bundle;
  if (typeof bundle !== "object" || bundle === null || Array.isArray(bundle)) {
    errors.push(`${where}.bundle: the public holdout manifest must reference the encrypted bundle`);
  } else {
    if (bundle.algorithm !== "aes-256-gcm") {
      errors.push(`${where}.bundle.algorithm: must be exactly "aes-256-gcm"`);
    }
    if (typeof bundle.bundleSha256 !== "string" || !/^[0-9a-f]{64}$/.test(bundle.bundleSha256)) {
      errors.push(`${where}.bundle.bundleSha256: must be a 64-hex sha256 digest of the encrypted bundle envelope`);
    }
  }
  const ids = new Set();
  const coverage = new Set();
  const FORBIDDEN_PRIVATE_FIELDS = ["prompt", "fixture", "title", "number", "scorer", "solution"];
  for (const task of value.tasks) {
    const id = task?.id;
    if (typeof id !== "string" || !/^holdout-task-\d{2}$/.test(id)) {
      errors.push(`${where}.tasks: every holdout task id must match ^holdout-task-\\d{2}$`);
    } else if (ids.has(id)) {
      errors.push(`${where}.tasks: duplicate task id ${id}`);
    } else {
      ids.add(id);
    }
    for (const field of FORBIDDEN_PRIVATE_FIELDS) {
      if (task?.[field] !== undefined) {
        errors.push(`${where}.tasks: ${id ?? "task"} must not carry the private field ${field}; holdout plaintext lives only in the encrypted bundle`);
      }
    }
    if (typeof task?.taskSha256 !== "string" || !/^[0-9a-f]{64}$/.test(task.taskSha256)) {
      errors.push(`${where}.tasks: every holdout task needs a 64-hex taskSha256 over its private definition`);
    }
    if (!Array.isArray(task?.coverage) || task.coverage.length === 0) {
      errors.push(`${where}.tasks: every holdout task needs coverage tags`);
    } else {
      for (const tag of task.coverage) {
        if (!HOLDOUT_COVERAGE_TAGS.includes(tag)) {
          errors.push(`${where}.tasks: unknown coverage tag ${JSON.stringify(tag)}`);
        } else {
          coverage.add(tag);
        }
      }
    }
  }
  const missing = HOLDOUT_COVERAGE_TAGS.filter((tag) => !coverage.has(tag));
  if (missing.length > 0) errors.push(`${where}.tasks: holdout coverage is missing ${missing.join(", ")}`);
  return { ok: errors.length === 0, errors };
}

/** Load, strictly validate, and digest one phase manifest. */
export function loadProviderStudyManifestFile(repoRoot, { phase }) {
  if (!PROVIDER_STUDY_PHASES.includes(phase)) {
    throw new Error(`provider-study phase must be development or holdout (got ${JSON.stringify(phase)})`);
  }
  const path = providerStudyManifestPath(repoRoot, phase);
  const bytes = readFileSync(path);
  const parsed = JSON.parse(bytes.toString("utf8"));
  const generalIds = phase === "development"
    ? JSON.parse(readFileSync(join(repoRoot, "evaluation", "task-manifest.json"), "utf8")).tasks.map((task) => task.id)
    : null;
  const check = validateProviderStudyManifest(parsed, { phase, ...(generalIds ? { generalTaskIds: generalIds } : {}) });
  if (!check.ok) throw new Error(`provider-study ${phase} manifest refused: ${check.errors.join("; ")}`);
  return {
    manifest: parsed,
    phase,
    sha256: createHash("sha256").update(bytes).digest("hex"),
    tasks: parsed.tasks,
    seed: parsed.evaluation.seed,
  };
}

/**
 * Hidden per-task data. Development resolves against the existing
 * general scorer tree. Holdout resolves only against a decrypted
 * private task delivered by withHoldoutTasks; the plaintext never
 * lives in this repository. Cross-phase reads are refused before any
 * file opens.
 */
export function loadProviderStudyTaskData(repoRoot, phase, taskId, { holdoutTask = null } = {}) {
  if (!PROVIDER_STUDY_PHASES.includes(phase)) {
    throw new Error(`provider-study phase must be development or holdout (got ${JSON.stringify(phase)})`);
  }
  if (typeof taskId !== "string" || taskId.length === 0) {
    throw new Error("task id must be a non-empty string");
  }
  if (taskId.startsWith("holdout-") !== (phase === "holdout")) {
    throw new Error(`task ${taskId} does not belong to the ${phase} phase; refusing the cross-phase read`);
  }
  if (phase === "holdout") {
    if (holdoutTask === null || typeof holdoutTask !== "object") {
      throw new Error(`holdout task ${taskId} needs its decrypted private task; open the encrypted bundle with --holdout-key-source first`);
    }
    const scorerObject = holdoutTask.scorer;
    if (typeof scorerObject !== "object" || scorerObject === null || !Array.isArray(scorerObject.assertions) || scorerObject.assertions.length === 0) {
      throw new Error(`holdout task ${taskId} hidden assertions must be a non-empty array`);
    }
    const solution = holdoutTask.solution;
    if (!Array.isArray(solution?.files) || solution.files.length === 0) {
      if (!Array.isArray(solution?.commands) || solution.commands.length === 0) {
        throw new Error(`holdout task ${taskId} hidden solution must carry files or commands`);
      }
    }
    return {
      assertions: scorerObject.assertions,
      solution,
      scorerSha256: createHash("sha256").update(stableJson(scorerObject)).digest("hex"),
    };
  }
  const assertionsPath = join(repoRoot, "evaluation", "scorers", "assertions", `${taskId}.json`);
  const solutionPath = join(repoRoot, "evaluation", "scorers", "solutions", `${taskId}.json`);
  const assertionsBytes = readFileSync(assertionsPath);
  const solutionBytes = readFileSync(solutionPath);
  const envelope = JSON.parse(assertionsBytes.toString("utf8"));
  const solution = JSON.parse(solutionBytes.toString("utf8"));
  if (!Array.isArray(envelope?.assertions) || envelope.assertions.length === 0) {
    throw new Error(`${phase} task ${taskId} hidden assertions must be a non-empty array`);
  }
  if (!Array.isArray(solution?.files) || solution.files.length === 0) {
    if (!Array.isArray(solution?.commands) || solution.commands.length === 0) {
      throw new Error(`${phase} task ${taskId} hidden solution must carry files or commands`);
    }
  }
  return {
    assertions: envelope.assertions,
    solution,
    scorerSha256: createHash("sha256").update(assertionsBytes).digest("hex"),
  };
}
