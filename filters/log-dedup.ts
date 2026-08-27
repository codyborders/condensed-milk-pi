/**
 * Generic log line dedup filter.
 *
 * Collapses consecutive identical lines (modulo timestamps) to "line [xN]".
 * Catches journalctl, tail, docker logs, tmux capture-pane output.
 */
import { registerFilter, type FilterResult } from "./dispatch.js";

const TIMESTAMP_PATTERNS = [
  /^\[\d{4}-\d{2}-\d{2}[T ]\d{2}:\d{2}:\d{2}(?:\.\d+)?(?:Z|[+-]\d{2}:?\d{2})?\]\s*/,
  /^\d{4}-\d{2}-\d{2}[T ]\d{2}:\d{2}:\d{2}(?:\.\d+)?(?:Z|[+-]\d{2}:?\d{2})?\s+/,
  /^(?:Jan|Feb|Mar|Apr|May|Jun|Jul|Aug|Sep|Oct|Nov|Dec)\s+\d{1,2}\s+\d{2}:\d{2}:\d{2}\s+/i,
  /^(?:\d{10}|\d{13})\s+/,
  /^\d{2}:\d{2}:\d{2}(?:[.,]\d+)?\s+/,
];

function normalize(line: string): string {
  for (const pattern of TIMESTAMP_PATTERNS) {
    const match = pattern.exec(line);
    if (match) return line.slice(match[0].length);
  }
  return line;
}

function filterLogOutput(input: string): FilterResult | null {
  if (input.length === 0) return null;

  const lines = input.split("\n");
  if (lines.length <= 15) return null;

  const out: string[] = [];
  let previous: { canonical: string; line: string; count: number } | null = null;

  const emit = (): void => {
    if (!previous) return;
    out.push(previous.count > 1 ? `${previous.line}  [x${previous.count}]` : previous.line);
  };

  for (const line of lines) {
    const canonical = normalize(line);
    if (canonical.length > 0 && previous !== null && previous.canonical === canonical) {
      previous.count++;
      continue;
    }
    emit();
    previous = { canonical, line, count: 1 };
  }
  emit();

  const result = out.join("\n");
  return result.length < input.length ? { output: result, category: "fast" } : null;
}

registerFilter("journalctl", filterLogOutput, "fast");
registerFilter("docker logs", filterLogOutput, "fast");
registerFilter("tail", filterLogOutput, "fast");
registerFilter("tmux capture-pane", filterLogOutput, "fast");
