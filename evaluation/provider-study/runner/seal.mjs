/**
 * Holdout bundle sealing (grown test-first).
 *
 * Sealing consumes one external private definitions document (task
 * titles, prompts, fixtures, hidden scorers, hidden solutions, and
 * the public coverage tags) plus one external key .env, and produces
 * exactly two repository artifacts:
 *
 * - `holdout.enc`: the authenticated encrypted bundle envelope with
 *   its frozen ciphertext digest, and
 * - `holdout-manifest.json`: the public manifest carrying only task
 *   ids, coverage tags, the frozen per-task/scorer/solution/fixture
 *   hashes, the bundle digest, and the non-sensitive execution block.
 *
 * The private definitions file and the key source must live outside
 * the repository; sealing refuses either inside it. The seal result
 * carries paths and digests only — never plaintext and never the key.
 * The key entry is ensured once (generated when missing, reused when
 * present) so re-sealing never rotates the key.
 */

import { existsSync, readFileSync, writeFileSync } from "node:fs";
import { createHash } from "node:crypto";
import { isAbsolute, join, relative, resolve } from "node:path";
import {
  ensureHoldoutKeyFile,
  readHoldoutKey,
  encryptHoldoutBundle,
  holdoutBundleEnvelopeSha256,
  holdoutTaskSha256,
} from "./holdout.mjs";
import { validateProviderStudyManifest } from "./manifest.mjs";
import { stableJson } from "./arms.mjs";

function stableSha256(value) {
  return createHash("sha256").update(stableJson(value), "utf8").digest("hex");
}

function refuseInsideRepo(path, label, repoRoot) {
  const rel = relative(resolve(repoRoot), resolve(path));
  if (rel === "" || (!rel.startsWith("..") && !isAbsolute(rel))) {
    throw new Error(`the ${label} must live outside this repository (got ${path}); refusing to seal`);
  }
}

function requireTaskField(task, field, id) {
  const value = task?.[field];
  if (value === undefined || value === null) {
    throw new Error(`holdout private task ${id ?? "(missing id)"} has no ${field}; refusing to seal`);
  }
  return value;
}

/**
 * Seal the holdout bundle. Reads the external private definitions and
 * the external key, validates the resulting public manifest against
 * the strict holdout contract, and writes both artifacts atomically
 * enough for a one-time operation: nothing is written unless the
 * whole document validates first.
 */
export async function providerStudySealHoldout({ repoRoot, keySourcePath, privateTasksPath }) {
  if (typeof repoRoot !== "string" || repoRoot.length === 0) {
    throw new Error("sealing needs the repository root");
  }
  if (typeof privateTasksPath !== "string" || privateTasksPath.length === 0) {
    throw new Error("sealing needs --private-tasks PATH pointing at the external definitions document");
  }
  if (typeof keySourcePath !== "string" || keySourcePath.length === 0) {
    throw new Error("sealing needs --holdout-key-source PATH pointing at the external key .env");
  }
  refuseInsideRepo(privateTasksPath, "private tasks document", repoRoot);
  refuseInsideRepo(keySourcePath, "holdout key source", repoRoot);
  const bundlePath = join(repoRoot, "evaluation", "provider-study", "holdout.enc");
  const manifestPath = join(repoRoot, "evaluation", "provider-study", "holdout-manifest.json");
  if (existsSync(bundlePath) || existsSync(manifestPath)) {
    throw new Error("holdout seal artifacts already exist; refusing to overwrite them");
  }
  const keyEnsured = ensureHoldoutKeyFile(keySourcePath);

  let document;
  try {
    document = JSON.parse(readFileSync(privateTasksPath, "utf8"));
  } catch (error) {
    throw new Error(`the private tasks document is not readable JSON (${privateTasksPath}): ${error?.message ?? error}`);
  }
  if (document?.study !== "provider-study" || document?.phase !== "holdout") {
    throw new Error("the private tasks document must be a provider-study holdout document");
  }
  if (!Array.isArray(document?.tasks)) {
    throw new Error("the private tasks document must carry a tasks array");
  }

  const sealedTasks = [];
  const publicTasks = [];
  for (const task of document.tasks) {
    const id = requireTaskField(task, "id", task?.id);
    const title = requireTaskField(task, "title", id);
    const prompt = requireTaskField(task, "prompt", id);
    const coverage = requireTaskField(task, "coverage", id);
    const fixture = requireTaskField(task, "fixture", id);
    const scorer = requireTaskField(task, "scorer", id);
    const solution = requireTaskField(task, "solution", id);
    if (typeof prompt !== "string" || prompt.trim().length === 0) {
      throw new Error(`holdout private task ${id} prompt must be a non-empty string; refusing to seal`);
    }
    const sealedTask = { id, title, prompt, fixture, scorer, solution };
    sealedTasks.push(sealedTask);
    publicTasks.push({
      id,
      coverage,
      taskSha256: holdoutTaskSha256(sealedTask),
      scorerSha256: stableSha256(scorer),
      solutionSha256: stableSha256(solution),
      fixtureSha256: stableSha256(fixture),
    });
  }

  const envelope = encryptHoldoutBundle({
    plainText: JSON.stringify({ schemaVersion: 1, tasks: sealedTasks }),
    keyHex: readHoldoutKey({ keySourcePath }),
  });
  const bundleSha256 = holdoutBundleEnvelopeSha256(envelope);

  const manifest = {
    schemaVersion: 1,
    study: "provider-study",
    phase: "holdout",
    evaluation: document.evaluation,
    bundle: { algorithm: "aes-256-gcm", authenticated: true, bundleSha256 },
    tasks: publicTasks,
  };
  const check = validateProviderStudyManifest(manifest, { phase: "holdout" });
  if (!check.ok) {
    throw new Error(`the sealed public holdout manifest is refused: ${check.errors.join("; ")}`);
  }

  writeFileSync(bundlePath, `${JSON.stringify(envelope, null, 2)}\n`, "utf8");
  writeFileSync(manifestPath, `${JSON.stringify(manifest, null, 2)}\n`, "utf8");
  return {
    bundlePath,
    manifestPath,
    bundleSha256,
    keyGenerated: keyEnsured.generated,
    tasks: publicTasks.map((task) => ({ id: task.id, taskSha256: task.taskSha256 })),
  };
}
