import { fetchBtcUsdRate, formatStaleness, getLastKnownBtcRate } from "@dvmkit/sdk/internal";
import { DvmError } from "@dvmkit/sdk/internal";
import {
  info,
} from "./output";

/**
 * What the caller needs the rate *for*. Picks the copy of the `rate_unavailable`
 * error: an agent relays `display` verbatim, so a conversion must not be told
 * "nothing was paid" — no payment was in flight to begin with.
 */
export type BtcRatePurpose = "payment" | "conversion";

/**
 * A BTC/USD rate resolved for a spend or a fiat conversion, tagged with whether
 * it came from a live fetch or the on-disk cache. `stale: true` means the rate
 * provider was unreachable and this is the last rate we saw — `cachedAt` is the
 * Unix ms it was fetched, so callers can render a freshness signal.
 */
export interface ResolvedBtcRate {
  rate: number;
  stale: boolean;
  cachedAt?: number;
}

/**
 * Agent-relayable marker that a figure was priced off a stale cached rate.
 * Emitted into the JSON of the commands whose output *is* a rate (`dvm convert`,
 * the wallet balance lines) so a relaying agent never quotes a days-old rate as
 * if it were current.
 */
export interface StaleRateNotice {
  /** ISO-8601 instant the rate was last fetched from the provider. */
  cached_at: string;
  /** Human age of the rate, e.g. "3 days ago". */
  age: string;

  display: string;
}

/**
 * Resolve BTC/USD, using the last cached rate when the provider is unreachable.
 * A stale rate still permits cap enforcement; no rate blocks the spend with
 * rate_unavailable rather than silently bypassing the cap. Stale fallback warns
 * once per process on stderr. Display-only callers use tryResolveBtcUsdRate.
 */
export async function resolveBtcUsdRate(purpose: BtcRatePurpose): Promise<ResolvedBtcRate> {
  try {
    return { rate: await fetchBtcUsdRate(), stale: false };
  } catch {
    const cached = getLastKnownBtcRate();
    if (cached) {
      warnStaleRate(cached.cachedAt);
      return { rate: cached.rate, stale: true, cachedAt: cached.cachedAt };
    }
    throw rateUnavailable(purpose);
  }
}

/**
 * Best-effort rate for a figure that is *displayed* but never spent — a price
 * label, a wallet balance line. Returns null rather than throwing: a caller
 * should not lose a payment, or be blocked from connecting a wallet, because a
 * price API was down when we went to render a dollar sign.
 */
export async function tryResolveBtcUsdRate(): Promise<ResolvedBtcRate | null> {
  try {
    return await resolveBtcUsdRate("conversion");
  } catch {
    return null;
  }
}

/** Freshness notice for a resolved rate. Undefined when the rate came back live. */
export function staleRateNotice(resolved: ResolvedBtcRate | null): StaleRateNotice | undefined {
  if (!resolved?.stale || resolved.cachedAt === undefined) return undefined;
  const age = formatStaleness(resolved.cachedAt);
  return {
    cached_at: new Date(resolved.cachedAt).toISOString(),
    age,
    display: `Priced with a BTC/USD rate cached ${age} — the rate provider is unreachable, so dollar figures may have drifted.`,
  };
}

/** One stderr line per process, however many times a run resolves a rate. */
let warnedStale = false;

function warnStaleRate(cachedAt: number): void {
  if (warnedStale) return;
  warnedStale = true;
  info(
    `Warning: the BTC/USD rate provider is unreachable — using the last rate this machine saw (cached ${formatStaleness(cachedAt)}). Dollar figures may have drifted.`
  );
}

function rateUnavailable(purpose: BtcRatePurpose): DvmError {
  const outcome = purpose === "payment" ? "nothing was paid" : "no conversion was performed";
  const noun = purpose === "payment" ? "payment" : "conversion";
  const capped = outcome.charAt(0).toUpperCase() + outcome.slice(1);
  return new DvmError(
    "rate_unavailable",
    `Could not price this ${noun}: the BTC/USD rate provider is unreachable and no cached rate is available.`,
    `${capped}. The rate provider (CoinGecko) is rate-limiting or down, and this machine has never cached a rate. Retry in a minute; if it keeps failing, check network access to api.coingecko.com.${purpose === "payment" ? " Budgets are denominated in dollars, so a payment cannot be authorised without a rate." : ""}`,
    {
      display: `BTC/USD rate unavailable — ${outcome}.`,
      anchor: "rate_unavailable",
      purpose,
      provider: "coingecko",
      retryable: true,
    }
  );
}
