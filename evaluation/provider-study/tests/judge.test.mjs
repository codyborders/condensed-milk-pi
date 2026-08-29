/**
 * Provider-study blinded judging (grown test-first).
 *
 * Cases are exported without arm identity, tokens, timing, transcript,
 * archive markers, model, or run order. The arm mapping stays in a
 * separate mapping file whose digest the import validates. One frozen
 * quality score lands per attempt, and judge provider usage is ledgered
 * separately so it never enters the plugin totals.
 */

import { test } from "node:test";
import assert from "node:assert/strict";
import { existsSync, mkdirSync, readFileSync, rmSync, writeFileSync } from "node:fs";
import { join } from "node:path";
import { tmpdir } from "node:os";
import { fileURLToPath } from "node:url";
import { providerStudyDryRun } from "../runner/study.mjs";
import { providerStudyJudgeExport, providerStudyJudgeImport, PROVIDER_STUDY_JUDGE_RUBRIC } from "../runner/judge.mjs";

const repoRoot = join(fileURLToPath(import.meta.url), "..", "..", "..", "..");

function freshRunsRoot() {
  const dir = join(tmpdir(), `provider-study-judge-${process.pid}-${Date.now()}-${Math.floor(Math.random() * 1e6)}`);
  mkdirSync(dir, { recursive: true });
  return dir;
}

test("judge export carries anonymous changed-file paths, full bytes, initial bytes, prompt, and rubric", async () => {
  const runsRoot = freshRunsRoot();
  try {
    await providerStudyDryRun({ repoRoot, runsRoot, phase: "development", taskIds: ["task-01"] });
    const exported = await providerStudyJudgeExport({ repoRoot, runsRoot, phase: "development" });
    const caseLines = readFileSync(exported.casesPath, "utf8").trim().split("\n").map((line) => JSON.parse(line));
    assert.equal(caseLines.length, 20);
    const forbidden = [
      "arm",
      "upstream",
      "remediated",
      "usage",
      "Tokens",
      "wallTime",
      "latency",
      "model",
      "transcript",
      "archive",
      "rep",
      "piVersion",
    ];
    for (const testCase of caseLines) {
      assert.equal(typeof testCase.prompt, "string");
      assert.ok(testCase.prompt.length > 0, "the task prompt travels with the case");
      assert.equal(testCase.rubric, PROVIDER_STUDY_JUDGE_RUBRIC, "the frozen rubric travels with the case");
      assert.ok(Array.isArray(testCase.finalChangedFiles), "changed files are enumerated");
      const statsChange = testCase.finalChangedFiles.find((file) => file.path === "stats.py");
      assert.ok(statsChange, "the changed file path is anonymous and present");
      assert.equal(statsChange.change, "modified");
      assert.match(statsChange.sha256, /^[0-9a-f]{64}$/);
      assert.equal(typeof statsChange.bytesHex, "string");
      const finalText = Buffer.from(statsChange.bytesHex, "hex").toString("utf8");
      assert.ok(finalText.includes("def median"), "complete final file bytes are exported");
      const initial = testCase.initialFiles.find((file) => file.path === "stats.py");
      assert.ok(initial, "the initial relevant file bytes are exported");
      const initialText = Buffer.from(initial.bytesHex, "hex").toString("utf8");
      assert.ok(initialText.includes("def median"));
      assert.notEqual(initial.sha256, statsChange.sha256, "initial and final bytes differ for a modified file");
      const stripped = { ...testCase };
      delete stripped.rubric;
      const text = JSON.stringify(stripped);
      for (const marker of forbidden) {
        assert.equal(text.includes(marker), false, `case must not contain ${marker}: ${text.substring(0, 120)}`);
      }
      assert.match(testCase.caseId, /^[0-9a-f]{64}$/);
    }
  } finally {
    rmSync(runsRoot, { recursive: true, force: true });
  }
});

test("judge export rejects an oversize case under the documented bound instead of hashing content", async () => {
  const runsRoot = freshRunsRoot();
  try {
    await providerStudyDryRun({ repoRoot, runsRoot, phase: "development", taskIds: ["task-01"] });
    const attemptDir = join(runsRoot, "development", "attempts", "task-01", "none", "attempt-001", "worktree");
    writeFileSync(join(attemptDir, "huge.txt"), "x".repeat(300 * 1024), "utf8");
    await assert.rejects(
      () => providerStudyJudgeExport({ repoRoot, runsRoot, phase: "development" }),
      /exceed the documented per-file bound/,
      "an oversize case must reject with the bound named, never silently hash content",
    );
  } finally {
    rmSync(runsRoot, { recursive: true, force: true });
  }
});

test("judge import validates exact coverage before writing any quality file", async () => {
  const runsRoot = freshRunsRoot();
  try {
    await providerStudyDryRun({ repoRoot, runsRoot, phase: "development", taskIds: ["task-01"] });
    const exported = await providerStudyJudgeExport({ repoRoot, runsRoot, phase: "development" });
    const cases = readFileSync(exported.casesPath, "utf8").trim().split("\n").map((line) => JSON.parse(line));
    const mapping = JSON.parse(readFileSync(exported.mappingPath, "utf8"));
    const scores = cases.map((entry) => ({ caseId: entry.caseId, score: 4 }));
    const firstQuality = join(runsRoot, "development", "attempts", "task-01", "none", "attempt-001", "quality.json");
    assert.throws(
      () => providerStudyJudgeImport({ runsRoot, phase: "development", scores: scores.filter((_, index) => index > 0), mappingDigest: mapping.mappingDigest }),
      /missing|exact|coverage/,
    );
    assert.equal(existsSync(firstQuality), false, "a partial import writes no quality file");
    assert.throws(
      () => providerStudyJudgeImport({ runsRoot, phase: "development", scores: [...scores, scores[0]], mappingDigest: mapping.mappingDigest }),
      /duplicate|exact|coverage/,
    );
    assert.equal(existsSync(firstQuality), false, "a duplicate import writes no quality file");
    assert.throws(
      () => providerStudyJudgeImport({ runsRoot, phase: "development", scores: [...scores.filter((_, index) => index > 0), { caseId: "0".repeat(64), score: 4 }], mappingDigest: mapping.mappingDigest }),
      /unknown case/,
    );
    assert.equal(existsSync(firstQuality), false, "an unknown case writes no quality file");
  } finally {
    rmSync(runsRoot, { recursive: true, force: true });
  }
});

test("judge export is blinded and the import freezes one score per attempt", async () => {
  const runsRoot = freshRunsRoot();
  try {
    await providerStudyDryRun({ repoRoot, runsRoot, phase: "development", taskIds: ["task-01"] });
    const exported = await providerStudyJudgeExport({ repoRoot, runsRoot, phase: "development" });
    assert.ok(exported.casesPath.endsWith("cases.jsonl"));
    const caseLines = readFileSync(exported.casesPath, "utf8").trim().split("\n").map((line) => JSON.parse(line));
    assert.equal(caseLines.length, 20);
    const forbidden = [
      "arm",
      "upstream",
      "remediated",
      "usage",
      "Tokens",
      "wallTime",
      "latency",
      "model",
      "transcript",
      "archive",
      "rep",
      "piVersion",
    ];
    for (const testCase of caseLines) {
      const stripped = { ...testCase };
      delete stripped.rubric;
      const text = JSON.stringify(stripped);
      for (const marker of forbidden) {
        assert.equal(text.includes(marker), false, `case must not contain ${marker}: ${text.substring(0, 120)}`);
      }
      assert.match(testCase.caseId, /^[0-9a-f]{64}$/);
    }
    const mapping = JSON.parse(readFileSync(exported.mappingPath, "utf8"));
    assert.equal(mapping.entries.length, 20);
    assert.match(mapping.mappingDigest, /^[0-9a-f]{64}$/);
    // Import: valid scores freeze one quality score per attempt.
    const scores = caseLines.map((testCase, index) => ({ caseId: testCase.caseId, score: 3 + (index % 3) }));
    const imported = providerStudyJudgeImport({ runsRoot, phase: "development", scores, mappingDigest: mapping.mappingDigest });
    assert.equal(imported.imported, 20);
    const attemptDir = join(runsRoot, "development", "attempts", "task-01", "none", "attempt-001");
    const quality = JSON.parse(readFileSync(join(attemptDir, "quality.json"), "utf8"));
    assert.equal(typeof quality.qualityScore, "number");
    assert.equal(quality.frozen, true);
    // Re-import refuses to overwrite the frozen score.
    assert.throws(
      () => providerStudyJudgeImport({ runsRoot, phase: "development", scores, mappingDigest: mapping.mappingDigest }),
           /refusing to overwrite/,
    );
    // An unknown case id is refused.
    assert.throws(
      () => providerStudyJudgeImport({
        runsRoot,
        phase: "development",
        scores: [{ caseId: "0".repeat(64), score: 1 }, ...scores.filter((_, index) => index > 0)],
        mappingDigest: mapping.mappingDigest,
      }),
      /unknown case/,
    );
    // A wrong mapping digest is refused.
    assert.throws(
      () => providerStudyJudgeImport({ runsRoot, phase: "development", scores, mappingDigest: "1".repeat(64) }),
      /mapping digest/,
    );
  } finally {
    rmSync(runsRoot, { recursive: true, force: true });
  }
});
