import { describe, expect, it, vi } from "vitest";
import { getLastKnownBtcRate } from "@dvmkit/sdk/internal";
import { costAnchor, formatAmount, formatAmountBestEffort, formatPaymentAmount, formatSats, monetaryJson, parseBudget } from "../src/lib/currency";
vi.mock("@dvmkit/sdk/internal", async (importOriginal) => ({
  ...(await importOriginal<typeof import("@dvmkit/sdk/internal")>()),
  getLastKnownBtcRate: vi.fn(() => null),
}));

describe("formatAmount", () => {
  const rate = 100_000;

  it("formats whole sats with thousands separator", () => {
    const result = formatAmount(5_000_000, rate);
    expect(result).toBe("~$5.00 (5,000 sats) — comparable to a coffee");
  });
});

describe("formatSats", () => {
  it.each([
    [0, "0 sats"],
    [40, "40 msats"],
    [999, "999 msats"],
    [1_000, "1 sats"],
    [1_500, "1.5 sats"],
    [5_000_000, "5,000 sats"],
  ])("renders %i msats as %s", (msats, expected) => {
    expect(formatSats(msats)).toBe(expected);
  });
});

describe("formatPaymentAmount", () => {
  const freshRate = { rate: 100_000, cachedAt: Date.now() };

  it("leads with the provider's own fiat price and keeps sats parenthetical", () => {
    expect(formatPaymentAmount(5_000, { amount: 0.05, currency: "usd" })).toBe(
      "$0.05 USD (5 sats) — comparable to an API call"
    );
  });

  it("honours a non-USD currency on both the figure and the anchor", () => {
    expect(formatPaymentAmount(2_000_000, { amount: 500, currency: "jpy" })).toBe(
      "¥500 JPY (2,000 sats) — comparable to a coffee"
    );
  });

  it("drops the anchor once the decision is made", () => {
    expect(formatPaymentAmount(5_000, { amount: 0.05, currency: "usd" }, { anchor: false })).toBe(
      "$0.05 USD (5 sats)"
    );
  });

  // No fiat envelope: fall back to the cached-rate estimate, which is
  // explicitly approximate ("~") because the conversion is the client's.
  it("estimates from the cached BTC rate when the provider stated no fiat price", () => {

    vi.mocked(getLastKnownBtcRate).mockReturnValue(freshRate);
    expect(formatPaymentAmount(5_000_000)).toBe("~$5.00 (5,000 sats) — comparable to a coffee");
  });

  it("degrades to sats when no rate has ever been cached", () => {
    vi.mocked(getLastKnownBtcRate).mockReturnValue(null);
    expect(formatPaymentAmount(5_000_000)).toBe("5000 sats");
  });

  // The transport synthesises `{ amount: 0, currency: "usd" }` for a provider
  // that priced in `price_msats` alone, so a zero envelope means "no stated
  // fiat price", not "free" — leading with $0.00 USD would misprice a real
  // charge at the consent moment.
  it("treats a zero-amount envelope as no fiat price at all", () => {
    vi.mocked(getLastKnownBtcRate).mockReturnValue(null);
    expect(formatPaymentAmount(5_000_000, { amount: 0, currency: "usd" })).toBe("5000 sats");
  });
});

describe("formatAmountBestEffort", () => {
  it("omits the cost anchor when asked", () => {

    vi.mocked(getLastKnownBtcRate).mockReturnValue({ rate: 100_000, cachedAt: Date.now() });
    expect(formatAmountBestEffort(5_000_000, { anchor: false })).toBe("~$5.00 (5,000 sats)");
  });
});

describe("costAnchor", () => {
  it("uses the USD anchor bands at their inclusive and exclusive boundaries", () => {
    for (const [amount, expected] of [
      [0.001, "fraction of a cent"], [0.009, "fraction of a cent"],
      [0.01, "comparable to an API call"], [0.05, "comparable to an API call"], [0.1, "comparable to an API call"],
      [0.11, "comparable to a ChatGPT query"], [0.5, "comparable to a ChatGPT query"], [1, "comparable to a ChatGPT query"],
      [1.01, "comparable to a coffee"], [5, "comparable to a coffee"], [10, "comparable to a coffee"],
      [10.01, "significant purchase — review carefully"], [50, "significant purchase — review carefully"],
    ] as const) {
      expect(costAnchor(amount), String(amount)).toBe(expected);
    }
  });

  it("applies JPY-scale bands when currency is jpy", () => {
    // 300 JPY ≈ $2 — must NOT hit "significant purchase" the way USD bands would.
    expect(costAnchor(300, "jpy")).toBe("comparable to a coffee");
    expect(costAnchor(0.5, "jpy")).toBe("fraction of a cent");
    expect(costAnchor(2000, "jpy")).toBe("significant purchase — review carefully");
  });

  it("falls back to USD bands for an unknown currency", () => {
    expect(costAnchor(0.05, "chf")).toBe("comparable to an API call");
  });
});

describe("monetaryJson", () => {
  it("returns correct shape with all fields", () => {
    const result = monetaryJson(5_000_000, 100_000);
    expect(result).toEqual({
      msats: 5_000_000,
      usd: 5,
      anchor: "comparable to a coffee",
      display: expect.stringContaining("$5.00"),
    });
  });

  it("rounds usd to 2 decimal places", () => {
    const result = monetaryJson(1_234_567, 100_000);
    expect(result.usd).toBe(1.23);
  });
});

describe("parseBudget", () => {
  it("parses raw millisats string", () => {
    expect(parseBudget("5000", 100_000)).toBe(5000);
  });

  it("parses USD string to millisats", () => {
    expect(parseBudget("$0.50", 100_000)).toBe(500_000);
  });

  it("throws on invalid budget", () => {
    expect(() => parseBudget("abc", 100_000)).toThrow("Invalid budget");
  });

  it("throws on invalid USD budget", () => {
    expect(() => parseBudget("$abc", 100_000)).toThrow("Invalid budget");
  });
});


describe("cached amount presentation", () => {
  it("marks a stale shared rate in the amount label", () => {
    vi.useFakeTimers();
    try {
      vi.setSystemTime(new Date("2026-01-01T00:10:00Z"));
      vi.mocked(getLastKnownBtcRate).mockReturnValue({ rate: 100_000, cachedAt: Date.now() - 600_000 });
      expect(formatAmountBestEffort(5_000_000)).toBe("~$5.00 (5,000 sats) — comparable to a coffee (rate cached 10 min ago)");
    } finally {
      vi.useRealTimers();
    }
  });
});
