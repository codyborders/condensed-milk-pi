/**
 * Python traceback filter.
 *
 * Uncertain output passes through. A recognized traceback keeps selected frames
 * with their paths and line numbers, the exception, and omitted-frame count.
 */
import { registerFilter, type FilterResult } from "./dispatch.js";

const TB_MARKER = "Traceback (most recent call last):";
const FRAME_HEADER = /^  File "([^"]+)", line (\d+)(?:, in .*)?$/;
const EXCEPTION_LINE = /^[A-Za-z_]\w*(?:\.[A-Za-z_]\w*)*: .+$/;

function filterPythonOutput(input: string): FilterResult | null {
  if (input.length === 0) return null;

  const lines = input.split("\n");
  const markerIndexes = lines.reduce<number[]>((indexes, line, index) => {
    if (line === TB_MARKER) indexes.push(index);
    return indexes;
  }, []);
  if (markerIndexes.length !== 1) return null;

  const markerIndex = markerIndexes[0];
  const frames: string[] = [];
  let index = markerIndex + 1;
  while (index < lines.length) {
    const header = lines[index];
    if (!FRAME_HEADER.test(header)) break;

    // Every frame must contain its source line. Unknown traceback variants
    // decline rather than risking a misleading compressed result.
    if (index + 1 >= lines.length || !lines[index + 1].startsWith("    ")) return null;
    const frameLines = [header];
    index++;
    while (index < lines.length && lines[index].startsWith("    ")) {
      frameLines.push(lines[index]);
      index++;
    }
    frames.push(frameLines.join("\n"));
  }
  if (frames.length === 0) return null;

  // Only trailing newlines may follow the exception. Chained or malformed
  // traceback text stays untouched because its decisive exception is unclear.
  if (index >= lines.length || !EXCEPTION_LINE.test(lines[index])) return null;
  const exceptionLine = lines[index];
  for (let tail = index + 1; tail < lines.length; tail++) {
    if (lines[tail].trim().length > 0) return null;
  }

  const out: string[] = [TB_MARKER];
  if (frames.length <= 4) {
    out.push(...frames);
  } else {
    out.push(...frames.slice(0, 2));
    out.push(`  ... ${frames.length - 4} frames omitted ...`);
    out.push(...frames.slice(-2));
  }
  out.push(exceptionLine);

  const stdoutLines = lines.slice(0, markerIndex).filter((line) => line.length > 0);
  if (stdoutLines.length > 0) out.unshift(`[${stdoutLines.length} lines stdout before crash]`);

  return { output: out.join("\n"), category: "fast" };
}

registerFilter("python", filterPythonOutput, "fast");
registerFilter("python3", filterPythonOutput, "fast");
