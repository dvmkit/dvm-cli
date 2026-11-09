import type { Quote } from "@dvmkit/sdk/internal";
import { describe, expect, it } from "vitest";

import { quoteWithinDeclaredLimit } from "../src/lib/quote-limit";

const tempoQuote: Quote = {
  upfront: { amount: 0.02, amount_micro: 20_000, currency: "usd" },
  description: "fixed price",
  priceMsats: 25_000,
};

describe("native-dollar quote limits", () => {
  it("accepts an exact Tempo dollar price despite advisory BTC/USD drift", () => {
    expect(quoteWithinDeclaredLimit(tempoQuote, 24_503, "$0.02", "tempo")).toBe(true);
  });

  it("refuses one Tempo microunit above the declared dollar limit", () => {
    expect(
      quoteWithinDeclaredLimit(
        { ...tempoQuote, upfront: { ...tempoQuote.upfront, amount_micro: 20_001 } },
        24_503,
        "$0.02",
        "tempo"
      )
    ).toBe(false);
  });

  it.each(["eur", "usdc"])("refuses Tempo quote currency %s", (currency) => {
    expect(
      quoteWithinDeclaredLimit(
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
      quoteWithinDeclaredLimit(
        { ...tempoQuote, upfront: { amount: 0.02, currency: "usd" }, priceMsats: 1 },
        24_503,
        "$0.02",
        "tempo"
      )
    ).toBe(false);
  });

  it("keeps Tempo bare-msat limits on the advisory comparison", () => {
    expect(quoteWithinDeclaredLimit(tempoQuote, 24_503, "24503", "tempo")).toBe(false);
  });

  it.each(["cashu", undefined, "lightning", "x402", "tempo"])(
    "compares exact USD prices with dollar limits on rail %s",
    (rail) => {
      const quote: Quote = {
        upfront: { amount: 0.99, amount_micro: 990_000, currency: "usd" },
        description: "fixed USD price",
        priceMsats: 1_312_000,
      };
      expect(quoteWithinDeclaredLimit(quote, 1_311_750, "$0.99", rail)).toBe(true);
      expect(quoteWithinDeclaredLimit(quote, 1_298_500, "$0.98", rail)).toBe(false);
      expect(quoteWithinDeclaredLimit(quote, 2_000_000, "$0.98", rail)).toBe(false);
    }
  );

  it.each(["cashu", undefined])("keeps millisat-only quotes on the millisat comparison with rail %s", (rail) => {
    const quote: Quote = { upfront: { amount: 0, currency: "usd" }, description: "millisat price", priceMsats: 1_312_000 };
    expect(quoteWithinDeclaredLimit(quote, 1_312_000, "1312000", rail)).toBe(true);
    expect(quoteWithinDeclaredLimit(quote, 1_311_999, "1311999", rail)).toBe(false);
    expect(quoteWithinDeclaredLimit(quote, 1_311_750, "$0.99", rail)).toBe(false);
  });

  it.each(["eur", "usdc"])("keeps non-USD %s prices on the millisat comparison", (currency) => {
    const quote = { ...tempoQuote, upfront: { ...tempoQuote.upfront, currency } };
    expect(quoteWithinDeclaredLimit(quote, 24_503, "$0.02", "cashu")).toBe(false);
    expect(quoteWithinDeclaredLimit(quote, 25_000, "$0.02", "cashu")).toBe(true);
  });

  it.each([undefined, -1, 0, 0.5, NaN, Infinity, Number.MAX_SAFE_INTEGER + 1])(
    "falls back to millisats for an unvalidated USD microunit amount %s",
    (amountMicro) => {
      const quote = { ...tempoQuote, upfront: { ...tempoQuote.upfront, amount_micro: amountMicro } };
      expect(quoteWithinDeclaredLimit(quote, 24_503, "$0.02", "cashu")).toBe(false);
      expect(quoteWithinDeclaredLimit(quote, 25_000, "$0.02", "cashu")).toBe(true);
    }
  );

  it("keeps explicit millisat limits on the millisat comparison for a USD quote", () => {
    expect(quoteWithinDeclaredLimit(tempoQuote, 24_503, "24503", "cashu")).toBe(false);
    expect(quoteWithinDeclaredLimit(tempoQuote, 25_000, "25000", "cashu")).toBe(true);
  });

  it("preserves x402's exact USDC microunit comparison", () => {
    const quote = { ...tempoQuote, requiredUsdcMicro: "20000" };
    expect(quoteWithinDeclaredLimit(quote, 24_503, "$0.02", "x402")).toBe(true);
    expect(
      quoteWithinDeclaredLimit({ ...quote, requiredUsdcMicro: "20001" }, 24_503, "$0.02", "x402")
    ).toBe(false);
  });
});
