# Condensed Milk

Condensed Milk is a pi terminal extension that reduces repetitive bash output and masks stale tool results before an LLM call. It uses deterministic, domain-aware transforms. It is not a general-purpose output truncator.

This repository is the maintained remediation fork of upstream Condensed Milk. The fork keeps upstream author credit and uses prerelease `1.10.1-remediated.0` under the `@codyborders` scope. It does not claim production approval.

Upstream v1.10.0 remains the reference baseline. Selecting upstream retains upstream behavior. This fork changes defaults and safety handling as documented below. Experimental filters stay disabled unless explicitly enabled. This prerelease includes bounded output recovery.

Fork defaults include ANSI stripping, mandatory environment redaction, validated safe semantic filters, and static-cutoff masking. Experimental opt-in filters remain separate from these defaults.

## Safety-first defaults

The extension applies ANSI escape-code removal to every text block in bash output. It removes cosmetic CSI and OSC sequences before other processing. It does not remove ordinary text.

The default semantic filters are deliberately small:

- `env` and `printenv` redact sensitive environment values.
- `pytest`, `python -m pytest`, and `python3 -m pytest` compress only a positively identified terminal all-pass summary. Known skip, deselection, and warning counts are allowed. Failures, errors, interruptions, and uncertain streams pass through unchanged.
- `git status --short` and `git status --porcelain` summarize validated porcelain v1 or v2 output. Unknown status formats pass through unchanged. Plain `git status` output is not summarized unless its command requests a supported porcelain form.

The context hook uses static-cutoff historical masking. Context pressure crosses thresholds `[0.30, 0.45, 0.60]`. Each zone freezes its cutoff at entry with coverage `[0.60, 0.80, 0.95]`. The cutoff does not drift as messages arrive. Older bash and read results become deterministic `[cm-masked ...]` placeholders. Reference files remain visible. A compaction event resets cutoff and tracker state.

Masking is not semantic summarization. It preserves the command or path so an agent can rerun or reread it. It masks only tool results that meet the size and safety rules. Failed tool results are not historically masked.

### Filters that are off by default

Lossy or higher-risk filters remain disabled until explicitly enabled in the global configuration. This is the experimental opt-in set. The following stable IDs remain across this fork as configuration keys:

- Safe defaults: `environment-secrets`, `pytest`, and `git-status-porcelain`.
- Experimental opt-ins: `git-log-verbose`, `log-deduplication`, `git-diff`, `git-add`, `git-commit`, `git-push`, `ls`, `find`, `tree`, search filters, traceback filters, build filters, linter filters, test-runner filters, package-install filters, and `json-schema`.

Use `/compress-stats` to see every registered command and its stable ID. Configure IDs in `~/.config/condensed-milk.json`. Do not use command text as a replacement key.

This includes:

- `git log` compression and generic log deduplication
- `git diff`, Git mutation summaries for `git add`, `git commit`, and `git push`
- `ls`, `find`, `tree`, `grep`, `rg`, and other search or listing summaries
- Python traceback summaries, TypeScript compiler summaries, linter summaries, build summaries, and JavaScript test-runner summaries
- Package-install summaries
- JSON schema extraction

ANSI removal and environment secret redaction are not optional semantic filters. Secret redaction can produce longer text because privacy takes priority over compression.

## Output safety contract

The dispatcher applies a transform only when its parser confirms the expected format and the result is strictly shorter. It does not use a generic JSON or unknown-format fallback. Malformed JSON, unknown output, uncertain shell syntax, unsupported pipelines, and failed semantic commands pass through unchanged.

Environment privacy has one explicit exception. The environment filter is allowed to process failed output, compound output, short output, and output where `[REDACTED]` is longer than the original value. It preserves non-sensitive lines byte-for-byte and only changes values for sensitive variable names. Neither global nor project configuration can disable this filter. A disable attempt produces a warning, and the filter stays enabled.

Semantic dispatch requires exactly one text block in each bash tool result. With multiple text blocks, the extension strips ANSI from each text block. It also applies mandatory environment secret redaction to each text block. Semantic compression stays off because blocks are partial fragments. Failed and unknown output is preserved except for ANSI removal and mandatory environment redaction. Non-text blocks remain in place and unchanged. The extension processes output after pi's normal 50 KB tool-result cap.

A command chain with two or more output-producing segments does not receive a semantic prefix filter. A small explicit allowlist treats `cd`, `export`, `set`, `unset`, `source`, `.`, `true`, `false`, and `:` as silent. Environment redaction still protects the combined text. Supported output pipes are limited to `head`, `tail`, `wc`, `sort`, and `uniq`. Other pipelines pass through.

## Output recovery

Lossy semantic summaries and historical masks include a stable `[cm-archive ID]` reference. The extension writes the complete ordered content-block array before replacing visible information. Reprocessing the same tool result in one session reuses the same reference.

Use `condensed_milk_retrieve` with the reference. Page mode accepts `offset` and `limit` as UTF-8 byte positions over a deterministic JSON form. Responses state the next offset and use text or base64 encoding. Concatenating decoded page bytes reconstructs the stored form exactly. Tail mode returns trailing text. Literal and restricted regex searches return bounded matching lines. Page, tail, literal, and regex modes cannot be combined.

Archives stay under `~/.pi/agent/condensed-milk-recovery` in opaque session directories. On supported systems, session directories use mode `0700`. Entry files use mode `0600`. The extension does not upload archives.

Storage strips ANSI codes and applies mandatory environment-line redaction before writing. Retrieval applies that redaction again. Non-text blocks remain unchanged, so users must treat local archive access like local session-file access.

Default retention allows 128 entries, 64 KiB per entry, 4 MiB per session, and a 24-hour lifetime. Cleanup runs at session start and after writes. Old entries leave bounded tombstones so retrieval can distinguish expiry from capacity eviction. Oversize output, unavailable storage, failed verification, or retention of a new entry causes the lossy transform to stop. Original redacted output remains visible.

## Installation

Install pinned prerelease through pi or npm:

```bash
pi install npm:@codyborders/condensed-milk-pi@1.10.1-remediated.0
npm install @codyborders/condensed-milk-pi@1.10.1-remediated.0
```

Install the tagged fork directly from its Git URL when a Git checkout is required:

```bash
pi install https://github.com/codyborders/condensed-milk-pi@v1.10.1-remediated.0
```

For local work, clone the fork and link it into the pi extensions directory:

```bash
git clone https://github.com/codyborders/condensed-milk-pi.git ~/condensed-milk-pi
ln -s ~/condensed-milk-pi ~/.pi/agent/extensions/condensed-milk
```

The extension loads automatically. Use `/compress-stats` to inspect filter, masking, and cache telemetry. Use `/compress-config` to view or change thresholds, coverage, and the status-bar indicator.

## Configuration

The cutoff configuration is global and lives at `~/.config/condensed-milk.json`. Project-local cutoff overrides are not supported. This single source keeps static-cutoff behavior and placeholder bytes consistent across a session.

```json
{
  "thresholds": [0.30, 0.45, 0.60],
  "coverage": [0.60, 0.80, 0.95],
  "showStatus": true,
  "archive": {
    "enabled": true,
    "maxEntries": 128,
    "maxEntryBytes": 65536,
    "maxAggregateBytes": 4194304,
    "ttlMs": 86400000
  },
  "filters": {
    "git-diff": false,
    "json-schema": false
  },
  "jsonSchemaCommands": ["curl", "gh api"]
}
```

Global `filters` values are booleans keyed by registered filter ID. The global file can enable or disable any registered filter except `environment-secrets`, including filters that are off by default. A global attempt to disable `environment-secrets` produces a warning and the filter stays enabled. Invalid IDs or non-boolean values produce warnings and are ignored.

Archive limits must be positive safe integers within fixed ceilings. Invalid values keep conservative defaults and produce warnings. Disabling archives also disables lossy semantic compression and historical result masking because unrecoverable transforms fail open.

Project filter configuration is optional at `./condensed-milk.config.json`:

```json
{
  "filters": {
    "pytest": false
  }
}
```

Project configuration can disable an enabled filter. It cannot enable a filter that is default-off, and it cannot disable `environment-secrets`. Project settings cannot register JSON schema commands. Global configuration therefore owns explicit opt-ins for risky filters.

### Explicit JSON schema allowlist

JSON structure extraction has no generic fallback. To enable it, add command prefixes to the global `jsonSchemaCommands` array and set the global `filters.json-schema` value to `true`:

```json
{
  "jsonSchemaCommands": ["curl", "gh api"],
  "filters": { "json-schema": true }
}
```

The filter parses only valid top-level objects or arrays. It emits types, object keys, and array lengths without scalar values. Malformed, uncertain, or non-shorter output passes through. The allowlist is global-only and applies only to the listed command prefixes.

### Reference files and invalidation rules

Reference protection and invalidation rules use separate files. The global rules file is `~/.pi/agent/condensed-milk-config.json`. The project rules file is `./condensed-milk.config.json`. Arrays merge additively across both files.

```json
{
  "referenceBasenames": ["spec.yaml"],
  "referencePathSubstrings": ["/openapi/"],
  "invalidationRules": [
    {
      "invalidator": "^cargo\\s+(build|update)\\b",
      "invalidated": "^cargo\\s+(check|clippy)\\b"
    }
  ],
  "disableDefaults": false
}
```

Reference basenames and path substrings prevent historical read masking. Invalidation rules mark earlier matching bash results stale in the same working directory. Built-in rules cover common Git mutations, package installation commands, and `pip install`. `cd` prefixes are stripped for matching. Unresolved shell expansions and cross-directory commands do not invalidate one another.

Rules validation is strict. Each file must contain a plain JSON object. Arrays must contain strings. Each invalidation rule must contain string regex sources that compile successfully. `disableDefaults` must be boolean. Missing files are allowed. Invalid JSON, invalid values, permission failures, and other read failures stop extension loading with an error rather than silently changing behavior. A file that sets `disableDefaults` removes built-in reference and invalidation defaults before user arrays are applied.

### Profiles and validation

Profiles bundle thresholds, coverage, an optional effective context cap, deterministic placeholder templates, and historical thinking masking. `default` is Anthropic-compatible. `qwen-vllm` is an explicit compatibility preset carried from prior configuration. It uses an effective cap of `131072`, earlier thresholds, and coverage-based historical thinking masking. These values were not validated by the paired task study. Profile selection is explicit. There is no backend auto-detection.

Profile arrays must be non-empty numbers in `[0, 1]`. Thresholds must be strictly increasing. Coverage length must match threshold length. A context cap must be null or a positive finite number. Templates must be strings with only supported variables. `maskOldThinking` must be `off`, `with-coverage`, or `above-cutoff`. Invalid profile overrides produce validation warnings and retain base values. Unknown profile names fall back to `default`. Profile validation does not crash session start.

### Migration from upstream v1.10.0

The fork retains upstream configuration paths: global cutoff settings at `~/.config/condensed-milk.json`, global rules at `~/.pi/agent/condensed-milk-config.json`, and project rules at `./condensed-milk.config.json`. Existing filter IDs remain configuration keys. Review settings after switching from upstream v1.10.0 because this fork enables only its safety-reviewed defaults. Git log compression and generic log deduplication now require global opt-in.

Configurations carrying the recognized v1.6.x defaults, thresholds `[0.20, 0.35, 0.50]` and coverage `[0.50, 0.75, 0.90]`, migrate automatically to current defaults on session start. A matching tuple is treated as stale generated configuration. Other threshold or coverage values remain explicit customization. The old v1.1.x `windowSize` setting is ignored because static-cutoff masking replaced the rolling window.

Pin prerelease installs to `1.10.1-remediated.0`. To roll back, remove the scoped fork and reinstall upstream v1.10.0 from its original package or repository. Do not reuse fork-only opt-ins when rolling back.

## Bounded telemetry

Historical re-read trackers and unique-mask sets are bounded insertion-ordered collections. Each has a maximum of 10,000 entries. When full, the oldest entry is evicted. This bounds memory use but means telemetry may omit re-read relationships for evicted entries.

Local session telemetry is separate and disabled by default. It writes only after graceful shutdown when explicitly enabled. It records aggregate counts, timing, thresholds, cache counters, and truncated hashes. It does not record message content, tool output, file paths, environment variables, API keys, or identity information. No automatic upload exists.

## Commands

| Command | Purpose |
| --- | --- |
| `/compress-stats` | Show active profile, filter totals, historical masks, re-read counters, and provider-reported cache counters. |
| `/compress-config` | Show or change thresholds, coverage, or the status-bar indicator. |
| `/compress-profile` | Show or select a named profile for the next session. |
| `/compress-telemetry` | Show local telemetry disclosure or manage explicit local logging. |

The cache section is diagnostic. Provider-reported cache counters can be missing on some OpenAI-compatible servers. Do not treat the displayed dollar values as a universal cost estimate.

## Development checks

Run the focused test suite and static checks from the repository root:

```bash
npm test
npm run typecheck
npm run benchmark
```

`npm test` runs the repository's fixture and regression tests. `npm run typecheck` runs TypeScript without emitting files. `npm run benchmark` runs the deterministic context-hook benchmark and checks its local budgets. See [benchmarks/README.md](benchmarks/README.md) for interpretation limits.

## Benchmark and evaluation status

The benchmark is a local synthetic performance check. It does not establish provider cost, task quality, safety in every shell environment, or production readiness. One completed sanitized Z.AI run covered 20 valid task pairs and 40 selected attempts. This was one completed 20-pair stochastic study. Both arms passed all 20 tasks, with zero measured quality difference. The run used `glm-5.3-flash`, Pi `0.84.2`, `high` thinking, and the `qwen-vllm` profile. Its aggregate token and timing deltas are descriptive only. They do not establish causality, broad savings, or production approval. Independent quality, accounting, safety, and repeatability review remain open. The protocol, limits, and sanitized result are documented in [evaluation/paired-task-evaluation.md](evaluation/paired-task-evaluation.md).

## Architecture

- `tool_result` strips ANSI and applies one configured bash filter to a single text block. Lossy output is archived first.
- `context` receives a copy of conversation history and applies deterministic static-cutoff masking to eligible historical results. Each masked result must receive an archive reference.
- `condensed_milk_retrieve` reads only the current session archive through bounded page or search operations.
- Filter modules register command prefixes. Longest matching prefix wins.
- Filters return `null` when format, safety, or output-size checks fail. The original output then remains visible.

The extension intentionally does not filter file content such as `cat`. Full source text is needed for reliable coding edits.

## License

MIT
