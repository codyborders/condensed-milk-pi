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

Results provide no provider-cost conclusion. They provide no task-quality conclusion. They provide no safety conclusion for arbitrary shell input. Passing local budgets does not establish production readiness.
