/**
 * Four-arm provider study: immutable arm definitions (growing test-first).
 */

import { readFileSync } from "node:fs";
import { createHash } from "node:crypto";
import { dirname, join } from "node:path";
import { fileURLToPath } from "node:url";

export const PROVIDER_STUDY_ROOT = join(dirname(fileURLToPath(import.meta.url)), "..");

export const PROVIDER_STUDY_ARM_NAMES = Object.freeze([
  "none",
  "upstream",
  "remediated-defaults",
  "remediated-archive",
]);

export const PROVIDER_STUDY_ARMS = Object.freeze([
  Object.freeze({ name: "none", role: "baseline", kind: "no-extension", commit: null, config: "neutral-none" }),
  Object.freeze({
    name: "upstream",
    role: "baseline",
    kind: "commit",
    commit: "71f9e396951c42687f0c3456727b2b5c8c625da1",
    config: "neutral-none",
  }),
  Object.freeze({
    name: "remediated-defaults",
    role: "treatment",
    kind: "commit",
    commit: "8c267c48d71507a300ec5bcbbe211a643ae417bb",
    config: "remediated-defaults",
  }),
  Object.freeze({
    name: "remediated-archive",
    role: "treatment",
    kind: "commit",
    commit: "8c267c48d71507a300ec5bcbbe211a643ae417bb",
    config: "remediated-archive",
    archiveEnabled: true,
  }),
]);

export function providerStudyArm(name) {
  const arm = PROVIDER_STUDY_ARMS.find((entry) => entry.name === name);
  if (!arm) {
    throw new Error(
      `unknown provider-study arm ${JSON.stringify(name)}; expected one of ${PROVIDER_STUDY_ARM_NAMES.join(", ")}`,
    );
  }
  return arm;
}

/** Canonical JSON: sorted keys, no whitespace, stable across processes. */
export function stableJson(value) {
  if (Array.isArray(value)) return `[${value.map(stableJson).join(",")}]`;
  if (value === null || typeof value !== "object") return JSON.stringify(value);
  const keys = Object.keys(value).sort();
  return `{${keys.map((key) => `${JSON.stringify(key)}:${stableJson(value[key])}`).join(",")}}`;
}

function sha256Text(text) {
  return createHash("sha256").update(text, "utf8").digest("hex");
}

function sha256File(path) {
  return createHash("sha256").update(readFileSync(path)).digest("hex");
}

/** The exact config bytes one arm receives, plus their digest. */
export function providerStudyArmConfig(repoRoot, armName) {
  void repoRoot;
  const arm = providerStudyArm(armName);
  const path = join(PROVIDER_STUDY_ROOT, "profiles", `${arm.config}.json`);
  const bytes = readFileSync(path, "utf8");
  return { bytes, sha256: sha256Text(bytes), path, config: arm.config };
}

/**
 * Arm identity hash: the digest over the canonical arm definition,
 * its config bytes digest, and — for every arm whose extension list
 * loads the neutral retrieval stub — the exact neutral stub bytes
 * digest. Arms that share a commit but differ in config bytes never
 * share an identity hash, so a run pinning one identity refuses any
 * other configuration.
 */
export function computeProviderStudyArmIdentitySha256({ arm, configSha256, neutralStubSha256 }) {
  const usesNeutralStub = ARM_EXTENSIONS[arm.name].includes("neutral-retrieval");
  if (usesNeutralStub && typeof neutralStubSha256 !== "string") {
    throw new Error(`arm ${arm.name} loads the neutral retrieval stub, so its identity binds the stub bytes`);
  }
  return sha256Text(stableJson({
    schemaVersion: 1,
    name: arm.name,
    role: arm.role,
    kind: arm.kind,
    commit: arm.commit,
    config: arm.config,
    configSha256,
    ...(usesNeutralStub ? { neutralStubSha256 } : {}),
    ...(arm.archiveEnabled ? { archiveEnabled: true } : {}),
  }));
}

export function providerStudyArmIdentitySha256(repoRoot, armName) {
  void repoRoot;
  const arm = providerStudyArm(armName);
  const config = providerStudyArmConfig(repoRoot, armName);
  return computeProviderStudyArmIdentitySha256({
    arm,
    configSha256: config.sha256,
    neutralStubSha256: sha256File(NEUTRAL_RETRIEVAL_EXTENSION),
  });
}

export function providerStudyArmIdentityMap(repoRoot) {
  return Object.fromEntries(
    PROVIDER_STUDY_ARM_NAMES.map((name) => [name, providerStudyArmIdentitySha256(repoRoot, name)]),
  );
}

export const PROVIDER_STUDY_TOOLS_ARGV = "read,bash,edit,write,grep,find,ls,condensed_milk_retrieve";
export const RETRIEVAL_TOOL_NAME = "condensed_milk_retrieve";

/** The checked-in neutral unavailable retrieval stub. */
export const NEUTRAL_RETRIEVAL_EXTENSION = join(PROVIDER_STUDY_ROOT, "arms", "neutral-retrieval.mjs");

/** Per-arm extension sources; commit arms load their own index.ts. */
const ARM_EXTENSIONS = Object.freeze({
  none: Object.freeze(["neutral-retrieval"]),
  upstream: Object.freeze(["arm-index", "neutral-retrieval"]),
  "remediated-defaults": Object.freeze(["arm-index"]),
  "remediated-archive": Object.freeze(["arm-index"]),
});

/**
 * Resolve the ordered extension source list for one arm. `armIndexDir`
 * is the verified arm worktree root for commit arms; it is never used
 * for the none arm, which loads no Condensed Milk production
 * extension.
 */
export function providerStudyArmExtensions(armName, { armIndexDir = null } = {}) {
  const arm = providerStudyArm(armName);
  const resolved = [];
  for (const source of ARM_EXTENSIONS[arm.name]) {
    if (source === "neutral-retrieval") {
      resolved.push(NEUTRAL_RETRIEVAL_EXTENSION);
      continue;
    }
    if (arm.kind !== "commit" || typeof armIndexDir !== "string" || armIndexDir.length === 0) {
      throw new Error(`arm ${arm.name} needs a verified arm worktree for its index.ts; refusing`);
    }
    resolved.push(join(armIndexDir, "index.ts"));
  }
  if (arm.name === "none" && resolved.some((path) => path.endsWith("index.ts"))) {
    throw new Error("the none arm must not load any Condensed Milk production extension");
  }
  return resolved;
}

/** The identical tool surface every arm must expose. */
export function providerStudyRetrievalSurface() {
  return { toolsArgv: PROVIDER_STUDY_TOOLS_ARGV, retrievalToolName: RETRIEVAL_TOOL_NAME };
}
