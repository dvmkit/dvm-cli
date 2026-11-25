import type { Quote } from "@dvmkit/sdk/internal";

import { hasKnownUpfrontPrice } from "./quote-upfront";

interface Decimal {
  digits: string;
  point: bigint;
  negative: boolean;
}

export interface QuoteLimitPrice {
  usd?: Decimal;
  msats?: number;
}

interface DeclaredLimit {
  declared?: string;
  msats: number;
}

function decimal(coefficient: string, exponent: bigint, negative = false): Decimal {
  const digits = coefficient.replace(/^0+/, "");
  if (!digits) return { digits: "", point: 0n, negative: false };
  return { digits: digits.replace(/0+$/, ""), point: BigInt(digits.length) + exponent, negative };
}

function parseDecimal(text: string): Decimal | undefined {
  // Match parseBudget's decimal prefix while retaining digits lost by parseFloat.
  const match = /^([+-]?)(\d+\.?\d*|\.\d+)(?:e([+-]?\d+))?/i.exec(text);
  if (!match || !Number.isFinite(parseFloat(match[0]))) return undefined;
  const [, sign, mantissa, exponent] = match;
  const [whole, fraction = ""] = mantissa.split(".");
  return decimal(whole + fraction, BigInt(exponent ?? "0") - BigInt(fraction.length), sign === "-");
}

function compareDecimals(a: Decimal, b: Decimal): number {
  if (a.negative !== b.negative) return a.negative ? -1 : 1;
  if (!a.digits || !b.digits) return Number(Boolean(a.digits)) - Number(Boolean(b.digits));
  // With the same decimal point, significant digits sort as strings once
  // trailing zeroes have been removed.
  const direction = a.negative ? -1 : 1;
  if (a.point !== b.point) return (a.point < b.point ? -1 : 1) * direction;
  if (a.digits === b.digits) return 0;
  return (a.digits < b.digits ? -1 : 1) * direction;
}

function floorMicro(amount: Decimal): bigint {
  const places = amount.point + 6n;
  if (!amount.digits) return 0n;
  if (places <= 0n) return amount.negative ? -1n : 0n;
  const count = Number(places);
  const whole = BigInt(amount.digits.slice(0, count).padEnd(count, "0"));
  if (!amount.negative) return whole;
  return count < amount.digits.length ? -whole - 1n : -whole;
}

export function usdFromMicro(micro: bigint): Decimal {
  return decimal(String(micro < 0n ? -micro : micro), -6n, micro < 0n);
}

export function quoteLimitPrice(quote: Quote | undefined, rail?: string): QuoteLimitPrice {
  if (!quote) return {};
  const msats = Number.isSafeInteger(quote.priceMsats) && quote.priceMsats > 0
    ? quote.priceMsats
    : undefined;
  const usdc = quote.requiredUsdcMicro;
  if (rail?.trim().toLowerCase() === "x402" && usdc !== undefined && /^\d+$/.test(usdc)) {
    return { usd: usdFromMicro(BigInt(usdc)), msats };
  }
  const upfront = quote.upfront;
  if (!upfront || !hasKnownUpfrontPrice(quote)) return { msats };

  const micro = upfront.amount_micro;
  if ((micro ?? 0) === 0 && upfront.amount === 0 && quote.shape !== "rate" && quote.priceMsats === 0) {
    return { usd: usdFromMicro(0n), msats: 0 };
  }
  if (upfront.currency !== "usd") return { msats };
  if (micro !== undefined && Number.isSafeInteger(micro) && micro > 0) {
    return { usd: usdFromMicro(BigInt(micro)), msats };
  }
  if (micro === undefined && upfront.amount > 0) {
    return { usd: parseDecimal(String(upfront.amount)), msats };
  }
  return { msats };
}

function dollarLimit(declared: string | undefined): Decimal | undefined {
  const text = declared?.trim();
  return text?.startsWith("$") ? parseDecimal(text.slice(1).trimStart()) : undefined;
}

function millisatLimitUsd(msats: number, btcRate: number): Decimal | undefined {
  if (msats === 0) return usdFromMicro(0n);
  if (!Number.isSafeInteger(msats) || msats < 0 || btcRate <= 0) return undefined;
  const rate = parseDecimal(String(btcRate));
  if (!rate) return undefined;
  const coefficient = BigInt(msats) * BigInt(rate.digits);
  return decimal(String(coefficient), rate.point - BigInt(rate.digits.length) - 11n);
}

function declaredLimitUsd(limit: DeclaredLimit, btcRate: number): Decimal | undefined {
  return limit.declared?.trim().startsWith("$")
    ? dollarLimit(limit.declared)
    : millisatLimitUsd(limit.msats, btcRate);
}

export function quoteWithinDeclaredLimit(
  price: QuoteLimitPrice,
  limitMsats: number,
  declaredLimit: string | undefined,
  btcRate = 0,
  rail?: string
): boolean {
  if (price.usd) {
    const limit = declaredLimitUsd({ msats: limitMsats, declared: declaredLimit }, btcRate);
    if (limit) return compareDecimals(price.usd, limit) <= 0;
    return !price.usd.digits && limitMsats >= 0;
  }
  if (price.msats === undefined) return false;
  const usdLimit = dollarLimit(declaredLimit);
  if (usdLimit) {
    if (rail?.trim().toLowerCase() === "tempo") return false;
    const usd = millisatLimitUsd(price.msats, btcRate);
    if (usd) return compareDecimals(usd, usdLimit) <= 0;
  }
  return price.msats <= limitMsats;
}

export function compareDeclaredLimits(
  a: DeclaredLimit,
  b: DeclaredLimit,
  price: QuoteLimitPrice,
  btcRate: number
): number {
  const aUsd = declaredLimitUsd(a, btcRate);
  const bUsd = declaredLimitUsd(b, btcRate);
  if (aUsd && bUsd && (price.usd || price.msats === undefined)) {
    return compareDecimals(aUsd, bUsd);
  }
  return a.msats - b.msats;
}

export function declaredLimitMicro(limit: DeclaredLimit, btcRate: number): bigint | undefined {
  const amount = declaredLimitUsd(limit, btcRate);
  return amount === undefined ? undefined : floorMicro(amount);
}

export function dollarLimitMicro(declaredLimit: string): bigint | undefined {
  const amount = dollarLimit(declaredLimit);
  return amount === undefined ? undefined : floorMicro(amount);
}

export function quoteLimitPriceMicro(price: QuoteLimitPrice): number | undefined {
  // Display a positive fractional microunit as at least one microunit.
  return price.usd === undefined ? undefined : Number(-floorMicro({ ...price.usd, negative: true }));
}
