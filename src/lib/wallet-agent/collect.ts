import { setTimeout as sleepFor } from "node:timers/promises";

import { MintQuoteState, setGlobalRequestOptions, type Wallet } from "@cashu/cashu-ts";
import { createMintQuoteRetryState, retryMintQuoteOperation, type AgentProof, type PendingMint } from "@dvmkit/sdk/internal";

import { reconcilePendingMint } from "./recovery";

const POLL_INTERVAL_MS = 2_000;
const FINAL_POLL_LEAD_MS = 500;
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
  // Some mints reject issuance the instant a quote expires. Leave part of the
  // last poll interval for both the status read and the mint request.
  const finalPollAt = expiry <= durationDeadline ? expiry - FINAL_POLL_LEAD_MS : pollUntil;
  const retryState = createMintQuoteRetryState();

  try {
    let startedAt = Date.now();
    while (startedAt < pollUntil) {
      const signal = AbortSignal.timeout(Math.min(MAX_TIMER_MS, deadline - startedAt));
      // Pass the signal to cashu-ts itself so response-body reads and its own
      // transport retry delays stop too. This command owns the CLI process.
      setGlobalRequestOptions({ signal });
      const outcome = await retryMintQuoteOperation(async () => {
        const pass = await reconcilePendingMint(entry, {
          getWalletForMint: async () => cashuWallet,
          pollDeadlineMs: pollUntil,
          quoteRetryTimeoutMs: Math.max(0, pollUntil - Date.now()),
          deadlineMs: deadline,
        });
        // Reconcile from disk again after a retryable failure. The mint may have
        // signed despite the failed response, and the outputs are already saved.
        if (pass.kind === "error") throw pass.cause;
        return pass;
      }, { deadlineMs: pollUntil, quoteId: entry.quote_id, state: retryState }).catch(() => undefined);
      if (!outcome) {
        return { kind: "stopped", reason: Date.now() >= pollUntil ? elapsedReason : "mint_unavailable" };
      }

      switch (outcome.kind) {
        case "minted":
        case "restored":
          return { kind: "collected", proofs: outcome.proofs };
        case "already_issued":
          return { kind: "already_issued" };
        case "no_longer_pending": {
          if (Date.now() >= pollUntil) return { kind: "stopped", reason: "no_longer_pending" };
          const quote = await cashuWallet.checkMintQuoteBolt11(entry.quote_id).catch(() => undefined);
          return quote?.state === MintQuoteState.ISSUED
            ? { kind: "already_issued" }
            : { kind: "stopped", reason: "no_longer_pending" };
        }
        case "expired":
          return { kind: "stopped", reason: "quote_expired" };
        case "paid_refused":
          return { kind: "stopped", reason: "paid_uncollected" };
        case "still_pending":
        case "busy": {
          const now = Date.now();
          const nextCheck = outcome.kind === "busy"
            ? Math.min(pollUntil, now + 100)
            : startedAt >= finalPollAt ? pollUntil : Math.min(finalPollAt, now + POLL_INTERVAL_MS);
          const delay = nextCheck - now;
          if (delay > 0) await sleepFor(delay);
          break;
        }
      }
      startedAt = Date.now();
    }
    return { kind: "stopped", reason: elapsedReason };
  } finally {
    setGlobalRequestOptions({});
  }
}
