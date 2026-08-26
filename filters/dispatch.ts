/**
 * Filter dispatch — matches bash commands to compression filters.
 *
 * Each filter spec has a command prefix (e.g., "git status") and a filter
 * function that transforms stdout into a compressed representation.
 * Longest-prefix match wins, so "git status" beats "git".
 */

export interface FilterContext {
  command: string;
  stdout: string;
  isError: boolean;
  toolName: string;
  details?: unknown;
}

export interface FilterResult {
  output: string;
  category: "fast" | "medium" | "slow" | "immutable" | "mutation";
  evidence?: string;
  /** Privacy-mandated redaction: the result may exceed the original output
   *  length. Honored ONLY for filter IDs in MANDATORY_REDACTION_IDS — the
   *  explicit allowlist that keeps every other filter under the
   *  shorter-output gate. */
  mandatory?: boolean;
}

export type FilterFn = (context: FilterContext) => FilterResult | null;
type LegacyFilterFn = (input: string, command: string) => FilterResult | null;

export interface FilterInfo {
  id: string;
  command: string;
  enabled: boolean;
  supportsErrors: boolean;
}

interface FilterSpec extends FilterInfo {
  /** Command prefix to match (e.g., "git status", "pytest") */
  command: string;
  filter: FilterFn;
  category: FilterResult["category"];
  defaultEnabled: boolean;
  dynamic: boolean;
}

function stableId(command: string): string {
  const known: Record<string, string> = {
    "git status": "git-status-porcelain", "git log": "git-log-verbose",
    env: "environment-secrets", printenv: "environment-secrets", pytest: "pytest",
    "python -m pytest": "pytest", "python3 -m pytest": "pytest",
    journalctl: "log-deduplication", "docker logs": "log-deduplication",
    tail: "log-deduplication", "tmux capture-pane": "log-deduplication",
  };
  return known[command] ?? command.replace(/[^a-zA-Z0-9]+/g, "-").replace(/^-|-$/g, "").toLowerCase();
}

const specs: FilterSpec[] = [];

// v1.10.0 (milestone 3C1): the only filter IDs whose results may bypass the
// central shorter-output gate. environment-secrets must redact even when
// [REDACTED] is longer than the original value — privacy beats compression.
const MANDATORY_REDACTION_IDS = new Set(["environment-secrets"]);

// v1.10.0 (privacy follow-up): the only filter IDs allowed to process
// failed-command output. environment-secrets preserves every non-sensitive
// line verbatim, so redacting errors cannot hide diagnostics. No filter
// registration API can add IDs here — every other filter keeps
// supportsErrors false and declines error output.
const ERROR_SUPPORTED_IDS = new Set(["environment-secrets"]);

// v1.10.0 (privacy follow-up): filter IDs safe on concatenated
// multi-producer compound stdout. Their filters preserve every
// non-sensitive line verbatim and never invent structure, so env secrets
// cannot ride a compound chain into context. Semantic filters stay off.
const LINE_PRESERVING_REDACTION_IDS = new Set(["environment-secrets"]);

/**
 * Register a filter for a command prefix.
 * Call this from individual filter modules at load time.
 */
export function registerFilter(
  command: string,
  filter: FilterFn | LegacyFilterFn,
  category: FilterResult["category"] = "fast",
  options: { context?: boolean; id?: string; dynamic?: boolean } = {},
): void {
  const safeDefaults = new Set(["pytest", "git-status-porcelain", "git-log-verbose", "environment-secrets", "log-deduplication"]);
  // v1.10.0 (milestone 3C1): explicit stable ID override — allowlist-registered
  // filters (json-schema) need one shared ID across many command prefixes.
  const id = options.id ?? stableId(command);
  const wrapped: FilterFn = options.context
    ? filter as FilterFn
    : (context) => (filter as (input: string, command?: string) => FilterResult | null)(context.stdout, context.command);
  // Re-registering the same command under the same ID replaces the spec —
  // keeps config reloads from piling up duplicate entries.
  const existing = specs.find((s) => s.command === command && s.id === id);
  if (existing) {
    existing.filter = wrapped;
    existing.category = category;
    existing.dynamic = options.dynamic === true;
    return;
  }
  const defaultEnabled = safeDefaults.has(id);
  specs.push({
    command,
    filter: wrapped,
    category,
    id,
    enabled: defaultEnabled,
    defaultEnabled,
    dynamic: options.dynamic === true,
    supportsErrors: ERROR_SUPPORTED_IDS.has(id),
  });
  // Keep sorted by command length descending for longest-prefix-first matching
  specs.sort((a, b) => b.command.length - a.command.length);
}

/**
 * Match a command string against registered filters and run the best match.
 * Returns null if no filter matches or the filter declines (returns null).
 *
 * Handles compound commands: "source .venv/bin/activate && python -m pytest -q"
 * is split on &&/||/; and each segment is checked. The LAST matching segment
 * wins (it produced the final output).
 */
// v1.9.0 (ADR-029 follow-up): a compound command with multiple
// output-producing segments gives us a concatenated stdout that no
// single per-command filter can interpret safely. Only these commands
// are known to produce no visible output or only trivially short
// output, so their presence in a chain is ignorable for producer
// counting.
const SILENT_COMMANDS = new Set([
  "cd", "export", "set", "unset", "source", ".",
  "true", "false", ":",
]);
function firstWord(seg: string): string {
  const trimmed = seg.trim();
  const match = trimmed.match(/^\S+/);
  return match?.[0] ?? "";
}
function isSilentSegment(seg: string): boolean {
  const cleaned = cleanSegment(seg);
  return cleaned.length === 0 || SILENT_COMMANDS.has(firstWord(cleaned));
}

export function dispatch(context: FilterContext): FilterResult | null;
/** @deprecated Use structured FilterContext. */
export function dispatch(command: string, stdout: string): FilterResult | null;
export function dispatch(contextOrCommand: FilterContext | string, legacyStdout?: string): FilterResult | null {
  const context: FilterContext = typeof contextOrCommand === "string"
    ? { command: contextOrCommand, stdout: legacyStdout ?? "", isError: false, toolName: "bash" }
    : contextOrCommand;
  const { command, stdout } = context;
  const unsupportedPipe = hasUnsupportedPipe(command);
  const uncertainShell = hasUncertainShellSyntax(command);
  // Error policy is enforced per matched spec, not globally: failed output
  // still gets privacy redaction from environment-secrets (which preserves
  // every diagnostic line), while every semantic filter declines it.
  // Skip tiny outputs — compression overhead exceeds savings — EXCEPT for
  // mandatory-redaction filters (v1.10.0 milestone 3C1): secret masking must
  // apply at any output size, even a single short line.
  const tiny = stdout.length < 80;

  // Split compound commands and try each segment
  const segments = splitCompoundCommand(command);

  // v1.9.0 (ADR-029 follow-up): when the compound has ≥2 non-silent
  // segments, the captured stdout is a concatenation of multiple
  // commands' outputs. Per-command prefix filters would misinterpret
  // non-matching bytes (e.g. `bd update … && git status` produced
  // 'on unknown: clean' because git-status parsing ran on the combined
  // stdout). Semantic filters stay disabled for such compounds, but the
  // line-preserving privacy redactor still applies to the combined text.
  const nonSilentSegments = segments.filter(
    (s) => s.trim().length > 0 && !isSilentSegment(s),
  );
  const multi = nonSilentSegments.length >= 2;

  // Try segments in reverse — last command in chain produced the output
  for (let i = segments.length - 1; i >= 0; i--) {
    const segment = segments[i].trim();
    if (segment.length === 0) continue;

    // Strip redirects and env var prefixes
    const cleaned = cleanSegment(segment);
    if (cleaned.length === 0) continue;

    for (const spec of specs) {
      if (commandMatches(cleaned, spec.command)) {
        if (!spec.enabled) continue;
        // Multi-producer compounds or unsupported pipelines: only
        // line-preserving privacy redaction may touch the captured text.
        if ((multi || unsupportedPipe || uncertainShell) && !LINE_PRESERVING_REDACTION_IDS.has(spec.id)) break;
        // Per-spec error policy: only environment-secrets may touch failed
        // output. Every semantic filter declines errors right here.
        if (context.isError && !spec.supportsErrors) break;
        if (tiny && !MANDATORY_REDACTION_IDS.has(spec.id)) break;
        const result = spec.filter({ ...context, command: cleaned });
        // Privacy-safe exception: mandatory redaction results from allowlisted
        // filter IDs are accepted even when longer than the original output.
        // Everything else must still get shorter.
        const mandatoryRedaction = result?.mandatory === true && MANDATORY_REDACTION_IDS.has(spec.id);
        if (result && (result.output.length < stdout.length || mandatoryRedaction)) {
          return { ...result, evidence: result.evidence ?? `matched ${spec.command}` };
        }
        break; // Matched but filter declined — fall through to content fallbacks
      }
    }
  }

  // Generic content fallbacks are intentionally disabled. Unknown formats pass through.
  return null;
}

// v1.10.1 (blocker 1 follow-up): narrow public API for line-preserving
// privacy redaction. The tool_result handler calls this on each text
// block of a multi-block bash result, where per-block text is a fragment
// whose producing command cannot be attributed safely. It applies ONLY
// the allowlisted line-preserving redaction filters (environment-secrets)
// — never a semantic filter — regardless of command, error state, or
// output size. It deliberately ignores spec.enabled: this redaction is
// mandatory and cannot be configured off (see configureFilters).
// Returns the redacted text, or null when nothing needed redaction.
export function redactPrivacyLines(text: string): string | null {
  const seen = new Set<string>();
  for (const spec of specs) {
    if (!LINE_PRESERVING_REDACTION_IDS.has(spec.id) || seen.has(spec.id)) continue;
    seen.add(spec.id);
    const result = spec.filter({ command: spec.command, stdout: text, isError: true, toolName: "bash" });
    if (result && (result.mandatory === true || result.output.length < text.length)) {
      return result.output;
    }
  }
  return null;
}

/**
 * Split a compound bash command on &&, ||, and ; outside quoted strings.
 */
function hasUncertainShellSyntax(command: string): boolean {
  let quote: "'" | '"' | null = null;
  let escaped = false;
  for (let i = 0; i < command.length; i++) {
    const ch = command[i];
    if (escaped) {
      escaped = false;
      continue;
    }
    if (quote === "'") {
      if (ch === "'") quote = null;
      continue;
    }
    if (ch === "\\") {
      escaped = true;
      continue;
    }
    if (quote === '"') {
      if (ch === '"') quote = null;
      else if (ch === "`" || (ch === "$" && command[i + 1] === "(")) return true;
      else if ((ch === "<" || ch === ">") && command[i + 1] === "(") return true;
      continue;
    }
    if (ch === "'" || ch === '"') {
      quote = ch;
      continue;
    }
    if (command.slice(i, i + 4) === "2>&1") {
      i += 3;
      continue;
    }
    if (ch === "`" || (ch === "$" && command[i + 1] === "(")) return true;
    if (ch === "&" && command[i + 1] === "&") {
      i++;
      continue;
    }
    if (ch === "&" || ch === "(" || ch === ")" || ch === "{" || ch === "}") return true;
    if (ch === "<" || ch === ">") return true;
  }
  return quote !== null || escaped;
}

function hasUnsupportedPipe(command: string): boolean {
  let quote: "'" | '"' | null = null;
  let escaped = false;
  const pipes: number[] = [];
  for (let i = 0; i < command.length; i++) {
    const ch = command[i];
    if (escaped) {
      escaped = false;
      continue;
    }
    if (quote === "'") {
      if (ch === "'") quote = null;
      continue;
    }
    if (ch === "\\") {
      escaped = true;
      continue;
    }
    if (quote === '"') {
      if (ch === '"') quote = null;
      continue;
    }
    if (ch === "'" || ch === '"') {
      quote = ch;
      continue;
    }
    if (ch === "|") {
      if (command[i + 1] === "|") {
        i++;
        continue;
      }
      pipes.push(i);
    }
  }
  for (const pipe of pipes) {
    if (!/^\s*(?:head|tail|wc|sort|uniq)\b/i.test(command.slice(pipe + 1))) return true;
  }
  return false;
}

function splitCompoundCommand(command: string): string[] {
  const segments: string[] = [];
  let start = 0;
  let quote: "'" | '"' | null = null;
  let escaped = false;
  for (let i = 0; i < command.length; i++) {
    const ch = command[i];
    if (escaped) {
      escaped = false;
      continue;
    }
    if (quote === "'") {
      if (ch === "'") quote = null;
      continue;
    }
    if (ch === "\\") {
      escaped = true;
      continue;
    }
    if (quote === '"') {
      if (ch === '"') quote = null;
      continue;
    }
    if (ch === "'" || ch === '"') {
      quote = ch;
      continue;
    }
    if (ch === ";" || (ch === "&" && command[i + 1] === "&") ||
        (ch === "|" && command[i + 1] === "|")) {
      segments.push(command.slice(start, i));
      start = i + (ch === ";" ? 1 : 2);
      if (ch !== ";") i++;
    }
  }
  segments.push(command.slice(start));
  return segments.map(stripTrailingOutputPipe);
}

function stripTrailingOutputPipe(segment: string): string {
  let quote: "'" | '"' | null = null;
  let escaped = false;
  let candidate = -1;
  for (let i = 0; i < segment.length; i++) {
    const ch = segment[i];
    if (escaped) {
      escaped = false;
      continue;
    }
    if (quote === "'") {
      if (ch === "'") quote = null;
      continue;
    }
    if (ch === "\\") {
      escaped = true;
      continue;
    }
    if (quote === '"') {
      if (ch === '"') quote = null;
      continue;
    }
    if (ch === "'" || ch === '"') {
      quote = ch;
      continue;
    }
    if (ch === "|" && /^\s*(?:head|tail|wc|sort|uniq)\b/i.test(segment.slice(i + 1))) {
      candidate = i;
    }
  }
  return candidate < 0 ? segment.trim() : segment.slice(0, candidate).trim();
}

/**
 * Strip leading env vars (FOO=bar), 2>&1 redirects, and source/cd noise.
 */
function cleanSegment(segment: string): string {
  return stripLeadingAssignments(stripOutsideRedirects(segment).trim());
}

function stripOutsideRedirects(value: string): string {
  let out = "";
  let quote: "'" | '"' | null = null;
  let escaped = false;
  for (let i = 0; i < value.length; i++) {
    const ch = value[i];
    if (escaped) {
      out += ch;
      escaped = false;
      continue;
    }
    if (quote === "'") {
      out += ch;
      if (ch === "'") quote = null;
      continue;
    }
    if (ch === "\\") {
      out += ch;
      escaped = true;
      continue;
    }
    if (quote === '"') {
      out += ch;
      if (ch === '"') quote = null;
      continue;
    }
    if (ch === "'" || ch === '"') {
      out += ch;
      quote = ch;
      continue;
    }
    if (value.slice(i, i + 4) === "2>&1") {
      i += 3;
      continue;
    }
    out += ch;
  }
  return out;
}

function stripLeadingAssignments(segment: string): string {
  let offset = 0;
  while (offset < segment.length) {
    while (/\s/.test(segment[offset] ?? "")) offset++;
    const end = shellTokenEnd(segment, offset);
    if (end === offset || !/^[A-Za-z_][A-Za-z0-9_]*=/.test(segment.slice(offset, end))) break;
    offset = end;
  }
  return segment.slice(offset).trim();
}

function shellTokenEnd(value: string, start: number): number {
  let quote: "'" | '"' | null = null;
  let escaped = false;
  for (let i = start; i < value.length; i++) {
    const ch = value[i];
    if (escaped) {
      escaped = false;
      continue;
    }
    if (quote === "'") {
      if (ch === "'") quote = null;
      continue;
    }
    if (ch === "\\") {
      escaped = true;
      continue;
    }
    if (quote === '"') {
      if (ch === '"') quote = null;
      continue;
    }
    if (ch === "'" || ch === '"') {
      quote = ch;
      continue;
    }
    if (/\s/.test(ch)) return i;
  }
  return value.length;
}

/**
 * Matches when command equals spec exactly OR starts with spec followed by
 * a space/tab. So "git status -s" matches "git status" but "git statusfoo" doesn't.
 */
function commandMatches(command: string, spec: string): boolean {
  if (command.length < spec.length) return false;
  if (!command.startsWith(spec)) return false;
  return command.length === spec.length || command[spec.length] === " " || command[spec.length] === "\t";
}

/**
 * Legacy compatibility hook. Content fallbacks remain disabled because
 * unknown output must pass through without unsafe semantic parsing.
 */
export function registerContentFallback(_name: string, _filter: FilterFn): void {
  // Intentionally inert. Existing extensions may still call this API.
}

export function registeredFilters(): FilterInfo[] {
  return specs.map(({ id, command, enabled, supportsErrors }) => ({ id, command, enabled, supportsErrors }));
}

/** Reset runtime filter configuration before loading current-session config.
 * Static filters return to their declared defaults. Dynamic filters, such as
 * JSON-schema allowlist entries, exist only while current config declares them.
 */
export function resetFilters(): void {
  for (let index = specs.length - 1; index >= 0; index--) {
    const spec = specs[index];
    if (spec.dynamic) specs.splice(index, 1);
    else spec.enabled = spec.defaultEnabled;
  }
}

export function configureGlobalFilters(values: Record<string, unknown>): string[] {
  return configureFilters(values);
}

export function configureProjectFilters(values: Record<string, unknown>): string[] {
  const warnings: string[] = [];
  for (const [id, value] of Object.entries(values)) {
    const matches = specs.filter((spec) => spec.id === id);
    if (matches.length === 0) {
      warnings.push(`unknown filter ID "${id}" ignored; valid IDs: ${specs.map((spec) => spec.id).join(", ")}`);
      continue;
    }
    if (typeof value !== "boolean") {
      warnings.push(`filter "${id}" must be boolean (got ${describeFilterValue(value)}; use true or false)`);
      continue;
    }
    if (id === "environment-secrets" && !value) {
      warnings.push("environment secret masking cannot be disabled by project configuration");
      continue;
    }
    for (const spec of matches) {
      if (value && !spec.enabled) {
        warnings.push(`project configuration cannot enable default-off filter "${id}"`);
        continue;
      }
      spec.enabled = value;
    }
  }
  return warnings;
}

function describeFilterValue(value: unknown): string {
  if (typeof value === "string") return JSON.stringify(value);
  if (value === null) return "null";
  if (Array.isArray(value)) return "array";
  return typeof value;
}

export function configureFilters(values: Record<string, unknown>): string[] {
  const warnings: string[] = [];
  for (const [id, value] of Object.entries(values)) {
    const matches = specs.filter((spec) => spec.id === id);
    if (matches.length === 0) {
      warnings.push(`unknown filter ID "${id}" ignored; valid IDs: ${specs.map((spec) => spec.id).join(", ")}`);
      continue;
    }
    if (typeof value !== "boolean") {
      warnings.push(`filter "${id}" must be boolean (got ${describeFilterValue(value)}; use true or false)`);
      continue;
    }
    // v1.10.1 (blocker 2): environment secret masking is a privacy
    // boundary, not a compression preference. Global (and direct)
    // configuration may not disable it — mirroring the project-config
    // guard below. The attempt warns and the filter stays enabled.
    if (id === "environment-secrets" && !value) {
      warnings.push("environment secret masking cannot be disabled; the filter remains enabled");
      continue;
    }
    for (const spec of matches) spec.enabled = value;
  }
  return warnings;
}

/** List registered filter commands (for debugging/stats). */
export function registeredCommands(): string[] {
  return specs.map((s) => s.command);
}
