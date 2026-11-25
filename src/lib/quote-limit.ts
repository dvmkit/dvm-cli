import type { Quote } from "@dvmkit/sdk/internal";

import { decimalRatio } from "./currency";
import { hasKnownUpfrontPrice } from "./quote-upfront";

export interface QuoteLimitPrice {
  usdMicro?: bigint;
  msats?: number;
}

export function quoteLimitPrice(quote: Quote | undefined, rail?: string): QuoteLimitPrice {
  if (!quote) return {};
  const normalizedRail = rail?.trim().toLowerCase();
  const msats = Number.isSafeInteger(quote.priceMsats) && quote.priceMsats > 0
    ? quote.priceMsats
    : undefined;
  const usdc = quote.requiredUsdcMicro;
  if (normalizedRail === "x402" && usdc !== undefined && /^\d+$/.test(usdc)) {
    return { usdMicro: BigInt(usdc), msats };
  }
  const upfront = quote.upfront;
  if (!upfront || !hasKnownUpfrontPrice(quote)) return { msats };

  const micro = upfront.amount_micro;
  if ((micro ?? 0) === 0 && upfront.amount === 0 && quote.shape !== "rate" && quote.priceMsats === 0) {
    return { usdMicro: 0n, msats: 0 };
  }
  if (upfront.currency !== "usd") return { msats };
  if (micro !== undefined && Number.isSafeInteger(micro) && micro > 0) {
    return { usdMicro: BigInt(micro), msats };
  }
  if (micro === undefined && normalizedRail !== "tempo" && upfront.amount > 0) {
    const dollars = decimalRatio(String(upfront.amount));
    if (dollars) {
      // Round a legacy decimal charge up so a positive sub-micro price cannot read as free.
      const [numerator, denominator] = dollars;
      return { usdMicro: (numerator * 1_000_000n + denominator - 1n) / denominator, msats };
    }
  }
  return { msats };
}

export function declaredLimitMicro(
  limitMsats: number,
  declaredLimit: string | undefined,
  btcRate: number
): bigint | undefined {
  if (declaredLimit?.trim().startsWith("$")) return dollarLimitMicro(declaredLimit);
  if (limitMsats === 0) return 0n;
  const rate = btcRate > 0 ? decimalRatio(String(btcRate)) : undefined;
  if (rate && Number.isSafeInteger(limitMsats) && limitMsats >= 0) {
    return BigInt(limitMsats) * rate[0] / (100_000n * rate[1]);
  }
  return undefined;
}

export function quoteWithinDeclaredLimit(
  price: QuoteLimitPrice,
  limitMsats: number,
  declaredLimit: string | undefined,
  btcRate = 0,
  rail?: string
): boolean {
  const nativeLimit = declaredLimitMicro(limitMsats, declaredLimit, btcRate);
  if (price.usdMicro !== undefined) {
    if (nativeLimit !== undefined) return price.usdMicro <= nativeLimit;
    if (price.usdMicro === 0n) return limitMsats >= 0;
  }
  if (rail?.trim().toLowerCase() === "tempo" && declaredLimit?.trim().startsWith("$")) return false;
  return price.msats !== undefined && price.msats <= limitMsats;
}

export function dollarLimitMicro(declaredLimit: string): bigint | undefined {
  const text = declaredLimit.trim();
  if (!text.startsWith("$")) return undefined;
  const value = text.slice(1).trimStart();
  if (!Number.isFinite(parseFloat(value))) return undefined;

  // Match the decimal prefix accepted by parseBudget without rounding it to a float.
  const amount = /^([+-]?)(\d+\.?\d*|\.\d+)(?:e([+-]?\d+))?/i.exec(value);
  if (!amount) return undefined;
  const [, sign, mantissa, exponent] = amount;
  const [whole, fraction = ""] = mantissa.split(".");
  const digits = whole + fraction;
  if (!/[1-9]/.test(digits)) return 0n;
  const places = Math.max(0, whole.length + Number(exponent ?? 0) + 6);
  const micro = BigInt(digits.slice(0, places).padEnd(places, "0") || "0");
  if (sign !== "-") return micro;
  // A whole-microunit charge must fit under the declaration, even below zero.
  return /[1-9]/.test(digits.slice(places)) ? -micro - 1n : -micro;
}
