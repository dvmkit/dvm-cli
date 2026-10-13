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

  it("does not apply Tempo native-dollar limits without an explicit Tempo rail", () => {
    expect(quoteWithinDeclaredLimit(tempoQuote, 24_503, "$0.02", undefined)).toBe(false);
  });

  it("preserves x402's exact USDC microunit comparison", () => {
    const quote = { ...tempoQuote, requiredUsdcMicro: "20000" };
    expect(quoteWithinDeclaredLimit(quote, 24_503, "$0.02", "x402")).toBe(true);
    expect(
      quoteWithinDeclaredLimit({ ...quote, requiredUsdcMicro: "20001" }, 24_503, "$0.02", "x402")
    ).toBe(false);
  });
});
