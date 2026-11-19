import { setTimeout as sleepFor } from "node:timers/promises";

import { MintQuoteState, setGlobalRequestOptions, type Wallet } from "@cashu/cashu-ts";
import type { AgentProof, PendingMint } from "@dvmkit/sdk/internal";

import { reconcilePendingMint } from "./recovery";

const POLL_INTERVAL_MS = 2_000;
const EXPIRY_MARGIN_MS = 5_000;
const MAX_TIMER_MS = 2_147_483_647;

type CollectionStop = "duration_elapsed" | "quote_expired" | "mint_unavailable" | "paid_uncollected" | "no_longer_pending";

export async function collectPendingMint(
  entry: PendingMint,
  cashuWallet: Wallet,
  durationMs: number
): Promise<
  | { kind: "collected"; proofs: AgentProof[] }
  | { kind: "already_issued" }
  | { kind: "stopped"; reason: CollectionStop }
> {
  const start = Date.now();
  const expiry = entry.expires_at === undefined ? Infinity : entry.expires_at * 1000;
  const durationDeadline = start + durationMs;
  const pollUntil = Math.min(expiry, durationDeadline);
  const deadline = Math.min(expiry + EXPIRY_MARGIN_MS, durationDeadline);
  const elapsedReason = expiry <= durationDeadline ? "quote_expired" : "duration_elapsed";
  if (expiry <= start) return { kind: "stopped", reason: "quote_expired" };

  try {
    while (Date.now() < deadline) {
      // One final check at expiry can observe a payment from the last poll interval.
      const finalCheck = Date.now() >= pollUntil;
      const retryUntil = finalCheck ? deadline : pollUntil;
      const signal = AbortSignal.timeout(Math.max(0, Math.min(MAX_TIMER_MS, deadline - Date.now())));
      // Pass the signal to cashu-ts itself so response-body reads and its own
      // transport retry delays stop too. This command owns the CLI process.
      setGlobalRequestOptions({ signal });
      const outcome = await reconcilePendingMint(entry, {
        getWalletForMint: async () => cashuWallet,
        pollDeadlineMs: retryUntil,
        quoteRetryTimeoutMs: Math.max(0, retryUntil - Date.now()),
        deadlineMs: deadline,
      });

      switch (outcome.kind) {
        case "minted":
        case "restored":
          return { kind: "collected", proofs: outcome.proofs };
        case "already_issued":
          return { kind: "already_issued" };
        case "no_longer_pending": {
          const quote = await cashuWallet.checkMintQuoteBolt11(entry.quote_id).catch(() => undefined);
          return quote?.state === MintQuoteState.ISSUED
            ? { kind: "already_issued" }
            : { kind: "stopped", reason: "no_longer_pending" };
        }
        case "expired":
          return { kind: "stopped", reason: "quote_expired" };
        case "paid_refused":
          return { kind: "stopped", reason: "paid_uncollected" };
        case "error":
          return { kind: "stopped", reason: Date.now() >= pollUntil ? elapsedReason : "mint_unavailable" };
        case "still_pending":
        case "busy": {
          if (finalCheck && outcome.kind === "still_pending") {
            return { kind: "stopped", reason: elapsedReason };
          }
          const nextCheck = finalCheck ? deadline : pollUntil;
          const interval = outcome.kind === "busy" ? 100 : POLL_INTERVAL_MS;
          const delay = Math.min(interval, nextCheck - Date.now());
          if (delay > 0) await sleepFor(delay);
          break;
        }
      }
    }
    return { kind: "stopped", reason: elapsedReason };
  } finally {
    setGlobalRequestOptions({});
  }
}
