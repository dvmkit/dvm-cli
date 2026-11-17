import { createFxFetcher, fxRateFor, type FxFetcher } from "@dvmkit/sdk";
import { dvmFetch } from "./http";
import { tryResolveBtcUsdRate } from "./btc-rate";

const currencyFetchers = new Map<string, FxFetcher>();
const MAX_CURRENCY_FETCHERS = 8;

export async function balanceCurrencyRate(currency: string): Promise<number | undefined> {
  if (currency === "usd") return (await tryResolveBtcUsdRate())?.rate;
  let fetcher = currencyFetchers.get(currency);
  if (!fetcher) {
    const source = new URL("https://api.coingecko.com/api/v3/simple/price");
    source.searchParams.set("ids", "bitcoin");
    source.searchParams.set("vs_currencies", `usd,${currency}`);
    fetcher = createFxFetcher({
      source: source.href,
      currencies: ["usd", currency],
      fetchFn: (input, init) => dvmFetch(input, { ...init,
        signal: init?.signal
          ? AbortSignal.any([init.signal, AbortSignal.timeout(5000)])
          : AbortSignal.timeout(5000),
      }),
    });
    if (currencyFetchers.size >= MAX_CURRENCY_FETCHERS)
      currencyFetchers.delete(currencyFetchers.keys().next().value!);
    currencyFetchers.set(currency, fetcher);
  }
  try {
    const snapshot = await fetcher.fetch();
    // A partial refresh must not quietly price this spend with an older rate.
    if (snapshot.carried_forward?.includes(currency) || snapshot.unavailable?.includes(currency)) return undefined;
    return fxRateFor(snapshot, currency);
  } catch { return undefined; }
}

