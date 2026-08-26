/**
 * TypeScript compiler output filter.
 *
 * Only complete, recognized diagnostic sets are compressed. Success, watch,
 * malformed, unknown, and failed command output pass through unchanged.
 */
import { registerFilter, type FilterContext, type FilterResult } from "./dispatch.js";

const DIAGNOSTIC = /^(.+)\((\d+),(\d+)\):\s+error\s+(TS\d+):\s+(.+)$/;
const SUMMARY = /^Found\s+(\d+)\s+errors?\.$/;
const MAX_RETAINED_DIAGNOSTICS = 10;

function filterTsc(context: FilterContext): FilterResult | null {
  const input = context.stdout;
  if (input.length === 0) return null;
  if (/(?:^|\s)(?:-w|--watch|--watchFile|--watchDirectory)(?:\s|$)/.test(context.command)) return null;
  if (/watch(?:ing| mode)|file changes detected|starting compilation in watch mode/i.test(input)) return null;

  const lines = input.split("\n");
  let terminalIndex = lines.length - 1;
  while (terminalIndex >= 0 && lines[terminalIndex].trim().length === 0) terminalIndex--;
  if (terminalIndex < 0) return null;

  const summaryLine = lines[terminalIndex].trim();
  const summaryMatch = summaryLine.match(SUMMARY);
  if (!summaryMatch) return null;
  const expectedCount = Number(summaryMatch[1]);
  if (!Number.isSafeInteger(expectedCount) || expectedCount < 1) return null;

  const diagnostics: string[] = [];
  for (let index = 0; index < terminalIndex; index++) {
    const line = lines[index];
    if (line.trim().length === 0) continue;
    if (!DIAGNOSTIC.test(line)) return null;
    diagnostics.push(line);
  }
  if (diagnostics.length !== expectedCount) return null;

  const retained = diagnostics.slice(0, MAX_RETAINED_DIAGNOSTICS);
  const omitted = diagnostics.length - retained.length;
  const out = [`tsc: ${summaryLine}`, ...retained];
  if (omitted > 0) out.push(`+${omitted} more diagnostics`);
  return { output: out.join("\n"), category: "fast" };
}

registerFilter("tsc", filterTsc, "fast", { context: true });
registerFilter("npx tsc", filterTsc, "fast", { context: true });
