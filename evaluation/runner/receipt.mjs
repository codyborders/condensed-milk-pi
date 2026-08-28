/**
 * Provider-invocation receipt validation.
 *
 * Every selected attempt must prove its invocation kind through the
 * durable `provider-invocation.json` receipt written at reservation:
 *
 * - run.mode real: the receipt must be a paid receipt (fake:false) whose
 *   identity (runId/taskId/arm/attempt) matches the slot, whose
 *   provider/model/armCommit match the manifest pins, and, whenever
 *   runtime pinning exists anywhere (receipt, pinned.json, run.json),
 *   whose piRuntime digest matches pinned.json plus run.json. Legacy
 *   real runs recorded before runtime pinning have no piRuntime
 *   anywhere and stay valid with an absent piRuntime.
 * - any other mode (fake/dry-run runs): the receipt must be a fake
 *   receipt (fake:true).
 *
 * Missing, malformed, or mismatched receipts are invalid. This module
 * only reads persisted state; it never reserves, executes, or spends.
 */

import { existsSync, readFileSync } from "node:fs";
import { join } from "node:path";

function readJsonOrNull(path) {
  if (!existsSync(path)) return null;
  try {
    const parsed = JSON.parse(readFileSync(path, "utf8"));
    return parsed && typeof parsed === "object" && !Array.isArray(parsed) ? parsed : null;
  } catch {
    return null;
  }
}

const RUNTIME_DIGEST_PATTERN = /^[0-9a-f]{64}$/;

/** A runtime pin is valid only as an object with a 64-hex-character digest. */
export function runtimePinDigest(pin) {
  return pin && typeof pin === "object" && typeof pin.digest === "string" && RUNTIME_DIGEST_PATTERN.test(pin.digest)
    ? pin.digest
    : null;
}

/**
 * Validate the receipt of one selected attempt.
 * Returns { ok: true, receipt } or { ok: false, reason }.
 */
export function validateSelectedAttemptReceipt({ runDir, attemptDir, runId, taskId, arm, attempt, manifest, expected = null }) {
  const receiptPath = join(attemptDir, "provider-invocation.json");
  if (!existsSync(receiptPath)) {
    return { ok: false, reason: "provider-invocation.json receipt is missing" };
  }
  const receipt = readJsonOrNull(receiptPath);
  if (!receipt) {
    return { ok: false, reason: "provider-invocation.json receipt is malformed" };
  }
  const run = readJsonOrNull(join(runDir, "run.json"));
  if (!run) {
    return { ok: false, reason: "run.json is unreadable; refusing to validate the receipt" };
  }
  if (run.mode !== "real") {
    if (receipt.fake !== true) {
      return { ok: false, reason: `receipt has fake:${JSON.stringify(receipt.fake)}; a ${run.mode ?? "unknown-mode"} run may only select fake receipts` };
    }
    return { ok: true, receipt };
  }
  if (receipt.fake !== false) {
    return { ok: false, reason: `receipt has fake:${JSON.stringify(receipt.fake)}; a real run may only select paid receipts (fake:false)` };
  }
  if (receipt.runId !== runId) {
    return { ok: false, reason: `receipt runId ${JSON.stringify(receipt.runId)} does not match run ${JSON.stringify(runId)}` };
  }
  if (receipt.taskId !== taskId) {
    return { ok: false, reason: `receipt taskId ${JSON.stringify(receipt.taskId)} does not match ${JSON.stringify(taskId)}` };
  }
  if (receipt.arm !== arm) {
    return { ok: false, reason: `receipt arm ${JSON.stringify(receipt.arm)} does not match ${JSON.stringify(arm)}` };
  }
  if (receipt.attempt !== attempt) {
    return { ok: false, reason: `receipt attempt ${JSON.stringify(receipt.attempt)} does not match attempt ${attempt}` };
  }
  const expectedProvider = manifest?.evaluation?.provider ?? null;
  if ((receipt.provider ?? null) !== expectedProvider) {
    return { ok: false, reason: `receipt provider ${JSON.stringify(receipt.provider ?? null)} does not match the pinned ${JSON.stringify(expectedProvider)}` };
  }
  const expectedModel = manifest?.evaluation?.model ?? null;
  if ((receipt.model ?? null) !== expectedModel) {
    return { ok: false, reason: `receipt model ${JSON.stringify(receipt.model ?? null)} does not match the pinned ${JSON.stringify(expectedModel)}` };
  }
  const expectedCommit = manifest?.evaluation?.arms?.find((entry) => entry.name === arm)?.commit ?? null;
  if ((receipt.armCommit ?? null) !== expectedCommit) {
    return { ok: false, reason: `receipt armCommit ${JSON.stringify(receipt.armCommit ?? null)} does not match the manifest arm commit ${JSON.stringify(expectedCommit)}` };
  }
  // Runtime pin cross-check. Legacy handling applies only when the
  // piRuntime field is absent everywhere (receipt, pinned.json,
  // run.json). Any present pin must be a valid object with a nonempty
  // 64-hex digest; the receipt must carry a valid pin matching every
  // other present pin. A present-but-malformed pin anywhere fails.
  const pinned = readJsonOrNull(join(attemptDir, "pinned.json"));
  const receiptPin = receipt.piRuntime;
  const pinnedPin = pinned?.piRuntime;
  const runPin = run.piRuntime;
  if (receiptPin !== undefined || pinnedPin !== undefined || runPin !== undefined) {
    if (receiptPin === undefined || pinnedPin === undefined || runPin === undefined) {
      return { ok: false, reason: "runtime pinning requires piRuntime in the receipt, pinned.json, and run.json" };
    }
    const receiptDigest = runtimePinDigest(receiptPin);
    if (!receiptDigest) {
      return { ok: false, reason: "runtime pinning exists but the receipt carries no valid piRuntime digest (64 hex characters)" };
    }
    const pinnedDigest = runtimePinDigest(pinnedPin);
    if (!pinnedDigest) return { ok: false, reason: "pinned.json carries a malformed piRuntime pin" };
    if (pinnedDigest !== receiptDigest) {
      return { ok: false, reason: "receipt piRuntime digest does not match pinned.json" };
    }
    const runDigest = runtimePinDigest(runPin);
    if (!runDigest) return { ok: false, reason: "run.json carries a malformed piRuntime pin" };
    if (runDigest !== receiptDigest) {
      return { ok: false, reason: "receipt piRuntime digest does not match run.json" };
    }
  }
  // Study extension: optional expected study/profile/fixture identity.
  // Applied only when `expected` is provided; the standard behavior
  // above is unchanged when it is absent.
  if (expected) {
    const pinnedForStudy = readJsonOrNull(join(attemptDir, "pinned.json")) ?? receipt;
    for (const field of ["study", "profileSha256", "fixtureContentSha256", "fixtureGitStateSha256", "implementationSha256", "observerSha256", "observerWrapperSha256"]) {
      if (expected[field] === undefined) continue;
      if (receipt[field] !== expected[field] || pinnedForStudy[field] !== expected[field]) {
        return {
          ok: false,
          reason: `receipt ${field} does not match the expected ${field} ${JSON.stringify(expected[field])}`,
        };
      }
    }
  }
  return { ok: true, receipt };
}
