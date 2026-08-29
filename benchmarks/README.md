# Context-hook benchmark

This benchmark measures local runtime behavior for `compressStaleToolResults`. It uses deterministic synthetic histories. It does not measure model quality or provider economics.

## Method

The generator creates 36 cases from these dimensions:

- Message counts: `100`, `1000`, `5000`, and `10000`
- Bash densities: `0.25`, `0.5`, and `0.9`
- Working-directory distributions: `single`, `balanced`, and `skewed`

Each case uses seed `0x4d494c4b`. It generates fixed conversation messages plus successful bash results. Bash commands contain synthetic `cd` prefixes and fixed payload text. The input hash records the generated history.

Each case runs five warmup iterations. It then runs 20 measured iterations. The report records the median runtime and the 95th percentile runtime. It also checks that every output hash matches the first output hash.

Run the benchmark with:

```bash
npm run benchmark
```

The command prints a report. It does not rewrite the checked-in result file. Update the local result file only after an intentional run:

```bash
npm run benchmark:update
```

## Pinned commit comparison

Both implementation worktrees must be clean. Pin each run to its exact commit and write results outside checked-in files:

```bash
mkdir -p evaluation/runs/local-comparison
UPSTREAM_ROOT="$HOME/Library/Caches/condensed-milk-eval/cache/arms/upstream-71f9e396951c42687f0c3456727b2b5c8c625da1"
FORK_ROOT="$HOME/Library/Caches/condensed-milk-eval/cache/arms/fork-f11ab9863b320ae05671386f144a8be469892e26"
node --expose-gc --import tsx benchmarks/context-hook.mjs \
  --implementation-root "$UPSTREAM_ROOT" \
  --expected-commit 71f9e396951c42687f0c3456727b2b5c8c625da1 \
  --output evaluation/runs/local-comparison/upstream.json
node --expose-gc --import tsx benchmarks/context-hook.mjs \
  --implementation-root "$FORK_ROOT" \
  --expected-commit f11ab9863b320ae05671386f144a8be469892e26 \
  --output evaluation/runs/local-comparison/fork.json
node benchmarks/compare-context-hook.mjs \
  evaluation/runs/local-comparison/upstream.json \
  evaluation/runs/local-comparison/fork.json \
  --json-output evaluation/runs/local-comparison/comparison.json \
  --markdown-output evaluation/runs/local-comparison/comparison.md
```

The comparator rejects mismatched case dimensions, input hashes, harness hashes, Node versions, machines, or nondeterministic arm output. Timing deltas are descriptive. Output hashes may differ between algorithms.

The completed sanitized comparison is checked in at `benchmarks/comparison-results.json`. It compares upstream with release-candidate commit `f11ab9863b320ae05671386f144a8be469892e26`. All 36 output hashes match, and every mask count is equal. Every recorded p95 value passed its budget. The aggregate fork delta is +0.682 ms at median and +0.8025 ms at p95. Aggregate ratios are about 2.55x and 2.13x. Absolute runtime remains far below budgets.

## Archive-enabled context benchmark

`benchmarks/archive-context.mjs` measures local filesystem recovery work in a temporary directory. It records runtime, filesystem operations, survivor counts, verification outcomes, and storage totals. It makes no provider, token, quality, or production-readiness claim.

### Method and workloads

Run the gate without changing checked-in results:

```bash
npm run benchmark:archive
```

Update `benchmarks/archive-results.json` only after intentional result regeneration:

```bash
npm run benchmark:archive:update
```

Steady workload repeats one candidate count across five passes. It checks live-reference reuse and zero repeated content or index rewrites. It also checks deterministic survivors and repeated-pass p95 budget.

Progressive workloads use candidate counts `[100, 200, 300, 400, 500]`. They cover disabled fail-open behavior, capacity pressure, aggregate-byte pressure, TTL expiry, and store recreation. Capacity cases test limits above and below candidate counts.

Each scenario runs warmups plus measured iterations. Archive-enabled cases use real temporary filesystem operations. Archive-disabled cases use the production batch wrapper. The wrapper returns null, so disabled runs mask nothing.

`benchmarks/archive-context.test.mjs` checks scenario names, candidate dimensions, pass schema, gate fields, storage bounds, disabled survivors, TTL expiry, and recreation verification.

### Result schema

`archive-results.json` uses `schemaVersion: 2`. It records benchmark identity, timestamp, Node version, iteration counts, candidate counts, p95 budgets, gate failures, and scenarios.

Each scenario records name, archive mode, recreation and TTL flags, candidate counts, configured storage totals, and pass records. Each pass records admission counts, evictions, expirations, masked and visible counts, filesystem operations, verification counts, retrieval counts, storage totals, runtime percentiles, sample count, and failures.

Repeated-pass p95 must remain below configured budgets. Steady-state reuse must perform zero archive-content writes and zero archive-content renames. Upstream comparison data describes local recovery work only. It is not a token or provider-cost measurement.

### Corrective rolling-admission result

The regenerated run used 20 measured iterations per pass. All eight scenarios passed with zero reported failures. Steady-state repeated p95 reached at most 5.276 ms against the 25 ms budget. Repeated steady passes performed zero entry or index rewrites.

| Fifth pass scenario | New admissions | Evictions | Expirations | Masked | Visible | p95 |
| --- | ---: | ---: | ---: | ---: | ---: | ---: |
| Disabled | 0 | 0 | 0 | 0 | 500 | 0.505 ms |
| Capacity above count | 100 | 0 | 0 | 500 | 0 | 42.429 ms |
| Capacity 128 | 100 | 100 | 0 | 128 | 372 | 39.714 ms |
| Entry pressure, capacity 4 | 4 | 4 | 0 | 4 | 496 | 7.883 ms |
| Aggregate pressure | 35 | 35 | 0 | 35 | 465 | 13.907 ms |
| TTL expiry | 500 | 0 | 400 | 500 | 0 | 147.197 ms |
| Store recreation | 100 | 0 | 0 | 500 | 0 | 39.189 ms |

Disabled passes performed zero archive filesystem operations. Every emitted reference returned expected canonical bytes. Old-reference alias count remained zero. Each pressured scenario stayed within its configured entry and aggregate-byte limits.

## Current local results

`benchmarks/results.json` contains the checked-in local run. It records runtime details, input dimensions, output hashes, mask counts, and budgets. The recorded run used 36 cases and 20 measured iterations per case.

The recorded machine is an Apple M1 Pro running Darwin with Node `v25.8.2`. The largest recorded p95 runtime is `9.827 ms`. The result file records all case budgets as passed. These values describe that machine and run only.

## Heap observations

`observedHeapDeltaBytes` is the largest observed difference in `heapUsed` during one measured case. It is not an allocation profile. It includes garbage-collector timing, runtime state, JIT effects, retained objects, and measurement noise. It is not a memory bound and does not show the absence of leaks.

The benchmark records heap observations because they can expose unexpected growth during local investigation. It does not claim stable memory behavior across Node versions, operating systems, workloads, or sessions.

## CI budgets

The benchmark checks p95 runtime budgets by message count:

| Message count | p95 budget |
| ---: | ---: |
| 100 | 25 ms |
| 1000 | 75 ms |
| 5000 | 250 ms |
| 10000 | 500 ms |

A case fails when its raw p95 exceeds the budget. The benchmark also fails when output hashes differ across warmup or measured runs. Budgets are regression guardrails for this synthetic workload. They are not service-level objectives.

## Interpretation limits

Synthetic messages omit real tool data and provider activity. The 36 cases cover selected history sizes, bash densities, and working-directory patterns. They do not cover every command form or extension configuration.

Results provide no provider-cost conclusion. They provide no task-quality conclusion. They provide no safety conclusion for arbitrary shell input. The paired evaluation is complete for 20 valid pairs, with results at `evaluation/results/upstream-vs-fork-glm-5.3-flash.md`. Two earlier private pilots were excluded because scorer definitions changed. One stochastic run and one synthetic workload do not establish production readiness.
