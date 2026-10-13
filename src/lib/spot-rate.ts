/**
 * 60s in-memory spot-rate cache for sub-minute spend/threshold decisions in
 * the agent wallet .
 *
 * Different cache layer, same source as the platform's daily FX refresh:
 * both sit on top of `fetchCoinGeckoSpot()` from `./fx-coingecko`. **Use this
 * helper for spend decisions only — accounting reads from `fx_rates` via
 * the platform's `getFxRate()`.**
 *
 * Falls back to the last successful in-memory rate when a network call
 * fails so a flaky upstream doesn't block a fund/threshold decision; warns
 * via structured-log so the caller can decide whether to proceed.
 */

import { type CoinGeckoSpot, fetchCoinGeckoSpot } from "@dvmkit/sdk/internal";

export type SpotPair = "btc_usd" | "usdc_usd";

const DEFAULT_MAX_AGE_MS = 60_000;

export interface SpotRateOptions {
  /** Cache TTL in ms; default 60s. */
  maxAgeMs?: number;
  now?: () => number;
  fetchSpot?: () => Promise<CoinGeckoSpot>;
}

/**
 * Result of a spot-rate lookup. `staleness_ms` is wall-clock distance from
 * the in-memory snapshot's `cached_at` to `now`; it can exceed `maxAgeMs`
 * when a refresh failed and the call returned the last-known value.
 */
export interface SpotRateResult {
  pair: SpotPair;
  rate: number;
  cached_at: number;
  staleness_ms: number;
  /** True iff the network call this tick failed and we returned the prior snapshot. */
  used_last_known: boolean;
}

/**
 * Read a spot rate. Returns the cached snapshot if it's fresh enough,
 * otherwise refreshes via `fetchCoinGeckoSpot()` and caches for 60s. On
 * fetch failure, returns the last-known snapshot with `used_last_known:
 * true`; throws only when no prior snapshot exists.
 */
export async function getSpotRate(pair: SpotPair, opts?: SpotRateOptions): Promise<SpotRateResult> {
  const now = opts?.now ?? (() => Date.now());
  const maxAgeMs = opts?.maxAgeMs ?? DEFAULT_MAX_AGE_MS;
  const fetchSpot = opts?.fetchSpot ?? fetchCoinGeckoSpot;
  const t = now();

  if (cached && t - cached.cachedAt < maxAgeMs) {
    return toResult(pair, cached, t, false);
  }
  if (inFlight) {
    const snapshot = await inFlight.catch(() => null);
    if (snapshot) {
      return toResult(pair, { snapshot, cachedAt: now() }, now(), false);
    }
    if (cached) return toResult(pair, cached, now(), true);
    throw new Error("spot-rate fetch failed and no prior snapshot is cached");
  }

  inFlight = fetchSpot();
  try {
    const snapshot = await inFlight;
    cached = { snapshot, cachedAt: now() };
    return toResult(pair, cached, now(), false);
  } catch (err) {
    if (cached) {
      console.warn(
        JSON.stringify({
          level: "spot_rate_using_last_known",
          pair,
          error: err instanceof Error ? err.message : String(err),
          cached_at: cached.cachedAt,
        })
      );
      return toResult(pair, cached, now(), true);
    }
    throw err;
  } finally {
    inFlight = null;
  }
}

/** Test-only: clear the in-memory cache so a fresh suite sees no prior state. */
export function _resetSpotRateCache(): void {
  cached = null;
  inFlight = null;
}

let cached: { snapshot: CoinGeckoSpot; cachedAt: number } | null = null;
let inFlight: Promise<CoinGeckoSpot> | null = null;

function toResult(
  pair: SpotPair,
  entry: { snapshot: CoinGeckoSpot; cachedAt: number },
  nowMs: number,
  usedLastKnown: boolean
): SpotRateResult {
  return {
    pair,
    rate: pair === "btc_usd" ? entry.snapshot.btc_usd : entry.snapshot.usdc_usd,
    cached_at: entry.cachedAt,
    staleness_ms: nowMs - entry.cachedAt,
    used_last_known: usedLastKnown,
  };
}
