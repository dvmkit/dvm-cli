/**
 * Pending-melt reconciliation with mint failures translated into the CLI's
 * bounded recovery vocabulary.
 *
 * The SDK deliberately keeps a melt pending when its mint cannot confirm the
 * quote, but its `errors[]` contains the mint's message verbatim. Observe the
 * original thrown value at the wallet seam so callers can report a classified
 * cause and wait without changing any melt outcome or wallet state.
 */

import type { Wallet } from "@cashu/cashu-ts";
import { getWallet } from "@dvmkit/sdk/internal";
import { type MeltSweepResult, sweepPendingMelts } from "./recovery-melt";

import {
  type UncheckedMint,
  uncheckedMint,
} from "./mint-sweep";
import {
  MintFailureLog,
  observeMintFailures,
  quoteFailureWallet,
} from "./mint-failure-observer";

type PendingMelt = MeltSweepResult["still_pending"][number];

export interface MeltReconcileOptions {
  now?: () => number;
  abandonAfterMs?: number;
  getWalletForMint?: (mintUrl: string) => Promise<Wallet>;
  /** Maximum time spent retrying a quote read. Defaults to the SDK's bounded 10-second window. */
  quoteRetryTimeoutMs?: number;
  sleep?: (ms: number) => Promise<void>;
}

export interface MeltReconcileResult extends MeltSweepResult {
  unchecked: UncheckedMint[];
}

export async function reconcilePendingMelts(
  opts: MeltReconcileOptions = {}
): Promise<MeltReconcileResult> {
  const observed = new MintFailureLog();
  const getWalletForMint = opts.getWalletForMint ?? getWallet;
  const sweep = await sweepPendingMelts({
    ...opts,
    getWalletForMint: async (url) => {
      const record = observed.open();
      let wallet: Wallet;
      try {
        wallet = await getWalletForMint(url);
      } catch (err) {
        wallet = quoteFailureWallet(err);
      }
      return observeMintFailures(wallet, record, (quoteId) => observed.clear(quoteId));
    },
  });

  // Claim by quote ID across however many wallet lookups the SDK's retry used.
  // A PAID melt can also throw while restoring change and recover by settling
  // without it; that caught error must not reach another entry at the same mint.
  const entries = new Map<string, PendingMelt>();
  const thrown = new Map<string, unknown>();
  for (const outcome of sweep.outcomes) {
    entries.set(outcome.entry.quote_id, outcome.entry);
    const claimed = observed.claim(outcome.entry.quote_id);
    if (claimed !== undefined) thrown.set(outcome.entry.quote_id, claimed);
  }

  return {
    ...sweep,
    unchecked: sweep.errors.map(({ quote_id, error }) =>
      uncheckedMint(entries.get(quote_id), quote_id, thrown.get(quote_id), error, "melt")
    ),
  };
}
