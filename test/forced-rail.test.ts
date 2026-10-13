import { describe, expect, it } from "vitest";

import { parseForcedRail } from "../src/lib/forced-rail";

describe("parseForcedRail", () => {
  it("normalizes an explicit supported rail", () => {
    expect(parseForcedRail(" CASHU ")).toBe("cashu");
  });

  it("keeps an omitted rail eligible for normal fallback", () => {
    expect(parseForcedRail(undefined)).toBeUndefined();
  });

  it.each(["", "   ", "lightning"])("rejects %j instead of enabling fallback", (rail) => {
    expect(() => parseForcedRail(rail)).toThrowError(
      expect.objectContaining({ code: "invalid_rail" })
    );
  });
});
