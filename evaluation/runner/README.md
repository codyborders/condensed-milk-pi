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

The CLI entry point is `node evaluation/runner/cli.mjs <command>`. `CLI_USAGE` in `cli.mjs` lists all flags. Fault modes and interruption controls support free recovery tests.

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
