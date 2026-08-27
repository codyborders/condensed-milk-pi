/**
 * Durable run state.
 *
 * Layout under runs/<run-id>/:
 *   run.json       static metadata incl. persisted per-task arm order
 *   journal.jsonl  append-only event log (fsync per event, monotonic seq)
 *   snapshot.json  atomic state snapshot (tmp + rename + dir fsync)
 *   attempts/      immutable per-attempt directories
 *
 * Recovery: snapshot first, then journal events with seq beyond the
 * snapshot. A truncated final journal line is tolerated and skipped.
 */

import {
  closeSync,
  existsSync,
  fsyncSync,
  mkdirSync,
  openSync,
  readFileSync,
  renameSync,
  rmSync,
  writeFileSync,
  writeSync,
} from "node:fs";
import { join } from "node:path";
import { createHash } from "node:crypto";

export function runDirFor(runsDir, runId) {
  return join(runsDir, runId);
}

/** Deterministic arm order per (runId, taskId): seeded bit decides order. */
export function armOrderFor(runId, taskId) {
  const hash = createHash("sha256").update(`${runId}:${taskId}`).digest();
  return hash[0] % 2 === 0 ? ["upstream", "fork"] : ["fork", "upstream"];
}

export function createRun({ repoRoot, manifest, runsDir, runId, mode = "dry-run" }) {
  const runDir = runDirFor(runsDir, runId);
  if (existsSync(runDir)) {
    throw new Error(`run ${runId} already exists at ${runDir}`);
  }
  mkdirSync(runDir, { recursive: true });
  const armOrder = {};
  for (const task of manifest.tasks) {
    armOrder[task.id] = armOrderFor(runId, task.id);
  }
  const run = {
    schemaVersion: 1,
    runId,
    mode,
    repoRoot,
    createdAt: new Date().toISOString(),
    manifestSha256: createHash("sha256")
      .update(readFileSync(join(repoRoot, "evaluation", "task-manifest.json")))
      .digest("hex"),
    armOrder,
  };
  writeFileSync(join(runDir, "run.json"), `${JSON.stringify(run, null, 2)}\n`, "utf8");
  const state = { runId, mode, seq: 0, attempts: {}, selection: {} };
  appendJournal(runDir, { type: "run-created", runId, mode });
  appendJournal(runDir, { type: "arm-order-persisted", armOrder });
  writeSnapshot(runDir, state);
  return { ...run, runDir, state };
}

/** Append one journal event; returns it with its assigned seq. */
export function appendJournal(runDir, event) {
  const journalPath = join(runDir, "journal.jsonl");
  let seq = 0;
  if (existsSync(journalPath)) {
    const lines = readFileSync(journalPath, "utf8").split("\n").filter((line) => line.length > 0);
    for (const line of lines) {
      try {
        const parsed = JSON.parse(line);
        if (typeof parsed.seq === "number" && parsed.seq > seq) seq = parsed.seq;
      } catch {
        // truncated tail line from a crash: ignored for seq counting
      }
    }
  }
  seq += 1;
  const entry = { seq, time: new Date().toISOString(), ...event };
  const fd = openSync(journalPath, "a");
  try {
    writeSync(fd, `${JSON.stringify(entry)}\n`);
    fsyncSync(fd);
  } finally {
    closeSync(fd);
  }
  return entry;
}

/** Atomic snapshot: write tmp file, rename over, fsync the directory. */
export function writeSnapshot(runDir, state) {
  const finalPath = join(runDir, "snapshot.json");
  const tmpPath = join(runDir, "snapshot.json.tmp");
  writeFileSync(tmpPath, `${JSON.stringify(state, null, 2)}\n`, "utf8");
  renameSync(tmpPath, finalPath);
  const dirFd = openSync(runDir, "r");
  try {
    fsyncSync(dirFd);
  } catch {
    // directory fsync is best-effort on some platforms
  } finally {
    closeSync(dirFd);
  }
  return finalPath;
}

/**
 * Load run state: snapshot when present and parseable, then replay any
 * journal events beyond the snapshot seq. Returns null when the run
 * directory does not exist.
 */
export function loadState(runDir) {
  if (!existsSync(runDir)) return null;
  let state = { runId: null, mode: null, seq: 0, attempts: {}, selection: {} };
  const snapshotPath = join(runDir, "snapshot.json");
  if (existsSync(snapshotPath)) {
    try {
      const parsed = JSON.parse(readFileSync(snapshotPath, "utf8"));
      if (parsed && typeof parsed === "object") state = parsed;
    } catch {
      // corrupt snapshot: rebuild from journal below
    }
  }
  const journalPath = join(runDir, "journal.jsonl");
  if (!existsSync(journalPath)) return state;
  const lines = readFileSync(journalPath, "utf8").split("\n");
  for (const line of lines) {
    if (line.trim().length === 0) continue;
    let event;
    try {
      event = JSON.parse(line);
    } catch {
      continue; // tolerate truncated tail
    }
    if (typeof event.seq !== "number" || event.seq <= state.seq) continue;
    state = applyEvent(state, event);
    state.seq = event.seq;
  }
  if (!isPlainObjectValue(state.selection)) state.selection = {};
  return state;
}

function isPlainObjectValue(value) {
  return typeof value === "object" && value !== null && !Array.isArray(value);
}

export function loadRun(runDir) {
  return JSON.parse(readFileSync(join(runDir, "run.json"), "utf8"));
}

/**
 * Atomic whole-run lock. Ownership metadata records the holder pid.
 * A live owner always refuses. A dead owner refuses unless `recover` is
 * explicitly requested. The lock is never auto-cleared.
 */
export function acquireRunLock(runDir, { recover = false } = {}) {
  const lockDir = join(runDir, "lock.d");
  const ownerPath = join(lockDir, "owner.json");
  try {
    mkdirSync(lockDir);
  } catch (error) {
    if (error?.code !== "EEXIST") throw error;
    let owner = null;
    try {
      owner = JSON.parse(readFileSync(ownerPath, "utf8"));
    } catch {
      throw new Error(
        `run lock exists at ${lockDir} but owner metadata is unreadable; refusing (pass --recover-lock only if certain)`,
      );
    }
    const alive = owner && typeof owner.pid === "number" && isPidAlive(owner.pid);
    if (alive) {
      throw new Error(`run is owned by live process ${owner.pid}; refusing concurrent mutation`);
    }
    if (!recover) {
      throw new Error(
        `run lock is stale (owner ${owner?.pid} is not running); refusing without --recover-lock`,
      );
    }
    rmSync(lockDir, { recursive: true, force: true });
    mkdirSync(lockDir);
  }
  writeFileSync(ownerPath, `${JSON.stringify({ pid: process.pid, at: new Date().toISOString() })}\n`, "utf8");
  return lockDir;
}

export function releaseRunLock(runDir) {
  rmSync(join(runDir, "lock.d"), { recursive: true, force: true });
}

/**
 * Atomic slot claim: the attempt directory itself is created exactly
 * once; a second claimant sees EEXIST and must not invoke.
 */
export function claimAttemptSlot(attemptDir) {
  try {
    mkdirSync(attemptDir);
    return true;
  } catch (error) {
    if (error?.code === "EEXIST") return false;
    throw error;
  }
}

function isPidAlive(pid) {
  try {
    process.kill(pid, 0);
    return true;
  } catch (error) {
    return error?.code === "EPERM";
  }
}

function applyEvent(state, event) {
  const next = { ...state, attempts: { ...state.attempts } };
  if (event.type === "run-created") {
    next.runId = event.runId;
    next.mode = event.mode;
  }
  if (event.type === "attempt-reserved" || event.type === "attempt-started" || event.type === "attempt-finished" || event.type === "attempt-abandoned") {
    const key = `${event.taskId}:${event.arm}:${event.attempt}`;
    next.attempts[key] = {
      taskId: event.taskId,
      arm: event.arm,
      attempt: event.attempt,
      status: event.type === "attempt-reserved" ? "reserved" : event.type === "attempt-started" ? "running" : event.type === "attempt-finished" ? event.status : "abandoned-reserved",
      ...(event.type === "attempt-finished" ? { outcome: event.outcome } : {}),
    };
  }
  if (event.type === "attempt-selected") {
    next.selection = {
      ...(isPlainObjectValue(state.selection) ? state.selection : {}),
      [`${event.taskId}:${event.arm}`]: event.attempt,
    };
  }
  return next;
}
