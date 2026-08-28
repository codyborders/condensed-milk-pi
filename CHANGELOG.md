# Changelog

## Unreleased

This work is not a release. It does not include publication or an upstream pull request.

### Safety

Bash processing now removes ANSI control sequences before optional compression. Environment redaction remains enabled by default and also covers short, failed, or compound output. It preserves all non-sensitive lines.

Bash results with multiple text blocks now receive environment redaction on each text block. ANSI removal still runs per block. Semantic filters still require a single text block, so no semantic filter processes partial blocks. Failed multi-block output keeps every diagnostic line.

Environment secret masking can no longer be disabled through global or project filter configuration. A disable attempt produces a warning and the filter stays enabled. Global configuration still enables default-off filters and controls every other default.

Semantic filters now require recognized formats. Failed commands, malformed data, uncertain shell syntax, unsupported pipelines, and unknown formats remain unchanged. Semantic compression requires one text block. Historical masking preserves non-text blocks and leaves failed tool results visible.

Default-on filters are limited to terminal pytest pass summaries, porcelain Git status, verbose Git log, and consecutive log deduplication. Higher-risk filters remain off. JSON structure extraction needs a global command allowlist plus a global filter setting.

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

README claims now distinguish local runtime measurements from provider results. The paired paid-task study remains not run because no paid-use approval was given. Its protocol and 20 task slots are recorded under `evaluation/`.
