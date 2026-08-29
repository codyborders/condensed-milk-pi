/**
 * Provider-study reservations: fail-closed slot ownership.
 *
 * A completed slot is never invoked again, an abandoned receipt without
 * a terminal result refuses instead of overwriting, and every artifact
 * is created with no-overwrite semantics so a second claim of the same
 * slot can never clobber the first.
 */

import { closeSync, existsSync, fsyncSync, mkdirSync, openSync, readFileSync, writeSync } from "node:fs";
import { createHash } from "node:crypto";
import { join } from "node:path";

/** Deterministic, phase-separated slot path with path-safe task ids. */
export function providerStudySlotPath(runsRoot, phase, taskId, arm, rep) {
  if (phase !== "development" && phase !== "holdout") {
    throw new Error("phase must be development or holdout");
  }
  if (typeof taskId !== "string" || taskId.includes("/") || taskId.includes("..") || taskId.length === 0) {
    throw new Error(`taskId must stay inside the run tree (got ${JSON.stringify(taskId)})`);
  }
  return join(runsRoot, phase, "attempts", taskId, arm, `attempt-${String(rep).padStart(3, "0")}`);
}

/** Write with O_EXCL so an existing target can never be replaced. */
function writeNoOverwrite(path, text) {
  const fd = openSync(path, "wx");
  try {
    writeSync(fd, text, "utf8");
    fsyncSync(fd);
  } finally {
    closeSync(fd);
  }
}

export function providerStudyCompletionPath(attemptDir) {
  return join(attemptDir, "provider-study-complete.json");
}

export function providerStudyReadCompletedResult(attemptDir) {
  const resultPath = join(attemptDir, "result.json");
  const completionPath = providerStudyCompletionPath(attemptDir);
  if (!existsSync(resultPath) || !existsSync(completionPath)) return null;
  try {
    const bytes = readFileSync(resultPath);
    const completion = JSON.parse(readFileSync(completionPath, "utf8"));
    const digest = createHash("sha256").update(bytes).digest("hex");
    if (completion?.schemaVersion !== 1 || completion?.resultSha256 !== digest) return null;
    return JSON.parse(bytes.toString("utf8"));
  } catch {
    return null;
  }
}

export function providerStudyPublishCompletion(attemptDir) {
  const resultPath = join(attemptDir, "result.json");
  if (!existsSync(resultPath)) throw new Error("provider-study completion needs a finalized result.json");
  const bytes = readFileSync(resultPath);
  const result = JSON.parse(bytes.toString("utf8"));
  if (result?.study !== "provider-study" && Object.keys(result ?? {}).length > 0) {
    throw new Error("provider-study completion refuses a non-study result");
  }
  const resultSha256 = createHash("sha256").update(bytes).digest("hex");
  writeNoOverwrite(
    providerStudyCompletionPath(attemptDir),
    `${JSON.stringify({ schemaVersion: 1, study: "provider-study", resultSha256 }, null, 2)}\n`,
  );
  return { resultSha256 };
}

/**
 * Claim one slot exactly once. Terminal slots skip without reinvoking,
 * abandoned receipts fail closed, and existing directories refuse.
 */
export function providerStudyReserve({ runDir, runId, phase, taskId, arm, rep, pins }) {
  const attemptDir = providerStudySlotPath(runDir, phase, taskId, arm, rep);
  const resultPath = join(attemptDir, "result.json");
  const receiptPath = join(attemptDir, "provider-invocation.json");
  const pinnedPath = join(attemptDir, "pinned.json");
  if (providerStudyReadCompletedResult(attemptDir) !== null) {
    return { claimed: false, reason: "completed", attemptDir };
  }
  if (existsSync(providerStudyCompletionPath(attemptDir))) {
    return { claimed: false, reason: "invalid-completion", attemptDir };
  }
  if (existsSync(receiptPath) && !existsSync(pinnedPath)) {
    // Receipt without its pin record: an inconsistent, stranded slot.
    // Fail closed; never overwrite the receipt.
    return { claimed: false, reason: "abandoned", attemptDir };
  }
  if (existsSync(pinnedPath) || existsSync(attemptDir)) {
    return { claimed: false, reason: "slot-exists", attemptDir };
  }
  try {
    mkdirSync(attemptDir, { recursive: true });
  } catch (error) {
    if (error?.code === "EEXIST") {
      return { claimed: false, reason: "slot-exists", attemptDir };
    }
    throw error;
  }
  writeNoOverwrite(
    pinnedPath,
    `${JSON.stringify({ schemaVersion: 1, study: "provider-study", phase, runId, taskId, arm, rep, ...pins }, null, 2)}\n`,
  );
  writeNoOverwrite(
    receiptPath,
    `${JSON.stringify({
      schemaVersion: 1,
      study: "provider-study",
      phase,
      runId,
      taskId,
      arm,
      rep,
      reservedAt: new Date().toISOString(),
    }, null, 2)}\n`,
  );
  return { claimed: true, attemptDir };
}
