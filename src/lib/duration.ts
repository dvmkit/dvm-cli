import { DvmError } from "@dvmkit/sdk/internal";

const UNIT_MS = { d: 86_400_000, h: 3_600_000, m: 60_000, s: 1_000 } as const;
const MAX_DURATION_MS = 365 * UNIT_MS.d;

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
  const components = match?.slice(1).map((count, index) => Number(count ?? 0) * Object.values(UNIT_MS)[index]) ?? [];
  const total = components.reduce((sum, component) => sum + component, 0);
  if (!match || components.some((component) => !Number.isSafeInteger(component)) ||
      !Number.isSafeInteger(total) || total > MAX_DURATION_MS) {
    throw new DvmError(
      "invalid_arguments",
      `Invalid duration "${input}"; use e.g. 30s, 5m, 2h, 1d or 1h30m`,
      "Give a length of time from now as whole numbers with units d, h, m, s, largest first: 30s, 45m, 12h, 1d or 1h30m. The maximum duration is 365d. A clock time or date is not accepted; work out how long until then."
    );
  }
  return total;
}

/** Whole-second compound duration, rounding any fractional second up. */
export function formatDurationMs(ms: number): string {
  let remaining = Math.ceil(ms / 1000) * 1000;
  const parts: string[] = [];
  for (const [unit, size] of Object.entries(UNIT_MS)) {
    const count = Math.floor(remaining / size);
    if (count > 0) parts.push(`${count}${unit}`);
    remaining %= size;
  }
  return parts.join("") || "0s";
}
