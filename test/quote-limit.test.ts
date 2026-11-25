import type { Quote } from "@dvmkit/sdk/internal";
import { describe, expect, it } from "vitest";

import { quoteLimitPrice, quoteWithinDeclaredLimit } from "../src/lib/quote-limit";

const tempoQuote: Quote = {
  upfront: { amount: 0.02, amount_micro: 20_000, currency: "usd" },
  description: "fixed price",
  priceMsats: 25_000,
};

function fits(quote: Quote | undefined, limitMsats: number, declared: string, rail?: string, rate = 0) {
  return quoteWithinDeclaredLimit(quoteLimitPrice(quote, rail), limitMsats, declared, rate, rail);
}

describe("native-dollar quote limits", () => {
  it("accepts an exact Tempo dollar price despite advisory BTC/USD drift", () => {
    expect(fits(tempoQuote, 24_503, "$0.02", "tempo")).toBe(true);
  });

  it("refuses one Tempo microunit above the declared dollar limit", () => {
    expect(
      fits(
        { ...tempoQuote, upfront: { ...tempoQuote.upfront, amount_micro: 20_001 } },
        24_503,
        "$0.02",
        "tempo"
      )
    ).toBe(false);
  });

  it.each(["eur", "usdc"])("refuses Tempo quote currency %s", (currency) => {
    expect(
      fits(
        {
          ...tempoQuote,
          upfront: { ...tempoQuote.upfront, currency },
          priceMsats: 1,
        },
        24_503,
        "$0.02",
        "tempo"
      )
    ).toBe(false);
  });

  it("refuses a Tempo dollar quote without a validated exact microunit amount", () => {
    expect(
      fits(
        { ...tempoQuote, upfront: { amount: 0.02, currency: "usd" }, priceMsats: 1 },
        24_503,
        "$0.02",
        "tempo"
      )
    ).toBe(false);
  });

  it("compares the native Tempo charge to a bare-msat limit using FX", () => {
    expect(fits(tempoQuote, 20_000, "20000", "tempo", 100_000)).toBe(true);
    expect(fits(tempoQuote, 19_999, "19999", "tempo", 100_000)).toBe(false);
  });

  it.each(["cashu", undefined, "lightning", "x402", "tempo"])(
    "compares exact USD prices with dollar limits on rail %s",
    (rail) => {
      const quote: Quote = {
        upfront: { amount: 0.99, amount_micro: 990_000, currency: "usd" },
        description: "fixed USD price",
        priceMsats: 1_312_000,
      };
      expect(fits(quote, 1_311_750, "$0.99", rail)).toBe(true);
      expect(fits(quote, 1_298_500, "$0.98", rail)).toBe(false);
      expect(fits(quote, 2_000_000, "$0.98", rail)).toBe(false);
    }
  );

  it.each(["cashu", undefined])("keeps millisat-only quotes on the millisat comparison with rail %s", (rail) => {
    const quote: Quote = { upfront: { amount: 0, currency: "usd" }, description: "millisat price", priceMsats: 1_312_000 };
    expect(fits(quote, 1_312_000, "1312000", rail)).toBe(true);
    expect(fits(quote, 1_311_999, "1311999", rail)).toBe(false);
    expect(fits(quote, 1_311_750, "$0.99", rail)).toBe(false);
  });

  it.each(["eur", "usdc"])("keeps non-USD %s prices on the millisat comparison", (currency) => {
    const quote = { ...tempoQuote, upfront: { ...tempoQuote.upfront, currency } };
    expect(fits(quote, 24_503, "$0.02", "cashu")).toBe(false);
    expect(fits(quote, 25_000, "$0.02", "cashu")).toBe(true);
  });

  it.each([-1, 0, 0.5, NaN, Infinity, Number.MAX_SAFE_INTEGER + 1])(
    "falls back to millisats for an unvalidated USD microunit amount %s",
    (amountMicro) => {
      const quote = { ...tempoQuote, upfront: { ...tempoQuote.upfront, amount_micro: amountMicro } };
      expect(fits(quote, 24_503, "$0.02", "cashu")).toBe(false);
      expect(fits(quote, 25_000, "$0.02", "cashu")).toBe(true);
    }
  );

  it("refuses a positive native charge without FX even when the advisory price fits", () => {
    expect(fits(tempoQuote, 25_000, "25000", "cashu")).toBe(false);
  });

  it("uses a legacy decimal USD amount in the exact comparison", () => {
    const quote = { ...tempoQuote, upfront: { amount: 0.02, currency: "usd" }, priceMsats: 1 };
    expect(fits(quote, 20_000, "$2.000000e-2")).toBe(true);
    expect(fits(quote, 20_000, "$0.0199999")).toBe(false);
  });

  it("does not read unknown or metered pricing as free", () => {
    const free = { ...tempoQuote, upfront: { amount: 0, currency: "usd" }, priceMsats: 0 };
    expect(fits(free, 0, "0")).toBe(true);
    expect(fits({ ...free, shape: "rate" }, 0, "0")).toBe(false);
    expect(fits(undefined, 0, "0")).toBe(false);
  });

  it("preserves x402's exact USDC microunit comparison", () => {
    const quote = { ...tempoQuote, requiredUsdcMicro: "20000" };
    expect(fits(quote, 24_503, "$0.02", "x402")).toBe(true);
    expect(
      fits({ ...quote, requiredUsdcMicro: "20001" }, 24_503, "$0.02", "x402")
    ).toBe(false);
  });
});
