import { DvmError } from "@dvmkit/sdk/internal";

/** Default locktime applied when `dvm wallet reserve` omits `--locktime`. */
export const DEFAULT_RESERVE_LOCKTIME_SECONDS = 30 * 24 * 60 * 60;

/**
 * Default NUT-11 locktime on a per-call payment's outputs.
 *
 * Deliberately past the 24h resume window (`RESUME_MAX_AGE_MS`): re-shipping to
 * a DVM that was merely unreachable always gets first crack, and the refund path
 * only opens once resume has given up. Reclaim is a backstop for a dead DVM, not
 * a normal-path timer.
 */
export const DEFAULT_PERCALL_LOCKTIME_SECONDS = 48 * 60 * 60;

export const PERCALL_LOCKTIME_ENV = "DVM_PERCALL_LOCKTIME_SEC";

/**
 * The locktime to put on a per-call payment, in seconds.
 *
 * Always at least the DVM's advertised `cashu.min_locktime` — that clamp is a
 * money-safety property, not politeness. A DVM under its accumulator threshold
 * banks the *original* locked proofs and melts them later, so the builder's
 * advertised floor is the window it has told callers it needs; undercutting it
 * would let a caller reclaim sats the DVM legitimately earned.
 *
 * The env knob shortens the base only — it can never take the result below the
 * builder's floor. Invalid / non-positive values fall back silently, matching
 * {@link inFlightTimeoutSeconds}.
 */
export function perCallLocktimeSeconds(minLocktimeSeconds?: number): number {
  const raw = process.env[PERCALL_LOCKTIME_ENV];
  const parsed = raw ? Number(raw) : NaN;
  const base =
    Number.isFinite(parsed) && parsed > 0 ? Math.floor(parsed) : DEFAULT_PERCALL_LOCKTIME_SECONDS;
  const floor =
    typeof minLocktimeSeconds === "number" && Number.isFinite(minLocktimeSeconds)
      ? Math.max(0, Math.floor(minLocktimeSeconds))
      : 0;
  return Math.max(base, floor);
}

const SUFFIXES: Record<string, number> = {
  s: 1,
  m: 60,
  h: 60 * 60,
  d: 24 * 60 * 60,
};

/**
 * Parse a human-friendly locktime string into seconds.
 *
 * Accepts a positive integer followed by a unit suffix:
 * - `s` seconds, `m` minutes, `h` hours, `d` days.
 *
 * Examples: `"30d"` → 2592000, `"7d"` → 604800, `"24h"` → 86400, `"1h"` →
 * 3600. Throws `DvmError("invalid_locktime", …)` on any other shape so the
 * CLI prints an actionable message instead of silently misinterpreting.
 */
export function parseLocktime(raw: string): number {
  const trimmed = raw.trim().toLowerCase();
  const match = /^(\d+)([smhd])$/.exec(trimmed);
  if (!match) {
    throw new DvmError(
      "invalid_locktime",
      `Could not parse "${raw}" as a locktime.`,
      "Pass a positive integer followed by `s`, `m`, `h`, or `d` — e.g. `30d`, `12h`, `90m`."
    );
  }
  const n = Number(match[1]);
  if (!Number.isFinite(n) || n <= 0) {
    throw new DvmError(
      "invalid_locktime",
      `Locktime must be a positive number; got "${raw}".`,
      "Pass a positive integer followed by `s`, `m`, `h`, or `d` — e.g. `30d`, `12h`, `90m`."
    );
  }
  const suffix = match[2];
  const seconds = n * SUFFIXES[suffix];
  return seconds;
}

/**
 * Pretty-print a number of seconds as the shortest equivalent `Nd`/`Nh`/
 * `Nm`/`Ns` form. Used by reserve/release output so the human/JSON surfaces
 * echo back what the user wrote — `30d` rather than `2592000s`.
 */
export function formatLocktime(seconds: number): string {
  if (seconds <= 0) return `${seconds}s`;
  if (seconds % SUFFIXES.d === 0) return `${seconds / SUFFIXES.d}d`;
  if (seconds % SUFFIXES.h === 0) return `${seconds / SUFFIXES.h}h`;
  if (seconds % SUFFIXES.m === 0) return `${seconds / SUFFIXES.m}m`;
  return `${seconds}s`;
}
