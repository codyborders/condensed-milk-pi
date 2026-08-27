# Paired task evaluation

## Status

The evaluation is complete for one run. It contains 20 valid task pairs and 40 selected attempts. All 20 tasks passed in both arms, with zero quality difference.

The run used provider `z-ai`, model `glm-5.3-flash`, Pi `0.84.2`, `high` thinking, and `qwen-vllm` profile. Upstream and fork commits were pinned to `71f9e396951c42687f0c3456727b2b5c8c625da1` and `85e9af185c2a6416ea37791cf5d08e57c399c0e0`.

Results are sanitized and checked in under `evaluation/results/`. No raw transcripts, tool content, selection map, credentials, or file paths are included. Two earlier private pilots are excluded because scorer definitions changed.

Production-readiness gates remain qualified. This run does not replace independent quality review, provider accounting review, broader safety review, or repeatability across environments.

## Exact protocol

The evaluator must use the 20 slots in `evaluation/task-manifest.json`. Each slot represents one task. The evaluator must create one baseline run and one treatment run for each slot.

1. Pin one repository snapshot for the pair. Use the same task prompt, starting files, tool permissions, time limit, and model settings in both runs.
2. Run the baseline without Condensed Milk. Run the treatment with the proposed configuration and no other extension changes.
3. Randomize arm order per pair. Record the order before either run starts.
4. Use fresh sessions and fresh worktrees for both arms. Do not reuse context, generated files, caches, or agent state between arms.
5. Use one approved provider and one pinned model for the complete evaluation. Do not switch provider, model, endpoint, or pricing during a pair.
6. Capture the complete transcript and all tool calls. Capture tool results and terminal exit codes.
7. Record wall-clock duration, token usage, cache usage, and billed amount for every run.
8. Record safety incidents separately. An incident includes hidden output, changed non-text content, leaked secret material, or an incorrect semantic transform.
9. Have an evaluator score task completion from the final repository state. Use the same rubric for both arms. Blind the evaluator to arm identity when practical.
10. Reconcile provider usage with local usage records. Preserve the raw provider response and the pricing snapshot.
11. Publish only an aggregate report after review. Keep task-level raw data private when it contains repository or prompt content.

The baseline and treatment are paired by task slot. A result is valid only when both runs complete with matching task inputs and provider metadata. An interrupted or incomplete pair is not a success or failure result.

Selected attempts must have matching prompt and scorer definition hashes.

## Aggregate real-run reporting

Reports use selected valid pairs for arm metrics. They write `summary.json`, `summary.md`, `pairs.csv`, `failures.json`, and `artifact-index.json`.

Reports contain no raw tool inputs, outputs, or matching JSONL lines. Tool calls count `tool_execution_start` events. Tool errors count `tool_execution_end` events with `isError: true`. Malformed JSONL counts non-empty lines that do not parse. Static mask counts use exact `[cm-masked ` occurrences.

Arm metrics cover scorer passes, score checks, duration statistics, first-event latency, token totals, and missing fields. They also cover proxy requests, tool calls, tool errors, malformed JSONL, and static mask placeholders.

First-event latency is measured from the persisted `piSpawnStartedAt` instant, captured immediately before the Pi process spawn. It never includes fixture preparation or workspace setup. Attempts recorded before this timing basis was introduced report no first-event latency, and such values are excluded from comparisons rather than relabeled.

Pair reports include fork-minus-upstream duration and token deltas. They include both-pass, upstream-only, fork-only, and both-fail outcomes. Numeric values remain `null` when unavailable. Incomplete and invalid pairs remain separate.

Two previous private real-run IDs are excluded from primary metrics. Pilot runs affected by scorer definition changes are also excluded from primary metrics.

## Required provider fields

Every run record must include the following provider data.

| Field | Required value |
| --- | --- |
| `provider` | Provider name and API mode |
| `model` | Exact model identifier |
| `modelVersion` | Provider version or deployment revision |
| `endpoint` | Region or deployment name, with secret portions removed |
| `apiVersion` | API version when available |
| `sdk` | Client name and version |
| `pricingSnapshot` | Price source and currency, with applicable token rates |
| `contextWindow` | Advertised context limit |
| `maxOutputTokens` | Requested output limit |
| `temperature` | Sampling temperature |
| `topP` | Sampling nucleus value when supported |
| `seed` | Seed when supported |
| `reasoning` | Reasoning mode and budget when supported |
| `toolSchemaVersion` | Tool definition version |
| `startedAt`, `finishedAt` | Timestamps with timezone |

A provider that cannot supply a field must record `null` and explain why. The evaluator must not infer missing cost or cache data.

## Result schema

Store one JSON object per run. Store no fabricated values. A not-run slot has `status: "not-run"` and `result: null`.

```json
{
  "taskId": "task-01",
  "arm": "baseline",
  "status": "not-run",
  "provider": {
    "provider": null,
    "model": null,
    "modelVersion": null,
    "endpoint": null,
    "apiVersion": null,
    "sdk": null,
    "pricingSnapshot": null,
    "contextWindow": null,
    "maxOutputTokens": null,
    "temperature": null,
    "topP": null,
    "seed": null,
    "reasoning": null,
    "toolSchemaVersion": null,
    "startedAt": null,
    "finishedAt": null
  },
  "result": {
    "taskSuccess": null,
    "qualityScore": null,
    "durationMs": null,
    "inputTokens": null,
    "outputTokens": null,
    "cacheReadTokens": null,
    "cacheWriteTokens": null,
    "billedAmount": null,
    "toolCalls": null,
    "safetyIncidents": [],
    "transcriptPath": null,
    "finalStatePath": null
  },
  "notes": ""
}
```

The example shows the field layout only. It is not an evaluation result. `qualityScore` must use a declared rubric. `billedAmount` must use the provider receipt or remain null.

## Acceptance thresholds

These thresholds apply only after all 20 pairs have valid records.

| Area | Threshold |
| --- | --- |
| Task success | Treatment can be at most five percentage points below baseline. |
| Safety | No secret leak, hidden output event, non-text mutation, or unsafe semantic rewrite is allowed. |
| Filter behavior | Failed output and unknown formats must remain visible in the safety corpus. |
| Hook runtime | Treatment p95 must remain within repository benchmark budgets. |
| Provider metadata | At least 95 percent of eligible runs must contain complete provider data. |
| Accounting | Cost and cache values must reconcile with provider records. |
| Recommendation | Any quality regression, safety incident, unreconciled spend, or repeatability failure blocks approval. |

These thresholds define acceptance. This run passed task success and recorded no malformed JSONL or duplicate invocation. Other gates still need separate review.

## Production-readiness gates

The run supports a qualified evaluation result, not a production approval. One stochastic run cannot establish causality or repeatability. Independent quality review, provider accounting reconciliation, broader safety review, and cross-environment repeatability remain open. This work does not include an approved release, publication, or upstream pull request.

The local synthetic benchmark is documented separately. It cannot close these gates because it excludes provider calls and task-quality judgment.

See [the checked-in result](results/upstream-vs-fork-glm-5.3-flash.md) and [the local comparator result](../benchmarks/comparison-results.json) for sanitized metrics.
