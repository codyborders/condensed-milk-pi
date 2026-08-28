# Evaluation runner

The runner supports deterministic fake runs and explicit real runs. CI uses only free commands. Real execution requires `--confirm-paid` plus a credential source.

## Commands

```bash
npm run evaluation:validate   # validate the manifest and hidden task data
npm run evaluation:fixtures   # regenerate deterministic fixtures and tree hashes
npm run evaluation:test       # run evaluation tests
npm run evaluation:dry-run    # run 40 fake attempts and verify invariants
npm run evaluation:report     # regenerate reports for the latest run
```

The CLI entry point is `node evaluation/runner/cli.mjs <command>`. `CLI_USAGE` in `cli.mjs` lists all flags. Fault modes and interruption controls support free recovery tests. `npm run evaluation:test` runs the suite serially (`--test-concurrency=1`) so tests that exercise the fixture cache and run locks never race each other.

Every cached fixture carries a canonical integrity record at `.git/integrity.json` inside its cache entry. The record binds the task identity, the non-.git tree digest, HEAD, the full required Git state, and the postcondition results under a self-seal digest. Every reuse re-verifies it, and any mutation refuses the run before a reservation is created. Set `CM_EVAL_FIXTURES_CACHE` to redirect the fixture cache to an isolated root (used by tests).

## Reproduction

All commands below are free and deterministic. They never read provider credentials and never make provider calls.

```bash
npm run evaluation:validate   # validate the manifest and hidden task data
npm run evaluation:fixtures   # regenerate deterministic fixtures and tree hashes
npm run evaluation:test       # serial evaluation test suite
npm run evaluation:dry-run    # run 40 fake attempts and verify invariants
```

Five consecutive test-suite runs (free repetition check). Every run must exit 0:

```bash
for i in 1 2 3 4 5; do npm run evaluation:test || exit 1; done
```

## Paid reproduction (explicit, never automatic)

Real runs are documented for reproducibility only. They spend provider money, require `--confirm-paid`, and are never invoked by tests or CI. Keep the credential file outside this repository.

`prepare` and `run` must receive the same `--runs-dir`. A real run's state lives outside the repository by default (user cache under `condensed-milk-eval`), while `prepare` defaults to `evaluation/runs` inside it.

```bash
RUNS="$HOME/Library/Caches/condensed-milk-eval/runs"    # macOS; Linux: "$XDG_CACHE_HOME/condensed-milk-eval/runs"
CACHE="$HOME/Library/Caches/condensed-milk-eval/cache"  # external pinned-input cache (arm worktrees, Pi runtime)
RUN_ID="eval-$(date +%Y%m%d%H%M%S)"
CREDENTIALS="/absolute/path/to/models.json"              # z-ai provider credential file, kept outside this repository

# 1. Create the run and persist arm order (free):
node evaluation/runner/cli.mjs prepare --runs-dir "$RUNS" --run-id "$RUN_ID" --mode real

# 2. Read-only plan check (free; no credential, no lock, no attempts):
node evaluation/runner/cli.mjs run --runs-dir "$RUNS" --run-id "$RUN_ID" --all --plan-only

# 3. Paid execution (spends provider money):
node evaluation/runner/cli.mjs run --runs-dir "$RUNS" --run-id "$RUN_ID" --all \
  --confirm-paid --credential-source "$CREDENTIALS" --cache-dir "$CACHE"

# Optional pinned inputs: --pi-runtime DIR --timeout-ms N

# 4. Post-run reporting and manual selection (free):
node evaluation/runner/cli.mjs report --runs-dir "$RUNS" --run-id "$RUN_ID"
node evaluation/runner/cli.mjs select --runs-dir "$RUNS" --run-id "$RUN_ID" --task task-01 --arm upstream --attempt 1
```

Real-run retry is unsupported. `retry` refuses runs prepared with `--mode real`. A crashed reserved attempt stays abandoned, and `resume` never respawns a paid attempt.

## Execution model

A run stores each task's arm order before execution. Every attempt receives an immutable number. The runner writes a durable reservation before process creation. It never automatically invokes a reserved attempt again.

Each child runs in its own process group. Timeout, cancellation, `SIGINT`, and `SIGTERM` trigger bounded group termination. The runner records the final exit state after child cleanup.

Fake runs apply hidden reference solutions in isolated worktrees. Real runs use pinned arm commits, an isolated Pi runtime, separate homes, and a loopback credential proxy. The evaluated child receives a dummy key. The proxy keeps the real key in parent memory.

The runner hashes the isolated Pi runtime. The hash covers sorted paths, regular file contents, link targets, and file modes. A resumed run must match its stored runtime hash before any reservation. Attempts store the same runtime pin.

## Attempts and selection

`resume` skips completed or reserved attempts. `retry --allow-new-paid-attempt` works only for fake runs. Real-run retry is unsupported. A future real retry path must repeat every paid preflight and durable reservation control.

`select --run-id X --task T --arm A --attempt N` changes selection under the run lock. Selection requires a terminal result plus a valid `provider-invocation.json` receipt. A real receipt uses `fake:false` and must match its run identity, provider, model, arm commit, and runtime pin. A fake run accepts only `fake:true` receipts. Legacy real attempts remain valid only when runtime pins are absent everywhere. Any present malformed runtime pin is invalid.

Pair checks use selected attempts only. Both arms must match fixture hashes, prompt hashes, scorer hashes, provider settings, Pi version, and runtime hash when present. Each arm commit must match the manifest.

## Scoring and collection

The scorer reads hidden assertions outside the evaluated worktree. File assertions reject links and paths outside the worktree. Command assertions execute against the final repository state.

Before completion, collection records porcelain v2 status, staged and unstaged binary patches, the Git index listing, and hashes for untracked regular files. External links are recorded but never followed. A collection failure prevents automatic selection.

Reports include pair quality and timing. They also include usage, proxy counts, tool-event counts, malformed JSONL counts, and static mask counts. Reports exclude raw tool data and credentials. They also exclude environment values and private matching lines.

## Recorded evaluation

The sanitized paid comparison is in `evaluation/results/upstream-vs-fork-glm-5.3-flash.md`. Raw attempts remain outside the repository. That run predates executable runtime digest pinning and corrected first-event timing. The report states both limitations.

## Masking-focused paired study

A second, separate study lives beside this runner. Its manifest is `evaluation/masking-task-manifest.json`. It pins 8 deterministic masking-focused tasks. The tasks cover repeated tests, repeated builds, git status/log/diff, high-volume search, overlapping reads, and noisy logs. One task uses a long success stream with a decisive failure. Another task recovers a diagnostic through `condensed_milk_retrieve`. Upstream stays at `71f9e396951c42687f0c3456727b2b5c8c625da1`. The fork arm pins `fca546506e3c6b26401155a780052646a65dee38`. The identity gate refuses any other provider than `z-ai` and any other model than `glm-5.3-flash`. The refusal happens before a reservation exists.

Both arms receive byte-identical profile bytes from `evaluation/masking-eval-profile.json`. The run and every attempt pin the profile SHA-256. The profile uses thresholds `[0.05, 0.08, 0.12]`, coverage `[0.50, 0.75, 0.90]`, and an effective context cap of `131072`. Each task reads 400 deterministic filler lines. This prevents a zero cutoff at initial context setup and crosses a masking threshold after tool output. This study profile is not a general-purpose preset.

Each run persists a seeded randomized arm order and a seeded randomized repetition order in `run.json`. This happens before any attempt exists. Every task runs at least three repetitions. Every repetition gets a fresh session directory and a fresh attempt home. The home receives the profile bytes in its isolated `condensed-milk.json`. Every repetition also gets a fresh worktree copy and a fixture-cache verification. Re-running the dry-run resumes. Completed attempts are skipped and never duplicated. Pairs and repetition groups are refused when task, scorer, fixture, provider, model, profile, runtime, or arm commit pins differ. Arm commits are validated against the manifest per arm. They are never compared across arms.

Each attempt records filter activation and four byte categories: original, visible, removed, and archived. Two separate ledgers estimate semantic savings and historical-mask savings. They never overlap. Other counters cover mask events and semantic transforms. Archive references and retrieval activity have separate counters. Rerun and reread counts remain distinct. Provider usage keeps each token category separate. Provider cost stays null when absent. Wall time, corrected first-event latency, correctness, and recovery status complete the row.

Fake correctness comes from the hidden masking scorer. The runner applies each reference solution and scores the solved worktree. It writes `scorer.json` per attempt. Null correctness fails its gate. Every attempt pins fixture content and Git state. Pair validation authenticates each pin against independent run or repository data. It also validates runtime values and each arm commit.

The fake path uses deterministic fixture knowledge. The task masking kind selects an exact tool-result script. Real attempts use the verified neutral observer described below.

### Neutral masking observer (event-derived instrumentation)

`evaluation/runner/masking-observer.mjs` provides event-derived metrics. `generateMaskingObservers` writes two standalone extensions under `<attemptDir>/observer/`. Files and JSONL metrics use mode 0600. The runner forces this order: pre observer, arm implementation, post observer. Observers never change events. They store no raw text, commands, paths, prompts, queries, archive bodies, or secret values. Call identities use truncated SHA-256 values. Tool names map to an allowlist. Diagnostic markers become SHA-256 values before embedding. Fixed caps limit events, blocks, line bytes, and total bytes. Overflow or write failure emits one bounded error marker and stops recording.

The real-attempt study configuration generates the observers before invocation. It pins `observerSha256` over both extension sources. It also pins `observerWrapperSha256` over the embedded wrapper config. It runs `extractMaskingInstrumentation` after scoring and final collection. An instrumentation failure throws. The orchestrator then stops later reservations. The standard no-study path stays byte-identical.

The extractor pairs records by event type and sequence. Missing or malformed records cause refusal. Duplicate, overflow, and unmatched records also cause refusal. Byte ledgers use matching cumulative observation surfaces. Separate counters cover semantic changes, historical masks, archive activity, repeated calls, diagnostic presence, privacy sentinels, and non-text ordering. Archived-byte totals come only from recovery `index.json` metadata. Entry bodies are never read.

`observerOrderingVerifier()` adapts exact-runtime ordering checks for the shared paid preflight. The callback runs before any reservation and caches results by runtime digest.

Release gates follow. A failing gate makes the whole report non-passing. The report command then exits nonzero. Passing also requires exactly 24 valid pairs with zero invalid and zero incomplete.

| Gate | Requirement |
| --- | --- |
| Activation | Every arm activates historical context masking. Semantic filter activation remains a reported metric. |
| Correctness | Fork correctness meets or exceeds upstream correctness for each task. |
| Diagnostics | Every required diagnostic is observed. |
| Recoverability | Every required fork attempt uses `condensed_milk_retrieve` and returns archived bytes. |
| Privacy | Configured privacy sentinels never appear in visible output. |
| Ordering | Non-text block order stays unchanged. |

Reports write a JSON summary and a Markdown summary. Sanitized metric rows and paired differences use separate JSON files. `artifact-index.json` records their SHA-256 values. Public rows contain approved metrics, identifiers, and outcomes only. They omit paths, transcripts, credentials, and provider strings. Paired differences include seeded bootstrap intervals plus paired-t intervals. Tests use known interval values. Raw transcripts and attempt state remain private under the run directory.

### Free commands (deterministic, no provider calls, no credentials)

```bash
npm run masking:validate
npm run masking:fixtures
MASKING_RUNS="$(mktemp -d)"
MASKING_ID="masking-free-01"
node evaluation/runner/cli.mjs masking-prepare --runs-dir "$MASKING_RUNS" --run-id "$MASKING_ID"
node evaluation/runner/cli.mjs masking-plan --runs-dir "$MASKING_RUNS" --run-id "$MASKING_ID"
node evaluation/runner/cli.mjs masking-dry-run --runs-dir "$MASKING_RUNS" --run-id "$MASKING_ID"
node evaluation/runner/cli.mjs masking-report --runs-dir "$MASKING_RUNS" --run-id "$MASKING_ID"
```

Masking tests run with the existing serial suite. Use `npm run evaluation:test`. The files are named `masking-*.test.mjs`.

### Paid masking execution: exact commands

Paid masking execution reuses the 20-task real-run controls through one shared path. Prepare a real-mode run first. Then run it with an explicit credential source.

```bash
RUNS="$HOME/Library/Caches/condensed-milk-eval/runs"
CACHE="$HOME/Library/Caches/condensed-milk-eval/cache"
CREDENTIALS="/absolute/path/to/models.json"
RUN_ID="masking-paid-01"
CLI=(node evaluation/runner/cli.mjs)
RUN_REF=(--runs-dir "$RUNS" --run-id "$RUN_ID")
"${CLI[@]}" masking-prepare "${RUN_REF[@]}" --mode real
"${CLI[@]}" masking-plan "${RUN_REF[@]}"
"${CLI[@]}" masking-run "${RUN_REF[@]}" \
  --confirm-paid --credential-source "$CREDENTIALS" --cache-dir "$CACHE"
"${CLI[@]}" masking-report "${RUN_REF[@]}"
```

The shared preflight checks paid confirmation, timeout, credentials, arm worktrees, runtime bytes, the runtime pin, and the Node engine. It verifies observer ordering before any reservation. Slots run sequentially by task, persisted repetition order, then persisted arm order. Every attempt uses an immutable paid receipt with `fake: false`. Observer, scorer, collection, runtime, or infrastructure errors stop later slots. A crash leaves its slot abandoned. `masking-run` stops at that slot and never invokes it again. No masking retry command exists. Acknowledge a crash with `masking-abandon --run-id X --task T --arm A --attempt N --reason R`. It marks the slot abandoned, marks the whole run invalid, and creates no new attempt. An invalid run cannot resume paid execution. Start a new run id instead. The fork arm pins `fca546506e3c6b26401155a780052646a65dee38`. A masking-only policy copies only `index.ts`, `filters/**`, and `pi-types.d.ts` from that commit. Evaluator files never enter an attempt.

Cost and publication limits: every masking-run invocation spends provider money across 48 paid attempts. Tests use a loopback fake provider and never call the real one. No real paid masking call has been made by this change. Publishing any masking result requires the same review as the 20-task study. Publish aggregate reports only, after review. Keep raw transcripts and credentials private.
