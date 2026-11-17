import { describe, expect, it } from "vitest";
import { formatDurationMs, parseDurationMs } from "../src/lib/duration";

describe("parseDurationMs", () => {
  it.each([
    ["30s", 30_000],
    ["12h", 43_200_000],
    ["1h30m", 5_400_000],
    ["9h15m", 33_300_000],
    ["9h30m", 34_200_000],
    ["1d2h3m4s", 93_784_000],
    [" 45m ", 2_700_000],
  ])("reads %j as %i ms", (input, ms) => {
    expect(parseDurationMs(input)).toBe(ms);
  });

  // A clock time, a fraction, an out-of-order compound or an ISO time is a caller
  // input error with guidance, not an internal failure.
  it.each(["9am", "7.5h", "30m1h", "1h1h", "", "h", "2026-11-17T06:00:00Z"])("refuses %j as invalid_arguments naming the accepted forms", (input) => {
    expect(() => parseDurationMs(input)).toThrow(expect.objectContaining({
      code: "invalid_arguments",
      hint: expect.stringContaining("1h30m"),
    }));
  });

  // The wait-limit hint prints formatDurationMs output for the caller to pass back as --until.
  it.each([1_000, 59_000, 90_000, 5_400_000, 33_300_000, 86_400_000, 93_784_000])("reads back what it formats for %i ms", (ms) => {
    expect(parseDurationMs(formatDurationMs(ms))).toBe(ms);
  });
});
