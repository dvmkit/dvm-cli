import { beforeEach, describe, expect, it, vi } from "vitest";

vi.mock("../src/lib/currency", () => ({ parseBudget: vi.fn() }));

import { parseBudget } from "../src/lib/currency";
import { DvmError } from "@dvmkit/sdk/internal";
import { buildPolicy } from "../src/lib/policy";

beforeEach(() => vi.clearAllMocks());

describe("buildPolicy", () => {
  it("parses the budget and derives the default payment limits", () => {
    vi.mocked(parseBudget).mockReturnValue(50_000);
    expect(buildPolicy({ budget: "50000", maxPayments: 1 }, 100_000)).toEqual({
      maxTotalMsats: 50_000,
      autoPayBelowMsats: 10_000,
      maxIncrementMsats: 50_000,
      maxPayments: 1,
    });
    expect(parseBudget).toHaveBeenCalledExactlyOnceWith("50000", 100_000);
  });

  it("parses each explicit limit with the supplied rate", () => {
    vi.mocked(parseBudget).mockReturnValueOnce(50_000).mockReturnValueOnce(5_000).mockReturnValueOnce(15_000);
    expect(buildPolicy({ budget: "50000", autoPayBelow: "5000", maxIncrement: "15000", maxPayments: 5 }, 100_000)).toEqual({
      maxTotalMsats: 50_000,
      autoPayBelowMsats: 5_000,
      maxIncrementMsats: 15_000,
      maxPayments: 5,
    });
    expect(vi.mocked(parseBudget).mock.calls).toEqual([["50000", 100_000], ["5000", 100_000], ["15000", 100_000]]);
  });

  it("uses zero spending limits without a budget and accepts a free job", () => {
    expect(buildPolicy({ maxPayments: 0 }, 100_000)).toEqual({
      maxTotalMsats: 0,
      autoPayBelowMsats: 0,
      maxIncrementMsats: 0,
      maxPayments: 0,
    });
    expect(parseBudget).not.toHaveBeenCalled();
  });

  it("requires a non-negative integer payment count with a relayable error", () => {
    for (const [maxPayments, code] of [[undefined, "missing_max_payments"], [-1, "invalid_max_payments"], [1.5, "invalid_max_payments"]] as const) {
      expect(() => buildPolicy({ maxPayments }, 100_000)).toThrow(expect.objectContaining({ code }));
      expect(() => buildPolicy({ maxPayments }, 100_000)).toThrow(DvmError);
    }
  });
});
