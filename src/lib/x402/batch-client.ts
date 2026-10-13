import { DvmError } from "@dvmkit/sdk/internal";

import { type PendingX402Funding } from "@dvmkit/sdk/internal";

import { type X402VoucherPendingState, x402VoucherPendingState } from "@dvmkit/sdk/internal";

/** Compatibility adapter retaining caller commands until consumer migration. */
export function x402VoucherPendingRefusal(
  blocking: PendingX402Funding,
  data: Record<string, unknown> = {}
): DvmError {
  return formatX402VoucherPendingRefusal(x402VoucherPendingState(blocking), data);
}

function formatX402VoucherPendingRefusal(
  blocking: X402VoucherPendingState,
  data: Record<string, unknown> = {}
): DvmError {
  const base = {
    credit_id: blocking.creditId,
    fund_id: blocking.fundId,
    channel_id: blocking.channelId,
    ...data,
  };
  if (!blocking.retired) {
    return new DvmError(
      "x402_voucher_pending",
      `A signed x402 voucher for credit ${blocking.creditId} is still waiting for its acknowledgement, so this channel cannot sign another.`,
      `Retry that funding ('dvm credit fund ${blocking.endpoint} --credit-id ${blocking.creditId}'), or retire it with 'dvm wallet x402-clear-pending --credit-id ${blocking.creditId}' if the DVM is gone.`,
      base
    );
  }
  const until = new Date(blocking.blockedUntil).toISOString();
  const signedDeadline = blocking.depositExpiresAt !== undefined;
  return new DvmError(
    "x402_voucher_pending",
    signedDeadline
      ? `The deposit this channel signed for credit ${blocking.creditId} was refused by the DVM but can still be submitted, so the channel cannot sign a second one yet.`
      : `The funding this channel signed for credit ${blocking.creditId} was refused by the DVM, and it names no deadline after which it stops being submittable, so the channel cannot sign a second one yet.`,
    signedDeadline
      ? `Fund again after ${until}, when that authorization expires and this block lifts by itself.`
      : `Fund again after ${until} — a conservative cutoff this CLI picks when a signature carries no expiry of its own, not a deadline the DVM agreed to. The block lifts by itself then.`,
    { ...base, refused: true, funding_blocked_until: until }
  );
}