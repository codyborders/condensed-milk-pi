/**
 * Hidden external scorer.
 *
 * Scores a final worktree against the hidden assertion file for a task.
 * Never scores assistant prose: the only inputs are the worktree tree,
 * its git state, and command exit codes run with a clean environment.
 *
 * Output contract (strict JSON, one object):
 *   { schemaVersion, taskId, status, checks[], passedCount, totalCount, error }
 * status is "passed", "failed", or "scorer-error".
 */

import { createHash } from "node:crypto";
import { lstatSync, readFileSync, existsSync, realpathSync, statSync } from "node:fs";
import { dirname, join, relative, resolve, sep } from "node:path";
import { spawnSync } from "node:child_process";
import { fileURLToPath } from "node:url";

export function scoreWorktree({ repoRoot, worktree, taskId, assertions }) {
  try {
    const resolved = assertions ?? loadAssertions(repoRoot, taskId);
    const checks = resolved.map((assertion) => runCheck(repoRoot, worktree, assertion));
    const infrastructureError = checks.find((check) => check.infraError)?.infraError;
    if (infrastructureError) {
      return {
        schemaVersion: 1,
        taskId,
        status: "scorer-error",
        checks,
        passedCount: 0,
        totalCount: checks.length,
        error: infrastructureError,
      };
    }
    const passedCount = checks.filter((check) => check.passed).length;
    return {
      schemaVersion: 1,
      taskId,
      status: passedCount === checks.length ? "passed" : "failed",
      checks,
      passedCount,
      totalCount: checks.length,
      error: null,
    };
  } catch (error) {
    return {
      schemaVersion: 1,
      taskId,
      status: "scorer-error",
      checks: [],
      passedCount: 0,
      totalCount: 0,
      error: `${error && error.message ? error.message : String(error)}`,
    };
  }
}

export function scorerDefinitionSha256(repoRoot, taskId) {
  const path = join(repoRoot, "evaluation", "scorers", "assertions", `${taskId}.json`);
  return createHash("sha256").update(readFileSync(path)).digest("hex");
}

function loadAssertions(repoRoot, taskId) {
  const path = join(repoRoot, "evaluation", "scorers", "assertions", `${taskId}.json`);
  const parsed = JSON.parse(readFileSync(path, "utf8"));
  return parsed.assertions;
}

function runCheck(repoRoot, worktree, assertion) {
  const detail = { id: assertion.id, kind: assertion.kind };
  if (assertion.kind === "command") {
    const argv = assertion.argv.map((part) =>
      part
        .replaceAll("$REPO_ROOT", repoRoot)
        .replaceAll("$SCORER_DATA", join(repoRoot, "evaluation", "scorers", "data")),
    );
    const result = spawnSync(argv[0], argv.slice(1), {
      cwd: worktree,
      encoding: "utf8",
      timeout: assertion.timeoutMs ?? 120_000,
      env: commandEnv(),
    });
    if (result.error) {
      return {
        ...detail,
        passed: false,
        infraError: `command infrastructure failure for ${assertion.id}: ${result.error.message}`,
      };
    }
    const expectedExit = assertion.expectExit ?? 0;
    const missingStdout = (assertion.stdoutContains ?? []).filter(
      (needle) => !(result.stdout ?? "").includes(needle),
    );
    const missingStderr = (assertion.stderrContains ?? []).filter(
      (needle) => !(result.stderr ?? "").includes(needle),
    );
    return {
      ...detail,
      passed: result.status === expectedExit && missingStdout.length === 0 && missingStderr.length === 0,
      exitCode: result.status,
      expectedExit,
      missingStdout,
      missingStderr,
    };
  }
  if (assertion.kind === "fileContains") {
    const body = readWorktreeFile(worktree, assertion.path);
    if (isEscape(body)) {
      return { ...detail, passed: false, infraError: escapeErrorText(assertion.path, body) };
    }
    if (body === null) {
      return { ...detail, passed: false, reason: `file not found: ${assertion.path}` };
    }
    const missing = (assertion.all ?? []).filter((needle) => !body.includes(needle));
    const forbidden = (assertion.none ?? []).filter((needle) => body.includes(needle));
    return {
      ...detail,
      passed: missing.length === 0 && forbidden.length === 0,
      missing,
      forbidden,
    };
  }
  if (assertion.kind === "fileEquals") {
    const body = readWorktreeFile(worktree, assertion.path);
    if (isEscape(body)) {
      return { ...detail, passed: false, infraError: escapeErrorText(assertion.path, body) };
    }
    return { ...detail, passed: body !== null && body === assertion.equals };
  }
  if (assertion.kind === "fileOccurrences") {
    const body = readWorktreeFile(worktree, assertion.path);
    if (isEscape(body)) {
      return { ...detail, passed: false, infraError: escapeErrorText(assertion.path, body) };
    }
    if (body === null) {
      return { ...detail, passed: false, reason: `file not found: ${assertion.path}` };
    }
    const count = body.split(assertion.needle).length - 1;
    return {
      ...detail,
      passed: count >= (assertion.min ?? 0) && count <= (assertion.max ?? Number.MAX_SAFE_INTEGER),
      count,
    };
  }
  if (assertion.kind === "fileExists") {
    const safe = classifyWorktreePath(worktree, assertion.path);
    if (safe.status === "escape") {
      return { ...detail, passed: false, infraError: escapeErrorText(assertion.path, safe) };
    }
    if (safe.status === "missing") {
      return { ...detail, passed: false, reason: `file not found: ${assertion.path}` };
    }
    return { ...detail, passed: existsSync(safe.path) };
  }
  if (assertion.kind === "gitStatus") {
    const status = gitLines(worktree, ["status", "--porcelain"]);
    if (status.error) {
      return { ...detail, passed: false, infraError: status.error };
    }
    const actual = status.lines.map((line) => line.trimEnd()).sort();
    const expected = [...(assertion.expect ?? [])].sort();
    return {
      ...detail,
      passed: JSON.stringify(actual) === JSON.stringify(expected),
      actual,
      expected,
    };
  }
  if (assertion.kind === "gitLog" || assertion.kind === "gitLogStartsWith") {
    const log = gitLines(worktree, ["log", "-1", "--format=%s"]);
    if (log.error) {
      return { ...detail, passed: false, infraError: log.error };
    }
    const subject = log.lines[0] ?? "";
    if (assertion.kind === "gitLogStartsWith") {
      const prefix = assertion.prefix ?? assertion.headMessageStartsWith;
      return { ...detail, passed: typeof prefix === "string" && subject.startsWith(prefix), actual: subject, prefix };
    }
    return { ...detail, passed: subject === assertion.headMessageEquals, actual: subject };
  }
  if (assertion.kind === "gitTagExists") {
    const tags = gitLines(worktree, ["tag", "-l", assertion.tag]);
    if (tags.error) {
      return { ...detail, passed: false, infraError: tags.error };
    }
    return { ...detail, passed: tags.lines.length > 0 };
  }
  return { ...detail, passed: false, reason: `unknown assertion kind ${assertion.kind}` };
}

function isEscape(body) {
  return body !== null && typeof body === "object" && body.escaped === true;
}

function readWorktreeFile(worktree, relativePath) {
  const safe = classifyWorktreePath(worktree, relativePath);
  if (safe.status === "escape") {
    return { escaped: true, reason: safe.reason };
  }
  if (safe.status === "missing") {
    return null;
  }
  let info;
  try {
    info = statSync(safe.path);
  } catch {
    return null;
  }
  if (!info.isFile()) {
    return null;
  }
  return readFileSync(safe.path, "utf8");
}

/** Error text for a rejected assertion path; never includes file contents. */
function escapeErrorText(assertionPath, classification) {
  if (classification.reason === "symlink") {
    return `assertion path is or traverses a symlink: ${assertionPath}`;
  }
  return `assertion path escapes the worktree: ${assertionPath}`;
}

/**
 * Resolve an assertion path against the canonical worktree.
 * Returns { status: "ok", path }, { status: "missing" }, or
 * { status: "escape", reason }:
 * - the worktree and the final target are canonicalized with realpath
 *   and any target whose real path escapes the canonical worktree is
 *   rejected;
 * - every existing path component is validated with lstat and any
 *   symlink component, final or intermediate, is rejected;
 * - a path that cannot exist (a missing or non-directory component)
 *   is a normal missing path, never an infrastructure error.
 */
function classifyWorktreePath(worktree, relativePath) {
  if (typeof relativePath !== "string" || relativePath.length === 0) {
    return { status: "escape", reason: "outside" };
  }
  if (relativePath.includes("\0")) {
    return { status: "escape", reason: "outside" };
  }
  let root;
  try {
    root = realpathSync(worktree);
  } catch {
    return { status: "escape", reason: "unreadable" };
  }
  const target = resolve(root, relativePath);
  if (target !== root && !target.startsWith(root + sep)) {
    return { status: "escape", reason: "outside" };
  }
  const parts = relative(root, target).split(sep).filter((part) => part.length > 0);
  let current = root;
  for (const part of parts) {
    const next = join(current, part);
    let info;
    try {
      info = lstatSync(next);
    } catch (error) {
      if (error?.code === "ENOENT" || error?.code === "ENOTDIR") {
        return { status: "missing" };
      }
      return { status: "escape", reason: "unreadable" };
    }
    if (info.isSymbolicLink()) {
      return { status: "escape", reason: "symlink" };
    }
    current = next;
  }
  let real;
  try {
    real = realpathSync(target);
  } catch (error) {
    if (error?.code === "ENOENT" || error?.code === "ENOTDIR") {
      return { status: "missing" };
    }
    return { status: "escape", reason: "unreadable" };
  }
  if (real !== root && !real.startsWith(root + sep)) {
    return { status: "escape", reason: "outside" };
  }
  return { status: "ok", path: real };
}

function gitLines(worktree, argv) {
  const result = spawnSync("git", argv, {
    cwd: worktree,
    encoding: "utf8",
    timeout: 120_000,
    env: commandEnv(),
  });
  if (result.error) {
    return { error: `git ${argv.join(" ")} failed to spawn: ${result.error.message}` };
  }
  if (result.signal) {
    return { error: `git ${argv.join(" ")} died from signal ${result.signal}` };
  }
  if (result.status !== 0) {
    return { error: `git ${argv.join(" ")} exited with status ${result.status}: ${(result.stderr ?? "").slice(0, 300)}` };
  }
  return { lines: (result.stdout ?? "").split("\n").filter((line) => line.trim().length > 0) };
}

/**
 * Clean command environment: no user configuration leaks into scoring.
 * git ignores global and system config; HOME stays unset so nothing
 * outside the worktree is consulted.
 */
function commandEnv() {
  return {
    PATH: process.env.PATH ?? "/usr/bin:/bin",
    GIT_CONFIG_GLOBAL: "/dev/null",
    GIT_CONFIG_NOSYSTEM: "1",
    PYTHONDONTWRITEBYTECODE: "1",
  };
}

/** CLI entry: node scorer.mjs --worktree <path> --task <id> [--assertions <file>] */
export function main(argv) {
  const args = parseArgs(argv);
  let assertions;
  let loadError = null;
  if (args.assertions) {
    try {
      assertions = JSON.parse(readFileSync(args.assertions, "utf8")).assertions;
    } catch (error) {
      loadError = `cannot read assertions ${args.assertions}: ${error.message}`;
    }
  }
  const result = loadError
    ? {
        schemaVersion: 1,
        taskId: args.task,
        status: "scorer-error",
        checks: [],
        passedCount: 0,
        totalCount: 0,
        error: loadError,
      }
    : scoreWorktree({
        repoRoot: args.repoRoot,
        worktree: args.worktree,
        taskId: args.task,
        assertions,
      });
  process.stdout.write(`${JSON.stringify(result)}\n`);
  process.exit(result.status === "scorer-error" ? 2 : 0);
}

function parseArgs(argv) {
  const args = { repoRoot: defaultRepoRoot() };
  for (let index = 0; index < argv.length; index += 2) {
    const flag = argv[index];
    const value = argv[index + 1];
    if (flag === "--worktree") args.worktree = value;
    else if (flag === "--task") args.task = value;
    else if (flag === "--assertions") args.assertions = value;
    else if (flag === "--repo-root") args.repoRoot = value;
    else {
      process.stderr.write(`scorer: unknown flag ${flag}\n`);
      process.exit(2);
    }
  }
  if (!args.worktree || !args.task) {
    process.stderr.write("scorer: --worktree and --task are required\n");
    process.exit(2);
  }
  return args;
}

function defaultRepoRoot() {
  return join(dirname(fileURLToPath(import.meta.url)), "..", "..");
}

if (process.argv[1] && process.argv[1].endsWith("scorer.mjs")) {
  main(process.argv.slice(2));
}
