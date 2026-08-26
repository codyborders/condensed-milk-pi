# Paired task evaluation

## Status

The planned evaluation contains 20 paired paid tasks. None of these tasks were run. This document records protocol and acceptance criteria. It records no task results, provider measurements, or fabricated metrics.

No provider spend occurred. Paid provider use requires explicit approval. No approval was given for this evaluation, so no paid calls were made.

Production-readiness gates remain unmet. Missing data includes paired task outcomes, independent quality review, provider accounting, safety review, and repeatability across environments.

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

The baseline and treatment are paired by task slot. A result is valid only when both runs complete with matching task inputs and recorded provider metadata. An interrupted or incomplete pair is not a success or failure result.

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

These thresholds define acceptance. No observed results exist because the evaluation was not run.

## Production-readiness gates

All production-readiness gates remain open. The 20 paired tasks have not run, and no provider accounting exists. No blinded quality comparison or cross-environment safety review exists. Repeatability has not been measured. This work does not include an approved release, publication, or upstream pull request.

The local synthetic benchmark is documented separately. It cannot close these gates because it excludes provider calls and task-quality judgment.
