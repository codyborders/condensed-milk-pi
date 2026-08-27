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

Reports include selected-pair quality, duration, usage, proxy counts, tool-event counts, malformed JSONL counts, and static mask counts. Reports exclude raw tool input, raw tool output, environment values, credentials, and private matching lines.

## Recorded evaluation

The sanitized paid comparison is in `evaluation/results/upstream-vs-fork-glm-5.3-flash.md`. Raw attempts remain outside the repository. That run predates executable runtime digest pinning and corrected first-event timing. The report states both limitations.
