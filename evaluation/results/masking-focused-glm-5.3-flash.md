# Masking-focused paired study

## Result

The final study passed every release gate. It produced 48 completed attempts and 24 valid pairs. No pair was invalid or incomplete.

Both arms passed 21 of 24 attempts. Fork correctness matched upstream correctness overall and met or exceeded it for each task.

The fork recovered every required hidden diagnostic through `condensed_milk_retrieve`. All three required fork repetitions recorded archived bytes, archive references, retrieval calls, and returned bytes.

## Pinned setup

| Field | Value |
| --- | --- |
| Run | `masking-final-v6-20260828T162330Z` |
| Evaluator commit | `c36f9eed5ca6d8985a9b9479263b013e14686ab1` |
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
| Original observed bytes | 13,924,372 | 13,627,267 | -297,105 |
| Visible observed bytes | 4,383,755 | 5,905,237 | +1,521,482 |
| Removed bytes | 9,540,617 | 7,722,030 | -1,818,587 |
| Removed share | 68.52% | 56.67% | -11.85 points |
| Archived bytes | 0 | 1,013,814 | +1,013,814 |
| Estimated semantic tokens saved | 3,732 | 1,455 | -2,277 |
| Estimated historical tokens saved | 2,381,414 | 1,929,042 | -452,372 |
| Provider input tokens | 799,550 | 1,006,483 | +206,933 |
| Provider output tokens | 31,339 | 30,888 | -451 |
| Provider cache-read tokens | 758,912 | 1,222,976 | +464,064 |
| Total reported tokens | 1,589,801 | 2,260,347 | +670,546 |
| Total wall time | 1,456,406 ms | 1,547,735 ms | +91,329 ms |
| Median wall time | 48,852 ms | 53,825 ms | +4,973 ms |
| p95 wall time | 131,209 ms | 133,415 ms | +2,206 ms |
| Median first-event latency | 1,187.5 ms | 1,323.5 ms | +136 ms |
| Historical mask events | 185 | 191 | +6 |
| Archive references | 0 | 286 | +286 |
| Retrieval calls | 0 | 48 | +48 |
| Returned archive bytes | 0 | 481,680 | +481,680 |
| Reruns | 8 | 8 | 0 |
| Rereads | 16 | 6 | -10 |
| Privacy-sentinel incidents | 0 | 0 | 0 |
| Non-text ordering incidents | 0 | 0 | 0 |

Provider cost remained null. The provider did not return authoritative cost values.

## Paired intervals

Intervals use a deterministic paired bootstrap percentile method over 24 fork-minus-upstream differences. The checked-in pair file also contains paired-t intervals.

| Metric | Mean difference | 95% bootstrap interval |
| --- | ---: | ---: |
| Estimated semantic tokens saved | -94.88 | [-418.71, 126.38] |
| Estimated historical tokens saved | -18,848.83 | [-38,118.81, -1,344.48] |
| Provider input tokens | +8,622.21 | [2,580.43, 14,522.35] |
| Provider output tokens | -18.79 | [-361.71, 326.46] |
| Wall time | +3,805.38 ms | [-9,309.68, 17,288.64] |
| First-event latency | +185.71 ms | [77.62, 310.00] |
| Retrieval calls | +2.00 | [1.42, 2.58] |
| Reruns | 0.00 | [-0.17, 0.17] |
| Rereads | -0.42 | [-0.67, -0.17] |

In this run, the fork matched quality and reduced rereads. It used 42.18% more reported tokens. Its median wall time was 10.18% higher, while the paired wall-time interval included zero. The study does not support a token-cost reduction claim for the recovery-enabled fork.

## Excluded runs

Five earlier paid runs were excluded from the final result:

- `masking-final-20260828T104951Z`: thinking-content changes were misclassified as non-text order changes. Task 8 also exposed its expected answer.
- `masking-final-v2-20260828T115526Z`: Task 2 upstream timed out during Cargo. Its fixed repetition slot was not retried.
- `masking-final-v3-20260828T131901Z`: one fork build attempt omitted its output file. The local script was changed to record each run.
- `masking-final-v4-20260828T141518Z`: historical context archive references were omitted from extracted recovery metrics.
- `masking-final-v5-20260828T151106Z`: Task 2 used an unsupported `fileEquals` field name, so six correct files were scored as failures.

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
