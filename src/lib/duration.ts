/**
 * Parse a short duration string (e.g. `30s`, `5m`, `2h`, `1d`) into
 * milliseconds.
 *
 * Accepts a single integer count followed by one unit: `s` (seconds),
 * `m` (minutes), `h` (hours), `d` (days). Throws on any other input.
 */
export function parseDurationMs(input: string): number {
  const match = /^(\d+)(s|m|h|d)$/.exec(input.trim());
  if (!match) {
    throw new Error(`Invalid duration "${input}"; use e.g. 30s, 5m, 2h, 1d`);
  }
  const count = Number(match[1]);
  const unitMs: Record<string, number> = {
    s: 1_000,
    m: 60_000,
    h: 3_600_000,
    d: 86_400_000,
  };
  return count * unitMs[match[2]];
}
