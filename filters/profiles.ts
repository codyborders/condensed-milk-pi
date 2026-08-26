/**
 * Profiles — backend-specific tuning bundles.
 *
 * v1.10.0 (Phase 1 of vLLM/Qwen support).
 *
 * Each profile bundles every knob that should change between Anthropic
 * (the original tuning target) and vLLM/Qwen (different cache model,
 * different long-context behavior, different placeholder norms). A user
 * picks one profile per session via `profile: "<name>"` in
 * `~/.config/condensed-milk.json`. No auto-detection — explicit only.
 *
 * Extending: drop a new entry in BUILT_IN_PROFILES, or add a custom
 * profile via the user config's `profiles` map.
 */

/** Policy for masking historical `<think>` / reasoning blocks.
 *  - "off"            never mask thinking (Anthropic default — extended
 *                     thinking is already cache-controlled)
 *  - "with-coverage"  mask thinking the same way tool results are masked
 *                     (idx < cutoffIdx; respects the static-cutoff zone)
 *  - "above-cutoff"   mask any thinking block at idx < cutoffIdx without
 *                     the MIN_MASK_LENGTH gate; aggressive mode for
 *                     long-context models with `preserve_thinking` on
 *                     where old reasoning is highest-value to drop */
export type ThinkingMaskPolicy = "off" | "with-coverage" | "above-cutoff";

/** Placeholder template strings. `{cmd}`, `{path}`, `{n}`, `{size}` are
 *  substituted at mask time. Templates MUST be deterministic — no
 *  timestamps, no random IDs — or cache prefix stability is broken.
 *  Tokens are kept short to minimize prefill cost when the model decides
 *  to skim a long masked region.
 *
 *  Anthropic-side default keeps the existing v1.9.0 `[cm-masked …]`
 *  format that downstream pi tooling already recognizes (e.g. session
 *  replay tools). Switching format on existing Anthropic sessions would
 *  invalidate previously-cached prefixes — the format change is opt-in
 *  per-profile precisely so that doesn't happen by accident. */
export interface PlaceholderTemplates {
  /** Substituted: {cmd} = first 80 chars of the bash command. */
  bash: string;
  /** Substituted: {path}, {n} (line count), {size} (formatted bytes). */
  read: string;
}

/** Profile shape — every backend-specific knob in one place. */
export interface Profile {
  /** Human-readable label. Shown in /compress-stats. */
  label: string;
  /** Pressure thresholds (monotonically increasing, 0..1). Cutoff
   *  advances when context usage crosses one of these. */
  thresholds: readonly number[];
  /** Coverage at each threshold (length === thresholds.length). */
  coverage: readonly number[];
  /** Effective context window cap. When set, used as the denominator
   *  in pressure math instead of the model's advertised context window.
   *  The qwen-vllm profile sets this to 131072 as part of its explicit
   *  compatibility preset. null = use the model's advertised context
   *  window unchanged. */
  effectiveContextCap: number | null;
  placeholderFormat: PlaceholderTemplates;
  maskOldThinking: ThinkingMaskPolicy;
}

/** Default profile — Anthropic compatibility. Identical to v1.9.0 behavior
 *  so upgrading users see zero behavior change. */
const DEFAULT_PROFILE: Profile = {
  label: "default (Anthropic compatibility)",
  thresholds: [0.30, 0.45, 0.60],
  coverage: [0.60, 0.80, 0.95],
  effectiveContextCap: null,
  placeholderFormat: {
    bash: "[cm-masked bash] {cmd}",
    read: "[cm-masked read] {path} ({n} lines, {size})",
  },
  maskOldThinking: "off",
};

/** Qwen on vLLM profile — explicit compatibility preset carried from prior
 *  configuration. Its values were not validated by the paired task study.
 *
 *  Thresholds are [0.20, 0.35, 0.55]. Coverage is [0.50, 0.75, 0.92].
 *  effectiveContextCap = 131072. These values are retained as preset
 *  configuration, without claims about context-window or model behavior.
 *
 *  Placeholder format stays at the default `[cm-masked …]` so selecting
 *  this profile does not change prefix format. The XML self-closing form
 *  remains available through custom profiles.
 *
 *  maskOldThinking = "with-coverage": historical `<think>` blocks are
 *  masked through the same coverage gate as tool results. */
const QWEN_VLLM_PROFILE: Profile = {
  label: "qwen-vllm (Qwen3.x on vLLM compatibility)",
  thresholds: [0.20, 0.35, 0.55],
  coverage: [0.50, 0.75, 0.92],
  effectiveContextCap: 131072,
  placeholderFormat: {
    bash: "[cm-masked bash] {cmd}",
    read: "[cm-masked read] {path} ({n} lines, {size})",
  },
  maskOldThinking: "with-coverage",
};

export const BUILT_IN_PROFILES: Readonly<Record<string, Profile>> = {
  default: DEFAULT_PROFILE,
  "qwen-vllm": QWEN_VLLM_PROFILE,
};

/** Partial override shape that users can supply per-profile in their
 *  config. Every field is optional — missing fields fall back to the
 *  built-in profile (or the default profile if the name isn't built in). */
export interface ProfileOverride {
  label?: string;
  thresholds?: readonly number[];
  coverage?: readonly number[];
  effectiveContextCap?: number | null;
  placeholderFormat?: Partial<PlaceholderTemplates>;
  maskOldThinking?: ThinkingMaskPolicy;
}

/** Resolve the active profile from:
 *   1. built-in profile by name (or built-in "default" if name unknown)
 *   2. user override under `profiles[name]`
 *   3. legacy top-level `thresholds`/`coverage` (back-compat for users
 *      with v1.9.x configs that predate profiles)
 *
 *  Validation: thresholds and coverage must remain monotonic and same
 *  length. Invalid overrides are silently dropped (logged via
 *  warnings[]) — never throws, so a malformed profile can't crash a
 *  session start.
 *
 *  Returns the resolved Profile plus warnings to surface in /compress-stats. */
export function resolveProfile(
  activeName: unknown,
  userProfiles: unknown,
  legacyTopLevel: unknown = {},
): { profile: Profile; activeName: string; warnings: string[] } {
  const warnings: string[] = [];
  const requestedName = typeof activeName === "string" ? activeName : "default";
  if (typeof activeName !== "string") {
    warnings.push("active profile name must be a string — falling back to \"default\"");
  }
  const profiles = isPlainObject(userProfiles) ? userProfiles : undefined;
  if (userProfiles !== undefined && profiles === undefined) {
    warnings.push("profiles must be a plain object — ignoring profile overrides");
  }

  // 1. Pick base profile by name.
  let base: Profile;
  let resolvedName = requestedName;
  if (hasOwn(BUILT_IN_PROFILES, requestedName)) {
    base = BUILT_IN_PROFILES[requestedName];
  } else if (profiles && hasOwn(profiles, requestedName)) {
    base = BUILT_IN_PROFILES.default;  // Custom name with no built-in → start from default.
  } else {
    warnings.push(
      `unknown profile "${requestedName}", falling back to "default". ` +
      `Built-in: ${Object.keys(BUILT_IN_PROFILES).join(", ")}.`,
    );
    base = BUILT_IN_PROFILES.default;
    resolvedName = "default";
  }

  // 2. Apply user override under profiles[name], if present.
  const override = profiles?.[resolvedName];
  let merged = applyOverride(base, override, warnings, `profiles.${resolvedName}`);

  // 3. Apply legacy top-level thresholds/coverage as a final override.
  //    Only when the active profile is "default" — applying legacy values
  //    to qwen-vllm would silently undo the profile's whole point.
  if (resolvedName === "default") {
    if (!isPlainObject(legacyTopLevel)) {
      warnings.push("top-level (legacy) must be a plain object — keeping base profile values");
    } else {
      merged = applyOverride(
        merged,
        {
          thresholds: legacyTopLevel.thresholds,
          coverage: legacyTopLevel.coverage,
        },
        warnings,
        "top-level (legacy)",
      );
    }
  }

  return { profile: merged, activeName: resolvedName, warnings };
}

function isPlainObject(value: unknown): value is Record<string, any> {
  if (typeof value !== "object" || value === null) return false;
  const prototype = Object.getPrototypeOf(value);
  return prototype === Object.prototype || prototype === null;
}

function hasOwn(value: object, key: PropertyKey): boolean {
  return Object.prototype.hasOwnProperty.call(value, key);
}

function applyOverride(
  base: Profile,
  override: unknown,
  warnings: string[],
  ctx: string,
): Profile {
  if (override === undefined) return base;
  if (!isPlainObject(override)) {
    warnings.push(`${ctx} must be a plain object — keeping base profile values`);
    return base;
  }
  const out: Profile = {
    label: base.label,
    thresholds: base.thresholds,
    coverage: base.coverage,
    effectiveContextCap: base.effectiveContextCap,
    placeholderFormat: base.placeholderFormat,
    maskOldThinking: base.maskOldThinking,
  };

  if (typeof override.label === "string") {
    out.label = override.label;
  } else if (override.label !== undefined) {
    warnings.push(`${ctx}.label must be a string — keeping base value`);
  }

  if (override.thresholds !== undefined || override.coverage !== undefined) {
    const rawThresholds = override.thresholds !== undefined ? override.thresholds : base.thresholds;
    const rawCoverage = override.coverage !== undefined ? override.coverage : base.coverage;
    const thresholdsValid = validateMonotonic(rawThresholds, ctx + ".thresholds", warnings);
    const coverageValid = validateCoverage(rawCoverage, ctx + ".coverage", warnings);
    if (thresholdsValid && coverageValid && rawThresholds.length === rawCoverage.length) {
      out.thresholds = rawThresholds;
      out.coverage = rawCoverage;
    } else if (thresholdsValid && coverageValid) {
      warnings.push(`${ctx}: thresholds.length (${rawThresholds.length}) !== coverage.length (${rawCoverage.length}) — keeping base profile values`);
    }
  }

  if (override.effectiveContextCap !== undefined) {
    if (override.effectiveContextCap === null ||
        (typeof override.effectiveContextCap === "number" &&
         override.effectiveContextCap > 0 &&
         Number.isFinite(override.effectiveContextCap))) {
      out.effectiveContextCap = override.effectiveContextCap;
    } else {
      warnings.push(`${ctx}.effectiveContextCap must be null or positive number — keeping base value`);
    }
  }

  if (override.placeholderFormat !== undefined) {
    const format = override.placeholderFormat;
    if (!isPlainObject(format)) {
      warnings.push(`${ctx}.placeholderFormat must be a plain object — keeping base value`);
    } else {
      const candidate = format as Partial<PlaceholderTemplates>;
      out.placeholderFormat = {
        bash: validateTemplate(candidate.bash, ["cmd"], ctx + ".placeholderFormat.bash", warnings)
          ?? base.placeholderFormat.bash,
        read: validateTemplate(candidate.read, ["path", "n", "size"], ctx + ".placeholderFormat.read", warnings)
          ?? base.placeholderFormat.read,
      };
    }
  }

  if (override.maskOldThinking !== undefined) {
    if (override.maskOldThinking === "off" ||
        override.maskOldThinking === "with-coverage" ||
        override.maskOldThinking === "above-cutoff") {
      out.maskOldThinking = override.maskOldThinking;
    } else {
      warnings.push(`${ctx}.maskOldThinking must be "off" | "with-coverage" | "above-cutoff" — keeping base value`);
    }
  }

  return out;
}

function validateMonotonic(arr: unknown, ctx: string, warnings: string[]): arr is readonly number[] {
  if (!Array.isArray(arr) || arr.length === 0) {
    warnings.push(`${ctx} must be non-empty number[]`);
    return false;
  }
  for (let i = 0; i < arr.length; i++) {
    if (typeof arr[i] !== "number" || !Number.isFinite(arr[i]) || arr[i] < 0 || arr[i] > 1) {
      warnings.push(`${ctx}[${i}] = ${String(arr[i])} must be number in [0, 1]`);
      return false;
    }
    if (i > 0 && arr[i] <= arr[i - 1]) {
      warnings.push(`${ctx} must be strictly increasing (got ${arr[i - 1]} >= ${arr[i]} at index ${i})`);
      return false;
    }
  }
  return true;
}

function validateCoverage(arr: unknown, ctx: string, warnings: string[]): arr is readonly number[] {
  if (!Array.isArray(arr) || arr.length === 0) {
    warnings.push(`${ctx} must be non-empty number[]`);
    return false;
  }
  for (let i = 0; i < arr.length; i++) {
    if (typeof arr[i] !== "number" || !Number.isFinite(arr[i]) || arr[i] < 0 || arr[i] > 1) {
      warnings.push(`${ctx}[${i}] = ${String(arr[i])} must be number in [0, 1]`);
      return false;
    }
  }
  return true;
}

function validateTemplate(
  value: unknown,
  allowed: readonly string[],
  ctx: string,
  warnings: string[],
): string | undefined {
  if (value === undefined) return undefined;
  if (typeof value !== "string") {
    warnings.push(`${ctx} must be a string — keeping base template`);
    return undefined;
  }
  const variables = value.match(/\{([^{}]*)\}/g) ?? [];
  for (const variable of variables) {
    const name = variable.slice(1, -1);
    if (!allowed.includes(name)) {
      warnings.push(`${ctx} contains unsupported variable ${variable} — keeping base template`);
      return undefined;
    }
  }
  return value;
}

/** Render a placeholder template with substitutions. Unknown placeholders
 *  are left as-is rather than throwing, so a user-supplied template that
 *  uses a token we don't substitute (e.g. `{stderr}`) just shows literally. */
export function renderPlaceholder(
  template: string,
  vars: { cmd?: string; path?: string; n?: number; size?: string },
): string {
  return template
    .replace(/\{cmd\}/g, vars.cmd ?? "")
    .replace(/\{path\}/g, vars.path ?? "")
    .replace(/\{n\}/g, vars.n !== undefined ? String(vars.n) : "")
    .replace(/\{size\}/g, vars.size ?? "");
}
