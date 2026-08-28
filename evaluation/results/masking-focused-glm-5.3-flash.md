# Masking-focused paired study

## Result

The final study passed every release gate. It produced 48 completed attempts and 24 valid pairs. No pair was invalid or incomplete.

Both arms passed 21 of 24 attempts. Fork correctness matched upstream correctness overall and met or exceeded it for each task.

The fork recovered every required hidden diagnostic through `condensed_milk_retrieve`. All three required fork repetitions recorded archived bytes, archive references, retrieval calls, and returned bytes.

## Pinned setup

| Field | Value |
| --- | --- |
| Run | `masking-final-v5-20260828T151106Z` |
| Evaluator commit | `e84f0181720b83ce6dfcc6045f51539978ce3268` |
| Provider | `z-ai` |
| Model | `glm-5.3-flash` |
| Thinking | `high` |
| Pi | `0.84.2` |
| Upstream commit | `71f9e396951c42687f0c3456727b2b5c8c625da1` |
| Fork commit | `fca546506e3c6b26401155a780052646a65dee38` |
| Manifest SHA-256 | `d8cc648ab3715dcfb223f882f4d34d3ead49df95fd0cf990879fe128cd4e2af9` |
| Profile SHA-256 | `377b900f39da2bbd00fb406ea1d816b48e63be6b26a66c0239f9fec02f9ffd19` |
| Pi runtime SHA-256 | `a131c543306799de2040b11c707d2fce857e58ce4be3d43649a809f7e38251e3` |

Both arms loaded Condensed Milk. This was not an extension-disabled comparison.

## Gates

| Gate | Result |
| --- | --- |
| 24 valid pairs, zero invalid, zero incomplete | Passed |
| Historical context masking in every attempt | Passed |
| Fork correctness at least upstream per task | Passed |
| Required diagnostics observed | Passed |
| Required fork archive recovery | Passed |
| Configured privacy sentinels absent | Passed |
| Non-text order unchanged | Passed |

Semantic filter activation was recorded as a descriptive metric. It was not a release gate.

## Aggregate metrics

| Metric | Upstream | Fork | Fork minus upstream |
| --- | ---: | ---: | ---: |
| Correct attempts | 21 / 24 | 21 / 24 | 0 |
| Original observed bytes | 11,562,442 | 14,742,198 | +3,179,756 |
| Visible observed bytes | 3,599,900 | 6,840,351 | +3,240,451 |
| Removed bytes | 7,962,542 | 7,901,847 | -60,695 |
| Removed share | 68.87% | 53.60% | -15.27 points |
| Archived bytes | 0 | 1,016,930 | +1,016,930 |
| Estimated semantic tokens saved | 5,385 | 2,165 | -3,220 |
| Estimated historical tokens saved | 1,985,244 | 1,973,285 | -11,959 |
| Provider input tokens | 753,687 | 942,045 | +188,358 |
| Provider output tokens | 27,108 | 32,531 | +5,423 |
| Provider cache-read tokens | 489,536 | 1,575,744 | +1,086,208 |
| Total reported tokens | 1,270,331 | 2,550,320 | +1,279,989 |
| Total wall time | 1,158,879 ms | 1,686,115 ms | +527,236 ms |
| Median wall time | 47,525 ms | 62,546 ms | +15,021 ms |
| p95 wall time | 88,981 ms | 112,104 ms | +23,123 ms |
| Median first-event latency | 1,174 ms | 1,283.5 ms | +109.5 ms |
| Historical mask events | 164 | 196 | +32 |
| Archive references | 0 | 331 | +331 |
| Retrieval calls | 0 | 59 | +59 |
| Returned archive bytes | 0 | 503,347 | +503,347 |
| Reruns | 9 | 5 | -4 |
| Rereads | 20 | 6 | -14 |
| Privacy-sentinel incidents | 0 | 0 | 0 |
| Non-text ordering incidents | 0 | 0 | 0 |

Provider cost remained null. The provider did not return authoritative cost values.

## Paired intervals

Intervals use a deterministic paired bootstrap percentile method over 24 fork-minus-upstream differences. The checked-in pair file also contains paired-t intervals.

| Metric | Mean difference | 95% bootstrap interval |
| --- | ---: | ---: |
| Estimated semantic tokens saved | -134.17 | [-408.92, 15.09] |
| Estimated historical tokens saved | -498.29 | [-19,331.63, 18,802.40] |
| Provider input tokens | +7,848.25 | [4,992.83, 11,018.21] |
| Provider output tokens | +225.96 | [-40.80, 520.59] |
| Wall time | +21,968.17 ms | [10,429.20, 34,622.94] |
| First-event latency | +35.25 ms | [-74.75, 118.59] |
| Retrieval calls | +2.46 | [1.58, 3.42] |
| Reruns | -0.17 | [-0.33, -0.04] |
| Rereads | -0.58 | [-0.92, -0.29] |

In this run, the fork matched quality and reduced reruns plus rereads. It used more provider input, more cache-read tokens, and more wall time. The study does not support a token-cost reduction claim for the recovery-enabled fork.

## Excluded runs

Four earlier paid runs were excluded from the final result:

- `masking-final-20260828T104951Z`: thinking-content changes were misclassified as non-text order changes. Task 8 also exposed its expected answer.
- `masking-final-v2-20260828T115526Z`: Task 2 upstream timed out during Cargo. Its fixed repetition slot was not retried.
- `masking-final-v3-20260828T131901Z`: one fork build attempt omitted its output file. The local script was changed to record each run.
- `masking-final-v4-20260828T141518Z`: historical context archive references were omitted from extracted recovery metrics.

Each replacement used a new run ID. No reserved or terminal paid slot was invoked again.

## Limits

This is one stochastic study with three repetitions per task. Estimated token savings use byte counts divided by four. They are not provider token accounting.

Privacy checks cover configured sentinel patterns. They do not establish absence of every possible secret form.

The public row file omits prompts, commands, paths, transcripts, archive contents, credentials, and internal digests. Private attempt data remains outside the repository.

## Public artifacts

- `masking-focused-glm-5.3-flash.json`
- `masking-focused-glm-5.3-flash-rows.json`
- `masking-focused-glm-5.3-flash-pairs.json`
- `masking-focused-glm-5.3-flash-artifact-index.json`
