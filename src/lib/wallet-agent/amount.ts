/**
 * Shared amount parser for the agent-wallet funding surfaces (`dvm wallet fund`
 * and `dvm wallet reserve`). Resolves a user-typed amount string into sats,
 * accepting:
 *
 *   - sats — a bare number, or any number under `--sats`
 *   - fiat — a leading currency symbol (`$ £ € ¥`) or an ISO-4217 code as a
 *     prefix or suffix (`5gbp`, `5 GBP`, `GBP 5`, `€5`), case- and
 *     whitespace-insensitive
 *
 * Fiat is converted live against BTC via the SDK's {@link createFxFetcher}
 * (CoinGecko, multi-currency, in-process cached). The result echoes the
 * original currency and the rate used so the funding surfaces can relay
 * "£5 ≈ 6250 sats" to a human without the agent doing the conversion.
 */

import { createFxFetcher, type FxFetcher, fxRateFor, FxRateUnavailableError } from "@dvmkit/sdk";
import { DvmError } from "@dvmkit/sdk/internal";

/**
 * Result of resolving a funding-amount string. `source_currency` is `"sats"`
 * for a sat-denominated input, otherwise the lowercase ISO code; `source_amount`
 * and `fx_rate_per_btc` are populated only for fiat inputs (the original fiat
 * figure the user typed and the fiat-per-BTC rate used for conversion).
 */
export interface ResolvedAmount {
  sats: number;
  source_currency: string;
  source_amount: number | null;
  fx_rate_per_btc: number | null;
}

export interface ResolveAmountDeps {
  fxFetcher?: FxFetcher;
}

export const CURRENCY_SYMBOLS: Record<string, string> = {
  usd: "$",
  gbp: "£",
  eur: "€",
  jpy: "¥",
};

/**
 * Human-readable phrase for a resolved amount, e.g. `1000 sats` for a sat
 * input or `£5 (≈ 6250 sats)` for a fiat input — used in funding log lines and
 * `display`/relay strings so a human sees what they actually asked for.
 */
export function describeAmount(amt: ResolvedAmount): string {
  if (amt.source_amount === null) return `${amt.sats.toString()} sats`;
  const symbol = CURRENCY_SYMBOLS[amt.source_currency] ?? "";
  const code = symbol ? "" : ` ${amt.source_currency.toUpperCase()}`;
  return `${symbol}${amt.source_amount.toString()}${code} (≈ ${amt.sats.toString()} sats)`;
}

/**
 * Echo the original currency on a JSON funding event. Always carries
 * `source_currency` (`"sats"` or an ISO code); fiat inputs also carry the
 * original `source_amount` and the `fx_rate_per_btc` used, so a relaying agent
 * can explain the conversion without re-deriving it.
 */
export function amountSourceFields(amt: ResolvedAmount): Record<string, unknown> {
  if (amt.source_amount === null) return { source_currency: "sats" };
  return {
    source_currency: amt.source_currency,
    source_amount: amt.source_amount,
    fx_rate_per_btc: amt.fx_rate_per_btc,
  };
}

const SYMBOL_TO_CODE: Record<string, string> = {
  $: "usd",
  "£": "gbp",
  "€": "eur",
  "¥": "jpy",
};

/**
 * Resolve a funding-amount string to sats. Throws {@link DvmError} with code
 * `invalid_amount` (unparseable / `--sats` + fiat conflict), `unsupported_currency`
 * (a recognised ISO code the fetcher can't convert), or `fx_unavailable`
 * (the BTC reference rate couldn't be fetched).
 */
export async function resolveFundingAmountSats(
  amount: string,
  satsFlag: boolean | undefined,
  deps?: ResolveAmountDeps
): Promise<ResolvedAmount> {
  const trimmed = amount.trim();
  const fetcher = deps?.fxFetcher ?? defaultFetcher();

  // `--sats` forces the sats interpretation: any currency marker becomes
  // ambiguous intent rather than a fiat shortcut, so reject it explicitly so
  // the operator doesn't wonder why "5" got billed at some fiat amount.
  if (satsFlag === true) {
    if (looksLikeFiat(trimmed)) {
      throw new DvmError(
        "invalid_amount",
        `--sats was set but the amount "${amount}" looks like a fiat amount.`,
        "Drop the currency symbol/code to fund in sats, or remove `--sats` to fund in that currency."
      );
    }
    return {
      sats: parseSats(trimmed, amount),
      source_currency: "sats",
      source_amount: null,
      fx_rate_per_btc: null,
    };
  }

  const fiat = detectFiat(trimmed, amount, fetcher);
  if (fiat === null) {
    return {
      sats: parseSats(trimmed, amount),
      source_currency: "sats",
      source_amount: null,
      fx_rate_per_btc: null,
    };
  }

  const rate = await fiatRatePerBtc(fetcher, fiat.currency);
  const sats = Math.max(1, Math.round((fiat.value / rate) * 100_000_000));
  return { sats, source_currency: fiat.currency, source_amount: fiat.value, fx_rate_per_btc: rate };
}

let sharedFetcher: FxFetcher | null = null;

function defaultFetcher(): FxFetcher {
  sharedFetcher ??= createFxFetcher();
  return sharedFetcher;
}

function looksLikeFiat(trimmed: string): boolean {
  if (trimmed.length > 0 && Object.prototype.hasOwnProperty.call(SYMBOL_TO_CODE, trimmed[0])) {
    return true;
  }
  return ISO_AMOUNT_RE.test(trimmed) && /[a-z]{3}/i.test(trimmed);
}

interface DetectedFiat {
  currency: string;
  value: number;
}

function lowerOrUndef(raw: string | undefined): string | undefined {
  return raw ? raw.toLowerCase() : undefined;
}

const ISO_AMOUNT_RE = /^([a-z]{3})?\s*(\d*\.?\d+)\s*([a-z]{3})?$/i;

/**
 * Detect a fiat amount (symbol- or ISO-coded). Returns `null` when the input
 * carries no currency marker (caller treats it as sats). Throws for malformed
 * fiat (e.g. `$abc`, both leading+trailing codes) or an unsupported code.
 */
function detectFiat(trimmed: string, original: string, fetcher: FxFetcher): DetectedFiat | null {
  const symbol = trimmed.length > 0 ? trimmed[0] : "";
  if (Object.prototype.hasOwnProperty.call(SYMBOL_TO_CODE, symbol)) {
    const currency = SYMBOL_TO_CODE[symbol];
    const value = parseFiatValue(trimmed.slice(1), original, fetcher);
    return { currency, value };
  }

  const match = ISO_AMOUNT_RE.exec(trimmed);
  if (!match) return null;
  // Optional capture groups are typed `string` but are `undefined` at runtime
  // when unmatched, so `lowerOrUndef` widens before the truthiness checks below.
  const lead = lowerOrUndef(match[1]);
  const trail = lowerOrUndef(match[3]);
  if (lead && trail) {
    throw invalidAmount(original);
  }
  const code = lead ?? trail;
  if (!code) return null; // bare number → sats

  if (!fetcher.supportedCurrencies().includes(code)) {
    throw unsupportedCurrency(code, original, fetcher);
  }
  const value = parseFiatValue(match[2], original, fetcher);
  return { currency: code, value };
}

function parseFiatValue(raw: string, original: string, fetcher: FxFetcher): number {
  const value = Number(raw.trim());
  if (!Number.isFinite(value) || value <= 0) {
    throw invalidAmount(original, fetcher);
  }
  return value;
}

function parseSats(trimmed: string, original: string): number {
  const sats = Number(trimmed);
  if (!Number.isFinite(sats) || sats <= 0) {
    throw invalidAmount(original);
  }
  return Math.floor(sats);
}

async function fiatRatePerBtc(fetcher: FxFetcher, currency: string): Promise<number> {
  try {
    const snapshot = await fetcher.fetch();
    return fxRateFor(snapshot, currency);
  } catch (err) {
    if (err instanceof FxRateUnavailableError) {
      throw new DvmError(
        "fx_unavailable",
        `Couldn't fetch the BTC reference rate to convert your ${currency.toUpperCase()} amount.`,
        "Transient — try again in a few seconds, or fund in sats with `--sats`."
      );
    }
    throw err;
  }
}

function invalidAmount(original: string, fetcher?: FxFetcher): DvmError {
  return new DvmError(
    "invalid_amount",
    `Invalid amount: "${original}".`,
    `Pass a positive sats amount (e.g. 1000), or a fiat amount — ${examples(fetcher)}.`
  );
}

function unsupportedCurrency(code: string, original: string, fetcher: FxFetcher): DvmError {
  const supported = fetcher.supportedCurrencies();
  return new DvmError(
    "unsupported_currency",
    `Unsupported currency "${code}" in amount "${original}".`,
    `Supported: ${supported.map((c) => c.toUpperCase()).join(", ")}, or sats. Examples: ${examples(fetcher)}.`,
    { supported: [...supported] }
  );
}

function examples(fetcher?: FxFetcher): string {
  const supported = fetcher?.supportedCurrencies() ?? ["usd", "eur", "gbp", "jpy"];
  const parts: string[] = [];
  if (supported.includes("usd")) parts.push("$5");
  if (supported.includes("gbp")) parts.push("£5 / 5gbp");
  if (supported.includes("eur")) parts.push("€5 / 5eur");
  parts.push("1000 (sats)");
  return parts.join(", ");
}
