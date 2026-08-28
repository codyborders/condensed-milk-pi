# Changelog

## 1.10.1-remediated.0

This prerelease identifies the maintained remediation fork at `https://github.com/codyborders/condensed-milk-pi`. It preserves upstream author credit from `tomooshi`. It does not claim production approval.

### Evaluation

One completed sanitized Z.AI run covered 20 valid task pairs and 40 selected attempts. This was one completed 20-pair stochastic study. Both arms passed all 20 tasks with zero measured quality difference. Results remain limited to one stochastic run, one model configuration, and the documented provider and review gaps. They do not establish broad savings or production readiness.

A second masking-focused study completed 48 paid attempts and 24 valid pairs. Both arms passed 21 attempts. Every masking and recovery gate passed. The fork used more reported tokens and more wall time. Rerun counts were equal, while the fork made fewer rereads. The result does not support a token-cost reduction claim.

This prerelease includes bounded output recovery.

## Unreleased

Follow-up work only. No additional release or publication is included here.

### Safety

Bash processing now removes ANSI control sequences before optional compression. Environment redaction remains enabled by default and also covers short, failed, or compound output. It preserves all non-sensitive lines.

Bash results with multiple text blocks now receive environment redaction on each text block. ANSI removal still runs per block. Semantic filters still require a single text block, so no semantic filter processes partial blocks. Failed multi-block output keeps every diagnostic line.

Environment secret masking can no longer be disabled through global or project filter configuration. A disable attempt produces a warning and the filter stays enabled. Global configuration still enables default-off filters and controls every other default.

Semantic filters now require recognized formats. Failed commands, malformed data, uncertain shell syntax, unsupported pipelines, and unknown formats remain unchanged. Semantic compression requires one text block. Historical masking preserves non-text blocks and leaves failed tool results visible.

Default-on filters are limited to environment redaction, terminal pytest pass summaries, and porcelain Git status. Git log compression and generic log deduplication now require global opt-in. Higher-risk filters remain off. JSON structure extraction needs a global command allowlist plus a global filter setting.

### Context processing

Historical masking still uses static cutoffs. A reverse invalidation index replaces repeated later-message scans. Working-directory parsing now handles quoted paths and prevents cross-repository invalidation when location cannot be resolved.

Historical tracking collections now retain at most 10,000 entries. They remove the oldest item when full. Image and custom content blocks keep their original order during masking.

### Output recovery

Lossy semantic summaries and historical result masks now archive complete ordered content blocks before replacement. Stable opaque references support exact byte paging, tail reads, literal search, and restricted regex search through `condensed_milk_retrieve`.

Archives are local, session-scoped, permission-restricted, and bounded by entry count, entry size, aggregate size, and lifetime. Storage and retrieval apply mandatory environment-line redaction. A failed archive operation leaves original redacted output visible and skips the lossy transform.

### Configuration

Global settings can control registered filters. Project settings can narrow enabled behavior but cannot enable default-off filters. Project settings also cannot disable environment redaction.

Rules files now receive strict runtime validation. Invalid JSON, wrong field types, malformed rules, invalid regular expressions, and read failures identify the source path. Profile validation now rejects unsafe arrays, caps, templates, and thinking policies while retaining base values.

### Quality checks

The repository now pins the current pi development dependency. It includes strict TypeScript checking, fixture tests, GitHub Actions, and deterministic context-hook benchmarks.

The benchmark records local median and p95 runtime across 36 synthetic cases. These measurements do not establish provider cost, model quality, or production readiness.

### Migration

Recognized v1.6.x generated defaults still migrate to current thresholds and coverage. Other values remain user customizations. The former `windowSize` setting remains ignored after the static-cutoff change.

Risky filters that previously ran automatically are now disabled unless the global configuration enables them. Review custom filter settings before use.

### Documentation

README claims distinguish local runtime measurements from the completed sanitized provider result. Documentation records the one 20-pair stochastic run, its limits, migration paths, stable filter IDs, prerelease pinning, and rollback guidance.
