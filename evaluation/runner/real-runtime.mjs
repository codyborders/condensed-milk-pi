/**
 * Runtime preparation for real provider attempts.
 *
 * Materializes the pinned evaluation inputs outside the source
 * repository:
 * - clean detached git worktrees at the exact manifest arm commits;
 * - a reusable isolated Pi runtime copied from the pinned node_modules.
 *
 * Fail-closed: any verification failure refuses before a reservation.
 */

import { spawnSync } from "node:child_process";
import { createHash } from "node:crypto";
import { cpSync, existsSync, mkdirSync, readFileSync, renameSync, rmSync } from "node:fs";
import { dirname, join } from "node:path";
import { computeRuntimeDigest } from "./runtime-digest.mjs";

function gitCleanEnv() {
  return {
    PATH: process.env.PATH ?? "/usr/bin:/bin",
    GIT_CONFIG_GLOBAL: "/dev/null",
    GIT_CONFIG_NOSYSTEM: "1",
  };
}

function git(args, cwd, timeoutMs = 60_000) {
  const result = spawnSync("git", args, { cwd, encoding: "utf8", env: gitCleanEnv(), timeout: timeoutMs });
  if (result.error || result.status !== 0) {
    throw new Error(`git ${args.join(" ")} failed: ${(result.stderr || result.error?.message || "").slice(0, 300)}`);
  }
  return result.stdout;
}

/** Arm worktree root under the caller-provided cache directory. */
export function armWorktreePath({ cacheRoot, arm }) {
  return join(cacheRoot, "arms", `${arm.name}-${arm.commit}`);
}

/**
 * Materialize the detached git worktree for one arm commit outside the
 * source repository, verify it, and return its metadata:
 * { commit, path, tracked }. Verification refuses a root that is not a
 * git worktree, a HEAD that is not the pinned commit, tracked dirt, an
 * index.ts that does not hash-match the commit, and tracked evaluator
 * fixture/scorer/runner files that the pinned commits must predate.
 */
export function verifyArmWorktree({ repoRoot, arm, cacheRoot }) {
  const forbidden = ["evaluation/cache/", "evaluation/scorers/", "evaluation/runner/", "evaluation/lib/", "evaluation/tests/"];
  const path = armWorktreePath({ cacheRoot, arm });
  if (!existsSync(join(path, ".git"))) {
    if (existsSync(path)) {
      throw new Error(`arm path exists but is not a git worktree; refusing`);
    }
    mkdirSync(dirname(path), { recursive: true });
    git(["worktree", "add", "--detach", path, arm.commit], repoRoot, 300_000);
  }
  const head = git(["rev-parse", "HEAD"], path).trim();
  if (head !== arm.commit) {
    throw new Error(`arm ${arm.name} worktree HEAD does not match the pinned commit; refusing`);
  }
  const status = git(["status", "--porcelain", "--untracked-files=all"], path);
  if (status.trim().length > 0) {
    throw new Error(`arm ${arm.name} worktree is not tracked-clean; refusing`);
  }
  const expectedIndexTs = git(["show", `${arm.commit}:index.ts`], repoRoot);
  const actualIndexTs = readFileSync(join(path, "index.ts"), "utf8");
  if (sha256Text(expectedIndexTs) !== sha256Text(actualIndexTs)) {
    throw new Error(`arm ${arm.name} worktree index.ts hash does not match the pinned commit; refusing`);
  }
  const tracked = git(["ls-files"], path).split("\n").filter((line) => line.length > 0);
  for (const trackedPath of tracked) {
    if (forbidden.some((prefix) => trackedPath.startsWith(prefix))) {
      throw new Error(`arm ${arm.name} worktree tracks evaluator artifacts; refusing`);
    }
  }
  if (!tracked.includes("index.ts")) {
    throw new Error(`arm ${arm.name} worktree has no tracked index.ts; refusing`);
  }
  return { commit: arm.commit, path, tracked };
}

function sha256Text(text) {
  return createHash("sha256").update(text).digest("hex");
}

/** Only plain >= numeric minimums are honored; any other form refuses. */
const ENGINE_MINIMUM_PATTERN = /^>=\s*v?(\d+)(?:\.(\d+))?(?:\.(\d+))?$/;
const NODE_VERSION_PATTERN = /^v?(\d+)(?:\.(\d+))?(?:\.(\d+))?/;

/**
 * Node engine preflight: read the isolated Pi runtime's engines.node
 * and verify the Node that will spawn Pi satisfies its minimum
 * supported form. Conservative by design: only a plain ">=X[.Y[.Z]]"
 * minimum is honored (the form Pi 0.84.2 declares); missing,
 * unreadable, or compound ranges refuse instead of guessing. The
 * refusal happens before any attempt is reserved.
 */
export function verifyNodeEngine({ runtimeDir, nodeVersion = process.version }) {
  let pkg;
  try {
    pkg = JSON.parse(readFileSync(join(runtimeDir, "package.json"), "utf8"));
  } catch {
    throw new Error("pi runtime has no readable package.json; refusing the node engine preflight");
  }
  const range = pkg?.engines?.node;
  if (typeof range !== "string" || range.trim().length === 0) {
    throw new Error("pi runtime declares no engines.node minimum; refusing the node engine preflight");
  }
  const minimumMatch = ENGINE_MINIMUM_PATTERN.exec(range.trim());
  if (!minimumMatch) {
    throw new Error(`pi runtime engines.node ${range.trim()} is not a supported >= minimum; refusing the node engine preflight`);
  }
  const minimum = [Number(minimumMatch[1]), Number(minimumMatch[2] ?? 0), Number(minimumMatch[3] ?? 0)];
  const versionText = String(nodeVersion ?? "").trim();
  const versionMatch = NODE_VERSION_PATTERN.exec(versionText);
  if (!versionMatch) {
    throw new Error(`node version ${JSON.stringify(versionText)} is not a recognizable form; refusing the node engine preflight`);
  }
  const current = [Number(versionMatch[1]), Number(versionMatch[2] ?? 0), Number(versionMatch[3] ?? 0)];
  const below =
    current[0] < minimum[0] ||
    (current[0] === minimum[0] && (current[1] < minimum[1] || (current[1] === minimum[1] && current[2] < minimum[2])));
  if (below) {
    throw new Error(
      `node ${versionText} is below the pi runtime minimum engines.node ${range.trim()}; refusing before any attempt`,
    );
  }
  return { nodeVersion: versionText, minimum: minimum.join(".") };
}

function verifyRuntimeDir(dir, manifest) {
  let pkg;
  try {
    pkg = JSON.parse(readFileSync(join(dir, "package.json"), "utf8"));
  } catch {
    throw new Error(`pi runtime at the cache target has no readable package.json; refusing`);
  }
  if (pkg.version !== manifest.evaluation.piVersion) {
    throw new Error(`pi runtime version ${pkg.version} does not match the pinned ${manifest.evaluation.piVersion}; refusing`);
  }
  if (!existsSync(join(dir, "dist", "cli.js"))) {
    throw new Error(`pi runtime at the cache target has no dist/cli.js; refusing`);
  }
}

/**
 * Materialize a reusable isolated Pi runtime under the cache root from
 * the pinned node_modules dependency and return its dist/cli.js path
 * plus the deterministic manifest digest of its executable bytes. The
 * copy lands outside the source repository; its version is verified to
 * match the manifest pin, and the whole tree digest is verified against
 * the pinned dependency both after a fresh copy and on every reuse, so
 * mutated cache bytes (dist/cli.js or any dependency) are refused.
 */
export function materializePiRuntime({ repoRoot, manifest, cacheRoot }) {
  const target = join(cacheRoot, "pi", `pi-coding-agent-${manifest.evaluation.piVersion}`);
  const source = join(repoRoot, "node_modules", "@earendil-works", "pi-coding-agent");
  verifyRuntimeDir(source, manifest);
  const sourceManifest = computeRuntimeDigest({ runtimeDir: source });
  const fresh = !existsSync(join(target, "package.json"));
  if (fresh) {
    mkdirSync(dirname(target), { recursive: true });
    const staging = `${target}.tmp-${process.pid}-${Date.now()}`;
    rmSync(staging, { recursive: true, force: true });
    cpSync(source, staging, { recursive: true, dot: true, verbatimSymlinks: true });
    try {
      renameSync(staging, target);
    } catch (error) {
      rmSync(staging, { recursive: true, force: true });
      if (!existsSync(join(target, "package.json"))) throw error;
    }
  }
  verifyRuntimeDir(target, manifest);
  const targetManifest = computeRuntimeDigest({ runtimeDir: target });
  if (targetManifest.digest !== sourceManifest.digest) {
    if (fresh) {
      rmSync(target, { recursive: true, force: true });
    }
    throw new Error(
      `pi runtime digest mismatch between the pinned dependency and the ${fresh ? "copied" : "cached"} runtime; refusing`,
    );
  }
  return { cliPath: join(target, "dist", "cli.js"), runtimeManifest: targetManifest };
}
