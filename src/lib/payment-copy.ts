import { paymentRailLabel } from "./rail-labels";
import { formatPaymentAmount } from "./currency";
import {
  formatUsdcMicrounits
} from "@dvmkit/sdk/internal";

import type { PaidPaymentResult } from "./payment-responder";

/**
 * The one-line confirmation a settled mid-job payment reports, shared by
 * `dvm pay` and the auto-pay leg of the stream loop so the two can't drift.
 * Fiat-first on both rails: an x402 spend states its exact signed USDC figure,
 * everything else leads with the provider's own fiat price (when it priced in
 * fiat) and keeps sats as the parenthetical. No cost anchor — the decision has
 * already been made by the time this renders.
 *
 * Deliberately outside `payment-responder` so a test that stubs the money path
 * still exercises the real copy.
 */
export function paidConfirmationDisplay(
  result: PaidPaymentResult,
  fiat?: { amount: number; currency: string }
): string {
  return `Paid ${formatPaidAmount(result, fiat)} via ${paymentRailLabel(result.rail)}.`;
}

export function formatPaidAmount(
  result: PaidPaymentResult,
  fiat?: { amount: number; currency: string }
): string {
  if (result.amountUsdcMicro !== undefined) {
    return `$${formatUsdcMicrounits(result.amountUsdcMicro)} USDC`;
  }
  return formatPaymentAmount(result.amountMsats, fiat, { anchor: false });
}
