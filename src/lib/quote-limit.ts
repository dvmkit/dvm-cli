import type { Quote } from "@dvmkit/sdk/internal";

/**
 * Compare exact dollar prices before advisory BTC conversions to avoid FX rounding.
 */
export function quoteWithinDeclaredLimit(
  quote: Quote,
  limitMsats: number,
  declaredLimit: string | undefined,
  rail: string | undefined
): boolean {
  const native = quoteWithinNativeDollarLimit(quote, declaredLimit, rail);
  return native ?? quote.priceMsats <= limitMsats;
}

export function dollarLimitMicro(declaredLimit: string): bigint | undefined {
  const amount = /^\$(\d+)(?:\.(\d{1,6}))?$/.exec(declaredLimit.trim().replace(/^\$\./, "$0."));
  if (!amount) return undefined;
  const whole = BigInt(amount[1]);
  const fraction = BigInt((amount[2] || "").padEnd(6, "0"));
  return whole * 1_000_000n + fraction;
}

function quoteWithinNativeDollarLimit(
  quote: Quote,
  declaredLimit: string | undefined,
  rail: string | undefined
): boolean | undefined {
  const normalizedRail = rail?.trim().toLowerCase();
  if (normalizedRail === "x402") {
    const native = x402QuoteWithinDollarLimit(quote, declaredLimit);
    if (native !== undefined) return native;
  }
  const upfront = upfrontQuoteWithinDollarLimit(quote, declaredLimit);
  if (normalizedRail === "tempo" && declaredLimit?.trim().startsWith("$")) {
    return upfront ?? false;
  }
  return upfront;
}

function x402QuoteWithinDollarLimit(
  quote: Quote,
  declaredLimit: string | undefined
): boolean | undefined {
  if (!declaredLimit || !quote.requiredUsdcMicro) return undefined;
  const limitMicro = dollarLimitMicro(declaredLimit);
  if (limitMicro === undefined || !/^\d+$/.test(quote.requiredUsdcMicro)) return undefined;
  return BigInt(quote.requiredUsdcMicro) <= limitMicro;
}

function upfrontQuoteWithinDollarLimit(
  quote: Quote,
  declaredLimit: string | undefined
): boolean | undefined {
  if (!declaredLimit?.trim().startsWith("$")) return undefined;
  const limitMicro = dollarLimitMicro(declaredLimit);
  const amountMicro = quote.upfront?.amount_micro;
  if (
    limitMicro === undefined ||
    quote.upfront?.currency !== "usd" ||
    amountMicro === undefined ||
    !Number.isSafeInteger(amountMicro) ||
    amountMicro <= 0
  ) {
    return undefined;
  }
  return BigInt(amountMicro) <= limitMicro;
}
