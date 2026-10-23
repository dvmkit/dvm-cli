import { asProviderText, type JobReceipt, type PaymentRequestContent } from "@dvmkit/sdk/internal";
import { formatPaymentAmount } from "./currency";
import { hasUnknownUpfrontCredit, type JobRecord } from "./job-store";
import { loadMessages } from "./messages";
import { isTerminalJobStatus } from "./next-action";

export function jobSpend(job: JobRecord, receipt?: JobReceipt) {
  const charges = [];
  const refunds = [];
  let request: { seq: number; content: PaymentRequestContent } | undefined;
  for (const message of loadMessages(job.id).sort((a, b) => a.seq - b.seq)) {
    if (message.from === "provider" && message.type === "payment-request") request = message;
    if (message.type !== "payment") continue;
    const payment = message.content;
    if (message.from === "provider") {
      refunds.push({ seq: message.seq, amount_msats: payment.amount_msats,
        display: formatPaymentAmount(payment.amount_msats ?? 0, undefined, { anchor: false }),
        reason: asProviderText(payment.reason ?? "refund") });
      continue;
    }
    const requestSeq = payment.credit?.request_seq ?? request?.seq;
    const ask = request && request.seq === requestSeq ? request.content : undefined;
    const booked = payment.credit && job.bookedCreditPayments?.find((entry) =>
      entry.authorization.payment_id === payment.credit?.payment_id);
    const amount = booked ? (booked.amountMsats ?? booked.request.amount_msats) : (payment.amount_msats ?? ask?.amount_msats ?? 0);
    const fiat = payment.credit
      ? { amount: payment.credit.amount_micro / 1_000_000, currency: payment.credit.currency }
      : ask?.fiat_amount;
    charges.push({ seq: message.seq, amount_msats: amount,
      display: formatPaymentAmount(amount, fiat, { anchor: false }),
      ...(fiat && fiat.amount > 0 ? { fiat_amount: fiat } : {}),
      rail: payment.credit ? "credit" : payment.tempo_credential ? "tempo"
        : payment.x402_payment ? "x402" : payment.cashu_token ? "cashu_p2pk" : "unknown",
      approval: job.paymentApprovals?.find((entry) => entry.requestSeq === requestSeq)?.approval ?? "unknown",
      reason: asProviderText(ask?.reason ?? booked?.request.reason ?? ""),
    });
    request = undefined;
  }
  // Submit books upfront payments in both counters before any conversation
  // charges. costMsats is only written at completion and must not be added again.
  const chargeTotal = charges.reduce((sum, charge) => sum + charge.amount_msats, 0);
  const total = job.totalPaidMsats ?? job.costMsats ?? 0;
  const knownCredit = job.paymentMethod === "credit" && !hasUnknownUpfrontCredit(job);
  const upfront = knownCredit ? job.upfrontPayment!.amount_msats : Math.max(0, total - chargeTotal);
  const payments = job.paymentsHonoured ?? charges.length + (upfront > 0 ? 1 : 0);
  const currency = charges[0]?.fiat_amount?.currency;
  // Conversation fiat prices describe the whole bill only when no upfront
  // charge is present; do not extrapolate an upfront price from later charges.
  const fiat = upfront === 0 && currency && charges.every((charge) => charge.fiat_amount?.currency === currency)
    ? { currency, amount: charges.reduce((sum, charge) => sum + charge.fiat_amount!.amount, 0) } : undefined;
  const totalDisplay = formatPaymentAmount(total, fiat, { anchor: false });
  // The policy stores only msats. Express its ceiling at the bill's aggregate
  // fiat/msat ratio, without consulting a different, current exchange rate.
  const budgetDisplay = job.policy
    ? formatPaymentAmount(job.policy.maxTotalMsats, fiat && total > 0
      ? { currency: fiat.currency, amount: fiat.amount * job.policy.maxTotalMsats / total } : undefined,
    { anchor: false }) : undefined;
  const logMismatch = isTerminalJobStatus(job.status) && (chargeTotal > total
    || payments !== charges.length + (upfront > 0 ? 1 : 0)
    || (knownCredit ? total !== chargeTotal + upfront
      : job.costMsats !== undefined && total - chargeTotal !== job.costMsats));
  // Credit receipts reflect settlement; local counters retain the original hold.
  const receiptMismatch = receipt && job.paymentMethod !== "credit" ? receipt.paid.msats !== total : undefined;
  const receiptTotalDisplay = receipt
    ? formatPaymentAmount(receipt.paid.msats, undefined, { anchor: false }) : undefined;
  let display = job.paymentMethod === "credit" && !knownCredit
    ? "Paid from prepaid credit; the upfront amount is not recorded locally"
      + (total > 0 ? `; recorded conversation payments: ${totalDisplay} over ${payments} charge${payments === 1 ? "" : "s"}` : "")
    : total === 0 && charges.length === 0
      ? (job.status === "completed" ? "This job was free" : "No charges yet")
      : `Paid ${totalDisplay} over ${payments} charge${payments === 1 ? "" : "s"}`;
  if (budgetDisplay) display += `, budget ${budgetDisplay}`;
  if (refunds.length > 0) display += `, ${refunds.length} refund${refunds.length === 1 ? "" : "s"}`;
  display += ".";
  if (logMismatch) display += " Local payment log disagrees with the job record.";
  if (receipt && job.paymentMethod === "credit" && !knownCredit) display += " The receipt total includes the unrecorded credit draw.";
  // Rounded labels can match while the msat totals differ, so fall back to exact msats.
  const [receiptLabel, localLabel] = receiptTotalDisplay === totalDisplay
    ? [`${receipt!.paid.msats} msats`, `${total} msats`] : [receiptTotalDisplay, totalDisplay];
  if (receiptMismatch) display += ` Receipt total ${receiptLabel} differs from local total ${localLabel}; mint fees, returned change, or a payment not recorded locally can explain the difference.`;
  return { charges, refunds, total_msats: total, total_display: totalDisplay,
    ...(upfront > 0 && (job.paymentMethod !== "credit" || knownCredit) ? {
      upfront_display: formatPaymentAmount(upfront, knownCredit && job.upfrontPayment?.amount_micro !== undefined
        ? { amount: job.upfrontPayment.amount_micro / 1_000_000, currency: job.upfrontPayment.currency! } : undefined,
      { anchor: false }),
    } : {}),
    ...(budgetDisplay ? { budget_display: budgetDisplay } : {}),
    payments, max_payments: job.policy?.maxPayments ?? null, log_mismatch: logMismatch,
    ...(receipt ? { receipt_total_display: receiptTotalDisplay,
      ...(receiptMismatch !== undefined ? { receipt_mismatch: receiptMismatch } : {}) } : {}), display };
}

export function renderSpendHuman(spend: ReturnType<typeof jobSpend>, print: (text: string) => void): void {
  print(spend.display);
  if (spend.upfront_display) print(`  Upfront: ${spend.upfront_display}`);
  const rails: Record<string, string> = { cashu_p2pk: "Cashu", tempo: "Tempo", x402: "x402", credit: "prepaid credit", unknown: "payment method not recorded" };
  const approvals: Record<string, string> = { auto: "paid automatically", explicit: "you approved", unknown: "approval not recorded" };
  for (const charge of spend.charges) {
    print(`  [${charge.seq}] ${charge.display} (${rails[charge.rail]}, ${approvals[charge.approval]})${charge.reason.text ? `: ${charge.reason.text}` : ""}`);
  }
  for (const refund of spend.refunds) print(`  [${refund.seq}] Refund: ${refund.display} (${refund.reason.text})`);
  if (spend.receipt_total_display) print(`  Receipt total: ${spend.receipt_total_display}`);
}
