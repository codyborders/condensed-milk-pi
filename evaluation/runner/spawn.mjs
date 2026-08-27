/**
 * Safe subprocess execution with bounded process ownership.
 *
 * Contract:
 * - argv arrays only; no shell is ever constructed.
 * - explicit cwd and an allowlisted environment (never inherit).
 * - stdout and stderr stream to files, not memory.
 * - the child runs in exactly one detached process group (child pid is
 *   the group id); the runner owns the whole group.
 * - teardown triggers: timeout, parent SIGINT, parent SIGTERM, or an
 *   aborted abort signal (explicit cancellation). Each sends SIGTERM
 *   to the group, waits a fixed grace period, then sends SIGKILL.
 * - the child is reaped (the close event); parent signal handlers are
 *   removed after settlement; library code never calls process.exit.
 * - the outcome records exit code, original signal, timeout, cancel
 *   reason, and cleanup outcome separately.
 */

import { spawn } from "node:child_process";
import { openSync, closeSync } from "node:fs";

export const ENV_ALLOWLIST = new Set([
  "PATH",
  "HOME",
  "TMPDIR",
  "FAKE_PI_SCENARIO",
  "FAKE_PI_INVOCATIONS",
  "FAKE_PI_TREE",
]);

/** Build an allowlisted environment; unknown names are dropped. */
export function allowlistEnv(source) {
  const clean = {};
  for (const name of ENV_ALLOWLIST) {
    if (source[name] !== undefined) clean[name] = source[name];
  }
  return clean;
}

/** Fixed grace period between SIGTERM and SIGKILL during teardown. */
export const TERM_GRACE_MS = 2_000;

/**
 * Run one command in its own detached process group.
 *
 * Resolves with { code, signal, timedOut, cancelled, cancelReason,
 * spawnError, pid, teardown } where code/signal come from the reaped
 * child exit, timedOut is true only when the runner's timeout fired,
 * cancelled/cancelReason record an explicit cancellation, spawnError is
 * a string when the command could not be spawned at all, and teardown
 * records which trigger tore the group down ({ triggered: false |
 * "timeout" | "SIGINT" | "SIGTERM" | "cancel", originalSignal,
 * escalatedToSigkill, outcome }).
 */
export function runSubprocess({
  argv,
  cwd,
  env,
  timeoutMs,
  stdoutPath,
  stderrPath,
  graceMs = TERM_GRACE_MS,
  abortSignal = null,
}) {
  return new Promise((resolve) => {
    let child;
    const stdoutFd = openSync(stdoutPath, "w");
    const stderrFd = openSync(stderrPath, "w");
    const teardown = {
      triggered: false,
      originalSignal: null,
      escalatedToSigkill: false,
      graceMs: TERM_GRACE_MS,
      outcome: "none",
    };
    let timedOut = false;
    let cancelled = false;
    let cancellationReason = null;
    let settled = false;
    let graceTimer = null;
    let timeoutTimer = null;

    const onParentSigint = () => beginTeardown("parent-signal", "SIGINT");
    const onParentSigterm = () => beginTeardown("parent-signal", "SIGTERM");
    const onAbort = () => beginTeardown("abort-signal", null, abortSignal?.reason);

    function killGroup(signal) {
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
    }

    function beginTeardown(trigger, originalSignal, reason) {
      if (settled || teardown.triggered) return;
      teardown.triggered = trigger;
      teardown.originalSignal = originalSignal;
      if (trigger === "timeout") timedOut = true;
      if (trigger === "abort-signal") {
        cancelled = true;
        cancellationReason = reason === undefined ? "cancelled" : String(reason?.message ?? reason);
      }
      teardown.outcome = "sigterm";
      teardown.graceMs = graceMs;
      killGroup("SIGTERM");
      graceTimer = setTimeout(() => {
        teardown.escalatedToSigkill = true;
        teardown.outcome = "sigterm-then-sigkill";
        killGroup("SIGKILL");
      }, graceMs);
      if (graceTimer.unref) graceTimer.unref();
    }

    function removeOwnHandlers() {
      process.off("SIGINT", onParentSigint);
      process.off("SIGTERM", onParentSigterm);
      if (abortSignal) abortSignal.removeEventListener("abort", onAbort);
    }

    function settle(outcome) {
      if (settled) return;
      settled = true;
      if (timeoutTimer) clearTimeout(timeoutTimer);
      if (graceTimer) clearTimeout(graceTimer);
      removeOwnHandlers();
      closeSync(stdoutFd);
      closeSync(stderrFd);
      resolve(outcome);
    }

    try {
      child = spawn(argv[0], argv.slice(1), {
        cwd,
        env,
        detached: true,
        stdio: ["ignore", stdoutFd, stderrFd],
      });
    } catch (error) {
      settle({
        code: null,
        signal: null,
        timedOut: false,
        cancelled: false,
        cancelReason: null,
        spawnError: String(error?.message ?? error),
        pid: child?.pid ?? null,
        teardown: { ...teardown },
      });
      return;
    }

    process.on("SIGINT", onParentSigint);
    process.on("SIGTERM", onParentSigterm);
    if (abortSignal) {
      if (abortSignal.aborted) {
        onAbort();
      } else {
        abortSignal.addEventListener("abort", onAbort, { once: true });
      }
    }

    child.on("error", (error) => {
      settle({
        code: null,
        signal: null,
        timedOut,
        cancelled,
        cancelReason,
        spawnError: String(error?.message ?? error),
        pid: child.pid,
        teardown: { ...teardown },
      });
    });

    timeoutTimer = setTimeout(() => beginTeardown("timeout", null), timeoutMs);
    if (timeoutTimer.unref) timeoutTimer.unref();

    // The close event is the reaping point: the child exited and its
    // stdio drained, so the pid no longer exists as a zombie.
    child.on("close", (code, signal) => {
      if (teardown.triggered && teardown.outcome === "sigterm" && !teardown.escalatedToSigkill) {
        teardown.outcome = "sigterm";
      }
      settle({
        code,
        signal,
        timedOut,
        cancelled,
        cancellationReason,
        spawnError: null,
        pid: child.pid,
        teardown: { ...teardown },
      });
    });
  });
}
