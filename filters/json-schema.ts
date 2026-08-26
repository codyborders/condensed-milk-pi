/**
 * JSON schema extraction filter (lossy-output boundary).
 *
 * v1.10.0 (milestone 3C1): there is NO generic JSON fallback — by default
 * curl, cat, API clients, and unknown commands preserve large JSON output
 * verbatim. Extraction happens only for command prefixes explicitly
 * allowlisted in ~/.config/condensed-milk.json under `jsonSchemaCommands`
 * AND enabled via the global `filters: { "json-schema": true }` toggle.
 * Project configuration cannot enable it (default-off filter rule).
 *
 * Extraction contract:
 *  - heterogeneous arrays: every observed type is represented
 *  - deterministic output for identical input
 *  - scalar values are omitted (types only, never values)
 *  - array lengths and object key shapes are preserved
 *  - malformed or uncertain input declines (returns null)
 *  - a schema is returned only when it is shorter than the input
 */
import { registerFilter, type FilterResult } from "./dispatch.js";

const JSON_SCHEMA_FILTER_ID = "json-schema";

function filterJsonSchema(input: string): FilterResult | null {
  const trimmed = input.trim();
  // Uncertain input declines: only well-formed top-level objects/arrays.
  if (trimmed[0] !== "{" && trimmed[0] !== "[") return null;

  let parsed: unknown;
  try {
    parsed = JSON.parse(trimmed);
  } catch {
    return null; // Malformed JSON passes through untouched.
  }
  if (typeof parsed !== "object" || parsed === null) return null;

  const header = Array.isArray(parsed)
    ? `JSON array (${(parsed as unknown[]).length} items)`
    : `JSON object (${Object.keys(parsed as Record<string, unknown>).length} keys)`;
  const output = `${header}\n${describeValue(parsed, 0)}`;
  // Lossy output must pay for itself: schema only when strictly shorter.
  return output.length < input.length ? { output, category: "medium" } : null;
}

// Recursion depth bound. Deeper structure is summarized as its shape
// (e.g. "object(3 keys)") instead of being expanded — keeps the schema
// bounded and deterministic regardless of nesting.
const MAX_DEPTH = 4;

/** Deterministic, value-free type descriptor for any parsed JSON value. */
function describeValue(value: unknown, depth: number): string {
  if (value === null) return "null";
  const t = typeof value;
  if (t === "boolean" || t === "number" || t === "string") return t;
  if (Array.isArray(value)) {
    if (value.length === 0) return "array(0)";
    return `array(${value.length}) of ${describeUnion(value, depth)}`;
  }
  if (t === "object") {
    const entries = Object.entries(value as Record<string, unknown>);
    if (entries.length === 0) return "object(0)";
    if (depth >= MAX_DEPTH) return `object(${entries.length} keys)`;
    const fields = entries.map(([k, v]) => `${JSON.stringify(k)}: ${describeValue(v, depth + 1)}`);
    return `object(${entries.length}) { ${fields.join(", ")} }`;
  }
  return "unknown";
}

/** Deterministic first-occurrence union of every observed element type. */
function describeUnion(items: unknown[], depth: number): string {
  const seen: string[] = [];
  for (const item of items) {
    const d = describeValue(item, depth + 1);
    if (!seen.includes(d)) seen.push(d);
  }
  return seen.join(" | ");
}

function describeEntryValue(value: unknown): string {
  if (typeof value === "string") return JSON.stringify(value);
  if (value === null) return "null";
  if (Array.isArray(value)) return "array";
  return typeof value;
}

/**
 * Validate the global-only `jsonSchemaCommands` config value and register
 * each valid command prefix under the stable json-schema ID (default off).
 * Returns actionable warnings; never throws.
 */
export function registerJsonSchemaConfig(value: unknown): string[] {
  const warnings: string[] = [];
  if (value === undefined || value === null) return warnings;
  if (!Array.isArray(value)) {
    warnings.push(
      `jsonSchemaCommands must be an array of command prefixes (e.g. ["curl", "gh api"]) in ~/.config/condensed-milk.json — got ${describeEntryValue(value)}; ignored`,
    );
    return warnings;
  }
  const seen = new Set<string>();
  for (const entry of value) {
    if (typeof entry !== "string") {
      warnings.push(`jsonSchemaCommands entry must be a command string — got ${describeEntryValue(entry)}; entry ignored`);
      continue;
    }
    const prefix = entry.trim();
    if (prefix.length === 0) {
      warnings.push(`jsonSchemaCommands entry must be a non-empty command prefix — empty entry ignored`);
      continue;
    }
    if (seen.has(prefix)) {
      warnings.push(`duplicate jsonSchemaCommands entry "${prefix}" ignored`);
      continue;
    }
    seen.add(prefix);
    registerFilter(prefix, filterJsonSchema, "medium", { id: JSON_SCHEMA_FILTER_ID, dynamic: true });
  }
  return warnings;
}
