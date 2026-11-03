import { isSignedJobReceipt, verifyJobReceipt, type JobReceipt, type ReceiptVerification } from "@dvmkit/sdk/internal";
import { formatAmount, formatPaymentAmount, formatSats } from "./currency";
import { hasUnknownUpfrontCredit, hasUnknownUpfrontRail, loadJob, type JobRecord } from "./job-store";
import { loadMessages } from "./messages";
import { isTerminalJobStatus } from "./next-action";
import { type PieceContext, pieceSettlement } from "./piece-settlement";

export interface JobSettlement {
  status: "settled" | "released" | "refunded" | "free" | "pending" | "unknown";
  settled_msats: number | null;
  released_msats?: number;
  refunded_msats: number;
  rail: string | null;
  evidence: "receipt" | "wallet" | "local" | "unknown";
  /** Piece-charging receipts only: the draw's hold, charge and release, in micro-units of `currency`. */
  held_micro?: number;
  charged_micro?: number;
  released_micro?: number;
  /** What a caller's cancel charged for the piece of work it stopped. */
  stopped_micro?: number;
  currency?: string | null;
  /** Most the ending may charge from this CLI's payments and the asks it saw, when every price is recorded. */
  ceiling_micro?: number;
  /** `payments` (this CLI's payments and the asks it saw) or `receipt_pieces` (the receipt's own pieces). */
  ceiling_basis?: "payments" | "receipt_pieces";
  /** The receipt charges more than `ceiling_micro`. */
  overcharged?: boolean;
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

export function receiptSettlement(
  receipt: JobReceipt,
  verification: ReceiptVerification | "unparseable",
  rate?: number,
  context?: PieceContext
): JobSettlement {
  const rail = receipt.paid.rail;
  if (verification !== "verified" && verification !== "verified_unattested") return unknownSettlement(rail);
  const pieces = pieceSettlement(receipt, context);
  if (pieces && !(receipt.outcome === "completed" && receipt.paid.msats === 0 && pieces.held_micro === 0)) {
    // A piece-settled draw can charge on any ending: finished pieces, and on a cancel the stopped one.
    const whole = receipt.outcome === "completed" && pieces.released_micro === 0;
    return {
      status: pieces.charged_micro === 0 ? "released" : "settled",
      settled_msats: whole ? receipt.paid.msats : pieces.charged_micro === 0 ? 0 : null,
      ...(pieces.charged_micro === 0 ? { released_msats: receipt.paid.msats } : {}),
      refunded_msats: 0, rail, evidence: "receipt",
      held_micro: pieces.held_micro, charged_micro: pieces.charged_micro, released_micro: pieces.released_micro,
      stopped_micro: pieces.stopped_micro, currency: pieces.currency,
      ...(pieces.ceiling_micro !== undefined ? { ceiling_micro: pieces.ceiling_micro, ceiling_basis: pieces.ceiling_basis } : {}),
      overcharged: pieces.overcharged,
      display: pieces.display,
    };
  }
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
  const summary = receipt && verified ? receiptSettlement(receipt, verified.status, undefined, { job, messages: log }) : undefined;
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
  /** The provider's credit currency; see {@link PieceContext.currency}. */
  currency?: string;
} = {}): { settlement?: JobSettlement } {
  const stored = options.persistLocalState === false ? null : loadJob(jobId);
  const status = options.status ?? stored?.status ?? options.receipt?.outcome;
  if (!status || !isTerminalJobStatus(status)) return {};
  const job: JobRecord = stored ? { ...stored, status } : { id: jobId, endpoint: "", submittedAt: 0, status };
  // Override reads must not borrow another endpoint's refunds or payment totals.
  return { settlement: options.persistLocalState === false
    ? options.receipt && options.receipt.outcome === status
      ? receiptSettlement(options.receipt, verifyJobReceipt({ receipt: options.receipt, expectedJobId: jobId }).status,
        undefined, { currency: options.currency })
      : unknownSettlement(null)
    : jobSettlement(job, options.receipt) };
}
