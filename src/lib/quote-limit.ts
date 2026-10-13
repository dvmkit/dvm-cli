import type { Quote } from "@dvmkit/sdk/internal";

/**
 * Check a quote against a caller-declared limit, preferring the rail's native
 * dollar units where that rail exposes an exact amount.
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

function quoteWithinNativeDollarLimit(
  quote: Quote,
  declaredLimit: string | undefined,
  rail: string | undefined
): boolean | undefined {
  const normalizedRail = rail?.trim().toLowerCase();
  if (normalizedRail === "x402") return x402QuoteWithinDollarLimit(quote, declaredLimit);
  if (normalizedRail === "tempo") return tempoQuoteWithinDollarLimit(quote, declaredLimit);
  return undefined;
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

function tempoQuoteWithinDollarLimit(
  quote: Quote,
  declaredLimit: string | undefined
): boolean | undefined {
  if (!declaredLimit?.trim().startsWith("$")) return undefined;
  const limitMicro = dollarLimitMicro(declaredLimit);
  const amountMicro = quote.upfront.amount_micro;
  if (
    limitMicro === undefined ||
    quote.upfront.currency !== "usd" ||
    amountMicro === undefined ||
    !Number.isSafeInteger(amountMicro) ||
    amountMicro <= 0
  ) {
    return false;
  }
  return BigInt(amountMicro) <= limitMicro;
}

function dollarLimitMicro(declaredLimit: string): bigint | undefined {
  const amount = /^\$(\d+)(?:\.(\d{1,6}))?$/.exec(declaredLimit.trim());
  if (!amount) return undefined;
  const whole = BigInt(amount[1]);
  const fraction = BigInt((amount[2] || "").padEnd(6, "0"));
  return whole * 1_000_000n + fraction;
}
