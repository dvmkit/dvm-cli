import { DvmError } from "@dvmkit/sdk/internal";

const MAX_TIMER_MS = 2_147_483_647;
const DECIMAL = /^(?:\d+(?:\.\d*)?|\.\d+)$/;
const INTEGER = /^\d+$/;

interface IntegerOption {
  code: string;
  name: string;
  defaultValue: number;
  min: number;
  max?: number;
  hint: string;
}

/** Parse a base-10 CLI integer without accepting prefixes, fractions, or unsafe values. */
export function parseDiscoveryInteger(raw: string | undefined, option: IntegerOption): number {
  if (raw === undefined) return option.defaultValue;

  const value = INTEGER.test(raw) ? Number(raw) : Number.NaN;
  if (
    !Number.isSafeInteger(value) ||
    value < option.min ||
    (option.max !== undefined && value > option.max)
  ) {
    throw new DvmError(
      option.code,
      `Invalid --${option.name}: "${raw}".`,
      option.hint
    );
  }
  return value;
}

/** Parse positive timeout seconds and return a duration safe for Node timers. */
export function parseDiscoveryTimeout(raw: string | undefined, defaultMs = 15_000): number {
  if (raw === undefined) return defaultMs;

  const seconds = DECIMAL.test(raw) ? Number(raw) : Number.NaN;
  const milliseconds = seconds * 1_000;
  if (!Number.isFinite(milliseconds) || seconds <= 0 || milliseconds > MAX_TIMER_MS) {
    throw new DvmError(
      "invalid_timeout",
      `Invalid --timeout: "${raw}".`,
      `Use a positive number of seconds no greater than ${MAX_TIMER_MS / 1_000}.`
    );
  }
  return milliseconds;
}
