/**
 * The pending-mint reconcile sweep, with the mint's own failures translated
 * into this CLI's vocabulary.
 *
 * `sweepPendingMints` reconciles every entry in `wallet.pending_mints[]`
 * against its mint, and reports a mint that wouldn't answer as
 * `errors: { quote_id, error: string }[]` — the mint's message, verbatim and
 * unclassified. A rate-limited mint therefore reached the caller as a bare
 * `429 Too Many Requests` with no cause, no retryable flag and no wait, which
 * left a paid invoice and an unpaid one reading exactly alike. It also
 * published unbounded third-party prose, where this CLI's error terminals
 * reduce a dependency's failure to a bounded fingerprint first (see
 * `unknownErrorDiagnostic`). The melt sweep uses the same observer and
 * classifier through `./melt-sweep` so both recovery surfaces stay aligned.
 *
 * The sweep takes a `getWalletForMint` seam, so this layer passively observes
 * the errors the SDK retries and shapes its bounded terminal result with the
 * same recovery fields the fund wait uses (`./fund-wait`). The invoice itself
 * is untouched — an entry the SDK cannot reconcile within its per-entry bound
 * stays pending for the next pass.
 */

import type { Wallet } from "@cashu/cashu-ts";
import { getWallet, type PendingMint } from "@dvmkit/sdk/internal";
import { sweepPendingMints, type SweepResult } from "./recovery";

import { unknownErrorDiagnostic } from "../error-handler";
import {
  classifyMintError,
  formatWait,
  type MintFailureCause,
  suggestedRetryAfterMs,
} from "./fund-wait";
import {
  MintFailureLog,
  observeMintFailures,
  quoteFailureWallet,
} from "./mint-failure-observer";

const RECONCILE_COMMAND = "dvm wallet show";

/**
 * A pending mint this pass couldn't reconcile, in bounded terms. Replaces the
 * sweep's raw `errors[]` on every surface: same recovery fields as
 * `fund_wait_interrupted`, so an agent that already branches on one can branch
 * on the other.
 */
export interface UncheckedMint {
  quote_id: string;
  mint: string;
  amount_sats: number;
  cause: MintFailureCause;
  retryable: boolean;
  reason: string;
  /** Always true: the wallet keeps the unresolved quote in its pending journal. */
  pending: true;
  /** How long to wait before reconciling again — the mint's own Retry-After when it named one. */
  retry_after_ms?: number;
  /** Bounded class/code fingerprint of what failed, never the mint's message. */
  error_name?: string;
  error_code?: string;
  display: string;
  hint: string;
  next_action: {
    type: "run_command";
    command: string;
    retry_after_ms?: number;
    hint: string;
  };
}

/**
 * Seams for {@link reconcilePendingMints}, mirroring the SDK's own
 * `SweepOptions` (which the package doesn't export).
 */
export interface ReconcileOptions {
  now?: () => number;
  /** Override the age at which an unpaid invoice is abandoned. */
  expirationMs?: number;
  getWalletForMint?: (mintUrl: string) => Promise<Wallet>;
  /** Maximum time spent retrying a quote read. Defaults to the SDK's bounded 10-second window. */
  quoteRetryTimeoutMs?: number;
  sleep?: (ms: number) => Promise<void>;
}

export interface ReconcileResult extends SweepResult {
  /** Entries this pass couldn't check. One per `errors[]` entry, classified. */
  unchecked: UncheckedMint[];
}

/**
 * Reconcile `wallet.pending_mints[]`, classifying whatever the mint threw.
 * Everything the SDK sweep returns is passed through unchanged; `unchecked` is
 * the bounded view callers should report instead of `errors`.
 */
export async function reconcilePendingMints(
  opts: ReconcileOptions = {}
): Promise<ReconcileResult> {
  const observed = new MintFailureLog();
  const getWalletForMint = opts.getWalletForMint ?? getWallet;
  const sweep = await sweepPendingMints({
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

  // The SDK may reacquire a wallet several times while retrying one entry.
  // Claim by quote ID so those attempts stay together and a later entry at the
  // same mint cannot inherit a refusal that was never meant for it.
  const entries = new Map<string, PendingMint>();
  const thrown = new Map<string, unknown>();
  for (const outcome of sweep.outcomes) {
    entries.set(outcome.entry.quote_id, outcome.entry);
    const claimed = observed.claim(outcome.entry.quote_id);
    if (claimed !== undefined) thrown.set(outcome.entry.quote_id, claimed);
  }

  return {
    ...sweep,
    unchecked: sweep.errors.map(({ quote_id, error }) =>
      uncheckedMint(entries.get(quote_id), quote_id, thrown.get(quote_id), error)
    ),
  };
}

/**
 * A 429 signal in a message the sweep already stringified. Only reached when
 * the failure came from inside the SDK rather than from a mint call, so no
 * error object was observed — a rate limit is still worth naming, and the
 * message itself never leaves this function.
 */
const RATE_LIMIT_TEXT = /\b429\b|rate[ -]?limit|too many requests/i;

export function uncheckedMint(
  entry: Pick<PendingMint, "mint" | "amount_sats"> | undefined,
  quoteId: string,
  thrown: unknown | undefined,
  message: string,
  subject: "mint" | "melt" = "mint"
): UncheckedMint {
  const cause: MintFailureCause =
    thrown !== undefined
      ? classifyMintError(thrown)
      : RATE_LIMIT_TEXT.test(message)
        ? "rate_limited"
        : "unexpected";
  const retryable = cause !== "unexpected";
  const retryAfterMs = suggestedRetryAfterMs(cause, thrown);
  const diagnostic = thrown !== undefined ? unknownErrorDiagnostic(thrown) : undefined;
  const amountSats = entry?.amount_sats ?? 0;
  const reason = describeCause(cause);
  const wait = retryAfterMs !== undefined ? ` Wait ${formatWait(retryAfterMs)} and try again.` : "";
  const copy = uncheckedCopy(subject, amountSats, quoteId, reason, wait, retryable);

  return {
    quote_id: quoteId,
    mint: entry?.mint ?? "",
    amount_sats: amountSats,
    cause,
    retryable,
    reason,
    pending: true,
    ...(retryAfterMs !== undefined ? { retry_after_ms: retryAfterMs } : {}),
    ...(diagnostic ? { error_name: diagnostic.name } : {}),
    ...(diagnostic?.code ? { error_code: diagnostic.code } : {}),
    display: copy.display,
    hint: copy.hint,
    next_action: {
      type: "run_command",
      command: RECONCILE_COMMAND,
      ...(retryAfterMs !== undefined ? { retry_after_ms: retryAfterMs } : {}),
      hint: copy.hint,
    },
  };
}

/**
 * Subject-specific recovery copy around the shared classified fields. A melt's
 * committed-sats warning stays in `pending_melts`; this block only says why
 * the mint was not checked and when to reconcile it again.
 */
function uncheckedCopy(
  subject: "mint" | "melt",
  amountSats: number,
  quoteId: string,
  reason: string,
  wait: string,
  retryable: boolean
): { display: string; hint: string } {
  if (subject === "melt") {
    return {
      display: `Cash-out quote ${quoteId} for ${amountSats} sats could not be checked — ${reason}. Its outcome remains unconfirmed.${wait}`,
      hint: retryable
        ? `Run \`${RECONCILE_COMMAND}\` after the wait to check it again; don't retry the cash-out before it resolves.`
        : `Run \`${RECONCILE_COMMAND}\` to check it again; don't retry the cash-out before it resolves.`,
    };
  }

  const hint = retryable
    ? `The invoice keeps its pending state — it is neither paid nor lost. Run \`${RECONCILE_COMMAND}\` after the wait to reconcile it; don't start a new fund for the same money.`
    : `The invoice keeps its pending state — it is neither paid nor lost. Run \`${RECONCILE_COMMAND}\` to try again; don't start a new fund for the same money.`;
  return {
    display: `${amountSats} sats on invoice ${quoteId} could not be checked — ${reason}. Whether it has been paid is unknown until the mint answers, so it is still recorded as pending.${wait}`,
    hint,
  };
}

function describeCause(cause: MintFailureCause): string {
  switch (cause) {
    case "rate_limited":
      return "the mint refused the status check as too frequent";
    case "mint_server_error":
      return "the mint failed the status check";
    case "mint_unreachable":
      return "the mint didn't answer";
    case "unexpected":
      return "an unexpected error interrupted the status check";
  }
}

/**
 * The short form for a row that already names the invoice — `dvm wallet show`
 * lists its pending mints separately, and a row that says nothing reads as one
 * awaiting payment, which is exactly what the mint declined to confirm.
 */
export function uncheckedPendingNote(unchecked: UncheckedMint): string {
  const wait =
    unchecked.retry_after_ms !== undefined
      ? ` Retry in ${formatWait(unchecked.retry_after_ms)}.`
      : "";
  return `not checked on this call — ${unchecked.reason}.${wait}`;
}
