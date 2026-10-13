import { afterEach, describe, expect, it } from "vitest";

import { DvmError } from "@dvmkit/sdk/internal";
import {
  DEFAULT_PERCALL_LOCKTIME_SECONDS,
  DEFAULT_RESERVE_LOCKTIME_SECONDS,
  formatLocktime,
  parseLocktime,
  PERCALL_LOCKTIME_ENV,
  perCallLocktimeSeconds,
} from "../locktime";

describe("parseLocktime", () => {
  it("parses day / hour / minute / second suffixes", () => {
    expect(parseLocktime("30d")).toBe(30 * 86400);
    expect(parseLocktime("24h")).toBe(86400);
    expect(parseLocktime("90m")).toBe(90 * 60);
    expect(parseLocktime("45s")).toBe(45);
  });

  it("trims and lowercases input", () => {
    expect(parseLocktime(" 30D ")).toBe(30 * 86400);
  });

  it("rejects empty and malformed input", () => {
    expect(() => parseLocktime("")).toThrow(DvmError);
    expect(() => parseLocktime("days")).toThrow(DvmError);
    expect(() => parseLocktime("30")).toThrow(DvmError);
    expect(() => parseLocktime("30y")).toThrow(DvmError);
  });

  it("rejects zero", () => {
    expect(() => parseLocktime("0d")).toThrow(DvmError);
  });
});

describe("formatLocktime", () => {
  it("rounds back to the shortest suffix that divides evenly", () => {
    expect(formatLocktime(DEFAULT_RESERVE_LOCKTIME_SECONDS)).toBe("30d");
    expect(formatLocktime(36 * 3600)).toBe("36h");
    expect(formatLocktime(90 * 60)).toBe("90m");
    expect(formatLocktime(45)).toBe("45s");
  });

});

describe("perCallLocktimeSeconds", () => {
  afterEach(() => {
    // eslint-disable-next-line @typescript-eslint/no-dynamic-delete
    delete process.env[PERCALL_LOCKTIME_ENV];
  });

  it("defaults to 48h — past the 24h resume window, so resume goes first", () => {
    expect(perCallLocktimeSeconds()).toBe(DEFAULT_PERCALL_LOCKTIME_SECONDS);
    expect(DEFAULT_PERCALL_LOCKTIME_SECONDS).toBe(48 * 3600);
  });

  it("clamps up to the builder's advertised floor", () => {
    expect(perCallLocktimeSeconds(7 * 86400)).toBe(7 * 86400);
  });

  it("keeps the default when the builder asks for less", () => {
    expect(perCallLocktimeSeconds(3600)).toBe(DEFAULT_PERCALL_LOCKTIME_SECONDS);
  });

  it("lets the env knob shorten the base", () => {
    process.env[PERCALL_LOCKTIME_ENV] = "45";
    expect(perCallLocktimeSeconds()).toBe(45);
  });

  // The clamp is money safety, not politeness: a DVM under its accumulator
  // threshold banks the original locked proofs and melts later, so undercutting
  // its advertised floor would let a caller reclaim sats it had earned.
  it("will not let the env knob undercut the builder's floor", () => {
    process.env[PERCALL_LOCKTIME_ENV] = "45";
    expect(perCallLocktimeSeconds(7 * 86400)).toBe(7 * 86400);
  });

  it("ignores a junk or non-positive env value", () => {
    for (const raw of ["abc", "0", "-1", ""]) {
      process.env[PERCALL_LOCKTIME_ENV] = raw;
      expect(perCallLocktimeSeconds()).toBe(DEFAULT_PERCALL_LOCKTIME_SECONDS);
    }
  });
});
