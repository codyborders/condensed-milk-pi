/**
 * Context-level retroactive compression — static-cutoff observation masking.
 *
 * v1.6.0 (ADR-024): cwd-aware invalidation + user-configurable rules.
 * v1.2.0 (ADR-018): static cutoff replaces rolling window.
 *
 * The mask cutoff T advances only when context usage crosses a pressure
 * threshold. Between advances, T is immutable → bytes before T stay
 * byte-identical turn-over-turn → cache prefix stays stable and the
 * mask-frontier drift bug of v1.1.x is eliminated.
 *
 * Measured on a real 1114-turn session:
 * - Rolling window N=10 (v1.1.1):  316 cache variants, $1594
 * - Static cutoff thresholds [0.20/0.35/0.50]:  159 variants, $1346
 * - No masking at all:              157 variants, $1414
 *
 * Rolling window was actively harmful (more expensive than no masking).
 * Static cutoff saves 16% vs rolling and 5% vs no-masking baseline.
 *
 * v1.7.0 (ADR-025): delayed thresholds [0.30/0.45/0.60] with coverage
 * [0.60/0.80/0.95] measured 0.5–19% cheaper than prior [0.20/0.35/0.50]
 * × [0.50/0.75/0.90] across 4 real sessions. Biggest wins on long
 * sessions with heavy post-zone-2 traffic. See
 * knowledge/findings/adr-020-sweep-and-bash-invalidation-audit.md.
 *
 * Why masking over summarization still holds (ADR-016): deterministic
 * byte-identical placeholders, JetBrains empirical advantage, agent
 * re-reads via just-in-time pattern.
 *
 * v1.10.0 (Phase 1 of vLLM/Qwen support): per-profile placeholder
 * templates and an optional historical thinking-block masking pass.
 */

import type { PlaceholderTemplates, ThinkingMaskPolicy } from "./profiles.js";
import { renderPlaceholder } from "./profiles.js";

/** Context-usage thresholds that trigger cutoff advancement.
 *  Must be monotonically increasing.
 *
 *  v1.7.0 (ADR-025): delayed from [0.20, 0.35, 0.50] to [0.30, 0.45, 0.60]
 *  after multi-session sweep found it saves 0.5–19% across real workloads
 *  with no regressions. Biggest wins on long sessions that continue past
 *  zone 2 entry — current-default cutoffs crystallize too early relative
 *  to how much session is still coming. Users targeting short sessions
 *  can override via `~/.config/condensed-milk.json`. */
const DEFAULT_THRESHOLDS: readonly number[] = [0.30, 0.45, 0.60];

/** Coverage at each threshold — fraction of current messages masked
 *  when that threshold first fires. Monotonically increasing.
 *  Length MUST match DEFAULT_THRESHOLDS.
 *
 *  v1.7.0: bumped to [0.60, 0.80, 0.95] (from [0.50, 0.75, 0.90]).
 *  Higher coverage was consistent 0.2–0.4% win on all sessions tested. */
const DEFAULT_COVERAGE: readonly number[] = [0.60, 0.80, 0.95];

/** Minimum tool-result size to mask. Below this, placeholder ≈ content → no win. */
const MIN_MASK_LENGTH = 120;

/** Default command-invalidation rules: when `invalidator` command runs,
 *  any earlier output matching `invalidated` becomes stale. These still
 *  fire immediately regardless of cutoff — staleness is semantic, not
 *  position-based.
 *
 *  v1.6.0: matched against `cd`-stripped command text. Matching is
 *  further scoped by cwd tuple in `isCommandInvalidated`. */
const DEFAULT_INVALIDATION_RULES: readonly { invalidator: RegExp; invalidated: RegExp }[] = [
  { invalidator: /^git\s+(add|rm|checkout|reset|stash|merge|rebase|cherry-pick)\b/, invalidated: /^git\s+status\b/ },
  { invalidator: /^git\s+(commit|merge|rebase)\b/, invalidated: /^git\s+(diff|log)\b/ },
  { invalidator: /^(npm|pnpm|yarn|bun)\s+(install|add|remove)\b/, invalidated: /^(npm|pnpm|yarn|bun)\s+(ls|list|outdated)\b/ },
  { invalidator: /^pip\s+install\b/, invalidated: /^pip\s+(list|freeze)\b/ },
];

/** Default basenames always treated as reference — never masked. */
const DEFAULT_REFERENCE_BASENAMES: readonly string[] = [
  // Agent instructions
  "AGENTS.md", "CONVENTIONS.md", "CLAUDE.md", "GEMINI.md",
  "SKILL.md",
  // Lint/format config
  ".ruff.toml", "ruff.toml", "biome.json",
  "pyproject.toml", "package.json", "tsconfig.json",
  "sgconfig.yml", ".shellcheckrc",
  // Project meta often re-read across a session
  "README.md", "CHANGELOG.md",
];

/** Default path substrings — any file under these trees is reference. */
const DEFAULT_REFERENCE_PATH_SUBSTRINGS: readonly string[] = [
  "/knowledge/decisions/",
  "/knowledge/concepts/",
  "/knowledge/patterns/",
  "/.pi/agent/skills/",
  "/.pi/skills/",
  "/rules/",
];

/** v1.6.0: strip iterative `cd <path> && ` prefixes, returning the
 *  last-seen cwd (effective working directory after all chained cds)
 *  and the residual command to match against invalidation regexes.
 *
 *  The public shape stays small for callers. The internal parser also tracks
 *  whether an explicit cwd was unresolved, so unknown paths never invalidate.
 *  Pure function. Deterministic. Cache-safe. */
export function parseCdPrefix(cmd: string): { cwd?: string; cmd: string } {
  const parsed = parseCdPrefixDetailed(cmd);
  return { cwd: parsed.cwd, cmd: parsed.cmd };
}

type ParsedCd = { cwd?: string; cmd: string; hasCd: boolean; cwdResolved: boolean };

function parseCdPrefixDetailed(cmd: string): ParsedCd {
  let cwd: string | undefined;
  let current = cmd;
  let hasCd = false;
  let cwdResolved = true;
  for (;;) {
    const prefix = parseCdPrefixOnce(current);
    if (prefix.kind === "none") break;
    hasCd = true;
    if (prefix.kind === "unresolved") {
      cwd = undefined;
      cwdResolved = false;
      break;
    } else {
      cwd = normalizeCwd(prefix.cwd);
      if (cwd === undefined) cwdResolved = false;
    }
    current = prefix.cmd;
  }
  return { cwd, cmd: current, hasCd, cwdResolved };
}

type CdPrefix =
  | { kind: "none" }
  | { kind: "unresolved"; cmd: string }
  | { kind: "resolved"; cwd: string; cmd: string };

function parseCdPrefixOnce(cmd: string): CdPrefix {
  if (!/^cd(?:[ \t]+)/.test(cmd)) return { kind: "none" };
  let i = 2;
  while (i < cmd.length && (cmd[i] === " " || cmd[i] === "\t")) i++;
  if (i >= cmd.length) return { kind: "unresolved", cmd };

  const quote = cmd[i] === "'" || cmd[i] === '"' ? cmd[i++] : undefined;
  let cwd = "";
  let unresolved = false;
  let closed = !quote;
  for (; i < cmd.length; i++) {
    const ch = cmd[i];
    if (quote) {
      if (ch.charCodeAt(0) === 92 && quote === '"' && i + 1 < cmd.length) {
        cwd += cmd[++i];
        continue;
      }
      if (ch === quote) { closed = true; i++; break; }
      cwd += ch;
      if (quote === '"' && (ch === "$" || ch === "`")) unresolved = true;
    } else {
      if (ch.charCodeAt(0) === 92 && i + 1 < cmd.length) { cwd += cmd[++i]; continue; }
      if (ch === " " || ch.charCodeAt(0) === 9) break;
      cwd += ch;
      if (ch === "$" || ch === "`" || ch === "*" || ch === "?" || ch === "[") unresolved = true;
    }
  }
  if (!closed || cwd.length === 0) return { kind: "unresolved", cmd };
  while (i < cmd.length && cmd.charCodeAt(i) <= 32) i++;
  if (!cmd.startsWith("&&", i)) return { kind: "unresolved", cmd };
  i += 2;
  while (i < cmd.length && cmd.charCodeAt(i) <= 32) i++;
  if (i >= cmd.length) return { kind: "unresolved", cmd };
  if (unresolved) return { kind: "unresolved", cmd: cmd.slice(i) };
  return { kind: "resolved", cwd, cmd: cmd.slice(i) };
}

function normalizeCwd(cwd: string): string | undefined {
  if (cwd.length === 0) return undefined;
  // Shell expansion and globbing do not identify one stable directory.
  if (/[ `$*?\\[\\]]/.test(cwd)) return undefined;
  const absolute = cwd.startsWith("/");
  const parts: string[] = [];
  for (const part of cwd.split("/")) {
    if (part === "" || part === ".") continue;
    if (part === ".." && parts.length > 0 && parts[parts.length - 1] !== "..") parts.pop();
    else if (part !== "..") parts.push(part);
    else if (!absolute) parts.push(part);
  }
  const normalized = parts.join("/");
  return absolute ? `/${normalized}` : normalized || ".";
}

// ── v1.6.0 config + rule resolution (pure, no IO) ──

/** User-supplied config shape. Populated from JSON files by index.ts
 *  (IO at the extension boundary; filter module stays pure). */
export interface UserConfig {
  referenceBasenames: string[];
  referencePathSubstrings: string[];
  invalidationRules: { invalidator: string; invalidated: string }[];
  disableDefaults: boolean;
}

export function emptyUserConfig(): UserConfig {
  return { referenceBasenames: [], referencePathSubstrings: [], invalidationRules: [], disableDefaults: false };
}

function isPlainJsonObject(value: unknown): value is Record<string, unknown> {
  if (value === null || typeof value !== "object" || Array.isArray(value)) return false;
  const prototype = Object.getPrototypeOf(value);
  return prototype === Object.prototype || prototype === null;
}

function invalidConfig(sourcePath: string, detail: string): never {
  throw new Error(`condensed-milk: invalid rules config '${sourcePath}': ${detail}`);
}

/** Validate one JSON rules file at the extension boundary. Missing fields use
 *  empty defaults so global and project configs can merge additively. */
export function validateUserConfig(value: unknown, sourcePath: string): UserConfig {
  if (!isPlainJsonObject(value)) invalidConfig(sourcePath, "top level must be a plain JSON object");

  const config = emptyUserConfig();
  if (Object.prototype.hasOwnProperty.call(value, "referenceBasenames")) {
    const basenames = value.referenceBasenames;
    if (!Array.isArray(basenames) || !basenames.every((entry) => typeof entry === "string")) {
      invalidConfig(sourcePath, "referenceBasenames must be an array of strings");
    }
    config.referenceBasenames = [...basenames];
  }
  if (Object.prototype.hasOwnProperty.call(value, "referencePathSubstrings")) {
    const substrings = value.referencePathSubstrings;
    if (!Array.isArray(substrings) || !substrings.every((entry) => typeof entry === "string")) {
      invalidConfig(sourcePath, "referencePathSubstrings must be an array of strings");
    }
    config.referencePathSubstrings = [...substrings];
  }
  if (Object.prototype.hasOwnProperty.call(value, "invalidationRules")) {
    const rules = value.invalidationRules;
    if (!Array.isArray(rules)) {
      invalidConfig(sourcePath, "invalidationRules must be an array");
    }
    config.invalidationRules = rules.map((rule, index) => {
      if (!isPlainJsonObject(rule)) {
        invalidConfig(sourcePath, `invalidationRules[${index}] must be a plain object with invalidator and invalidated fields`);
      }
      if (typeof rule.invalidator !== "string") {
        invalidConfig(sourcePath, `invalidationRules[${index}].invalidator must be a string`);
      }
      if (typeof rule.invalidated !== "string") {
        invalidConfig(sourcePath, `invalidationRules[${index}].invalidated must be a string`);
      }
      for (const field of ["invalidator", "invalidated"] as const) {
        try {
          new RegExp(rule[field] as string);
        } catch (error: any) {
          invalidConfig(
            sourcePath,
            `invalidationRules[${index}].${field} has invalid regex source: ${error?.message ?? error}`,
          );
        }
      }
      return { invalidator: rule.invalidator, invalidated: rule.invalidated };
    });
  }
  if (Object.prototype.hasOwnProperty.call(value, "disableDefaults")) {
    if (typeof value.disableDefaults !== "boolean") {
      invalidConfig(sourcePath, "disableDefaults must be a boolean");
    }
    config.disableDefaults = value.disableDefaults;
  }
  return config;
}

export interface ResolvedRules {
  basenames: ReadonlySet<string>;
  substrings: readonly string[];
  invalidationRules: readonly { invalidator: RegExp; invalidated: RegExp }[];
}

/** Pure transform UserConfig → ResolvedRules. Compiles user regex
 *  strings once; merges with or replaces defaults per disableDefaults. */
export function resolveRules(user: UserConfig): ResolvedRules {
  const baseNames = user.disableDefaults
    ? user.referenceBasenames
    : [...DEFAULT_REFERENCE_BASENAMES, ...user.referenceBasenames];
  const subs = user.disableDefaults
    ? user.referencePathSubstrings
    : [...DEFAULT_REFERENCE_PATH_SUBSTRINGS, ...user.referencePathSubstrings];
  const userRules = user.invalidationRules.map((r) => ({
    invalidator: new RegExp(r.invalidator),
    invalidated: new RegExp(r.invalidated),
  }));
  const rules = user.disableDefaults
    ? userRules
    : [...DEFAULT_INVALIDATION_RULES, ...userRules];
  return { basenames: new Set(baseNames), substrings: subs, invalidationRules: rules };
}

/** Built-in default rules — used when caller doesn't inject a config.
 *  index.ts loads user JSON and overrides via opts.rules. */
const DEFAULT_RULES: ResolvedRules = resolveRules(emptyUserConfig());

/** v1.10.0: replace any `<think>…</think>` blocks and any
 *  `type: "thinking"` content blocks on an assistant message with a
 *  deterministic empty placeholder. Pure transform — never mutates
 *  the input message; returns a new structure if anything changed.
 *
 *  Both formats are handled because providers vary:
 *  - pi-ai's normalized assistant content uses `{type: "thinking"}` blocks
 *  - some openai-completions paths fold thinking inline as `<think>...</think>`
 *  - some shapes carry a top-level `reasoning_content` string field
 *
 *  The "with-coverage" vs "above-cutoff" distinction is handled by the
 *  caller via the cutoff gate — this function masks unconditionally
 *  when invoked. "above-cutoff" is not yet differentiated from
 *  "with-coverage" in this minimal Phase 1 — both currently mask any
 *  thinking on a pre-cutoff assistant message. Reserved for future
 *  divergence (e.g. "above-cutoff" might also bypass MIN_MASK_LENGTH-
 *  style thresholds we don't currently apply to thinking). */
function maskAssistantThinking(
  m: any,
  _policy: ThinkingMaskPolicy,
): { message: any; changed: boolean; bytesSaved: number } {
  const msg = m?.message ?? m;
  if (msg?.role !== "assistant") return { message: m, changed: false, bytesSaved: 0 };

  let bytesSaved = 0;
  let changed = false;

  // 1. Content blocks of type "thinking" — replace .thinking with the
  //    empty placeholder. Block kept in place so block count stays
  //    stable (any downstream code counting blocks won't shift).
  let newContent = msg.content;
  if (Array.isArray(msg.content)) {
    let blockChanged = false;
    newContent = msg.content.map((block: any) => {
      if (block?.type !== "thinking") return block;
      const original = typeof block.thinking === "string" ? block.thinking : "";
      if (original.length === 0) return block;  // already empty — skip
      bytesSaved += original.length - MASKED_THINKING_PLACEHOLDER.length;
      blockChanged = true;
      return { ...block, thinking: MASKED_THINKING_PLACEHOLDER };
    });
    // Also strip inline `<think>...</think>` from text blocks (some
    // openai-completions paths fold thinking into text). Conservative:
    // only strip well-formed pairs to avoid corrupting text that
    // legitimately mentions `<think>` substrings.
    newContent = newContent.map((block: any) => {
      if (block?.type !== "text" || typeof block.text !== "string") return block;
      const stripped = block.text.replace(/<think>[\s\S]*?<\/think>/g, "");
      if (stripped === block.text) return block;
      bytesSaved += block.text.length - stripped.length;
      blockChanged = true;
      return { ...block, text: stripped };
    });
    if (blockChanged) changed = true;
  }

  // 2. Top-level reasoning_content field (some shapes; e.g. deepseek-style).
  let newReasoning: string | undefined = msg.reasoning_content;
  if (typeof msg.reasoning_content === "string" && msg.reasoning_content.length > 0) {
    bytesSaved += msg.reasoning_content.length;
    newReasoning = "";
    changed = true;
  }

  if (!changed) return { message: m, changed: false, bytesSaved: 0 };

  // Rebuild preserving the m / m.message wrapper shape used by the rest
  // of the codebase.
  const updatedMsg: any = { ...msg, content: newContent };
  if (newReasoning !== undefined) updatedMsg.reasoning_content = newReasoning;
  if (m?.message) return { message: { ...m, message: updatedMsg }, changed: true, bytesSaved };
  return { message: updatedMsg, changed: true, bytesSaved };
}

function isReferenceFile(path: string, rules: ResolvedRules): boolean {
  const base = path.split("/").pop() ?? path;
  if (rules.basenames.has(base)) return true;
  for (const sub of rules.substrings) {
    if (path.includes(sub)) return true;
  }
  return false;
}

/** Count newlines + 1 (matches `wc -l` + 1 semantics for non-trailing-newline files). */
function countLines(s: string): number {
  if (s.length === 0) return 0;
  let n = 1;
  for (let i = 0; i < s.length; i++) if (s.charCodeAt(i) === 10) n++;
  return n;
}

/** Deterministic size string — must not depend on locale or time. */
function formatSize(bytes: number): string {
  if (bytes < 1024) return `${bytes}B`;
  if (bytes < 1024 * 1024) return `${(bytes / 1024).toFixed(1)}KB`;
  return `${(bytes / (1024 * 1024)).toFixed(1)}MB`;
}

export interface CompressResult {
  messages: any[];
  bytesSaved: number;
  masksApplied: number;
  /** The cutoff index used for this pass. Consumer persists this across
   *  calls so T doesn't regress. */
  cutoffIdx: number;
  /** Paths of read tool results newly masked this call. Caller records
   *  these + the current turn to detect re-reads. (v1.3.0 exp 3.) */
  maskedPaths: string[];
  /** Commands of bash tool results newly masked this call. Full command,
   *  not the 80-char truncated placeholder. */
  maskedCommands: string[];
}

export interface CompressOptions {
  /** Context usage thresholds (monotonically increasing). */
  thresholds?: readonly number[];
  /** Coverage fractions at each threshold (monotonically increasing). */
  coverage?: readonly number[];
  /** Current context usage (0..1). From pi's getContextUsage. */
  contextUsage?: number;
  /** Previous cutoff idx. T never decreases. */
  previousCutoff?: number;
  /** Highest zone ever entered this session. v1.2.1 true-static:
   *  a zone enters EXACTLY once. After that, cutoff is frozen at the
   *  messages.length-at-entry * coverage[zone]. Prevents drift when
   *  messages.length keeps growing past a threshold. */
  zoneEntered?: number;
  /** v1.6.0: override the module-level DEFAULT_RULES. Tests inject a
   *  custom ResolvedRules here; prod callers leave unset. */
  rules?: ResolvedRules;
  /** v1.10.0: profile-supplied placeholder templates. Falls back to
   *  the v1.9.0 `[cm-masked …]` strings when undefined. */
  placeholderFormat?: PlaceholderTemplates;
  /** v1.10.0: policy for masking historical `<think>` / reasoning
   *  blocks on assistant messages. Defaults to "off" (Anthropic
   *  behavior). See profiles.ts for semantics. */
  maskOldThinking?: ThinkingMaskPolicy;
  /** Optional recovery archive. When present, every eligible bash or read
   *  result is archived (complete ordered content, keyed by toolCallId)
   *  BEFORE masking, and the returned stable reference is appended to the
   *  placeholder. When the callback returns null the message is left
   *  unmasked (fail-open: the original output stays visible). Calls
   *  without this option keep the exact pre-archive placeholder bytes. */
  archive?: ArchiveSink;
  /** Two-phase batch archive sink. When present, one context pass
   *  collects every eligible bash or read candidate first, calls
   *  prepareBatch exactly once, and applies placeholders only to
   *  messages whose tool call came back with a live reference.
   *  Messages without a returned reference keep their original
   *  content fully visible (fail-open). A null return from the sink
   * leaves every candidate visible. */
  archiveBatch?: ArchiveBatchSink;
}

/** Storage boundary contract used by compressStaleToolResults. */
export interface ArchiveSink {
  /** Archive the blocks for one tool result. Returns the stable opaque
   *  reference id, or null when archiving failed (caller must not mask). */
  store(toolCallId: string | undefined, blocks: unknown[]): string | null;
}

/** Batch storage boundary: one call archives every eligible candidate
 *  for the pass and returns live references keyed by tool call id. A
 *  null result means the whole batch failed and nothing may be masked. */
export interface ArchiveBatchSink {
  prepareBatch(
    candidates: ReadonlyArray<{
      toolCallId: string | undefined;
      blocks: unknown[];
      kind: "historical";
    }>,
  ): Map<string, string> | null;
}

/** A context pass keeps only its newest bounded candidate window. Older
 *  candidates remain visible and never reach storage. */
const MAX_ARCHIVE_BATCH_CANDIDATES = 10_000;

/** v1.10.0 fallback templates — exact byte match for the v1.9.0
 *  hardcoded strings. Used when no profile is supplied. */
const FALLBACK_PLACEHOLDERS: PlaceholderTemplates = {
  bash: "[cm-masked bash] {cmd}",
  read: "[cm-masked read] {path} ({n} lines, {size})",
};

/** v1.10.0 deterministic constant for masked thinking blocks. Empty
 *  string keeps prefix bytes minimal AND identical across turns —
 *  same content, same hash, same prefix-cache lookup. */
const MASKED_THINKING_PLACEHOLDER = "";

export interface CutoffDecision {
  /** Cutoff to use for this call. */
  cutoffIdx: number;
  /** Zone currently active (-1 if below all thresholds). */
  activeZone: number;
  /** True if this call caused a zone transition (caller should persist
   *  the new zone + cutoff). */
  zoneAdvanced: boolean;
}

/**
 * Decide the cutoff for the current turn.
 *
 * v1.2.1: cutoff is frozen at first entry into a zone. Does NOT
 * re-derive from current messages.length on subsequent turns within
 * the same zone.
 *
 * @param messagesLength Current number of messages in the branch.
 * @param opts previousCutoff + zoneEntered (persisted by caller).
 */
export function decideCutoff(
  messagesLength: number,
  opts: CompressOptions = {},
): CutoffDecision {
  const thresholds = opts.thresholds ?? DEFAULT_THRESHOLDS;
  const coverage = opts.coverage ?? DEFAULT_COVERAGE;
  const usage = opts.contextUsage ?? 0;
  const previousCutoff = opts.previousCutoff ?? 0;
  const zoneEntered = opts.zoneEntered ?? -1;

  // Determine current pressure zone.
  let activeZone = -1;
  for (let z = thresholds.length - 1; z >= 0; z--) {
    if (usage >= thresholds[z]) { activeZone = z; break; }
  }

  // v1.8.1 (ADR-028) defense-in-depth: clamp the persisted cutoff to the
  // current array length. /pi-vcc compaction shrinks messages.length but
  // does not renumber indices consistently with the old cutoff value.
  // Without this clamp, every post-compact message sits below the stale
  // cutoff and all tool_results get masked. With it, at worst a compact
  // event that we missed degrades to "mask everything prior to the compact
  // boundary" which is still a correct bound since nothing prior exists.
  const clampedPreviousCutoff = Math.min(previousCutoff, messagesLength);

  // True-static: only compute a new cutoff if we've entered a higher
  // zone than previously seen. Otherwise keep previousCutoff exactly.
  let cutoffIdx = clampedPreviousCutoff;
  let zoneAdvanced = false;
  if (activeZone > zoneEntered) {
    const newCutoff = Math.floor(messagesLength * coverage[activeZone]);
    cutoffIdx = Math.max(clampedPreviousCutoff, newCutoff);
    zoneAdvanced = true;
  }

  return { cutoffIdx, activeZone, zoneAdvanced };
}

/**
 * Process messages with static-cutoff masking.
 * Returns null if nothing to mask at the current cutoff.
 */
export function compressStaleToolResults(
  messages: any[],
  opts: CompressOptions = {},
): CompressResult | null {
  const rules = opts.rules ?? DEFAULT_RULES;
  const { cutoffIdx } = decideCutoff(messages.length, opts);

  if (cutoffIdx <= 0) return null;

  const toolCallIndex = buildToolCallIndex(messages);
  const invalidationIndex = buildInvalidationIndex(messages, toolCallIndex, rules);

  // Two-phase archive mode: collect every eligible candidate first, then
  // hand the whole set to one batch call. Masking below consults only the
  // returned live references, so candidates without a reference stay
  // fully visible. A null batch result masks nothing.
  let batchReferences: Map<string, string> | null = null;
  if (opts.archiveBatch) {
    const candidates: Array<{
      toolCallId: string | undefined;
      blocks: unknown[];
      kind: "historical";
    }> = [];
    let candidateHead = 0;
    for (let idx = 0; idx < messages.length; idx++) {
      const msg = messages[idx]?.message ?? messages[idx];
      if (isAlreadyMasked(msg)) continue;
      if (msg?.role === "toolResult" && msg.isError) continue;
      let eligible = false;
      if (isBashToolResult(msg)) {
        const content = extractTextContent(msg);
        if (content.length >= MIN_MASK_LENGTH) {
          const command = extractCommand(msg, toolCallIndex);
          const pastCutoff = idx < cutoffIdx;
          const invalidated = !pastCutoff && isCommandInvalidated(command, idx, invalidationIndex, rules);
          eligible = pastCutoff || invalidated;
        }
      } else if (isReadToolResult(msg)) {
        const path = extractPath(msg, toolCallIndex);
        const content = extractTextContent(msg);
        eligible = Boolean(path && content.length >= MIN_MASK_LENGTH && !isReferenceFile(path, rules) && idx < cutoffIdx);
      }
      if (eligible) {
        const archiveCandidate = {
          toolCallId: msg?.toolCallId,
          blocks: Array.isArray(msg?.content) ? msg.content : [],
          kind: "historical" as const,
        };
        if (candidates.length < MAX_ARCHIVE_BATCH_CANDIDATES) {
          candidates.push(archiveCandidate);
        } else {
          candidates[candidateHead] = archiveCandidate;
          candidateHead = (candidateHead + 1) % MAX_ARCHIVE_BATCH_CANDIDATES;
        }
      }
    }
    if (candidateHead > 0) candidates.push(...candidates.splice(0, candidateHead));
    batchReferences = opts.archiveBatch.prepareBatch(candidates);
  }

  /** Live reference for one message under the configured archive mode,
   *  or undefined when no archive mode is configured. */
  const referenceFor = (msg: any): string | null | undefined => {
    if (opts.archiveBatch) {
      if (batchReferences === null) return null;
      if (typeof msg?.toolCallId !== "string") return null;
      return batchReferences.get(msg.toolCallId) ?? null;
    }
    if (opts.archive) return opts.archive.store(msg.toolCallId, msg.content ?? []);
    return undefined;
  };

  let bytesSaved = 0;
  let masksApplied = 0;
  const maskedPaths: string[] = [];
  const maskedCommands: string[] = [];

  const result = messages.map((m: any, idx: number) => {
    const msg = m?.message ?? m;
    if (isAlreadyMasked(msg)) return m;
    if (msg?.role === "toolResult" && msg.isError) return m;

    // BASH: past cutoff OR invalidated by later command
    if (isBashToolResult(msg)) {
      const content = extractTextContent(msg);
      if (content.length < MIN_MASK_LENGTH) return m;

      const command = extractCommand(msg, toolCallIndex);
      const pastCutoff = idx < cutoffIdx;
      const invalidated = !pastCutoff && isCommandInvalidated(command, idx, invalidationIndex, rules);

      if (pastCutoff || invalidated) {
        // Recovery archive (optional): the batch sink already ran once
        // for the whole pass. A missing reference fails this message open
        // so no dead reference is ever emitted.
        let archiveSuffix = "";
        if (opts.archive || opts.archiveBatch) {
          const reference = referenceFor(msg);
          if (!reference) return m;
          archiveSuffix = ` [cm-archive ${reference}]`;
        }
        // v1.9.0 (ADR-029): `cm-` prefix brands placeholder as a
        // condensed-milk artifact (not a tool failure) — self-documenting
        // for self-sufficient looping agents who only see placeholder text
        // post-context_checkout. Bytes stay deterministic per message.
        // v1.10.0: template comes from active profile (back-compat default
        // matches v1.9.0 byte-for-byte).
        const tpl = (opts.placeholderFormat ?? FALLBACK_PLACEHOLDERS).bash;
        const placeholder = (command
          ? renderPlaceholder(tpl, { cmd: command.slice(0, 80) })
          : renderPlaceholder(tpl, { cmd: "" }).trimEnd()) + archiveSuffix;
        bytesSaved += content.length - placeholder.length;
        masksApplied++;
        if (command) maskedCommands.push(command);
        return replaceContent(m, placeholder);
      }
    }

    // READ: past cutoff AND not reference file
    if (isReadToolResult(msg)) {
      const path = extractPath(msg, toolCallIndex);
      const content = extractTextContent(msg);

      if (path && content.length >= MIN_MASK_LENGTH && !isReferenceFile(path, rules) && idx < cutoffIdx) {
        // v1.4.0: enrich read placeholder with deterministic size/line
        // metadata so the model can decide whether to re-read without
        // actually re-reading. Derived purely from the original content
        // → byte-identical per message → cache prefix stays stable.
        const lineCount = countLines(content);
        const sizeStr = formatSize(content.length);
        // Recovery archive (optional): see the bash branch above.
        let archiveSuffix = "";
        if (opts.archive || opts.archiveBatch) {
          const reference = referenceFor(msg);
          if (!reference) return m;
          archiveSuffix = ` [cm-archive ${reference}]`;
        }
        // v1.9.0 (ADR-029): `cm-` prefix (see bash branch above).
        // v1.10.0: profile-supplied template (back-compat default identical to v1.9.0).
        const tpl = (opts.placeholderFormat ?? FALLBACK_PLACEHOLDERS).read;
        const placeholder = renderPlaceholder(tpl, { path, n: lineCount, size: sizeStr }) + archiveSuffix;
        bytesSaved += content.length - placeholder.length;
        masksApplied++;
        maskedPaths.push(path);
        return replaceContent(m, placeholder);
      }
    }

    // v1.10.0: thinking-block masking on assistant messages.
    // Only mutates messages strictly before cutoffIdx. Replaces thinking
    // content with a deterministic empty string so post-cutoff bytes stay
    // byte-identical turn-over-turn → cache prefix is unaffected.
    const thinkingPolicy = opts.maskOldThinking ?? "off";
    if (thinkingPolicy !== "off" && idx < cutoffIdx) {
      const masked = maskAssistantThinking(m, thinkingPolicy);
      if (masked.changed) {
        bytesSaved += masked.bytesSaved;
        masksApplied++;
        return masked.message;
      }
    }

    return m;
  });

  if (masksApplied === 0) return null;

  return { messages: result, bytesSaved, masksApplied, cutoffIdx, maskedPaths, maskedCommands };
}

/** Scan messages, return Map<toolCallId, {command, path, cwd}> from
 *  assistant toolCall blocks. `command` is the RAW tool-call argument
 *  (preserved for the bash placeholder, which wants the cd-prefix
 *  visible to the model). `cwd` is parsed from a `cd X && ` prefix
 *  and used for invalidation scoping.
 *  Handles live + persisted shapes. */
type ToolCallEntry = { command?: string; path?: string; cwd?: string };
function buildToolCallIndex(messages: any[]): Map<string, ToolCallEntry> {
  const idx = new Map<string, ToolCallEntry>();
  for (const m of messages) {
    const msg = m?.message ?? m;
    if (msg?.role !== "assistant" || !Array.isArray(msg.content)) continue;
    for (const block of msg.content) {
      if (block?.type !== "toolCall") continue;
      const id = block.id ?? block.toolCallId;
      if (!id) continue;
      const args = block.arguments ?? block.input ?? {};
      const rawCmd = typeof args.command === "string" ? args.command : undefined;
      const cwd = rawCmd ? parseCdPrefix(rawCmd).cwd : undefined;
      idx.set(id, {
        command: rawCmd,
        path: typeof args.path === "string" ? args.path : undefined,
        cwd,
      });
    }
  }
  return idx;
}

/** v1.6.0: cwd-aware invalidation.
 *
 *  Both the candidate (self) and each later command are stripped of
 *  their `cd X && ` prefixes before regex matching. Invalidation fires
 *  only when their cwds match exactly. `undefined === undefined` counts
 *  as a match (the common single-cwd case where neither command has
 *  explicit cd), so existing sessions behave identically. Cross-cwd
 *  cases (mvdirty's multi-repo pattern) no longer spuriously invalidate. */
type InvalidationIndex = Map<string, ReadonlyMap<number, number>>;

function cwdIndexKey(parsed: ParsedCd): string | undefined {
  if (!parsed.cwdResolved) return undefined;
  return parsed.hasCd ? `explicit:${parsed.cwd ?? ""}` : "implicit";
}

function regexMatches(pattern: RegExp, value: string): boolean {
  pattern.lastIndex = 0;
  return pattern.test(value);
}

/** Build one reverse index of invalidators by cwd and stable rule index. */
function buildInvalidationIndex(
  messages: any[],
  toolCallIndex: Map<string, ToolCallEntry>,
  rules: ResolvedRules,
): InvalidationIndex {
  const mutable = new Map<string, Map<number, number>>();
  for (let i = messages.length - 1; i >= 0; i--) {
    const msg = messages[i]?.message ?? messages[i];
    if (!isBashToolResult(msg) || msg.isError) continue;
    const parsed = parseCdPrefixDetailed(extractCommand(msg, toolCallIndex));
    const key = cwdIndexKey(parsed);
    if (key === undefined) continue;
    for (let ruleIndex = 0; ruleIndex < rules.invalidationRules.length; ruleIndex++) {
      const rule = rules.invalidationRules[ruleIndex];
      if (!regexMatches(rule.invalidator, parsed.cmd)) continue;
      let matches = mutable.get(key);
      if (!matches) { matches = new Map<number, number>(); mutable.set(key, matches); }
      const latestIndex = matches.get(ruleIndex);
      if (latestIndex === undefined || i > latestIndex) matches.set(ruleIndex, i);
    }
  }
  return mutable;
}

function isCommandInvalidated(
  command: string,
  candidateIndex: number,
  index: InvalidationIndex,
  rules: ResolvedRules,
): boolean {
  const self = parseCdPrefixDetailed(command);
  const key = cwdIndexKey(self);
  if (key === undefined) return false;
  const invalidators = index.get(key);
  if (!invalidators) return false;
  for (let ruleIndex = 0; ruleIndex < rules.invalidationRules.length; ruleIndex++) {
    const rule = rules.invalidationRules[ruleIndex];
    const latestIndex = invalidators.get(ruleIndex);
    if (regexMatches(rule.invalidated, self.cmd) && latestIndex !== undefined && latestIndex > candidateIndex) return true;
  }
  return false;
}

function isBashToolResult(msg: any): boolean {
  return msg?.role === "toolResult" && msg?.toolName === "bash";
}
function isReadToolResult(msg: any): boolean {
  return msg?.role === "toolResult" && msg?.toolName === "read";
}
function isAlreadyMasked(msg: any): boolean {
  if (msg?.role !== "toolResult") return false;
  const content = (msg.content ?? [])[0];
  if (!content || content.type !== "text") return false;
  const text = content.text ?? "";
  // v1.9.0 (ADR-029): accept `[cm-masked ` (current) and `[masked `
  // (pre-v1.9.0 legacy, persisted in older session files on disk).
  return (
    text.startsWith("[cm-masked ") ||
    text.startsWith("[masked ") ||
    text.startsWith("[compressed]")
  );
}

function extractCommand(msg: any, toolCallIndex?: Map<string, ToolCallEntry>): string {
  const fromDetails = msg?.details?.command ?? msg?.input?.command;
  if (fromDetails) return fromDetails;
  if (toolCallIndex && msg?.toolCallId) return toolCallIndex.get(msg.toolCallId)?.command ?? "";
  return "";
}
function extractPath(msg: any, toolCallIndex?: Map<string, ToolCallEntry>): string {
  const fromDetails = msg?.details?.path ?? msg?.input?.path;
  if (fromDetails) return fromDetails;
  if (toolCallIndex && msg?.toolCallId) return toolCallIndex.get(msg.toolCallId)?.path ?? "";
  return "";
}

function extractTextContent(msg: any): string {
  return (msg.content ?? [])
    .filter((c: any) => c?.type === "text")
    .map((c: any) => c.text ?? "")
    .join("\n");
}

function replaceContent(m: any, text: string): any {
  const msg = m?.message ?? m;
  const content = Array.isArray(msg?.content) ? msg.content : [];
  let replaced = false;
  const preservedContent = content.map((block: any) => {
    if (block?.type !== "text") return block;
    if (replaced) return { ...block, text: "" };
    replaced = true;
    return { ...block, text };
  });
  if (m?.message) return { ...m, message: { ...m.message, content: preservedContent } };
  return { ...m, content: preservedContent };
}
