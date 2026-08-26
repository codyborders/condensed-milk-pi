/**
 * ANSI escape code stripper.
 * Runs on ALL bash output before other filters.
 * Zero information loss — purely cosmetic codes that waste tokens.
 *
 * Ported from MasuRii/pi-rtk-optimizer techniques/ansi.ts
 */

export function stripAnsi(text: string): string {
  if (!text.includes("\x1b")) return text;
  return text
    // CSI: ESC [ parameter bytes, optional intermediate bytes, final byte.
    .replace(/\x1b\[[0-?]*[ -/]*[@-~]/g, "")
    // OSC: ESC ] payload terminated by BEL or ST (ESC backslash).
    .replace(/\x1b\][^\x07\x1b]*(?:\x07|\x1b\\)/g, "");
}
