/**
 * Real attempt execution (module contract; grown test-first).
 *
 * One reserved real attempt builds an opaque task worktree (fixture copy
 * plus the arm's tracked files under implementation/, hidden from the
 * fixture git), starts a parent-owned loopback credential proxy, writes
 * an isolated models.json with a dummy key, spawns the cached Pi CLI
 * exactly once with an allowlisted environment, aggregates usage, runs
 * the hidden scorer, collects the final git state, and persists pins
 * plus the result. The real key never reaches disk, argv, the child
 * environment, artifacts, reports, or error text.
 */

import {
  chmodSync,
  closeSync,
  copyFileSync,
  cpSync,
  existsSync,
  mkdirSync,
  openSync,
  readFileSync,
  readdirSync,
  rmSync,
  statSync,
  writeFileSync,
  writeSync,
} from "node:fs";
import { createHash, randomBytes } from "node:crypto";
import { basename, dirname, isAbsolute, join, relative } from "node:path";
import { fileURLToPath } from "node:url";
import { loadProviderCredential, startCredentialProxy, loadSafeModelTemplate } from "./real-credentials.mjs";
import { runSubprocess } from "./spawn.mjs";
import { scoreWorktree, scorerDefinitionSha256 } from "../lib/scorer.mjs";
import { collectFinalState } from "./collect.mjs";
import { ATTEMPT_PROMPT_FILE, buildAttemptPrompt, sha256Text } from "./prompt.mjs";

export { ATTEMPT_PROMPT_FILE, buildAttemptPrompt };

/** The evaluator source repository root, derived from this module's location. */
const SOURCE_ROOT = join(dirname(fileURLToPath(import.meta.url)), "..", "..");

/**
 * PATH for the Pi child with every entry inside the evaluator source
 * repository removed, so the agent cannot discover the evaluator
 * location through its environment (npm prepends our node_modules/.bin).
 */
function sanitizedPath() {
  const raw = process.env.PATH ?? "/usr/bin:/bin";
  const kept = raw
    .split(":")
    .filter((entry) => entry.length > 0 && !entry.startsWith(SOURCE_ROOT));
  return kept.length > 0 ? kept.join(":") : "/usr/bin:/bin";
}
export const EVAL_PROVIDER_ID = "z-ai-eval";
export const EVAL_MODEL_ID = "glm-5.3-flash";
const EVAL_CONTEXT_WINDOW = 1_000_000;
export const EVAL_MAX_TOKENS = 65_536;

/**
 * The per-attempt dummy key: random per attempt, written only into the
 * isolated models.json (mode 0600) and handed to the loopback proxy as
 * the exact value it must see on x-api-key. Never the real key, never
 * argv, never the environment.
 */
export function generateDummyApiKey() {
  return `eval-${randomBytes(24).toString("hex")}`;
}

/**
 * Model-definition fields copied from the safe template because they
 * carry z-ai compatibility behavior. Cost and credentials are never
 * in this list.
 */
const TEMPLATE_COMPAT_FIELDS = ["thinkingLevelMap", "samplingParams", "compat"];

/**
 * The isolated models.json provider tree for one attempt. The pinned
 * evaluation values (reasoning, text+image input, 1M context window,
 * 65536 maxTokens) are set explicitly; compatibility knobs are copied
 * from the safe glm-5.3 template when present. Cost claims and
 * credentials from the template are never copied: the provider talks
 * to the loopback proxy with the dummy key only.
 */
export function buildEvalProviderModels({ proxyBaseUrl, template = null, dummyApiKey }) {
  if (typeof dummyApiKey !== "string" || dummyApiKey.length === 0) {
    throw new Error("buildEvalProviderModels needs the attempt's generated dummy key; refusing to emit a config");
  }
  const model = {
    id: EVAL_MODEL_ID,
    name: `${EVAL_MODEL_ID} (evaluation)`,
    reasoning: true,
    input: ["text", "image"],
    contextWindow: EVAL_CONTEXT_WINDOW,
    maxTokens: EVAL_MAX_TOKENS,
  };
  if (template && typeof template === "object") {
    for (const field of TEMPLATE_COMPAT_FIELDS) {
      if (template[field] !== undefined) model[field] = structuredClone(template[field]);
    }
  }
  return {
    providers: {
      [EVAL_PROVIDER_ID]: {
        name: "z-ai evaluation proxy",
        baseUrl: proxyBaseUrl,
        api: "anthropic-messages",
        apiKey: dummyApiKey,
        models: [model],
      },
    },
  };
}

export function attemptPaths(attemptDir) {
  return {
    worktree: join(attemptDir, "worktree"),
    implementation: join(attemptDir, "worktree", "implementation"),
    sessions: join(attemptDir, "sessions"),
    home: join(attemptDir, "home"),
    agent: join(attemptDir, "agent"),
    tmp: join(attemptDir, "tmp"),
    agentModels: join(attemptDir, "agent", "models.json"),
    homeConfig: join(attemptDir, "home", ".config", "condensed-milk.json"),
    stdout: join(attemptDir, "pi-stdout.jsonl"),
    stderr: join(attemptDir, "pi-stderr.txt"),
    invocations: join(attemptDir, "invocations.jsonl"),
    proxy: join(attemptDir, "proxy.json"),
    invocation: join(attemptDir, "invocation.json"),
    pinned: join(attemptDir, "pinned.json"),
    result: join(attemptDir, "result.json"),
    scorer: join(attemptDir, "scorer.json"),
    finalState: join(attemptDir, "final-state.json"),
  };
}

/**
 * Build the opaque task worktree and the isolated child directories:
 * fixture copy, arm implementation files, a fixture-git exclude for the
 * evaluator scaffolding, the isolated Condensed Milk config, and the
 * credential-free isolated models.json (mode 0600).
 */
function dependencyFiles(root, prefix = "") {
  const files = [];
  for (const entry of readdirSync(root, { withFileTypes: true })) {
    const relativePath = prefix.length === 0 ? entry.name : `${prefix}/${entry.name}`;
    const path = join(root, entry.name);
    if (entry.isDirectory()) files.push(...dependencyFiles(path, relativePath));
    else if (entry.isFile() && statSync(path).isFile()) files.push(relativePath);
  }
  return files.sort();
}

function dependencyDirectorySha256(root) {
  const files = dependencyFiles(root);
  const hash = createHash("sha256");
  hash.update(`${files.length}\n`);
  for (const relativePath of files) {
    hash.update(`${relativePath}:`);
    hash.update(createHash("sha256").update(readFileSync(join(root, relativePath))).digest("hex"));
    hash.update("\n");
  }
  return hash.digest("hex");
}

export function prepareAttemptWorkspace({ attemptDir, fixtureDir, arm, profile, proxyBaseUrl, template = null, dummyApiKey, study = null }) {
  const paths = attemptPaths(attemptDir);
  mkdirSync(paths.sessions, { recursive: true });
  mkdirSync(paths.tmp, { recursive: true });
  mkdirSync(dirname(paths.homeConfig), { recursive: true });
  mkdirSync(paths.agent, { recursive: true });
  cpSync(fixtureDir, paths.worktree, { recursive: true, dot: true });
  for (const relativePath of arm.tracked) {
    const source = join(arm.path, relativePath);
    const target = join(paths.implementation, relativePath);
    mkdirSync(dirname(target), { recursive: true });
    copyFileSync(source, target);
    chmodSync(target, statSync(source).mode & 0o777);
  }
  for (const dependency of study?.implementationDependencies ?? []) {
    if (
      dependency === null
      || typeof dependency !== "object"
      || typeof dependency.name !== "string"
      || !/^[a-z0-9._-]+$/.test(dependency.name)
      || typeof dependency.sourcePath !== "string"
      || typeof dependency.sha256 !== "string"
      || !/^[0-9a-f]{64}$/.test(dependency.sha256)
      || !existsSync(join(dependency.sourcePath, "package.json"))
    ) {
      throw new Error("study implementation dependency is malformed or unavailable");
    }
    if (dependencyDirectorySha256(dependency.sourcePath) !== dependency.sha256) {
      throw new Error(`study implementation dependency ${dependency.name} differs from its frozen digest`);
    }
    const target = join(paths.implementation, "node_modules", dependency.name);
    mkdirSync(dirname(target), { recursive: true });
    cpSync(dependency.sourcePath, target, { recursive: true, dot: true });
    if (dependencyDirectorySha256(target) !== dependency.sha256) {
      throw new Error(`staged implementation dependency ${dependency.name} differs from its frozen digest`);
    }
  }
  mkdirSync(join(paths.worktree, ".git", "info"), { recursive: true });
  const excludePath = join(paths.worktree, ".git", "info", "exclude");
  const existing = existsSync(excludePath) ? readFileSync(excludePath, "utf8") : "";
  if (!existing.split("\n").includes("/implementation/")) {
    const prefix = existing.length === 0 || existing.endsWith("\n") ? "" : "\n";
    writeFileSync(excludePath, `${existing}${prefix}/implementation/\n`, "utf8");
  }
  if (study?.profileBytes !== undefined) {
    // Study profile bytes are written exactly as provided, never
    // reserialized, and verified against the pinned sha256 first.
    if (
      typeof study.profileBytes !== "string" ||
      typeof study.profileSha256 !== "string" ||
      sha256Text(study.profileBytes) !== study.profileSha256
    ) {
      throw new Error("study profile bytes do not match profileSha256; refusing to write the config");
    }
    writeFileSync(paths.homeConfig, study.profileBytes, "utf8");
  } else {
    writeFileSync(paths.homeConfig, `${JSON.stringify({ schemaVersion: 1, profile }, null, 2)}\n`, "utf8");
  }
  writeFileSync(
    paths.agentModels,
    `${JSON.stringify(buildEvalProviderModels({ proxyBaseUrl, template, dummyApiKey }), null, 2)}\n`,
    { mode: 0o600 },
  );
  return paths;
}

/** Fixed child environment allowlist; nothing else is inherited. */
export const PI_ENV_KEYS = ["PATH", "HOME", "TMPDIR", "PI_CODING_AGENT_DIR"];

/**
 * Study observer configuration (optional): generate() writes the two
 * attempt-local neutral observer extensions before the invocation is
 * planned; extract() returns the attempt's instrumentation after
 * scoring and final collection. The resolved setup must carry both
 * extension paths inside the attempt directory plus the observer and
 * wrapper-config digests. Any failure throws so the orchestrator stops
 * later reservations instead of emitting an uninstrumented attempt.
 */
function validateObserverSetup(setup, attemptDir) {
  if (setup === null || typeof setup !== "object" || Array.isArray(setup)) {
    throw new Error("study observer setup must be an object");
  }
  for (const field of ["preExtensionPath", "postExtensionPath"]) {
    const value = setup[field];
    if (typeof value !== "string" || !value.endsWith(".mjs")) {
      throw new Error(`study observer ${field} must be an .mjs path`);
    }
    if (attemptDir !== null) {
      const contained = relative(attemptDir, value);
      if (contained === "" || contained.startsWith("..") || isAbsolute(contained)) {
        throw new Error("study observer extensions must live inside the attempt directory");
      }
    }
  }
  for (const field of ["observerSha256", "observerWrapperSha256"]) {
    if (typeof setup[field] !== "string" || !/^[0-9a-f]{64}$/.test(setup[field])) {
      throw new Error(`study observer ${field} must be a 64-hex sha256 digest`);
    }
  }
  return {
    preExtensionPath: setup.preExtensionPath,
    postExtensionPath: setup.postExtensionPath,
    observerSha256: setup.observerSha256,
    observerWrapperSha256: setup.observerWrapperSha256,
  };
}

/**
 * Resolve the study observers for one attempt: generate() runs before
 * the invocation is planned (so the extensions exist on disk before
 * the child loads them) and its setup is validated and merged into the
 * study the invocation planner sees. Returns the study unchanged when
 * no observers are configured.
 */
function studyForInvocation(attemptDir, study) {
  if (!study?.observers) return study;
  if (typeof study.observers.generate !== "function" || typeof study.observers.extract !== "function") {
    throw new Error("study.observers needs generate() and extract() functions");
  }
  const setup = validateObserverSetup(study.observers.generate({ attemptDir }), attemptDir);
  return { ...study, observers: { ...study.observers, ...setup } };
}

/**
 * Plan the one Pi invocation for an attempt: exact argv, an allowlisted
 * environment, the combined prompt hash, the pinned metadata, and the
 * artifact paths. Pure: no spawn, no credential, no evaluator path
 * beyond the opaque attempt tree, and no key material (the dummy key
 * lives only in the prepared models.json). The prompt is the exact
 * combined attempt prompt (checked-in rules plus task text) and its
 * SHA-256 covers that whole string. Study observers force the argv
 * extension order [pre, arm implementation, post].
 */
export function planRealInvocation({ paths, manifest, task, arm, piCliPath, nodePath = process.execPath, study = null }) {
  const evaluation = manifest.evaluation;
  const extensionPath = join(paths.implementation, "index.ts");
  const prompt = buildAttemptPrompt(task.prompt);
  const promptSha256 = sha256Text(prompt);
  const scorerSha256 = study?.scorerSha256 ?? scorerDefinitionSha256(SOURCE_ROOT, task.id);
  // Ordered study extension paths replace the single standard -e flag.
  // The order is preserved exactly as given. Resolved study observers
  // wrap the loaded list as [pre observer, extensions, post observer].
  const observers = study?.observers ? validateObserverSetup(study.observers, null) : null;
  let extensionArgs;
  if (observers) {
    const loaded = study?.extensionPaths && study.extensionPaths.length > 0
      ? study.extensionPaths
      : [extensionPath];
    extensionArgs = [
      "-e", observers.preExtensionPath,
      ...loaded.flatMap((extension) => ["-e", extension]),
      "-e", observers.postExtensionPath,
    ];
  } else if (study?.extensionPaths && study.extensionPaths.length > 0) {
    extensionArgs = study.extensionPaths.flatMap((extension) => ["-e", extension]);
  } else {
    extensionArgs = ["-e", extensionPath];
  }
  const argv = [
    nodePath,
    piCliPath,
    "--mode", "json",
    "-p",
    "--no-extensions",
    ...extensionArgs,
    "--no-skills",
    "--no-prompt-templates",
    "--no-themes",
    "--no-context-files",
    "--offline",
    "--tools", evaluation.tools.join(","),
    "--provider", EVAL_PROVIDER_ID,
    "--model", EVAL_MODEL_ID,
    "--thinking", evaluation.thinking,
    "--session-dir", paths.sessions,
    prompt,
  ];
  const env = {
    PATH: sanitizedPath(),
    HOME: paths.home,
    TMPDIR: paths.tmp,
    PI_CODING_AGENT_DIR: paths.agent,
  };
  return {
    argv,
    env,
    cwd: paths.worktree,
    stdoutPath: paths.stdout,
    stderrPath: paths.stderr,
    sessionDir: paths.sessions,
    extensionPath,
    prompt,
    promptSha256,
    pinned: {
      promptSha256,
      scorerSha256,
      provider: evaluation.provider,
      model: evaluation.model,
      thinking: evaluation.thinking,
      piVersion: evaluation.piVersion,
      armCommit: arm.commit,
      ...(arm.implementationSha256 ? { implementationSha256: arm.implementationSha256 } : {}),
      tools: evaluation.tools,
      ...(study?.extraPins ?? {}),
      ...(observers
        ? { observerSha256: observers.observerSha256, observerWrapperSha256: observers.observerWrapperSha256 }
        : {}),
    },
  };
}

/**
 * Merge completion pins: the plan pins land in pinned.json, and any
 * runtime pin recorded at reservation is preserved verbatim. Used by
 * executeRealAttempt when it rewrites pinned.json at completion.
 */
export function mergeCompletionPins(reservedPinned, planPinned) {
  const reservedRuntimePin = reservedPinned?.piRuntime ?? null;
  return {
    schemaVersion: 1,
    // Reserved study pins (repetition, fixture and observer digests,
    // study, identity) survive the completion rewrite; plan pins then
    // layer their standard fields on top with identical values.
    ...reservedPinned,
    ...(reservedRuntimePin ? { piRuntime: reservedRuntimePin } : {}),
    ...planPinned,
  };
}

/**
 * Execute one reserved real attempt end to end, exactly once.
 *
 * State transitions: terminal-refusal (a result.json already exists)
 * -> credential load (memory only) -> proxy up -> workspace prepared
 * -> single spawn under runSubprocess ownership -> exit -> models.json
 * deleted -> proxy stats persisted and proxy closed -> scorer -> final
 * git collection -> terminal result.json. The credential key never
 * reaches argv, the child environment, artifacts, or error text.
 */
export async function executeRealAttempt({
  repoRoot,
  manifest,
  task,
  arm,
  armInfo,
  attemptDir,
  fixtureDir,
  credentialSourcePath,
  piCliPath,
  timeoutMs,
  identity = {},
  study = null,
}) {
  const resultPath = join(attemptDir, "result.json");
  if (existsSync(resultPath)) {
    throw new Error(`attempt at ${basename(attemptDir)} already reached a terminal status; refusing to invoke Pi again`);
  }
  const evaluation = manifest.evaluation;
  const paths = attemptPaths(attemptDir);
  const { apiKey, baseUrl } = loadProviderCredential({ sourcePath: credentialSourcePath });
  const template = loadSafeModelTemplate({ sourcePath: credentialSourcePath });
  const dummyApiKey = generateDummyApiKey();
  const proxy = await startCredentialProxy({ upstreamBaseUrl: baseUrl, apiKey, dummyApiKey });
  const startedMs = Date.now();
  let firstEventLatencyMs = null;
  let piSpawnStartedAt = null;
  let outcome = null;
  let plan = null;
  try {
    prepareAttemptWorkspace({
      attemptDir,
      fixtureDir,
      arm: armInfo,
      profile: evaluation.profile,
      proxyBaseUrl: proxy.baseUrl,
      template,
      dummyApiKey,
      study,
    });
    const invocationPlan = planRealInvocation({ paths, manifest, task, arm: armInfo, piCliPath, study: studyForInvocation(attemptDir, study) });
    plan = invocationPlan;
    // Invocation-to-first-event timing starts immediately before the Pi
    // process spawn, after every fixture-preparation step, so the
    // reported latency never includes workspace preparation.
    const spawnStartedMs = Date.now();
    piSpawnStartedAt = new Date(spawnStartedMs).toISOString();
    writeInvocationMarker(paths.invocations, piSpawnStartedAt);
    const pollFirstEvent = () => {
      if (firstEventLatencyMs !== null) return;
      try {
        const firstLine = readFileSync(paths.stdout, "utf8").split("\n", 1)[0];
        if (firstLine.trim().length === 0) return;
        JSON.parse(firstLine);
        firstEventLatencyMs = Date.now() - spawnStartedMs;
      } catch {
        // no complete first line yet
      }
    };
    const watcher = setInterval(pollFirstEvent, 10);
    if (watcher.unref) watcher.unref();
    try {
      outcome = await runSubprocess({
        argv: plan.argv,
        cwd: plan.cwd,
        env: plan.env,
        timeoutMs: timeoutMs ?? evaluation.timeoutMsPerAttempt,
        stdoutPath: plan.stdoutPath,
        stderrPath: plan.stderrPath,
      });
    } finally {
      clearInterval(watcher);
    }
  } finally {
    // Teardown happens on every path: the credential-bearing models.json
    // goes away, proxy stats are persisted without bodies, the proxy
    // stops listening, and the key stays memory-only.
    rmSync(paths.agentModels, { force: true });
    const stats = proxy.stats();
    writeFileSync(paths.proxy, `${JSON.stringify(stats, null, 2)}\n`, "utf8");
    await proxy.close();
  }

  const stdoutText = readFileSync(paths.stdout, "utf8");
  const lines = stdoutText.split("\n").filter((line) => line.trim().length > 0);
  const malformedLines = [];
  const events = [];
  lines.forEach((line, index) => {
    try {
      events.push(JSON.parse(line));
    } catch {
      malformedLines.push(index + 1);
    }
  });
  const usage = { input: null, output: null, cacheRead: null, cacheWrite: null };
  const sawUsageField = { input: false, output: false, cacheRead: false, cacheWrite: false };
  for (const event of events) {
    if (event?.type === "message_end" && event?.message?.role === "assistant") {
      const source = event.message.usage;
      if (source) {
        for (const field of ["input", "output", "cacheRead", "cacheWrite"]) {
          if (typeof source[field] === "number") {
            sawUsageField[field] = true;
            usage[field] = (usage[field] ?? 0) + source[field];
          }
        }
      }
    }
  }
  for (const field of ["input", "output", "cacheRead", "cacheWrite"]) {
    if (!sawUsageField[field]) usage[field] = null;
  }

  // Preserve the runtime manifest pin recorded at reservation: the
  // completion write must never drop it, or pair validity against
  // run.json would falsely invalidate the pair.
  const reservedPinned = existsSync(paths.pinned) ? JSON.parse(readFileSync(paths.pinned, "utf8")) : null;
  writeFileSync(
    paths.pinned,
    `${JSON.stringify(mergeCompletionPins(reservedPinned, plan.pinned), null, 2)}\n`,
    "utf8",
  );
  // An injected hidden score function (study) replaces the standard
  // scorer without exposing scorer or solution paths to the child.
  const scoreAttempt = study?.scoreWorktree ?? scoreWorktree;
  const scorerResult = scoreAttempt({ repoRoot, worktree: paths.worktree, taskId: task.id });
  writeFileSync(paths.scorer, `${JSON.stringify(scorerResult, null, 2)}\n`, "utf8");
  const collection = await collectFinalState({ worktree: paths.worktree, outDir: join(attemptDir, "final-state") });
  writeFileSync(paths.finalState, `${JSON.stringify(collection, null, 2)}\n`, "utf8");
  // Study instrumentation runs after scoring and final collection. A
  // failure throws so the orchestrator stops later reservations rather
  // than keep an uninstrumented paid attempt.
  if (study?.observers) {
    const instrumentation = study.observers.extract({ attemptDir });
    if (instrumentation === null || typeof instrumentation !== "object" || Array.isArray(instrumentation)) {
      throw new Error("study observers extract() must return an instrumentation object");
    }
    writeFileSync(join(attemptDir, "instrumentation.json"), `${JSON.stringify(instrumentation, null, 2)}\n`, "utf8");
  }

  const effectiveTimeoutMs = timeoutMs ?? evaluation.timeoutMsPerAttempt;
  const failures = [];
  if (outcome.spawnError) failures.push(`spawn error: ${outcome.spawnError}`);
  else if (outcome.timedOut) failures.push(`timeout after ${effectiveTimeoutMs}ms (escalated: ${outcome.teardown.escalatedToSigkill})`);
  else if (outcome.signal) failures.push(`signal ${outcome.signal}`);
  else if (outcome.code !== 0) failures.push(`exit ${outcome.code}`);
  const status =
    collection.status === "error" ? "collection-error"
      : outcome.spawnError ? "failed"
        : outcome.timedOut ? "timeout"
          : outcome.signal ? "interrupted"
            : outcome.code === 0 ? "completed"
              : "failed";
  const proxyStats = JSON.parse(readFileSync(paths.proxy, "utf8"));
  const result = {
    schemaVersion: 1,
    ...identity,
    taskId: task.id,
    arm,
    status,
    durationMs: Date.now() - startedMs,
    piSpawnStartedAt,
    exit: {
      code: outcome.code,
      signal: outcome.signal,
      timedOut: outcome.timedOut,
      spawnError: outcome.spawnError,
      teardown: outcome.teardown,
    },
    usage,
    firstEventLatencyMs,
    jsonl: { lines: lines.length, malformedLines },
    scorer: {
      status: scorerResult.status,
      passedCount: scorerResult.passedCount,
      totalCount: scorerResult.totalCount,
      error: scorerResult.error,
    },
    collection: {
      status: collection.status,
      errors: collection.errors,
      artifacts: collection.artifacts.map(({ name, file, bytes, sha256 }) => ({ name, file, bytes, sha256 })),
    },
    proxy: {
      requestCount: proxyStats.requests.length,
      rejectedCount: proxyStats.rejected.length,
    },
    failures,
  };
  writeFileSync(resultPath, `${JSON.stringify(result, null, 2)}\n`, "utf8");
  return {
    taskId: task.id,
    arm,
    ...(identity.attempt !== undefined ? { attempt: identity.attempt } : {}),
    status,
    durationMs: result.durationMs,
    firstEventLatencyMs,
    usage,
    scorer: result.scorer,
    exit: { code: outcome.code, signal: outcome.signal, timedOut: outcome.timedOut, spawnError: outcome.spawnError },
  };
}

function writeInvocationMarker(path, piSpawnStartedAt) {
  const fd = openSync(path, "wx");
  try {
    writeSync(fd, `${JSON.stringify({ at: new Date().toISOString(), piSpawnStartedAt, pid: process.pid })}\n`);
  } finally {
    closeSync(fd);
  }
}
