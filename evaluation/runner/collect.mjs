/**
 * Final repository collector.
 *
 * Captures the final state of one attempt worktree after the agent is
 * done and before the attempt reaches terminal completion:
 * - porcelain v2 status (all untracked files enumerated)
 * - binary staged patch (git diff --cached --binary)
 * - binary unstaged patch (git diff --binary)
 * - ls-files index listing (git ls-files --stage)
 * - SHA-256 for every untracked regular file
 *
 * Safety contract:
 * - argv arrays only; no shell; allowlisted environment; git output
 *   streams straight into artifact files, never memory.
 * - symlinks pointing outside the worktree are recorded and never
 *   followed; every resolved path that gets hashed stays under the
 *   worktree realpath.
 * - a git spawn error, timeout, signal, or nonzero exit is a
 *   collection error ({ status: "error" }) — always distinct from task
 *   or scorer failure; the caller decides how to record it.
 */

import { spawn } from "node:child_process";
import {
  closeSync,
  createReadStream,
  lstatSync,
  mkdirSync,
  openSync,
  readFileSync,
  readlinkSync,
  realpathSync,
  statSync,
} from "node:fs";
import { createHash } from "node:crypto";
import { isAbsolute, join, relative, resolve } from "node:path";

export const GIT_TIMEOUT_MS = 30_000;
const GIT_KILL_GRACE_MS = 2_000;

const GIT_ENV = {
  GIT_CONFIG_GLOBAL: "/dev/null",
  GIT_CONFIG_NOSYSTEM: "1",
};

/** True when `candidate` resolves inside `root` (both realpaths). */
function isUnderRoot(root, candidate) {
  const resolvedRoot = realpathSync(root);
  const resolvedCandidate = realpathSync(candidate);
  const rel = relative(resolvedRoot, resolvedCandidate);
  return rel !== "" && !rel.startsWith("..") && !isAbsolute(rel);
}

/**
 * Run one git command, streaming stdout into `outPath`. Resolves with
 * { ok, reason, detail } where reason is null on success and one of
 * "spawn-error", "timeout", "signal", "nonzero-exit" otherwise.
 */
function gitToFile({ gitPath, argv, cwd, outPath, timeoutMs }) {
  return new Promise((resolve_) => {
    let child;
    const stdoutFd = openSync(outPath, "w");
    const stderrPath = `${outPath}.stderr`;
    const stderrFd = openSync(stderrPath, "w");
    let timedOut = false;
    let killTimer = null;
    let finished = false;
    const done = (outcome) => {
      if (finished) return; // error and close may both fire; finish once
      finished = true;
      if (killTimer) clearTimeout(killTimer);
      closeSync(stdoutFd);
      closeSync(stderrFd);
      resolve_(outcome);
    };
    const killGroup = (signal) => {
      if (!child?.pid) return;
      try {
        process.kill(-child.pid, signal);
      } catch {
        try {
          child.kill(signal);
        } catch {
          // already gone
        }
      }
    };
    try {
      child = spawn(gitPath, argv, {
        cwd,
        env: { PATH: process.env.PATH ?? "/usr/bin:/bin", ...GIT_ENV },
        detached: true,
        stdio: ["ignore", stdoutFd, stderrFd],
      });
    } catch (error) {
      done({ ok: false, reason: "spawn-error", detail: String(error?.message ?? error) });
      return;
    }
    const timer = setTimeout(() => {
      timedOut = true;
      killGroup("SIGTERM");
      killTimer = setTimeout(() => killGroup("SIGKILL"), GIT_KILL_GRACE_MS);
    }, timeoutMs);
    child.on("error", (error) => {
      clearTimeout(timer);
      done({ ok: false, reason: "spawn-error", detail: String(error?.message ?? error) });
    });
    child.on("close", (code, signal) => {
      clearTimeout(timer);
      if (timedOut) {
        done({ ok: false, reason: "timeout", detail: `git ${argv[0]} exceeded ${timeoutMs}ms and was killed` });
        return;
      }
      if (signal) {
        done({ ok: false, reason: "signal", detail: `git ${argv[0]} died from ${signal}` });
        return;
      }
      if (code !== 0) {
        let stderrText = "";
        try {
          stderrText = readFileSync(stderrPath, "utf8").slice(0, 400);
        } catch {
          // stderr unavailable; the exit code still classifies
        }
        done({ ok: false, reason: "nonzero-exit", detail: `git ${argv.join(" ")} exited ${code}: ${stderrText.trim()}` });
        return;
      }
      done({ ok: true, reason: null, detail: null });
    });
  });
}

function sha256FileStreaming(path) {
  return new Promise((resolve_, reject) => {
    const hash = createHash("sha256");
    const stream = createReadStream(path);
    stream.on("data", (chunk) => hash.update(chunk));
    stream.on("error", reject);
    stream.on("end", () => resolve_(hash.digest("hex")));
  });
}

function parseUntrackedPaths(porcelainText) {
  const paths = [];
  for (const line of porcelainText.split("\n")) {
    if (!line.startsWith("? ")) continue;
    paths.push(line.slice(2).replace(/^"/, "").replace(/"$/, ""));
  }
  return paths;
}

/**
 * Collect the final state of `worktree` into `outDir`. Returns
 * { schemaVersion, status, errors, artifacts, untracked }:
 * - status "collected" only when every git artifact succeeded
 * - artifacts lists { name, file, bytes, sha256 } for each written
 *   artifact file (written even on partial failure, hashes included)
 * - untracked lists every untracked entry with kind "file" or
 *   "symlink-internal" (hashed, path verified under the worktree) or
 *   skipped entries ({ kind, skipReason, sha256: null }) that were
 *   never followed.
 */
export async function collectFinalState({ worktree, outDir, timeoutMs = GIT_TIMEOUT_MS, gitPath = "git" }) {
  mkdirSync(outDir, { recursive: true });
  const errors = [];
  const artifacts = [];
  const runs = [
    { name: "porcelain-v2", file: "porcelain-v2.txt", argv: ["status", "--porcelain=v2", "--untracked-files=all"] },
    { name: "staged.patch", file: "staged.patch", argv: ["diff", "--cached", "--binary"] },
    { name: "unstaged.patch", file: "unstaged.patch", argv: ["diff", "--binary"] },
    { name: "ls-files", file: "ls-files.txt", argv: ["ls-files", "--stage"] },
  ];
  for (const run of runs) {
    const outcome = await gitToFile({
      gitPath,
      argv: run.argv,
      cwd: worktree,
      outPath: join(outDir, run.file),
      timeoutMs,
    });
    const path = join(outDir, run.file);
    let bytes = 0;
    try {
      bytes = statSync(path).size;
    } catch {
      bytes = 0;
    }
    artifacts.push({
      name: run.name,
      file: run.file,
      bytes,
      sha256: sha256FileStreaming(path),
      ok: outcome.ok,
      reason: outcome.reason,
    });
    if (!outcome.ok) {
      errors.push({ command: `git ${run.argv.join(" ")}`, reason: outcome.reason, detail: outcome.detail });
    }
  }
  await Promise.all(artifacts.map(async (artifact) => {
    if (typeof artifact.sha256?.then === "function") {
      artifact.sha256 = await artifact.sha256;
    }
  }));

  const untracked = [];
  const porcelainArtifact = artifacts.find((entry) => entry.name === "porcelain-v2");
  if (porcelainArtifact?.ok) {
    const porcelainText = readFileSync(join(outDir, "porcelain-v2.txt"), "utf8");
    for (const relativePath of parseUntrackedPaths(porcelainText)) {
      untracked.push(await describeUntracked(worktree, relativePath));
    }
  }

  return {
    schemaVersion: 1,
    status: errors.length === 0 ? "collected" : "error",
    errors,
    artifacts,
    untracked,
  };
}

async function describeUntracked(worktree, relativePath) {
  const absolute = resolve(worktree, relativePath);
  let info = lstatSync(absolute);
  if (info.isSymbolicLink()) {
    // Never read through the link blindly. Report the link target and
    // hash it only when the resolved target stays under the worktree.
    const linkText = readlinkSync(absolute);
    const resolvedTarget = resolve(worktree, linkText);
    let targetStat = null;
    let targetState;
    try {
      targetStat = statSync(resolvedTarget);
      targetState = "present";
    } catch (error) {
      targetState = error?.code === "ENOENT" ? "broken" : "unreadable";
    }
    if (targetState === "broken") {
      return {
        path: relativePath,
        kind: "symlink-broken",
        sha256: null,
        target: linkText,
        skipReason: "broken-target",
      };
    }
    let inside;
    try {
      inside = isUnderRoot(worktree, resolvedTarget);
    } catch {
      inside = false;
    }
    if (!inside) {
      return {
        path: relativePath,
        kind: "symlink-external",
        sha256: null,
        target: linkText,
        skipReason: "outside-worktree",
      };
    }
    let hash = null;
    if (targetState === "present" && targetStat.isFile()) {
      try {
        hash = await sha256FileStreaming(absolute);
      } catch {
        hash = null;
      }
    }
    return {
      path: relativePath,
      kind: "symlink-internal",
      sha256: hash,
      target: linkText,
      skipReason: hash ? null : targetStat?.isDirectory() ? "target-not-file" : "unreadable",
    };
  }
  if (!info.isFile()) {
    return { path: relativePath, kind: info.isDirectory() ? "directory" : "other", sha256: null, skipReason: "not-a-regular-file" };
  }
  // Every hashed path must resolve under the worktree.
  let contained;
  try {
    contained = isUnderRoot(worktree, absolute);
  } catch {
    contained = false;
  }
  if (!contained) {
    return { path: relativePath, kind: "file", sha256: null, skipReason: "outside-worktree" };
  }
  const hash = await sha256FileStreaming(absolute);
  return { path: relativePath, kind: "file", sha256: hash, skipReason: null };
}
