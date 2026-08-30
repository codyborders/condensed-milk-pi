/**
 * Provider-study real judge execution (grown test-first).
 *
 * Fake-only: a loopback fake judge upstream answers every case with a
 * JSON score. The judge uses a separate proxy, a frozen rubric, an
 * anonymous seeded order, and a private usage ledger; judge usage never
 * enters the plugin attempt totals.
 */

import { test } from "node:test";
import assert from "node:assert/strict";
import { existsSync, mkdtempSync, readFileSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { fileURLToPath } from "node:url";
import http from "node:http";
import { providerStudyCli } from "../runner/cli.mjs";
import { writeCredentialSource, SENTINEL_KEY } from "../../tests/real-attempt-fakes.mjs";

const repoRoot = join(fileURLToPath(import.meta.url), "..", "..", "..", "..");

/** Loopback fake judge upstream: one JSON score per request. */
function startFakeJudgeUpstream({ failFirstCount = 0 } = {}) {
  const seen = [];
  const server = http.createServer((req, res) => {
    let body = "";
    req.on("data", (chunk) => {
      body += chunk;
    });
    req.on("end", () => {
      seen.push({ url: req.url, headers: req.headers, body });
      if (seen.length <= failFirstCount) {
        res.writeHead(503, { "content-type": "application/json" });
        res.end(JSON.stringify({ error: "transient judge failure" }));
        return;
      }
      if (req.method !== "POST" || req.url !== "/v1/messages") {
        res.writeHead(404, { "content-type": "application/json" });
        res.end(JSON.stringify({ error: "not the messages endpoint" }));
        return;
      }
      res.writeHead(200, { "content-type": "application/json" });
      res.end(JSON.stringify({
        content: [{ type: "text", text: '{"score": 4, "rationale": "meets the rubric"}' }],
        usage: { input: 4200, output: 96, cacheRead: 1100, cacheWrite: 60 },
      }));
    });
  });
  return new Promise((resolve) => {
    server.listen(0, "127.0.0.1", () => {
      resolve({
        port: server.address().port,
        seen,
        close: () => new Promise((done) => server.close(() => done())),
      });
    });
  });
}

test("an incomplete judge run seals no scores and can retry the frozen schedule", { timeout: 240_000 }, async () => {
  const work = mkdtempSync(join(tmpdir(), "cm-ps-judge-retry-"));
  const upstream = await startFakeJudgeUpstream({ failFirstCount: 3 });
  try {
    const runsRoot = join(work, "runs");
    const credentialSource = join(work, "models.json");
    writeCredentialSource(credentialSource, `http://127.0.0.1:${upstream.port}`);
    await providerStudyCli(["dry-run", "--phase", "development", "--task", "task-01", "--runs-root", runsRoot], { repoRoot });
    await providerStudyCli(["judge-export", "--phase", "development", "--runs-root", runsRoot], { repoRoot });
    const args = [
      "judge-run", "--phase", "development", "--runs-root", runsRoot,
      "--confirm-paid", "--credential-source", credentialSource,
    ];
    const first = await providerStudyCli(args, { repoRoot });
    assert.notEqual(first.code, 0);
    assert.equal(existsSync(join(runsRoot, "development", "judge", "scores.jsonl")), false);
    assert.equal(existsSync(join(runsRoot, "development", "judge", "judge-run.json")), false);
    const second = await providerStudyCli(args, { repoRoot });
    assert.equal(second.code, 0, second.stderr);
    assert.equal(JSON.parse(second.stdout).judged, 20);
    assert.equal(existsSync(join(runsRoot, "development", "judge", "scores.jsonl")), true);
  } finally {
    await upstream.close();
    rmSync(work, { recursive: true, force: true });
  }
});

test("judge-run scores every case through a separate proxy and keeps judge usage out of attempt totals", { timeout: 240_000 }, async () => {
  const work = mkdtempSync(join(tmpdir(), "cm-ps-judge-run-"));
  const upstream = await startFakeJudgeUpstream();
  try {
    const runsRoot = join(work, "runs");
    const credentialSource = join(work, "models.json");
    writeCredentialSource(credentialSource, `http://127.0.0.1:${upstream.port}`);
    const dry = await providerStudyCli(["dry-run", "--phase", "development", "--task", "task-01", "--runs-root", runsRoot], { repoRoot });
    assert.equal(dry.code, 0, dry.stderr);
    const exported = await providerStudyCli(["judge-export", "--phase", "development", "--runs-root", runsRoot], { repoRoot });
    assert.equal(JSON.parse(exported.stdout).caseCount, 20);

    const run = await providerStudyCli(
      [
        "judge-run", "--phase", "development", "--runs-root", runsRoot,
        "--confirm-paid", "--credential-source", credentialSource,
      ],
      { repoRoot },
    );
    assert.equal(run.code, 0, run.stderr);
    const body = JSON.parse(run.stdout);
    assert.equal(body.judged, 20, `every case judged once: ${JSON.stringify(body).substring(0, 200)}`);
    assert.equal(body.failed, 0);
    assert.match(body.rubricSha256, /^[0-9a-f]{64}$/);
    assert.equal(new Set(body.order).size, 20, "the anonymous order is a permutation of every case");
    assert.equal(upstream.seen.length, 20);
    for (const seen of upstream.seen) {
      assert.equal(seen.headers["x-api-key"], SENTINEL_KEY);
      assert.ok(seen.body.includes("TASK PROMPT"), "the judge request carries the task prompt");
      assert.ok(seen.body.includes("FINAL CHANGED FILES"), "the judge request carries the changed files");
      assert.ok(seen.body.includes("def median"), "the judge request carries complete changed-file bytes");
    }
    const scoreLines = readFileSync(join(runsRoot, "development", "judge", "scores.jsonl"), "utf8").trim().split("\n").map((line) => JSON.parse(line));
    assert.equal(scoreLines.length, 20);
    for (const score of scoreLines) {
      assert.equal(score.score, 4);
    }
    const ledger = readFileSync(join(runsRoot, "development", "judge", "judge-usage-ledger.jsonl"), "utf8").trim().split("\n").map((line) => JSON.parse(line));
    assert.equal(ledger.length, 20);
    const result = JSON.parse(readFileSync(join(runsRoot, "development", "attempts", "task-01", "none", "attempt-001", "result.json"), "utf8"));
    assert.equal(result.usage.input < 4200, true, "attempt usage never includes judge usage");
    assert.equal(existsSync(join(runsRoot, "development", "attempts", "task-01", "none", "attempt-001", "quality.json")), false, "judge-run alone imports nothing");

    // Import through the CLI freezes one score per attempt, exactly once.
    const imported = await providerStudyCli(["judge-import", "--phase", "development", "--runs-root", runsRoot], { repoRoot });
    assert.equal(imported.code, 0, imported.stderr);
    assert.equal(JSON.parse(imported.stdout).imported, 20);
    const quality = JSON.parse(readFileSync(join(runsRoot, "development", "attempts", "task-01", "none", "attempt-001", "quality.json"), "utf8"));
    assert.equal(quality.qualityScore, 4);
    assert.equal(quality.frozen, true);
    const again = await providerStudyCli(["judge-import", "--phase", "development", "--runs-root", runsRoot], { repoRoot });
    assert.notEqual(again.code, 0);
    assert.match(again.stderr, /already imported|refusing to overwrite/);

    // A second judge-run never re-judges: the scores file is frozen.
    const second = await providerStudyCli(
      [
        "judge-run", "--phase", "development", "--runs-root", runsRoot,
        "--confirm-paid", "--credential-source", credentialSource,
      ],
      { repoRoot },
    );
    assert.notEqual(second.code, 0);
    assert.match(second.stderr, /already|frozen|once/);
    assert.equal(upstream.seen.length, 20, "no additional judge request after the frozen run");
  } finally {
    await upstream.close();
    rmSync(work, { recursive: true, force: true });
  }
});
