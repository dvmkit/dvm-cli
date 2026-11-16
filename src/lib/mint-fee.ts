import type { PendingSubmission } from "@dvmkit/sdk/internal";
import { formatAmountBestEffort } from "./currency";

/**
 * The swap fee a prepared submission recorded. The SDK wallet file keeps unknown
 * keys on `pending_submissions`, so the field persists without an SDK change.
 * Zero for entries that predate it or shipped reserve proofs.
 */
export function submissionSwapFeeSats(submission: PendingSubmission): number {
  const fee = (submission as PendingSubmission & { swap_fee_sats?: number }).swap_fee_sats;
  return Number.isSafeInteger(fee) && fee! > 0 ? fee! : 0;
}

/** Said once per result; the wording must stand without any Cashu background. */
export const MINT_FEE_EXPLAINER =
  "A mint fee is a small charge the mint that holds your ecash takes for each coin it handles.";

function label(sats: number): string {
  return formatAmountBestEffort(sats * 1000, { anchor: false });
}

/**
 * The plain-words line for a Cashu payment that cost a mint fee on top of the
 * price. Empty when no fee was charged, so a reserve payment reads unchanged.
 */
export function describeCashuPayment(paidSats: number, feeSats: number): string {
  if (feeSats <= 0) return "";
  return `Paid ${label(paidSats)} to the provider plus ${label(feeSats)} mint fee; ${label(paidSats + feeSats)} left your wallet. ${MINT_FEE_EXPLAINER}`;
}

/** Additive JSON fields for a Cashu payment: the price, the mint fee, and what the wallet lost. */
export function cashuPaymentFeeFields(paidSats: number, feeSats: number): Record<string, unknown> {
  const display = describeCashuPayment(paidSats, feeSats);
  return {
    swap_fee_sats: feeSats,
    wallet_debit_sats: paidSats + feeSats,
    ...(display ? { fee_display: display } : {}),
  };
}
