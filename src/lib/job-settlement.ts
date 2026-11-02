import { isSignedJobReceipt, verifyJobReceipt, type JobReceipt, type ReceiptVerification } from "@dvmkit/sdk/internal";
import { formatAmount, formatPaymentAmount, formatSats } from "./currency";
import { hasUnknownUpfrontCredit, hasUnknownUpfrontRail, loadJob, type JobRecord } from "./job-store";
import { loadMessages } from "./messages";
import { isTerminalJobStatus } from "./next-action";

export interface JobSettlement {
  status: "settled" | "released" | "refunded" | "free" | "pending" | "unknown";
  settled_msats: number | null;
  released_msats?: number;
  refunded_msats: number;
  rail: string | null;
  evidence: "receipt" | "wallet" | "local" | "unknown";
  display: string;
}

function amountDisplay(msats: number, rail: string | null, rate?: number): string {
  const amount = rate === undefined ? formatPaymentAmount(msats, undefined, { anchor: false })
    : rate > 0 ? formatAmount(msats, rate, { anchor: false }) : formatSats(msats);
  return amount
    + (rail === "tempo" || rail === "x402" ? " (BTC valuation)" : "");
}

function unknownSettlement(rail: string | null): JobSettlement {
  return { status: "unknown", settled_msats: null, refunded_msats: 0, rail, evidence: "unknown",
    display: "Settlement unknown; recorded payments do not prove a final charge or return." };
}

export function receiptSettlement(receipt: JobReceipt, verification: ReceiptVerification | "unparseable", rate?: number): JobSettlement {
  const rail = receipt.paid.rail;
  if (verification !== "verified" && verification !== "verified_unattested") return unknownSettlement(rail);
  const amount = amountDisplay(receipt.paid.msats, rail, rate);
  if (receipt.outcome === "completed") {
    return { status: receipt.paid.msats === 0 ? "free" : "settled", settled_msats: receipt.paid.msats,
      refunded_msats: 0, rail, evidence: "receipt",
      display: receipt.paid.msats === 0 ? "This was a free job." : `Settled ${amount}${rail ? ` via ${rail}` : ""}.` };
  }
  // paid.msats is total credited value, including holds. The terminal credit
  // countersignature records release on failure/cancellation, not a wallet refund.
  if (receipt.credit) {
    return { status: "released", settled_msats: 0, released_msats: receipt.paid.msats,
      refunded_msats: 0, rail, evidence: "receipt",
      display: `Released ${amount} to the provider credit balance${rail ? ` (funding rail: ${rail})` : ""}; no job charge.` };
  }
  return unknownSettlement(rail);
}

export function jobSettlement(job: JobRecord, offeredReceipt?: JobReceipt): JobSettlement {
  const receipt = offeredReceipt ?? (isSignedJobReceipt(job.receipt) ? job.receipt : undefined);
  const rail = receipt?.paid.rail ?? job.upfrontPayment?.rail ?? job.paymentMethod ?? null;
  const total = job.totalPaidMsats ?? job.costMsats;
  const log = loadMessages(job.id);
  const inbound = log.filter((message) => message.from === "provider" && message.type === "payment"
    && message.content.cashu_token && (message.content.reason ?? "refund") === "refund");
  let refunded = 0;
  let pending = false;
  for (const message of inbound) {
    const amount = job.claimedPaymentAmountsMsats?.[message.seq];
    if (job.claimedPaymentSeqs?.includes(message.seq) && amount !== undefined && Number.isSafeInteger(amount) && amount > 0)
      refunded += amount;
    else pending = true;
  }
  const verified = receipt ? verifyJobReceipt({ receipt, expectedJobId: job.id, builder: job.builderAnchor }) : undefined;
  const summary = receipt && verified ? receiptSettlement(receipt, verified.status) : undefined;
  // A receipt for a different outcome must not overwrite a fresher terminal read.
  const matching = receipt?.outcome === job.status;
  if (!isTerminalJobStatus(job.status)) {
    return { status: "pending", settled_msats: null, refunded_msats: refunded, rail, evidence: "local",
      display: "Settlement pending; payments sent or held are not the final job charge." };
  }
  if (refunded > 0 || pending) {
    const soundReceipt = matching && (verified?.status === "verified" || verified?.status === "verified_unattested");
    const expectedTotal = soundReceipt ? receipt!.paid.msats : total;
    const converted = [rail, job.paymentMethod, job.upfrontPayment?.rail,
      typeof job.upfrontRailPayment === "object" ? job.upfrontRailPayment.method : undefined]
      .some((method) => method === "tempo" || method === "x402")
      || log.some((message) => message.from === "requester" && message.type === "payment"
        && (message.content.tempo_credential || message.content.x402_payment));
    const full = expectedTotal !== undefined && expectedTotal > 0 && refunded >= expectedTotal && !converted
      && (soundReceipt || (!hasUnknownUpfrontCredit(job) && !hasUnknownUpfrontRail(job)));
    return { status: full ? "refunded" : pending ? "pending" : "unknown",
      settled_msats: full ? 0 : null, refunded_msats: refunded, rail: "cashu", evidence: refunded > 0 ? "wallet" : "unknown",
      display: `${refunded > 0 ? `Refunded ${amountDisplay(refunded, "cashu")} via cashu into your wallet.` : "Refund pending via cashu; no wallet-confirmed amount is recorded."}`
        + (full ? " No net job charge." : refunded > 0 ? " Final net charge is unknown." : "") };
  }
  if (matching && summary && summary.status !== "unknown") return summary;
  if (summary) return unknownSettlement(rail);
  if (job.status === "completed" && !hasUnknownUpfrontCredit(job) && !hasUnknownUpfrontRail(job)) {
    const amount = total ?? 0;
    return { status: amount === 0 ? "free" : "settled", settled_msats: amount, refunded_msats: 0, rail, evidence: "local",
      display: amount === 0 ? "This job was free." : `Settled ${amountDisplay(amount, rail)}${rail ? ` via ${rail}` : ""}.` };
  }
  return unknownSettlement(rail);
}

export function terminalSettlementFields(jobId: string, options: {
  status?: string;
  receipt?: JobReceipt;
  persistLocalState?: boolean;
} = {}): { settlement?: JobSettlement } {
  const stored = options.persistLocalState === false ? null : loadJob(jobId);
  const status = options.status ?? stored?.status ?? options.receipt?.outcome;
  if (!status || !isTerminalJobStatus(status)) return {};
  const job: JobRecord = stored ? { ...stored, status } : { id: jobId, endpoint: "", submittedAt: 0, status };
  // Override reads must not borrow another endpoint's refunds or payment totals.
  return { settlement: options.persistLocalState === false
    ? options.receipt && options.receipt.outcome === status
      ? receiptSettlement(options.receipt, verifyJobReceipt({ receipt: options.receipt, expectedJobId: jobId }).status)
      : unknownSettlement(null)
    : jobSettlement(job, options.receipt) };
}
