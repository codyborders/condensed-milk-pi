#!/usr/bin/env node
/**
 * Fake Pi coding agent executable (fault path).
 *
 * Current red slice: the timeout fault. Spawns a grandchild that must
 * die with the process group, then hangs the parent so the runner has
 * to own the timeout and kill the whole group.
 */

import { appendFileSync, readFileSync, writeFileSync } from "node:fs";
import { spawn } from "node:child_process";
import { applySolution } from "../lib/fixtures.mjs";

const FIXED_TIME = "1970-01-01T00:00:00.000Z";
const scenario = JSON.parse(readFileSync(process.env.FAKE_PI_SCENARIO, "utf8"));
const behavior = scenario.behavior ?? "timeout";

if (process.env.FAKE_PI_INVOCATIONS) {
  appendFileSync(
    process.env.FAKE_PI_INVOCATIONS,
    `${JSON.stringify({ at: FIXED_TIME, behavior })}\n`,
    "utf8",
  );
}

if (behavior === "nonzero") {
  process.exit(3);
}

if (behavior === "malformed") {
  process.stdout.write("{\"type\":\"agent_start\"}\n");
  applySolution({ worktree: process.cwd(), solution: scenario.solution, taskId: scenario.taskId });
  process.stdout.write("<<<truncated final line>>>\n");
  process.exit(0);
}

if (behavior === "missing-usage") {
  const message = { role: "assistant", content: [{ type: "text", text: "done without usage" }] };
  process.stdout.write(`${JSON.stringify({ type: "message_end", message })}\n`);
  applySolution({ worktree: process.cwd(), solution: scenario.solution, taskId: scenario.taskId });
  process.exit(0);
}

if (behavior === "interrupted") {
  process.stdout.write("{\"type\":\"agent_start\"}\n");
  process.kill(process.pid, "SIGINT");
}

if (behavior === "ignore-term") {
  process.stdout.write("{\"type\":\"agent_start\"}\n");
  process.on("SIGTERM", () => {
    // deliberately ignore SIGTERM so the runner must escalate to SIGKILL
  });
  const stubborn = spawn(process.execPath, ["-e", "process.on('SIGTERM',()=>{}); setInterval(() => {}, 1000)"], { stdio: "ignore" });
  if (process.env.FAKE_PI_TREE) {
    writeFileSync(
      process.env.FAKE_PI_TREE,
      `${JSON.stringify({ pid: process.pid, childPid: stubborn.pid })}\n`,
      "utf8",
    );
  }
  setInterval(() => {}, 1000);
}

if (behavior === "scorer-failure") {
  process.stdout.write("{\"type\":\"agent_start\"}\n");
  writeFileSync("BROKEN.txt", "reference fix deliberately not applied\n", "utf8");
  process.exit(0);
}

if (behavior === "multi-turn") {
  const first = { role: "assistant", content: [{ type: "text", text: "turn one" }], usage: { input: 10, output: 25 } };
  const second = { role: "assistant", content: [{ type: "text", text: "turn two" }], usage: { input: 25, output: 35 } };
  process.stdout.write(`${JSON.stringify({ type: "message_end", message: first })}\n`);
  process.stdout.write(`${JSON.stringify({ type: "turn_end", message: second, toolResults: [] })}\n`);
  process.stdout.write(`${JSON.stringify({ type: "message_end", message: second })}\n`);
  process.stdout.write(`${JSON.stringify({ type: "agent_end", messages: [first, second] })}\n`);
  applySolution({ worktree: process.cwd(), solution: scenario.solution, taskId: scenario.taskId });
  process.exit(0);
}

const grandchild = spawn(process.execPath, ["-e", "setInterval(() => {}, 1000)"], { stdio: "ignore" });
if (process.env.FAKE_PI_TREE) {
  writeFileSync(
    process.env.FAKE_PI_TREE,
    `${JSON.stringify({ pid: process.pid, childPid: grandchild.pid })}\n`,
    "utf8",
  );
}
setInterval(() => {}, 1000);
