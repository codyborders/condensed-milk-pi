# Provider Study Protocol

Four-arm, blinded, pre-registered evaluation of Condensed Milk provider-cost effects in pi terminal.

## Arms

Four immutable baseline arms use the same retrieval tool interface. Each arm receives the shared `--tools` list and one `condensed_milk_retrieve` tool. The tool uses one canonical parameter schema.

| Arm | Implementation | Config bytes | Retrieval |
| --- | --- | --- | --- |
| `none` | No Condensed Milk production extension loads. Only the neutral stub registers the retrieval tool. | `profiles/neutral-none.json` | neutral unavailable |
| `upstream` | Verified tomooshi main `71f9e396951c42687f0c3456727b2b5c8c625da1` plus the neutral stub. | `profiles/neutral-none.json` | neutral unavailable |
| `remediated-defaults` | Remediated commit `8c267c48d71507a300ec5bcbbe211a643ae417bb` with shipped defaults. Here `archive.enabled` is false. | `profiles/remediated-defaults.json` | exact |
| `remediated-archive` | Same commit with only `archive.enabled` true. | `profiles/remediated-archive.json` | exact |

Arm identity hashes bind the arm definition, its exact config bytes, and the neutral stub bytes. A run pinning one arm identity refuses any other configuration.

## Shared execution pins

These pins are frozen for every arm and phase.

| Condition | Frozen value |
| --- | --- |
| Provider route | `z-ai` |
| Model and thinking | `glm-5.3-flash`, `high` |
| Pi runtime | `0.84.2` with executable digest pinning |
| Prompt | Checked-in attempt rules plus exact task text |
| Timeout | 3600000 milliseconds per attempt |
| Retry | No paid retry. Each attempt runs at most once. |
| Environment | `PATH`, `HOME`, `TMPDIR`, and `PI_CODING_AGENT_DIR` only |
| Isolation | Fresh `HOME`, session directory, agent directory, fixture copy, and arm worktree |

Each fixture copy must match its cached content and Git-state digests. System rules and tool lists remain identical across arms.

## Phases and tasks

Development uses exactly 12 exposed general tasks from `development-manifest.json`. These tasks are used only for diagnosis and optimization.

Holdout uses exactly 8 new tasks in authenticated encrypted `holdout.enc`. Its public manifest contains IDs, coverage, hashes, and non-sensitive execution pins. The tasks cover noisy tests, build failures, large diffs, repeated reads, search, repetitive logs, and command outcomes. They also cover long masking pressure, exact diagnostics, archive recovery, and multi-step implementation with tests and status.

The phases use separate commands and run roots. Cross-phase reads are refused before any fixture opens. Every holdout command requires an explicit external key source. The command appends to the access ledger before authenticated decryption. Decrypted bytes exist only in a command-private temporary directory, which is removed after success or failure.

The task author saw holdout definitions while sealing them. No real holdout result existed before sealing. Optimization agents receive no key path or plaintext holdout data.

## Design

Randomized complete blocks. Each task gets five preallocated repetitions. Each block contains all four arms in one seeded permutation. The permutation comes from the phase seed. The schedule is a pure function of the phase manifest and seed. The plan hash therefore reproduces exactly across processes and runs. Conditional repetitions 6-10 exist in the plan. They run only under the five-to-ten rule.

## Runner requirements

The runner supports four arms and five preallocated repetitions. Repetitions 6-10 are conditional. Reservations fail closed, and completed slots never run again. A receipt without a terminal result is abandoned and refused.

Artifacts use no-overwrite writes. A resumed phase skips completed slots without invoking them again. `prepare` stores the exact plan under the phase run root and refuses an existing lock. Every attempt starts after a clean-worktree check.

## Attempt metrics

Each attempt records uncached input, cache read, cache write, and output. Each category is preserved verbatim, including unknown provider usage fields. Each attempt also records the summed provider total, peak provider context, wall time, and first-event latency.

Proxy records are authoritative for model request counts. Results keep status counts, failed provider requests, rejected proxy requests, and assistant completion counts separately. A mismatch between provider requests and assistant completions is reported.

Each attempt records tool calls, shell reruns, file rereads, test reruns, and build reruns. It also records compression events and historical mask events. Archive references, retrieval calls, failures, deterministic results, and blinded quality scores remain separate. Failed tasks remain in reports. Failed tasks never count as savings.

## Blinded judging

`judge-export` writes anonymous cases. Cases carry no arm identity, tokens, timing, transcripts, archive markers, model, or run order. Each case includes the task prompt and frozen rubric. It also includes initial bytes for changed files and complete final changed-file bytes. A file above 256 KiB or case above 2 MiB refuses export instead of dropping content.

The arm mapping lives beside the cases under a mapping digest. `judge-import` validates that digest. One frozen quality score lands per attempt and is never overwritten. Base and conditional repetitions use the same slot enumeration.

Judge execution uses a separate schedule, proxy ledger, and provider usage ledger. A case may retry up to three times after invalid or failed judge responses. Judge usage is excluded from all plugin token totals.

## Statistics

Use matched complete blocks only. Reject every incomplete block.

Primary endpoint: success-only total provider tokens. Compare `remediated-defaults` against `upstream`.

Report results per task and per arm. Include mean and median paired changes. Include percentages. Include a seeded task-clustered bootstrap 95 percent interval. Include a paired-t sensitivity interval. Include success differences, latency, reruns, and rereads.

Five-to-ten rule: run repetitions 6-10 when the primary interval includes zero. Missing, null, invalid, incomplete, or unusable intervals also require extension. Run all conditional repetitions for every task and arm. After repetition 10, report an inconclusive interval without more calls.

## Free commands and paid boundary

Free commands are `validate`, `freeze`, `fixtures`, `plan`, `dry-run`, `report`, `status`, and `judge-export`. Paid commands are `run` and `judge-run`. They require `--confirm-paid` and an explicit `--credential-source` path. Holdout fixture checks, dry-runs, paid runs, and judge exports also require `--holdout-key-source`.

Credential and key paths are CLI-only and never persisted. Private runs default to an external cache directory outside this repository. Sanitized reports are new files under `evaluation/results/provider-study/`. Reports never overwrite older reports.

## Freeze

`freeze` binds the evaluator source digest and evaluator commit. It binds the encrypted holdout envelope and public manifests. It also binds profiles, neutral retrieval bytes, runner modules, shared evaluation modules, and development scorers. Task manifests, judge rules, statistical code, plans, seeds, provider, model, and Pi pins are included.

The frozen evaluator commit must remain an ancestor of the current checkout. Evaluator source bytes must remain unchanged. This permits later production-only optimization commits while preventing evaluator drift. Paid execution refuses any mismatch before reservation.
