/**
 * Canonical fixture-cache integrity.
 *
 * Every cached task carries one integrity record stored inside the
 * entry at .git/integrity.json. The placement keeps evaluated non-.git
 * bytes and porcelain status unchanged while travelling with the entry
 * through the single atomic publication rename.
 *
 * The record binds:
 * - task identity (taskId),
 * - the deterministic non-.git tree digest (contentSha256),
 * - the full required Git state: HEAD, porcelain lines, the git-state
 *   digest, and, when a failed merge is declared, MERGE_HEAD, the
 *   unmerged stage map, and the local commit identity,
 * - the postcondition validation result,
 * - a self-seal digest (recordSha256) over the canonical JSON of all
 *   other fields.
 *
 * Every cache reuse recomputes the record and compares it field by
 * field. Any mutation, missing record, or broken seal refuses reuse
 * before an attempt reservation is created.
 */

import { existsSync, mkdirSync, readFileSync, renameSync, rmSync, writeFileSync } from "node:fs";
import { spawnSync } from "node:child_process";
import { join } from "node:path";
import { createHash } from "node:crypto";
import {
  generateFixture,
  gitStateHash,
  gitStateSnapshot,
  hashTree,
  validateFixturePostconditions,
} from "./fixtures.mjs";

export const INTEGRITY_RECORD_FILENAME = "integrity.json";

/**
 * Fixture cache root. CM_EVAL_FIXTURES_CACHE overrides the repository
 * default so tests and tools can point reuse at isolated roots.
 */
export function fixturesCacheRoot(repoRoot) {
  const override = process.env.CM_EVAL_FIXTURES_CACHE;
  if (typeof override === "string" && override.trim().length > 0) {
    return override;
  }
  return join(repoRoot, "evaluation", "cache", "fixtures");
}

export function cacheEntryDir(repoRoot, taskId) {
  return join(fixturesCacheRoot(repoRoot), taskId);
}

export function integrityRecordPath(fixtureDir) {
  return join(fixtureDir, ".git", INTEGRITY_RECORD_FILENAME);
}

/**
 * Publish one immutable task fixture through a single directory rename.
 * The integrity record enters the staged Git directory before publication.
 */
export function publishFixtureCache({ repoRoot, task, cacheRoot }) {
  if (typeof task?.id !== "string" || task.id.length === 0) {
    throw new Error("fixture cache publication requires a task id");
  }
  if (typeof cacheRoot !== "string" || cacheRoot.length === 0) {
    throw new Error("fixture cache publication requires a cache root");
  }

  const fixtureDir = join(cacheRoot, task.id);
  if (existsSync(join(fixtureDir, ".git"))) {
    return fixtureDir;
  }

  mkdirSync(cacheRoot, { recursive: true });
  const nonce = `${process.pid}-${Date.now()}-${Math.random().toString(36).slice(2, 8)}`;
  const stagingRoot = join(cacheRoot, `fixtures-tmp-${nonce}`);
  const staging = join(stagingRoot, task.id);
  try {
    generateFixture({ repoRoot, task, outDir: staging });
    writeFileSync(
      integrityRecordPath(staging),
      `${JSON.stringify(buildIntegrityRecord({ task, fixtureDir: staging }), null, 2)}\n`,
      "utf8",
    );
    renameSync(staging, fixtureDir);
  } catch (error) {
    if (!existsSync(join(fixtureDir, ".git"))) {
      throw error;
    }
  } finally {
    rmSync(stagingRoot, { recursive: true, force: true });
  }
  return fixtureDir;
}

/** Deterministic JSON: sorted object keys, no incidental whitespace. */
function canonicalJson(value) {
  if (Array.isArray(value)) return `[${value.map(canonicalJson).join(",")}]`;
  if (value !== null && typeof value === "object") {
    const keys = Object.keys(value).sort();
    return `{${keys.map((key) => `${JSON.stringify(key)}:${canonicalJson(value[key])}`).join(",")}}`;
  }
  return JSON.stringify(value);
}

function sha256(text) {
  return createHash("sha256").update(text).digest("hex");
}

/** Seal one record: returns the record plus its self-seal digest. */
export function sealIntegrityRecord(record) {
  const { recordSha256, ...rest } = record;
  void recordSha256;
  return { ...rest, recordSha256: sha256(canonicalJson(rest)) };
}

/**
 * Compute the canonical integrity record of one fixture directory. Pure
 * read: recomputation never mutates the entry.
 */
export function buildIntegrityRecord({ task, fixtureDir }) {
  const snapshot = gitStateSnapshot(fixtureDir);
  const postconditions = validateFixturePostconditions({ task, fixtureDir });
  const git = {
    head: snapshot.head,
    porcelain: snapshot.porcelain,
    gitStateSha256: gitStateHash(fixtureDir),
  };
  const mergeState = readMergeState({ task, fixtureDir });
  if (mergeState) {
    Object.assign(git, mergeState);
  }
  return sealIntegrityRecord({
    schemaVersion: 2,
    taskId: task.id,
    fixtureDefinitionSha256: sha256(canonicalJson(task.fixture)),
    contentSha256: hashTree(fixtureDir),
    git,
    postconditions: { ok: postconditions.ok, errors: postconditions.errors },
  });
}

/**
 * Required Git state of a declared failed merge: MERGE_HEAD, the
 * unmerged stage map of each declared conflict path, and the local
 * commit identity the generator must have set.
 */
function readMergeState({ task, fixtureDir }) {
  const declared = task.fixture.git.post.filter(
    (step) => step.argv?.[0] === "git" && step.argv?.[1] === "merge" && step.expectFailure,
  );
  if (declared.length === 0) return null;
  const mergeHeadPath = join(fixtureDir, ".git", "MERGE_HEAD");
  const mergeHead = existsSync(mergeHeadPath) ? readFileSync(mergeHeadPath, "utf8").trim() : null;
  const conflictStages = {};
  for (const step of declared) {
    for (const path of Array.isArray(step.conflictPaths) ? step.conflictPaths : []) {
      conflictStages[path] = unmergedStages(fixtureDir, path);
    }
  }
  return {
    mergeHead,
    conflictStages,
    identity: localGitIdentity(fixtureDir),
  };
}

function unmergedStages(fixtureDir, path) {
  const result = spawnSync("git", ["ls-files", "--unmerged", "--", path], {
    cwd: fixtureDir,
    encoding: "utf8",
    env: gitEnv(),
  });
  if (result.status !== 0) return [];
  return (result.stdout ?? "")
    .split("\n")
    .filter((line) => line.trim().length > 0)
    .map((line) => Number(line.split("\t")[0].split(" ")[2]))
    .sort((a, b) => a - b);
}

function localGitIdentity(fixtureDir) {
  const name = spawnSync("git", ["config", "--local", "user.name"], {
    cwd: fixtureDir,
    encoding: "utf8",
    env: gitEnv(),
  });
  const email = spawnSync("git", ["config", "--local", "user.email"], {
    cwd: fixtureDir,
    encoding: "utf8",
    env: gitEnv(),
  });
  if (name.status !== 0 || email.status !== 0) return null;
  return { name: name.stdout.trim(), email: email.stdout.trim() };
}

function gitEnv() {
  return {
    PATH: process.env.PATH ?? "/usr/bin:/bin",
    GIT_CONFIG_GLOBAL: "/dev/null",
    GIT_CONFIG_NOSYSTEM: "1",
  };
}

/**
 * Verify one cache entry against its stored integrity record. Returns
 * { ok, errors, record }. Never mutates the entry; any read error or
 * field mismatch becomes a refusal reason.
 */
export function verifyFixtureCacheEntry({ task, entryDir }) {
  const errors = [];
  const recordPath = integrityRecordPath(entryDir);
  if (!existsSync(join(entryDir, ".git"))) {
    return { ok: false, errors: ["fixture cache entry is missing its git repository"], record: null };
  }
  if (!existsSync(recordPath)) {
    return {
      ok: false,
      errors: [
        "integrity record is missing; the entry predates integrity records or was altered; " +
          "regenerate with: npm run evaluation:fixtures",
      ],
      record: null,
    };
  }
  let stored;
  try {
    stored = JSON.parse(readFileSync(recordPath, "utf8"));
  } catch {
    return { ok: false, errors: ["integrity record is not readable JSON; regenerate with: npm run evaluation:fixtures"], record: null };
  }
  if (stored?.schemaVersion !== 2) {
    return { ok: false, errors: ["integrity record schemaVersion must be 2"], record: null };
  }
  if (stored.taskId !== task.id) {
    return { ok: false, errors: [`integrity record taskId ${JSON.stringify(stored.taskId)} does not match ${task.id}`], record: null };
  }
  const resealed = sealIntegrityRecord(stored);
  if (resealed.recordSha256 !== stored.recordSha256) {
    return { ok: false, errors: ["integrity record self-seal digest mismatch; the record itself was altered"], record: null };
  }
  const recomputed = buildIntegrityRecord({ task, fixtureDir: entryDir });
  if (recomputed.taskId !== stored.taskId) {
    errors.push(`integrity mismatch: taskId changed (${stored.taskId} -> ${recomputed.taskId})`);
  }
  if (recomputed.fixtureDefinitionSha256 !== stored.fixtureDefinitionSha256) {
    errors.push("integrity mismatch: fixture definition changed since publication");
  }
  if (recomputed.contentSha256 !== stored.contentSha256) {
    errors.push("integrity mismatch: non-.git tree content changed since publication");
  }
  if (recomputed.git.head !== stored.git?.head) {
    errors.push(`integrity mismatch: HEAD moved (${stored.git?.head} -> ${recomputed.git.head})`);
  }
  if (canonicalJson(recomputed.git.porcelain) !== canonicalJson(stored.git?.porcelain)) {
    errors.push("integrity mismatch: git status (required Git state) changed since publication");
  }
  if (recomputed.git.gitStateSha256 !== stored.git?.gitStateSha256) {
    errors.push("integrity mismatch: git-state digest changed since publication");
  }
  if (recomputed.git.mergeHead !== stored.git?.mergeHead) {
    errors.push("integrity mismatch: MERGE_HEAD changed since publication");
  }
  if (canonicalJson(recomputed.git.conflictStages) !== canonicalJson(stored.git?.conflictStages)) {
    errors.push("integrity mismatch: unmerged conflict stages changed since publication");
  }
  if (canonicalJson(recomputed.git.identity) !== canonicalJson(stored.git?.identity)) {
    errors.push("integrity mismatch: local git identity changed since publication");
  }
  if (recomputed.postconditions.ok !== stored.postconditions?.ok) {
    errors.push("integrity mismatch: declared postconditions no longer hold");
  }
  if (recomputed.recordSha256 !== stored.recordSha256) {
    errors.push("integrity mismatch: canonical record digest changed since publication");
  }
  if (!recomputed.postconditions.ok) {
    errors.push(...recomputed.postconditions.errors);
  }
  if (errors.length > 0) {
    return { ok: false, errors, record: stored };
  }
  return { ok: true, errors: [], record: stored };
}
