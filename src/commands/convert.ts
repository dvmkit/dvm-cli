import { costAnchor } from "../lib/currency";
import {
  DvmError,
  formatUsd,
  msatsToUsd,
  usdToMsats,
} from "@dvmkit/sdk/internal";
import {
  info,
  json,
} from "../lib/output";
import { resolveBtcUsdRate, staleRateNotice } from "../lib/btc-rate";

export interface ConvertOptions {
  human?: boolean;
  /** Treat numeric input as sats instead of millisats */
  sats?: boolean;
}

export async function convert(amount: string, opts: ConvertOptions): Promise<void> {
  const resolved = await resolveBtcUsdRate("conversion");
  const { rate } = resolved;
  // The rate *is* the output of this command, so a cached one is labelled rather
  // than quoted as current — an agent relaying `rate_stale.display` tells its user
  // the figure may have drifted.
  const notice = staleRateNotice(resolved);
  const rateStr = `@ $${rate.toLocaleString()}/BTC${notice ? `, cached ${notice.age}` : ""}`;
  const staleFields = notice ? { rate_stale: notice } : {};

  if (amount.startsWith("$")) {
    const usd = parseFloat(amount.slice(1));
    if (isNaN(usd)) throw new DvmError("invalid_amount", `Invalid amount: ${amount}`);
    const msats = usdToMsats(usd, rate);
    const sats = Math.round(msats / 1000);
    if (opts.human) {
      info(`$${usd.toFixed(2)} = ${sats} sats (${rateStr})`);
    } else {
      json({ usd, msats, sats, btcusd: rate, anchor: costAnchor(usd), ...staleFields });
    }
  } else {
    const num = parseFloat(amount);
    if (isNaN(num)) throw new DvmError("invalid_amount", `Invalid amount: ${amount}`);
    const msats = opts.sats ? Math.round(num * 1000) : Math.round(num);
    const usd = msatsToUsd(msats, rate);
    if (opts.human) {
      info(`${Math.round(msats / 1000)} sats = $${formatUsd(usd)} (${rateStr})`);
    } else {
      json({
        msats,
        sats: Math.round(msats / 1000),
        usd: Math.round(usd * 100) / 100,
        btcusd: rate,
        anchor: costAnchor(usd),
        ...staleFields,
      });
    }
  }
}
