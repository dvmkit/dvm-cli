import { DvmError } from "@dvmkit/sdk/internal";

const UNIT_MS = { d: 86_400_000, h: 3_600_000, m: 60_000, s: 1_000 } as const;

// Integer counts in largest-to-smallest unit order, each unit at most once:
// `30s`, `5m`, `12h`, `1d`, `1h30m`, `9h15m`. Not an absolute time.
const DURATION_PATTERN = /^(?:(\d+)d)?(?:(\d+)h)?(?:(\d+)m)?(?:(\d+)s)?$/;

/** Whether `input` is in the duration grammar {@link parseDurationMs} accepts. */
export function isDuration(input: string): boolean {
  const text = input.trim();
  return text !== "" && DURATION_PATTERN.test(text);
}

/**
 * Parse a relative duration such as `30s`, `5m`, `12h`, `1d` or `1h30m` into
 * milliseconds. Throws `invalid_arguments` on anything else, including clock
 * times and ISO timestamps.
 */
export function parseDurationMs(input: string): number {
  const match = isDuration(input) ? DURATION_PATTERN.exec(input.trim()) : null;
  if (!match) {
    throw new DvmError(
      "invalid_arguments",
      `Invalid duration "${input}"; use e.g. 30s, 5m, 2h, 1d`,
      "Give a length of time from now as whole numbers with units d, h, m, s, largest first: 30s, 45m, 12h, 1d or 1h30m. A clock time or date is not accepted; work out how long until then."
    );
  }
  const [, d, h, m, s] = match;
  return Number(d ?? 0) * UNIT_MS.d + Number(h ?? 0) * UNIT_MS.h + Number(m ?? 0) * UNIT_MS.m + Number(s ?? 0) * UNIT_MS.s;
}

/** Inverse of {@link parseDurationMs}: the largest unit that states `ms` exactly. */
export function formatDurationMs(ms: number): string {
  for (const [unit, size] of [["d", 86_400_000], ["h", 3_600_000], ["m", 60_000]] as const)
    if (ms >= size && ms % size === 0) return `${ms / size}${unit}`;
  return `${Math.ceil(ms / 1000)}s`;
}
