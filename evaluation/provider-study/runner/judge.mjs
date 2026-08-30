/**
 * Provider-study blinded judging.
 *
 * Exported cases carry no arm identity, token counts, timing,
 * transcripts, archive markers, model identity, or run order: each case
 * is an opaque id, the task prompt, and a sanitized final-state tree.
 * The arm mapping lives beside the cases under a separate mapping
 * digest; the import validates that digest before writing anything.
 * One frozen quality score lands per attempt and never overwrites an
 * existing one. Judge provider usage is ledgered separately and never
 * enters the plugin totals.
 */

import { closeSync, existsSync, fsyncSync, mkdirSync, openSync, readFileSync, readdirSync, renameSync, statSync, unlinkSync, writeFileSync, writeSync } from "node:fs";
import { createHash, randomBytes } from "node:crypto";
import { join } from "node:path";
import http from "node:http";
import { loadProviderStudyManifestFile } from "./manifest.mjs";
import { providerStudySchedule, providerStudyPlannedBlocks } from "./schedule.mjs";
import { providerStudyReadCompletedResult, providerStudySlotPath } from "./reserve.mjs";
import { providerStudyRejectInsideRepo, providerStudyFreezeMatchesPath } from "./paid.mjs";
import { withHoldoutTasks } from "./holdout.mjs";
import { fixturesCacheRoot, publishFixtureCache } from "../../lib/cache.mjs";
import { loadProviderCredential, startCredentialProxy } from "../../runner/real-credentials.mjs";
import { gitStateHash, hashTree } from "../../lib/fixtures.mjs";

const ARMS = ["none", "upstream", "remediated-defaults", "remediated-archive"];

/**
 * Documented judge-case content bounds. A case may carry complete file
 * bytes only while every file stays under the per-file cap and the
 * whole case payload stays under the total cap. Oversize cases are
 * rejected with an error naming the case and the bound; content is
 * never silently reduced to a hash.
 */
export const PROVIDER_STUDY_JUDGE_CASE_LIMITS = Object.freeze({
  maxFileBytes: 256 * 1024,
  maxCaseBytes: 2 * 1024 * 1024,
});

function sha256Text(text) {
  return createHash("sha256").update(text, "utf8").digest("hex");
}

function readJsonOrNull(path) {
  if (!existsSync(path)) return null;
  try {
    return JSON.parse(readFileSync(path, "utf8"));
  } catch {
    return null;
  }
}

/** Resolve the fixture base directory for a task in one phase. */
function fixtureBaseDirFor(repoRoot, phase, task, privateDir = null) {
  const cacheRoot = phase === "development" ? fixturesCacheRoot(repoRoot) : join(privateDir, "fixtures");
  const entry = join(cacheRoot, task.id);
  if (existsSync(join(entry, ".git"))) return entry;
  return publishFixtureCache({ repoRoot, task, cacheRoot });
}

function walkFiles(root, prefix = "") {
  const files = new Map();
  if (!existsSync(root)) return files;
  for (const entry of readdirSync(root, { withFileTypes: true })) {
    const path = join(root, entry.name);
    const relative = prefix.length === 0 ? entry.name : `${prefix}/${entry.name}`;
    if (entry.isDirectory()) {
      if (entry.name === ".git" || (prefix.length === 0 && entry.name === "implementation")) continue;
      for (const [nested, bytes] of walkFiles(path, relative)) files.set(nested, bytes);
      continue;
    }
    if (!entry.isFile()) continue;
    const info = statSync(path);
    if (!info.isFile()) continue;
    files.set(relative, readFileSync(path));
  }
  return files;
}

/**
 * Anonymous per-case file evidence: every path whose bytes differ from
 * the fixture base, with complete final bytes (null for deletions),
 * the initial bytes for modified and deleted paths, and digests. Bound
 * violations reject the case instead of silently hashing content.
 */
export function providerStudyJudgeCaseFiles({ caseId, worktree, baseDir }) {
  const base = walkFiles(baseDir);
  const final = walkFiles(worktree);
  const initialFiles = [];
  const finalChangedFiles = [];
  let totalBytes = 0;
  const takeBytes = (buffer, path, kind) => {
    if (buffer === null) return null;
    if (buffer.length > PROVIDER_STUDY_JUDGE_CASE_LIMITS.maxFileBytes) {
      throw new Error(
        `judge case ${caseId} rejects file ${path}: ${kind} bytes ${buffer.length} exceed the documented per-file bound ${PROVIDER_STUDY_JUDGE_CASE_LIMITS.maxFileBytes}`,
      );
    }
    totalBytes += buffer.length;
    if (totalBytes > PROVIDER_STUDY_JUDGE_CASE_LIMITS.maxCaseBytes) {
      throw new Error(
        `judge case ${caseId} exceeds the documented total case bound ${PROVIDER_STUDY_JUDGE_CASE_LIMITS.maxCaseBytes}; refusing to export partial content`,
      );
    }
    return buffer.toString("hex");
  };
  for (const [path, buffer] of final) {
    const baseBuffer = base.get(path);
    if (baseBuffer !== undefined && baseBuffer.equals(buffer)) continue;
    const change = baseBuffer === undefined ? "added" : "modified";
    finalChangedFiles.push({
      path,
      change,
      sha256: createHash("sha256").update(buffer).digest("hex"),
      bytesHex: takeBytes(buffer, path, "final"),
    });
    if (baseBuffer !== undefined) {
      initialFiles.push({
        path,
        sha256: createHash("sha256").update(baseBuffer).digest("hex"),
        bytesHex: takeBytes(baseBuffer, path, "initial"),
      });
    }
  }
  for (const [path, baseBuffer] of base) {
    if (final.has(path)) continue;
    finalChangedFiles.push({ path, change: "deleted", sha256: null, bytesHex: null });
    initialFiles.push({
      path,
      sha256: createHash("sha256").update(baseBuffer).digest("hex"),
      bytesHex: takeBytes(baseBuffer, path, "initial"),
    });
  }
  initialFiles.sort((left, right) => left.path.localeCompare(right.path));
  finalChangedFiles.sort((left, right) => left.path.localeCompare(right.path));
  return { initialFiles, finalChangedFiles };
}

/** Prompt text for a task in one phase (holdout manifests carry prompts). */
function promptFor(repoRoot, phase, taskId, privateTasks = null) {
  if (phase === "holdout") return privateTasks?.get(taskId)?.prompt ?? null;
  const loaded = loadProviderStudyManifestFile(repoRoot, { phase });
  const task = loaded.tasks.find((entry) => entry.id === taskId);
  if (typeof task?.prompt === "string") return task.prompt;
  const general = JSON.parse(readFileSync(join(repoRoot, "evaluation", "task-manifest.json"), "utf8"));
  const generalTask = general.tasks.find((entry) => entry.id === taskId);
  return generalTask?.prompt ?? null;
}

/**
 * Export anonymous judge cases for one phase. The case body holds the
 * opaque case id, the task prompt, and a sanitized final tree (relative
 * paths plus digests) — never arm identity, tokens, timing, transcripts,
 * archive markers, model, or run order.
 */
export async function providerStudyJudgeExport({
  repoRoot,
  runsRoot,
  phase,
  keySourcePath = null,
  privateTasks = null,
  privateDir = null,
}) {
  const loaded = loadProviderStudyManifestFile(repoRoot, { phase });
  if (phase === "holdout" && privateTasks === null) {
    return withHoldoutTasks({
      repoRoot,
      runsRoot,
      command: "judge-export",
      keySourcePath,
      taskIds: loaded.tasks.map((task) => task.id),
      fn: ({ tasks, privateDir: openedDir }) => providerStudyJudgeExport({
        repoRoot,
        runsRoot,
        phase,
        keySourcePath,
        privateTasks: tasks,
        privateDir: openedDir,
      }),
    });
  }
  const schedule = providerStudySchedule(repoRoot, phase);
  const judgeRoot = join(runsRoot, phase, "judge");
  mkdirSync(judgeRoot, { recursive: true });
  const cases = [];
  const entries = [];
  const judgeTasks = phase === "holdout"
    ? loaded.tasks.map((task) => privateTasks.get(task.id))
    : loaded.tasks;
  for (const task of judgeTasks) {
    const taskSchedule = schedule.tasks.find((entry) => entry.taskId === task.id);
    for (const block of providerStudyPlannedBlocks(taskSchedule)) {
      for (const arm of block.arms) {
        const attemptDir = providerStudySlotPath(runsRoot, phase, task.id, arm, block.rep);
        const result = providerStudyReadCompletedResult(attemptDir);
        if (result?.status !== "completed") continue;
        const caseId = randomBytes(32).toString("hex");
        const worktree = join(attemptDir, "worktree");
        const tree = existsSync(worktree)
          ? { contentSha256: hashTree(worktree), gitStateSha256: gitStateHash(worktree) }
          : null;
        const files = tree === null
          ? { initialFiles: [], finalChangedFiles: [] }
          : providerStudyJudgeCaseFiles({
              caseId,
              worktree,
              baseDir: fixtureBaseDirFor(repoRoot, phase, task, privateDir),
            });
        cases.push({
          schemaVersion: 1,
          caseId,
          taskId: task.id,
          prompt: promptFor(repoRoot, phase, task.id, privateTasks),
          rubric: PROVIDER_STUDY_JUDGE_RUBRIC,
          initialFiles: files.initialFiles,
          finalChangedFiles: files.finalChangedFiles,
          finalTree: tree,
        });
        entries.push({ caseId, taskId: task.id, arm, rep: block.rep });
      }
    }
  }
  const mapping = {
    schemaVersion: 1,
    study: "provider-study",
    phase,
    entries,
    mappingDigest: "",
  };
  mapping.mappingDigest = sha256Text(JSON.stringify(entries.map((entry) => [entry.caseId, entry.taskId, entry.arm, entry.rep])));
  const casesPath = join(judgeRoot, "cases.jsonl");
  const mappingPath = join(judgeRoot, "case-mapping.json");
  writeAppendNew(casesPath, `${cases.map((testCase) => JSON.stringify(testCase)).join("\n")}\n`);
  writeAppendNew(mappingPath, `${JSON.stringify(mapping, null, 2)}\n`);
  return { casesPath, mappingPath, caseCount: cases.length, mappingDigest: mapping.mappingDigest };
}

/** Write a file only when it does not already exist. */
function writeAppendNew(path, text) {
  const fd = openSync(path, "wx");
  try {
    writeSync(fd, text, "utf8");
    fsyncSync(fd);
  } finally {
    closeSync(fd);
  }
}

/**
 * Import judge scores: the mapping digest must match the exported
 * mapping, every case id must be known, and each attempt receives one
 * frozen quality score that is never overwritten.
 */
export function providerStudyJudgeImport({ runsRoot, phase, scores, mappingDigest }) {
  const mappingPath = join(runsRoot, phase, "judge", "case-mapping.json");
  const mapping = readJsonOrNull(mappingPath);
  if (!mapping) throw new Error(`judge mapping is missing at ${mappingPath}`);
  if (mapping.mappingDigest !== mappingDigest) {
    throw new Error("mapping digest mismatch: refusing to import scores against a different export");
  }
  if (!Array.isArray(mapping.entries) || !Array.isArray(scores)) {
    throw new Error("judge import needs mapping entries and scores arrays");
  }
  const byCase = new Map();
  for (const entry of mapping.entries) {
    if (byCase.has(entry.caseId)) throw new Error(`duplicate case id ${entry.caseId} in judge mapping`);
    byCase.set(entry.caseId, entry);
  }
  if (scores.length !== byCase.size) {
    throw new Error(`judge score coverage must be exact: expected ${byCase.size}, received ${scores.length}`);
  }
  const seen = new Set();
  const plans = [];
  for (const score of scores) {
    const entry = byCase.get(score.caseId);
    if (!entry) throw new Error(`unknown case id ${score.caseId}; refusing the whole import`);
    if (seen.has(score.caseId)) throw new Error(`duplicate judge score for case ${score.caseId}`);
    seen.add(score.caseId);
    if (typeof score.score !== "number" || !Number.isFinite(score.score) || score.score < 0 || score.score > 5) {
      throw new Error(`case ${score.caseId} score must be a finite number in [0, 5]`);
    }
    const attemptDir = providerStudySlotPath(runsRoot, phase, entry.taskId, entry.arm, entry.rep);
    const qualityPath = join(attemptDir, "quality.json");
    const temporaryPath = `${qualityPath}.tmp-import-${process.pid}`;
    if (existsSync(qualityPath) || existsSync(temporaryPath)) {
      throw new Error(`refusing to overwrite the frozen quality score at ${qualityPath}`);
    }
    plans.push({
      qualityPath,
      temporaryPath,
      bytes: `${JSON.stringify({
        schemaVersion: 1,
        study: "provider-study",
        phase,
        taskId: entry.taskId,
        arm: entry.arm,
        rep: entry.rep,
        qualityScore: score.score,
        frozen: true,
        source: "blinded-judge",
      }, null, 2)}\n`,
    });
  }
  const staged = [];
  const committed = [];
  try {
    for (const plan of plans) {
      writeAppendNew(plan.temporaryPath, plan.bytes);
      staged.push(plan.temporaryPath);
    }
    for (const plan of plans) {
      renameSync(plan.temporaryPath, plan.qualityPath);
      committed.push(plan.qualityPath);
    }
  } catch (error) {
    for (const path of staged) {
      try { if (existsSync(path)) unlinkSync(path); } catch { /* best effort rollback */ }
    }
    for (const path of committed) {
      try { if (existsSync(path)) unlinkSync(path); } catch { /* best effort rollback */ }
    }
    throw error;
  }
  return { imported: plans.length, mappingDigest };
}

/**
 * Judge provider usage ledger: judge runs record their usage separately
 * so report totals for the plugin arms never include judge spending.
 */
export function providerStudyJudgeUsageLedgerPath(runsRoot, phase) {
  return join(runsRoot, phase, "judge", "judge-usage-ledger.jsonl");
}

export function appendJudgeUsage(runsRoot, phase, entry) {
  const path = providerStudyJudgeUsageLedgerPath(runsRoot, phase);
  mkdirSync(join(path, ".."), { recursive: true });
  const fd = openSync(path, "a");
  try {
    writeSync(fd, `${JSON.stringify({ schemaVersion: 1, ...entry })}\n`, "utf8");
    fsyncSync(fd);
  } finally {
    closeSync(fd);
  }
}

/** List judge score files for one phase (used by reports). */
export function judgeQualityFiles(runsRoot, phase) {
  const root = join(runsRoot, phase, "attempts");
  if (!existsSync(root)) return [];
  const files = [];
  for (const taskId of readdirSync(root)) {
    for (const arm of ARMS) {
      const armRoot = join(root, taskId, arm);
      if (!existsSync(armRoot)) continue;
      for (const slot of readdirSync(armRoot)) {
        const quality = join(armRoot, slot, "quality.json");
        if (existsSync(quality)) files.push(quality);
      }
    }
  }
  return files;
}

/** The frozen judge rubric bytes. */
export const PROVIDER_STUDY_JUDGE_RUBRIC = `You are a blinded quality judge for a software-engineering study.
You see one task prompt and the final state of one anonymous attempt.
Score the attempt from 0 to 5 against this rubric:
5 = fully correct, complete, clean final state.
4 = correct core outcome with minor gaps.
3 = partial progress, main goal unclear or incomplete.
2 = substantial errors or missing artifacts.
1 = barely started or wholly wrong.
0 = no relevant work.
Answer with exactly one JSON object: {"score": <0-5>, "rationale": "<one sentence>"}.
Do not mention any identity, model, or tokens.
`;

/** Digest of the frozen rubric bytes. */
export function providerStudyJudgeRubricSha256() {
  return sha256Text(PROVIDER_STUDY_JUDGE_RUBRIC);
}

/** Anonymous seeded order: a deterministic shuffle of the case ids. */
export function providerStudyJudgeOrder(caseIds, seed) {
  const random = seededRandom(`provider-study:judge:${seed}`);
  const order = [...caseIds];
  for (let index = order.length - 1; index > 0; index -= 1) {
    const swap = Math.floor(random() * (index + 1));
    [order[index], order[swap]] = [order[swap], order[index]];
  }
  return order;
}

function seededRandom(seedText) {
  let hash = 2166136261;
  for (let index = 0; index < seedText.length; index += 1) {
    hash ^= seedText.charCodeAt(index);
    hash = Math.imul(hash, 16777619);
  }
  let state = hash >>> 0;
  return function random() {
    state = (state + 0x6d2b79f5) >>> 0;
    let t = state;
    t = Math.imul(t ^ (t >>> 15), t | 1);
    t ^= t + Math.imul(t ^ (t >>> 7), t | 61);
    return ((t ^ (t >>> 14)) >>> 0) / 4294967296;
  };
}

/** Render one file entry for the judge prompt as readable text. */
function judgeFileText(entry) {
  if (entry === null || entry.bytesHex === null || entry.bytesHex === undefined) return "(no bytes)";
  return Buffer.from(entry.bytesHex, "hex").toString("utf8");
}

/**
 * Build the judge request body for one case: the frozen rubric, the
 * anonymous task prompt, the initial relevant bytes, and the complete
 * final changed-file bytes. No arm, token, timing, transcript, archive,
 * run-order, commit, or provider identity ever enters this prompt.
 */
export function providerStudyJudgePrompt(entry) {
  const initial = (entry.initialFiles ?? [])
    .map((file) => `--- ${file.path} ---\n${judgeFileText(file)}`)
    .join("\n\n");
  const changed = (entry.finalChangedFiles ?? [])
    .map((file) => `--- ${file.path} (${file.change}) ---\n${file.change === "deleted" ? "(file deleted)" : judgeFileText(file)}`)
    .join("\n\n");
  return [
    PROVIDER_STUDY_JUDGE_RUBRIC,
    "TASK PROMPT:",
    entry.prompt ?? "",
    "",
    "INITIAL FILES:",
    initial.length === 0 ? "(unchanged from the fixture)" : initial,
    "",
    "FINAL CHANGED FILES:",
    changed.length === 0 ? "(no changed files)" : changed,
    "",
  ].join("\n");
}

const JUDGE_MAX_RESPONSE_BYTES = 1024 * 1024;

/** One non-streaming judge request through the loopback proxy. */
function judgeRequest({ proxyBaseUrl, dummyApiKey, model, prompt, timeoutMs }) {
  return new Promise((resolve) => {
    const body = JSON.stringify({ model, max_tokens: 1024, stream: false, messages: [{ role: "user", content: prompt }] });
    const request = http.request(
      new URL(`${proxyBaseUrl}/v1/messages`),
      {
        method: "POST",
        headers: { "content-type": "application/json", "x-api-key": dummyApiKey, accept: "application/json" },
      },
      (response) => {
        const chunks = [];
        let bytes = 0;
        response.on("data", (chunk) => {
          bytes += chunk.length;
          if (bytes > JUDGE_MAX_RESPONSE_BYTES) {
            request.destroy(new Error("judge response exceeds the bound"));
            return;
          }
          chunks.push(chunk);
        });
        response.on("end", () => {
          let parsed = null;
          try {
            parsed = JSON.parse(Buffer.concat(chunks).toString("utf8"));
          } catch {
            resolve({ error: `judge response is not JSON (status ${response.statusCode})` });
            return;
          }
          resolve({ status: response.statusCode, body: parsed });
        });
        response.on("error", (error) => resolve({ error: error.message }));
      },
    );
    request.setTimeout(timeoutMs, () => request.destroy(new Error("judge request timeout")));
    request.on("error", (error) => resolve({ error: error.message }));
    request.end(body);
  });
}

/** Parse one judge answer into a validated score. */
function scoreFromJudgeBody(body) {
  const text = Array.isArray(body?.content)
    ? body.content.find((block) => block?.type === "text")?.text ?? null
    : null;
  if (typeof text !== "string") return { error: "judge answer carries no text block" };
  const match = /\{[^{}]*"score"\s*:\s*([0-9]+(?:\.[0-9]+)?)[^{}]*\}/.exec(text);
  if (!match) return { error: "judge answer carries no JSON score object" };
  const score = Number(match[1]);
  if (!Number.isFinite(score) || score < 0 || score > 5) return { error: "judge score is outside [0, 5]" };
  return { score };
}

/**
 * Real judge execution: one request per exported case, in the frozen
 * anonymous order, through a separate loopback proxy with its own
 * dummy key. Every case is asked exactly once (no paid retry); usage
 * lands only in the private judge ledger and never in the plugin
 * attempt totals. The scores file is written once and never replaced.
 */
export async function providerStudyJudgeRun({ repoRoot, runsRoot = null, phase, flags = {} }) {
  if (flags["--confirm-paid"] !== true) {
    throw new Error("judge-run needs --confirm-paid; refusing before any request");
  }
  const { providerStudyRunsRoot } = await import("./study.mjs");
  const root = runsRoot ?? (typeof flags["--runs-root"] === "string" ? flags["--runs-root"] : providerStudyRunsRoot());
  providerStudyRejectInsideRepo(root, repoRoot);
  const credentialSourcePath = flags["--credential-source"];
  if (!credentialSourcePath) {
    throw new Error("judge-run needs --credential-source PATH; refusing before any request");
  }
  // Judge execution is paid: it refuses the same way the arm runner
  // does when any frozen input, including the evaluator commit and
  // source digest, changed since the freeze.
  const freezeCheck = providerStudyFreezeMatchesPath(repoRoot, flags);
  if (!freezeCheck.ok) {
    throw new Error(`judge-run refused: ${freezeCheck.problems.join("; ")}`);
  }
  const judgeRoot = join(root, phase, "judge");
  const casesPath = join(judgeRoot, "cases.jsonl");
  const mappingPath = join(judgeRoot, "case-mapping.json");
  const scoresPath = join(judgeRoot, "scores.jsonl");
  if (!existsSync(casesPath) || !existsSync(mappingPath)) {
    throw new Error(`no judge export at ${judgeRoot}; run judge-export first`);
  }
  if (existsSync(scoresPath)) {
    throw new Error(`judge scores already exist at ${scoresPath}; each case is judged exactly once`);
  }
  const manifest = loadProviderStudyManifestFile(repoRoot, { phase });
  const model = manifest.manifest.evaluation.model;
  const cases = readFileSync(casesPath, "utf8").split("\n").filter((line) => line.trim().length > 0).map((line) => JSON.parse(line));
  const mapping = JSON.parse(readFileSync(mappingPath, "utf8"));
  const rubricSha256 = providerStudyJudgeRubricSha256();
  const order = providerStudyJudgeOrder(cases.map((entry) => entry.caseId), mapping.mappingDigest);
  const byCase = new Map(cases.map((entry) => [entry.caseId, entry]));

  const { apiKey, baseUrl } = loadProviderCredential({ sourcePath: credentialSourcePath });
  const { generateDummyApiKey } = await import("../../runner/real-attempt.mjs");
  const dummyApiKey = generateDummyApiKey();
  const proxy = await startCredentialProxy({ upstreamBaseUrl: baseUrl, apiKey, dummyApiKey });
  const results = [];
  const failures = [];
  try {
    for (const caseId of order) {
      const entry = byCase.get(caseId);
      const prompt = providerStudyJudgePrompt(entry);
      const response = await judgeRequest({
        proxyBaseUrl: proxy.baseUrl,
        dummyApiKey,
        model,
        prompt,
        timeoutMs: 120_000,
      });
      if (response.error) {
        failures.push({ caseId, error: response.error });
        continue;
      }
      if (response.status !== 200) {
        failures.push({ caseId, error: `judge upstream status ${response.status}` });
        continue;
      }
      const parsed = scoreFromJudgeBody(response.body);
      if (parsed.error) {
        failures.push({ caseId, error: parsed.error });
        continue;
      }
      appendJudgeUsage(root, phase, { caseId, model, usage: response.body.usage ?? null });
      results.push({ caseId, score: parsed.score });
    }
  } finally {
    await proxy.close();
  }
  if (failures.length > 0 || results.length !== cases.length) {
    const failurePath = join(judgeRoot, "judge-failure-ledger.jsonl");
    const fd = openSync(failurePath, "a");
    try {
      writeSync(fd, `${JSON.stringify({
        schemaVersion: 1,
        study: "provider-study",
        phase,
        attempted: cases.length,
        completed: results.length,
        failures,
        at: new Date().toISOString(),
      })}\n`, "utf8");
      fsyncSync(fd);
    } finally {
      closeSync(fd);
    }
    throw new Error(`judge run incomplete: ${results.length} of ${cases.length} cases produced valid scores`);
  }
  writeAppendNew(scoresPath, `${results.map((result) => JSON.stringify(result)).join("\n")}\n`);
  writeAppendNew(
    join(judgeRoot, "judge-run.json"),
    `${JSON.stringify({ schemaVersion: 1, study: "provider-study", phase, rubricSha256, order, judged: results.length, failed: failures.length, failures, ranAt: new Date().toISOString() }, null, 2)}\n`,
  );
  return { judged: results.length, failed: failures.length, scoresPath, rubricSha256, order };
}

/** Import the frozen judge scores file into per-attempt quality records. */
export function providerStudyJudgeImportFromScores({ runsRoot, phase }) {
  const judgeRoot = join(runsRoot, phase, "judge");
  const scoresPath = join(judgeRoot, "scores.jsonl");
  if (!existsSync(scoresPath)) {
    throw new Error(`no judge scores at ${scoresPath}; run judge-run first`);
  }
  const mapping = JSON.parse(readFileSync(join(judgeRoot, "case-mapping.json"), "utf8"));
  const scores = readFileSync(scoresPath, "utf8").split("\n").filter((line) => line.trim().length > 0).map((line) => JSON.parse(line));
  const markerPath = join(judgeRoot, "imported.json");
  if (existsSync(markerPath)) {
    throw new Error(`judge scores were already imported (see ${markerPath}); each score imports once`);
  }
  const imported = providerStudyJudgeImport({ runsRoot, phase, scores, mappingDigest: mapping.mappingDigest });
  writeAppendNew(markerPath, `${JSON.stringify({ schemaVersion: 1, imported: imported.imported, at: new Date().toISOString() }, null, 2)}\n`);
  return imported;
}
