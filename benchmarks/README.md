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

`benchmarks/archive-context.mjs` measures the real recovery store in a temporary directory. It covers 100, 300, 1,000, and 10,000 eligible results. Each case records the first, second, and fifth context passes. Archive-enabled and archive-disabled cases use supported capacities above or below candidate count where possible.

Run the gate without changing checked-in results:

```bash
npm run benchmark:archive
```

Update `benchmarks/archive-results.json` only after an intentional full run:

```bash
npm run benchmark:archive:update
```

Repeated-pass p95 must remain below 25 ms. Repeated processing of live tool-call IDs must perform zero archive-content writes and zero archive-content renames. `benchmarks/archive-context.test.mjs` checks the complete dimension set, exact pass sample counts, raw result gates, and supported-capacity survivor counts.

The corrected local run passed all 16 cases. Its highest repeated-pass p95 was 9.750 ms for 10,000 candidates. The fifth-pass p95 was 0.772 ms for 100 candidates, 1.123 ms for 300, and 3.056 ms for 1,000. Every repeated pass recorded zero content writes and renames.

`benchmarks/archive-before-results.json` records the synchronous per-entry behavior from merge commit `8d004bf97f5142d869aebcedf05ae7d7be4e1d30`. At 300 candidates with capacity 128, its fifth-pass p95 was 368.189 ms. The corrected batch path measured 0.665 ms for the matching case. At 300 candidates with capacity above candidate count, p95 changed from 43.448 ms to 1.123 ms.

First-pass work remains larger because new survivors must be written and verified. At 10,000 candidates with the supported 1,024-entry maximum, first-pass p95 was 222.032 ms. The release gate applies to repeated passes, while first-pass timings remain visible in the raw report.

Upstream ratios use exact candidate counts and pass numbers from `benchmarks/archive-upstream-baseline.json`. That file pins upstream commit `71f9e396951c42687f0c3456727b2b5c8c625da1`. Upstream does not archive results, so archive-enabled ratios describe added local recovery work. They are not token or provider-cost measurements.

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
