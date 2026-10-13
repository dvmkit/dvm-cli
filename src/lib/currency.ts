import { msatsToUsd, usdToMsats, formatUsd, getLastKnownBtcRate, formatStaleness, FX_CACHE_TTL_MS } from "@dvmkit/sdk/internal";
import { formatFiat, type Currency } from "@dvmkit/sdk";

export interface AmountLabelOptions {
  anchor?: boolean;
}

/**
 * The sats half of an amount label: whole sats where the amount divides evenly,
 * two decimals where it doesn't, and raw msats below one sat (where "0 sats"
 * would be a lie about a real charge).
 */
export function formatSats(msats: number): string {
  if (msats === 0) return "0 sats";
  if (msats < 1000) return `${msats.toLocaleString("en-US")} msats`;
  if (msats % 1000 === 0) return `${(msats / 1000).toLocaleString("en-US")} sats`;
  return `${Math.round((msats / 1000) * 100) / 100} sats`;
}

export function formatAmount(msats: number, rate: number, opts?: AmountLabelOptions): string {
  const usd = msatsToUsd(msats, rate);
  const base = `~$${formatUsd(usd)} (${formatSats(msats)})`;
  return opts?.anchor === false ? base : `${base} — ${costAnchor(usd)}`;
}

/**
 * Fiat-first label for a charge, for every surface a human is asked to approve,
 * relay or confirm. When the provider stated its own fiat price, that figure
 * leads and sats follow in parentheses — the provider's number is the one the
 * human is actually being charged, and on a stablecoin-priced DVM the sats are
 * a derived conversion. With no fiat envelope — or a zero-amount one, which is
 * what the transport synthesises for a provider that priced in `price_msats`
 * alone — falls back to {@link formatAmountBestEffort} (USD via the cached BTC
 * rate, sats otherwise). Leading with `$0.00 USD` for a real charge would be
 * worse than saying nothing about fiat at all.
 */
export function formatPaymentAmount(
  msats: number,
  fiat?: { amount: number; currency: string },
  opts?: AmountLabelOptions
): string {
  if (!fiat || fiat.amount <= 0) return formatAmountBestEffort(msats, opts);
  const base = `${formatFiat(fiat.amount, fiat.currency)} (${formatSats(msats)})`;
  return opts?.anchor === false ? base : `${base} — ${costAnchor(fiat.amount, fiat.currency)}`;
}

/**
 * Per-currency band thresholds used by {@link costAnchor}. Bands are tuned so
 * the same anchor label fires at roughly the same purchasing power across
 * currencies — USD/EUR/GBP collapse to the same scale at v1 granularity, JPY
 * is ×100ish because it has no sub-yen practical denomination. Adding a new
 * Currency means adding a row here; otherwise `costAnchor` falls back to the
 * USD bands.
 */
const COST_ANCHOR_BANDS: Record<string, [number, number, number, number]> = {
  usd: [0.01, 0.1, 1.0, 10.0],
  eur: [0.01, 0.1, 1.0, 10.0],
  gbp: [0.01, 0.1, 1.0, 10.0],
  jpy: [1, 10, 100, 1500],
};

/**
 * Map a fiat amount to a familiar cost-comparison label. Defaults to the USD
 * band table; pass `currency` to apply a non-USD scale. An unknown currency
 * falls back to USD bands so a caller adding a currency at the type layer but
 * not in this table degrades gracefully rather than silently mis-labelling.
 */
export function costAnchor(amount: number, currency: Currency = "usd"): string {
  const bands = COST_ANCHOR_BANDS[currency] ?? COST_ANCHOR_BANDS.usd;
  if (amount < bands[0]) return "fraction of a cent";
  if (amount <= bands[1]) return "comparable to an API call";
  if (amount <= bands[2]) return "comparable to a ChatGPT query";
  if (amount <= bands[3]) return "comparable to a coffee";
  return "significant purchase — review carefully";
}

export function monetaryJson(
  msats: number,
  rate: number
): { msats: number; usd: number; anchor: string; display: string } {
  const usd = msatsToUsd(msats, rate);
  return {
    msats,
    usd: Math.round(usd * 100) / 100,
    anchor: costAnchor(usd),
    display: formatAmount(msats, rate),
  };
}
export function parseBudget(budget: string, rate: number): number {
  const value = assertValidBudget(budget);
  return budget.startsWith("$") ? usdToMsats(value, rate) : value;
}

/**
 * Validate a budget string (`"$1.00"` or a bare msats integer) and return the
 * number it carries, without converting it. Rate-free on purpose: `dvm wallet
 * setup --default-budget` persists the string verbatim and only converts it at
 * spend time, so a rate-provider outage must not block wallet setup.
 */
export function assertValidBudget(budget: string): number {
  const value = budget.startsWith("$") ? parseFloat(budget.slice(1)) : parseInt(budget, 10);
  if (isNaN(value)) throw new Error(`Invalid budget: ${budget}`);
  return value;
}
export function formatAmountBestEffort(msats?: number, opts?: AmountLabelOptions): string {
  const m = msats ?? 0;
  const cached = getLastKnownBtcRate();
  if (cached === null) return `${Math.round(m / 1000)} sats`;
  const base = formatAmount(m, cached.rate, opts);
  if (Date.now() - cached.cachedAt < FX_CACHE_TTL_MS) return base;
  return `${base} (rate cached ${formatStaleness(cached.cachedAt)})`;
}
