/**
 * Fees above this share of the payout are called out before money moves. Lightning
 * routing alone is normally a small fraction of a percent, so a larger share means a
 * mint's per-coin input fee is dominating, as it does on small payouts.
 */
export const LARGE_FEE_SHARE_PERCENT = 2;

/** Fees as a percentage of the payout, to one decimal; null when nothing is paid out. */
export function feeSharePercent(feeSats: number, payoutSats: number): number | null {
  if (payoutSats <= 0) return null;
  return Math.round((feeSats / payoutSats) * 1000) / 10;
}

/** Integer arithmetic, so a share of exactly the threshold never warns. */
export function isLargeFeeShare(feeSats: number, payoutSats: number): boolean {
  return payoutSats > 0 && feeSats * 100 > payoutSats * LARGE_FEE_SHARE_PERCENT;
}

export interface CashOutFeeBreakdown {
  /** Everything that left the wallet beyond the payout. */
  feeSats: number;
  inputFeeSats: number;
  /** Routing fee the Lightning payment really used. */
  routingFeeSats: number;
  /** Reserved routing buffer the payment did not use. */
  routingReserveReturnedSats: number;
}

/**
 * Split a settled melt's fee. `debit - amount - change` is the whole cost; the mint's
 * input fee is known from the quote, so the rest is what routing used.
 */
export function settledFeeBreakdown(quote: {
  amount_sats: number;
  fee_reserve_sats: number;
  input_fee_sats: number;
  debit_sats: number;
}, changeSats: number): CashOutFeeBreakdown {
  const feeSats = quote.debit_sats - quote.amount_sats - changeSats;
  const routingFeeSats = Math.max(0, feeSats - quote.input_fee_sats);
  return {
    feeSats,
    inputFeeSats: quote.input_fee_sats,
    routingFeeSats,
    routingReserveReturnedSats: Math.max(0, quote.fee_reserve_sats - routingFeeSats),
  };
}

/** Plain-words advice appended wherever the fee is shown before any money moves. */
export const LARGE_FEE_ADVICE =
  "That is a large share of the payout. Run with --dry-run to see the fee before anything is paid, and pass --max-fee <sats> to refuse a mint whose fees exceed your limit.";
