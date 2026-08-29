/**
 * Provider-study CLI (grown test-first).
 *
 * One entry point for every study command. The credential path is a
 * CLI-only flag: it is never written to run metadata, journals, or
 * reports.
 */

import { test } from "node:test";
import assert from "node:assert/strict";
import { existsSync, mkdirSync, rmSync } from "node:fs";
import { join } from "node:path";
import { tmpdir } from "node:os";
import { fileURLToPath } from "node:url";
import { providerStudyCli } from "../runner/cli.mjs";

const repoRoot = join(fileURLToPath(import.meta.url), "..", "..", "..", "..");

function freshRunsRoot() {
  const dir = join(tmpdir(), `provider-study-cli-${process.pid}-${Date.now()}-${Math.floor(Math.random() * 1e6)}`);
  mkdirSync(dir, { recursive: true });
  return dir;
}

test("cli dry-run runs one task across four arms and five reps", async () => {
  const runsRoot = freshRunsRoot();
  try {
    const dry = await providerStudyCli(["dry-run", "--phase", "development", "--task", "task-01", "--runs-root", runsRoot], { repoRoot });
    assert.equal(JSON.parse(dry.stdout).executed, 20);
    assert.ok(existsSync(join(runsRoot, "development", "attempts", "task-01", "none", "attempt-005", "result.json")));
  } finally {
    rmSync(runsRoot, { recursive: true, force: true });
  }
});

test("cli prepare persists a phase lock and run refuses without --confirm-paid", async () => {
  const runsRoot = freshRunsRoot();
  try {
    const prepare = await providerStudyCli(["prepare", "--phase", "development", "--run-id", "run-1", "--runs-root", runsRoot], { repoRoot });
    assert.equal(prepare.code, 0);
    const refused = await providerStudyCli(["run", "--phase", "development", "--run-id", "run-1", "--runs-root", runsRoot], { repoRoot });
    assert.notEqual(refused.code, 0);
    assert.match(refused.stderr, /--confirm-paid/);
  } finally {
    rmSync(runsRoot, { recursive: true, force: true });
  }
});

test("cli plan and status report the persisted schedule and slot counts", async () => {
  const runsRoot = freshRunsRoot();
  try {
    await providerStudyCli(["dry-run", "--phase", "development", "--task", "task-01", "--runs-root", runsRoot], { repoRoot });
    const plan = await providerStudyCli(["plan", "--phase", "development"], { repoRoot });
    const planBody = JSON.parse(plan.stdout);
    assert.equal(planBody.tasks.length, 12);
    assert.match(planBody.planSha256, /^[0-9a-f]{64}$/);
    const status = await providerStudyCli(["status", "--runs-root", runsRoot], { repoRoot });
    const statusBody = JSON.parse(status.stdout);
    assert.equal(statusBody.development.completedSlots, 20);
    assert.equal(statusBody.holdout.completedSlots, 0);
  } finally {
    rmSync(runsRoot, { recursive: true, force: true });
  }
});

test("cli freeze dispatches through the freeze module", async () => {
  const freeze = await providerStudyCli(["freeze"], { repoRoot });
  assert.equal(freeze.code, 0);
  assert.equal(JSON.parse(freeze.stdout).written, false);
});

test("cli holdout fixtures require an explicit private key source", async () => {
  const runsRoot = freshRunsRoot();
  try {
    const fixtures = await providerStudyCli(["fixtures", "--phase", "holdout", "--runs-root", runsRoot], { repoRoot });
    assert.notEqual(fixtures.code, 0);
    assert.match(fixtures.stderr, /--holdout-key-source/);
  } finally {
    rmSync(runsRoot, { recursive: true, force: true });
  }
});

test("cli report writes the sanitized report files for a dry-run root", async () => {
  const runsRoot = freshRunsRoot();
  const label = `cli-${Date.now()}`;
  try {
    await providerStudyCli(["dry-run", "--phase", "development", "--task", "task-01", "--runs-root", runsRoot], { repoRoot });
    const report = await providerStudyCli(["report", "--phase", "development", "--label", label, "--runs-root", runsRoot], { repoRoot });
    assert.equal(JSON.parse(report.stdout).rows, 20);
  } finally {
    rmSync(runsRoot, { recursive: true, force: true });
    rmSync(join(repoRoot, "evaluation", "results", "provider-study", `development-${label}.json`), { force: true });
    rmSync(join(repoRoot, "evaluation", "results", "provider-study", `development-${label}.md`), { force: true });
  }
});

test("cli judge-export emits blinded cases for a dry-run root", async () => {
  const runsRoot = freshRunsRoot();
  try {
    await providerStudyCli(["dry-run", "--phase", "development", "--task", "task-01", "--runs-root", runsRoot], { repoRoot });
    const exported = await providerStudyCli(["judge-export", "--phase", "development", "--runs-root", runsRoot], { repoRoot });
    assert.equal(JSON.parse(exported.stdout).caseCount, 20);
  } finally {
    rmSync(runsRoot, { recursive: true, force: true });
  }
});

test("cli judge-run refuses without --confirm-paid", async () => {
  const judgeRun = await providerStudyCli(["judge-run", "--phase", "development"], { repoRoot });
  assert.notEqual(judgeRun.code, 0);
  assert.match(judgeRun.stderr, /--confirm-paid/);
});

test("cli validate reports both manifests, the freeze lock, and the plan hashes", async () => {
  const validate = await providerStudyCli(["validate"], { repoRoot });
  assert.equal(validate.code, 0, validate.stderr);
  const body = JSON.parse(validate.stdout);
  assert.equal(body.ok, true, JSON.stringify(body.problems ?? []));
  assert.equal(body.phases.development.tasks, 12);
  assert.equal(body.phases.holdout.tasks, 8);
  assert.equal(body.freeze.ok, true);
  assert.match(body.phases.development.planSha256, /^[0-9a-f]{64}$/);
  assert.match(body.phases.holdout.planSha256, /^[0-9a-f]{64}$/);
});
