import { recordSpend } from "./budget-ledger";
import { loadJob, markPaymentRequestPaid, type UnconfirmedPaymentSubmission } from "./job-store";
import { commitHeldSubmission } from "./wallet-agent/spend";

/**
 * Spend-label fields recorded in the budget ledger for a mid-job payment,
 * rendered by `dvm wallet history`. The provider's `payment-request.reason`
 * is provider-supplied free text, so it's tagged `labelSource: "provider"` and
 * the history command provenance-wraps it on relay. Omitted when blank.
 */
export function midJobSpendLabel(reason: string | undefined): { label?: string; labelSource?: "provider" } {
  const text = reason?.trim();
  return text ? { label: text, labelSource: "provider" } : {};
}

/**
 * Finish booking a submission that `markPaymentRequestPaid` returned. Only the
 * caller that received it may call this, which keeps the ledger entry and the
 * wallet commit to at most one per payment; a crash before it finishes leaves
 * the ledger one entry short.
 */
export async function finishBookedSubmission(jobId: string, booked: UnconfirmedPaymentSubmission, endpoint?: string): Promise<void> {
  recordSpend({
    msats: booked.amountMsats,
    btcRate: booked.btcRate,
    jobId,
    providerEndpoint: endpoint ?? loadJob(jobId)?.endpoint ?? "",
    ...midJobSpendLabel(booked.reason),
  });
  if (booked.rail === "cashu_p2pk") await commitHeldSubmission(booked.cashuRequestId);
}

/** The provider took the payment for this ask: mark it paid and book a held submission once. */
export async function settleTakenPayment(jobId: string, requestSeq: number): Promise<UnconfirmedPaymentSubmission | undefined> {
  const booked = markPaymentRequestPaid(jobId, requestSeq);
  if (booked) await finishBookedSubmission(jobId, booked);
  return booked;
}
