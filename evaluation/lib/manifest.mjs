/**
 * Manifest loading and strict schemaVersion 2 validation.
 *
 * The manifest is executable evaluation data, not documentation. Strict
 * validation grows test-first; the current slice rejects non-objects,
 * wrong schema versions, and unknown keys.
 */

import { readFileSync } from "node:fs";
import { join } from "node:path";

const TOP_LEVEL_KEYS = ["schemaVersion", "evaluation", "tasks"];
const EVALUATION_KEYS = [
  "provider",
  "model",
  "thinking",
  "profile",
  "piVersion",
  "tools",
  "timeoutMsPerAttempt",
  "arms",
];

const TASK_KEYS = ["number", "id", "category", "scale", "title", "prompt", "fixture"];
const CATEGORIES = new Set([
  "python",
  "typescript",
  "javascript",
  "git",
  "search",
  "build",
  "debugging",
  "cache",
  "parser",
  "long-context",
  "mixed-tool",
]);
const SCALES = new Set(["standard", "long"]);

export function validateManifest(value) {
  const errors = [];
  if (!isPlainObject(value)) {
    return { ok: false, errors: ["manifest: must be a JSON object"] };
  }
  checkKeys(value, TOP_LEVEL_KEYS, "manifest", errors);
  if (value.schemaVersion !== 2) {
    errors.push(
      `manifest.schemaVersion: must be exactly 2 (got ${JSON.stringify(value.schemaVersion)})`,
    );
  }
  if (!isPlainObject(value.evaluation)) {
    errors.push("manifest.evaluation: must be an object");
  } else {
    checkKeys(value.evaluation, EVALUATION_KEYS, "manifest.evaluation", errors);
    validateEvaluationPins(value.evaluation, errors);
  }
  if (!Array.isArray(value.tasks)) {
    errors.push("manifest.tasks: must be an array");
  } else if (value.tasks.length !== 20) {
    errors.push(
      `manifest.tasks: must contain exactly 20 tasks (got ${value.tasks.length})`,
    );
  } else {
    validateTasks(value.tasks, errors);
  }
  if (errors.length > 0) {
    return { ok: false, errors };
  }
  return { ok: true, value };
}

function checkKeys(object, allowed, where, errors) {
  for (const key of Object.keys(object)) {
    if (!allowed.includes(key)) {
      errors.push(`${where}: unknown key "${key}"`);
    }
  }
}

function validateTasks(tasks, errors) {
  const seenIds = new Set();
  tasks.forEach((task, index) => {
    const where = `manifest.tasks[${index}]`;
    if (!isPlainObject(task)) {
      errors.push(`${where}: must be an object`);
      return;
    }
    checkKeys(task, TASK_KEYS, where, errors);
    const expectedNumber = index + 1;
    if (task.number !== expectedNumber) {
      errors.push(`${where}.number: must be ${expectedNumber} (got ${JSON.stringify(task.number)})`);
    }
    const expectedId = `task-${String(expectedNumber).padStart(2, "0")}`;
    if (task.id !== expectedId) {
      errors.push(`${where}.id: must be "${expectedId}" (got ${JSON.stringify(task.id)})`);
    }
    if (seenIds.has(task.id)) {
      errors.push(`${where}.id: duplicate task id ${JSON.stringify(task.id)}`);
    }
    seenIds.add(task.id);
    if (!CATEGORIES.has(task.category)) {
      errors.push(`${where}.category: ${JSON.stringify(task.category)} is not a known category`);
    }
    if (!SCALES.has(task.scale)) {
      errors.push(`${where}.scale: must be "standard" or "long" (got ${JSON.stringify(task.scale)})`);
    }
    if (typeof task.title !== "string" || task.title.trim().length === 0) {
      errors.push(`${where}.title: must be a non-empty string`);
    }
    if (typeof task.prompt !== "string" || task.prompt.trim().length === 0) {
      errors.push(`${where}.prompt: must be a non-empty string`);
    }
    const fixtureErrors = [];
    validateFixture(task.fixture, `${where}.fixture`, fixtureErrors);
    errors.push(...fixtureErrors);
  });
}

function validateFixture(fixture, where, errors) {
  if (!isPlainObject(fixture)) {
    errors.push(`${where}: must be an object`);
    return;
  }
  const allowed = ["files", "generate", "mutations", "untracked", "git"];
  for (const key of Object.keys(fixture)) {
    if (!allowed.includes(key)) {
      errors.push(`${where}: unknown key "${key}"`);
    }
  }
  for (const file of Array.isArray(fixture.files) ? fixture.files : []) {
    if (isPlainObject(file)) {
      checkSafePath(file.path, `${where}.files[].path`, errors);
    }
  }
  for (const file of Array.isArray(fixture.untracked) ? fixture.untracked : []) {
    if (isPlainObject(file)) {
      checkSafePath(file.path, `${where}.untracked[].path`, errors);
    }
  }
  for (const entry of Array.isArray(fixture.generate) ? fixture.generate : []) {
    if (isPlainObject(entry)) {
      checkSafePath(entry.path, `${where}.generate[].path`, errors);
      const knownTemplates = ["python-module", "js-service", "log-lines", "jsonl-events"];
      if (!knownTemplates.includes(entry.template)) {
        errors.push(
          `${where}.generate[].template: unknown template ${JSON.stringify(entry.template)}`,
        );
      }
    }
  }
  for (const mutation of Array.isArray(fixture.mutations) ? fixture.mutations : []) {
    if (isPlainObject(mutation) && (typeof mutation.from !== "string" || typeof mutation.to !== "string")) {
      errors.push(`${where}.mutations[].from/to: must be strings`);
    }
  }
  const post = isPlainObject(fixture.git) ? fixture.git.post : [];
  for (const step of Array.isArray(post) ? post : []) {
    if (!isPlainObject(step)) {
      continue;
    }
    const argvOk =
      Array.isArray(step.argv) &&
      step.argv.length > 0 &&
      step.argv.every((part) => typeof part === "string" && part.length > 0);
    if (!argvOk) {
      errors.push(`${where}.git.post[].argv: must be a non-empty array of strings`);
    } else if (step.argv[0] !== "git") {
      errors.push(`${where}.git.post[].argv: fixture post steps must start with "git"`);
    }
  }
}

const THINKING_LEVELS = ["off", "minimal", "low", "medium", "high", "xhigh", "max"];
const ARM_NAMES = ["upstream", "fork"];
const ARM_ROLES = ["baseline", "treatment"];

function validateEvaluationPins(evaluation, errors) {
  const where = "manifest.evaluation";
  for (const key of ["provider", "model", "profile"]) {
    if (typeof evaluation[key] !== "string" || evaluation[key].trim().length === 0) {
      errors.push(`${where}.${key}: must be a non-empty string`);
    }
  }
  if (!THINKING_LEVELS.includes(evaluation.thinking)) {
    errors.push(
      `${where}.thinking: must be one of ${THINKING_LEVELS.join(", ")} (got ${JSON.stringify(evaluation.thinking)})`,
    );
  }
  if (typeof evaluation.piVersion !== "string" || !/^\d+\.\d+\.\d+$/.test(evaluation.piVersion)) {
    errors.push(`${where}.piVersion: must be a semver string like 0.84.2`);
  }
  const tools = evaluation.tools;
  if (
    !Array.isArray(tools) ||
    tools.length === 0 ||
    tools.some((tool) => typeof tool !== "string" || tool.length === 0) ||
    new Set(tools).size !== tools.length
  ) {
    errors.push(`${where}.tools: must be a non-empty array of unique tool name strings`);
  }
  if (
    typeof evaluation.timeoutMsPerAttempt !== "number" ||
    !Number.isInteger(evaluation.timeoutMsPerAttempt) ||
    evaluation.timeoutMsPerAttempt <= 0
  ) {
    errors.push(`${where}.timeoutMsPerAttempt: must be a positive integer of milliseconds`);
  }
  const arms = evaluation.arms;
  if (!Array.isArray(arms) || arms.length !== 2) {
    errors.push(`${where}.arms: must contain exactly two arms`);
  } else {
    arms.forEach((arm, index) => {
      if (!isPlainObject(arm)) {
        errors.push(`${where}.arms[${index}]: must be an object`);
        return;
      }
      checkKeys(arm, ["name", "role", "commit"], `${where}.arms[${index}]`, errors);
      if (arm.name !== ARM_NAMES[index]) {
        errors.push(`${where}.arms[${index}].name: must be "${ARM_NAMES[index]}"`);
      }
      if (arm.role !== ARM_ROLES[index]) {
        errors.push(`${where}.arms[${index}].role: must be "${ARM_ROLES[index]}"`);
      }
      if (typeof arm.commit !== "string" || !/^[0-9a-f]{40}$/.test(arm.commit)) {
        errors.push(`${where}.arms[${index}].commit: must be a 40-character lowercase commit sha`);
      }
    });
  }
}

function checkSafePath(pathValue, where, errors) {
  if (typeof pathValue !== "string" || pathValue.length === 0) {
    errors.push(`${where}: must be a non-empty string`);
    return;
  }
  if (pathValue.startsWith("/") || pathValue.includes("\\") || pathValue.includes("\0")) {
    errors.push(`${where}: must be a relative path without backslashes`);
    return;
  }
  const segments = pathValue.split("/");
  if (segments.some((segment) => segment === ".." || segment === "")) {
    errors.push(`${where}: must not contain "..", empty, or redundant segments`);
    return;
  }
  if (segments[0] === ".git") {
    errors.push(`${where}: must not write inside .git`);
  }
}

function isPlainObject(value) {
  return (
    typeof value === "object" &&
    value !== null &&
    !Array.isArray(value) &&
    Object.getPrototypeOf(value) === Object.prototype
  );
}

export class ManifestError extends Error {
  constructor(message, errors) {
    super(message);
    this.name = "ManifestError";
    this.errors = errors ?? [];
  }
}

/** Load and strictly validate the manifest at `manifestPath`. */
export function loadManifestFile(manifestPath) {
  let parsed;
  try {
    parsed = JSON.parse(readFileSync(manifestPath, "utf8"));
  } catch (error) {
    throw new ManifestError(`cannot read manifest ${manifestPath}: ${error.message}`);
  }
  const result = validateManifest(parsed);
  if (!result.ok) {
    throw new ManifestError(`invalid manifest ${manifestPath}`, result.errors);
  }
  return result.value;
}

/**
 * Load the hidden per-task data: scorer assertions and the reference
 * solution used by the fake Pi. These files never enter task prompts or
 * task worktrees.
 */
export function loadTaskData(repoRoot, taskId) {
  const assertionsPath = join(repoRoot, "evaluation", "scorers", "assertions", `${taskId}.json`);
  const solutionPath = join(repoRoot, "evaluation", "scorers", "solutions", `${taskId}.json`);
  let assertions;
  let solution;
  try {
    assertions = JSON.parse(readFileSync(assertionsPath, "utf8"));
  } catch (error) {
    throw new ManifestError(`cannot read assertions for ${taskId}: ${error.message}`);
  }
  try {
    solution = JSON.parse(readFileSync(solutionPath, "utf8"));
  } catch (error) {
    throw new ManifestError(`cannot read solution for ${taskId}: ${error.message}`);
  }
  return { assertions: assertions.assertions, solution };
}
