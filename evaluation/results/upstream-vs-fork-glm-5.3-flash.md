# Upstream versus fork evaluation

Completed evaluation used 20 valid task pairs and 40 selected attempts. Both arms passed all 20 tasks. Quality difference was zero: 20/20 versus 20/20.

Upstream used commit `71f9e396951c42687f0c3456727b2b5c8c625da1`. Fork used commit `85e9af185c2a6416ea37791cf5d08e57c399c0e0`. Both arms used `z-ai` with `glm-5.3-flash`, Pi `0.84.2`, `high` thinking, and the `qwen-vllm` profile.

This paid run predates executable runtime digest pinning. Version equality does not establish identical runtime bytes or dependency bytes. Prompt and scorer hashes matched within all 20 pairs. No duplicate invocations occurred. Each attempt had at most one invocation.

## Aggregate deltas

All deltas are fork minus upstream. Percentages use upstream as denominator.

| Measure | Upstream | Fork | Delta | Change |
| --- | ---: | ---: | ---: | ---: |
| Uncached input tokens | 174,611 | 181,096 | +6,485 | +3.7% |
| Cache-read tokens | 272,128 | 255,616 | -16,512 | -6.1% |
| Output tokens | 20,821 | 19,884 | -937 | -4.5% |
| Combined prompt tokens | 446,739 | 436,712 | -10,027 | -2.2% |
| Total reported tokens | 467,560 | 456,596 | -10,964 | -2.3% |
| Total duration (ms) | 838,166 | 872,758 | +34,592 | +4.1% |
| Median duration (ms) | 41,222 | 35,436 | -5,786 | -14.0% |
| p95 duration (ms) | 83,233 | 80,807 | -2,426 | -2.9% |
| Tool calls | 158 | 159 | +1 | +0.6% |
| Proxy requests | 137 | 136 | -1 | -0.7% |

Total reported tokens decreased modestly while uncached input increased. One stochastic run cannot establish causality. Fork showed zero historical mask placeholders versus five upstream. Measured token difference cannot be credited to more historical masking.

Tool errors were 3 upstream and 4 fork. Malformed JSONL was zero in both arms. Cache-write tokens were zero in both arms.

First-event latency is omitted from this result. The recorded timing basis included fixture preparation before the Pi spawn, so those values are not comparable across arms or runs. The evaluator now records `piSpawnStartedAt` immediately before the spawn and measures first-event latency from that instant. This paid run predates that correction and cannot be retrofitted.

## Local comparator

Deterministic local benchmark covered 36 cases. All output hashes matched, mask counts matched, and all verified budgets passed. Fork hook median-case aggregate delta was **+0.6585 ms**. p95 aggregate delta was **+0.876 ms**. Relative aggregate ratios were about **2.51x** for median and **2.54x** for p95. Absolute runtime remained far below configured budgets.

These results describe one local machine and synthetic workload. They do not establish provider cost, task quality, safety, or production readiness.

## Exclusions and limitations

Two earlier private pilot runs were excluded because scorer definitions changed. No raw selection map or task content is included here. Results cover one model configuration and one stochastic run. The Pi package version matched across arms, but runtime bytes and dependencies lacked execution-time digest pins. Deltas are descriptive. Independent repeatability, broader safety review, provider accounting review, and production-readiness gates remain required.

Files:

- [Sanitized evaluation result](upstream-vs-fork-glm-5.3-flash.json)
- [Sanitized local comparator result](../../benchmarks/comparison-results.json)
