import type { ProgressContent } from "@dvmkit/sdk";
import {
  info,
} from "./output";

const BAR_WIDTH = 24;

let active = false;

/**
 * Render a `progress` message in `--human` mode. In a TTY, redraws a single
 * bar line in place on stderr; otherwise falls back to a static `info()` line
 * (preserving the seq prefix) so piped/CI logs still see one entry per
 * heartbeat.
 */
export function renderProgressLine(content: ProgressContent, seq: number): void {
  const pct = Math.max(0, Math.min(100, content.percent_complete));
  const phase = content.current_phase ? ` (${content.current_phase})` : "";
  const hint = content.hint ? ` — ${content.hint}` : "";

  if (!process.stderr.isTTY) {
    info(`[${String(seq)}] Progress: ${String(pct)}%${phase}${hint}`);
    return;
  }

  const filled = Math.round((pct / 100) * BAR_WIDTH);
  const bar = "█".repeat(filled) + "░".repeat(BAR_WIDTH - filled);
  const pctStr = String(pct).padStart(3);
  process.stderr.write(`\r\x1b[K[${bar}] ${pctStr}%${phase}${hint}`);
  active = true;
}

/**
 * Close out an active in-place progress line so the next stderr write lands on
 * its own row. No-op when no bar has been drawn (non-TTY or never called).
 */
export function finalizeProgressLine(): void {
  if (!active) return;
  process.stderr.write("\n");
  active = false;
}

export function __resetProgressLineState(): void {
  active = false;
}
