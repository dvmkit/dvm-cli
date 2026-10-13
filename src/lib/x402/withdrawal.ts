
/**
 * Unclaimed escrow available to a timed withdrawal at one chain read.
 *
 * The contract maintains `totalClaimed <= balance`; flooring here keeps a
 * malformed or racing RPC response from becoming a negative caller figure.
 */
export function x402WithdrawalRemainder(balance: bigint, totalClaimed: bigint): bigint {
  return balance > totalClaimed ? balance - totalClaimed : 0n;
}

/**
 * Amount `finalizeWithdraw` returns at execution time.
 *
 * The contract caps the amount recorded by `initiateWithdraw` against the
 * then-current unclaimed escrow. Claims during the delay therefore reduce the
 * payout, including cleanly to zero, without leaving the withdrawal pending.
 */
export function x402FinalizedWithdrawalAmount(
  requested: bigint,
  balance: bigint,
  totalClaimed: bigint
): bigint {
  const available = x402WithdrawalRemainder(balance, totalClaimed);
  return requested < available ? requested : available;
}
