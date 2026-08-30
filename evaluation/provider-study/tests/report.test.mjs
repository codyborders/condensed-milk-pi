/**
 * Provider-study sanitized report (grown test-first).
 *
 * Reports contain only allowlisted row fields and aggregate statistics
 * over matched complete blocks. Judge quality scores attach per attempt
 * but judge provider usage never enters token totals. Reports land in
 * new files under evaluation/results/provider-study and an existing
 * report file is never overwritten.
 */

import { test } from "node:test";
import assert from "node:assert/strict";
import { existsSync, mkdirSync, readFileSync, rmSync } from "node:fs";
import { join } from "node:path";
import { tmpdir } from "node:os";
import { fileURLToPath } from "node:url";
import { providerStudyDryRun } from "../runner/study.mjs";
import { providerStudyReport, PROVIDER_STUDY_ROW_FIELDS } from "../runner/report.mjs";

const repoRoot = join(fileURLToPath(import.meta.url), "..", "..", "..", "..");
const resultsRoot = join(repoRoot, "evaluation", "results", "provider-study");

function freshRunsRoot() {
  const dir = join(tmpdir(), `provider-study-report-${process.pid}-${Date.now()}-${Math.floor(Math.random() * 1e6)}`);
  mkdirSync(dir, { recursive: true });
  return dir;
}

test("report writes sanitized rows with complete-block statistics and never overwrites", async () => {
  const runsRoot = freshRunsRoot();
  const label = `test-${Date.now()}`;
  try {
    await providerStudyDryRun({ repoRoot, runsRoot, phase: "development", taskIds: ["task-01"] });
    const report = providerStudyReport({ repoRoot, runsRoot, phase: "development", label });
    assert.ok(existsSync(report.jsonPath));
    assert.ok(report.jsonPath.startsWith(resultsRoot), "reports must land under evaluation/results/provider-study");
    const body = JSON.parse(readFileSync(report.jsonPath, "utf8"));
    assert.equal(body.rows.length, 20);
    for (const row of body.rows) {
      for (const field of Object.keys(row)) {
        assert.ok(PROVIDER_STUDY_ROW_FIELDS.includes(field), `${field} is not an allowlisted row field`);
      }
      assert.ok(["none", "upstream", "remediated-defaults", "remediated-archive"].includes(row.arm));
      assert.equal(typeof row.totalProviderTokens, "number");
    }
    assert.equal(body.statistics.completeBlocks, 5);
    assert.equal(typeof body.statistics.fiveToTen.extensionRequired, "boolean");
    assert.equal(typeof body.statistics.primary.meanPairedChange, "number");
    assert.ok(body.statistics.primary.n > 0);
    assert.equal(typeof body.statistics.primaryConclusion.conclusive, "boolean");
    assert.equal(body.judgeUsageIncludedInTotals, false);
    assert.deepEqual(Object.keys(body.summaries.byArm).sort(), ["none", "remediated-archive", "remediated-defaults", "upstream"]);
    assert.equal(body.summaries.byArm.upstream.attempts, 5);
    assert.equal(body.summaries.byArm.upstream.successes, 5);
    assert.equal(body.summaries.byArm.upstream.successRate, 1);
    assert.equal(typeof body.summaries.byArm.upstream.successful.totalProviderTokens.mean, "number");
    assert.equal(typeof body.summaries.byArm.upstream.successful.tokenCategories.input.sum, "number");
    assert.equal(typeof body.summaries.byArm.upstream.successful.wallTimeMs.mean, "number");
    assert.equal(typeof body.summaries.byArm.upstream.successful.shellReruns.mean, "number");
    assert.equal(typeof body.summaries.byTask["task-01"].arms.upstream.successRate, "number");
    assert.equal(typeof body.comparisons["remediated-defaults-vs-upstream"].totalProviderTokens.meanPairedChange, "number");
    assert.equal(typeof body.comparisons["remediated-defaults-vs-upstream"].totalProviderTokens.meanPairedPercentChange, "number");
    assert.equal(typeof body.comparisons["remediated-defaults-vs-upstream"].wallTimeMs.meanPairedChange, "number");
    assert.equal(typeof body.comparisons["remediated-defaults-vs-upstream"].shellReruns.meanPairedChange, "number");
    assert.ok(Array.isArray(body.failures));
    for (const row of body.rows) {
      assert.equal(typeof row.proxyRequestCount, "number", "proxy request count is reported");
      assert.equal(typeof row.proxyFailedRequestCount, "number", "failed proxy requests are reported");
      assert.equal(typeof row.proxyRejectedCount, "number", "rejected proxy requests are reported");
      assert.equal(typeof row.assistantCompletions, "number", "assistant completions stay separate");
      assert.equal(row.providerTrafficAnomaly, false, "consistent dry-run counts carry no anomaly");
      assert.deepEqual(row.proxyStatusCounts, { "200": row.modelRequests });
    }
    // A second report with the same label refuses to overwrite.
    assert.throws(
      () => providerStudyReport({ repoRoot, runsRoot, phase: "development", label }),
      /refusing to overwrite/,
    );
  } finally {
    rmSync(join(resultsRoot, `development-${label}.json`), { force: true });
    rmSync(join(resultsRoot, `development-${label}.md`), { force: true });
    rmSync(runsRoot, { recursive: true, force: true });
  }
});
