import { formatFiat } from "@dvmkit/sdk";
import { type Message } from "@dvmkit/sdk/internal";
import { loadJob, mutateCreditPayment, recordAnsweredPaymentRequest, type JobRecord } from "./job-store";
import { loadMessages } from "./messages/index";

type CreditPayment = NonNullable<Extract<Message, { type: "payment" }>["content"]["credit"]> & { mandate?: boolean };
export function mandateCredit(message: Message): CreditPayment | undefined {
  if (message.from !== "requester" || message.type !== "payment") return undefined;
  const credit = message.content.credit as CreditPayment | undefined;
  return credit?.mandate === true ? credit : undefined;
}

function validMicro(value: number): boolean {
  return Number.isSafeInteger(value) && value >= 0;
}

function safeCurrency(value: unknown): string | null {
  return typeof value === "string" && /^[a-z]{3}$/i.test(value) ? value.toLowerCase() : null;
}

function money(micro: number, currency: string | null): string {
  if (!validMicro(micro)) return "an unrecorded amount";
  return currency ? formatFiat(micro / 1_000_000, currency)
    : `${(micro / 1_000_000).toLocaleString("en-US", { maximumFractionDigits: 6 })} (currency not recorded)`;
}

export function mandateDrawTotal(job: JobRecord, history: Message[]): number {
  const mandate = job.mandate;
  if (!mandate) return 0;
  const bound = (credit: { credit_id?: string; draw_id?: string; currency?: string; amount_micro?: number } | undefined) =>
    credit?.credit_id === mandate.credit_id && credit.draw_id === mandate.draw_id && credit.currency === mandate.currency &&
    validMicro(credit.amount_micro!) ? credit.amount_micro! : 0;
  let total = bound(job.upfrontPayment);
  const seen = new Set<number>();
  for (const message of history) {
    if (seen.has(message.seq)) continue;
    seen.add(message.seq);
    if (message.from === "requester" && message.type === "payment") total += bound(message.content.credit);
  }
  return total;
}

export function mandatePaymentReports(job: JobRecord | null | undefined, history: Message[], fullHistoryThrough?: number) {
  const mandate = job?.mandate;
  const currency = safeCurrency(mandate?.currency);
  const seen = new Set<number>();
  const paidAsks = new Set<number>();
  const reports = [];
  const asks = new Map<number, Extract<Message, { type: "payment-request" }>>();
  const prefix: Message[] = [];
  for (const message of [...history].sort((a, b) => a.seq - b.seq)) {
    if (seen.has(message.seq)) continue;
    seen.add(message.seq);
    prefix.push(message);
    if (message.from === "provider" && message.type === "payment-request") asks.set(message.seq, message);
    const paid = mandateCredit(message);
    if (!paid) {
      if (message.from === "requester" && message.type === "payment") {
        const seq = message.content.credit?.request_seq ?? [...asks.keys()].at(-1);
        if (seq !== undefined) paidAsks.add(seq);
      }
      continue;
    }
    const total = job ? mandateDrawTotal(job, prefix) : 0;
    const ask = asks.get(paid.request_seq);
    // A skipped sequence could contain the ask. A full read or an observed
    // message at that sequence can establish that the payment has no ask.
    const requestUnverified = !ask && !seen.has(paid.request_seq) &&
      (fullHistoryThrough === undefined || message.seq > fullHistoryThrough);
    const violations: string[] = [];
    const reasons: string[] = [];
    const breach = (field: string, reason: string) => { violations.push(field); reasons.push(reason); };
    if (!validMicro(paid.amount_micro) || paid.amount_micro === 0) breach("amount_micro", "an invalid payment amount");
    if (!ask) {
      if (!requestUnverified) breach("request_seq", "a payment for a charge missing from the job's requests");
    } else if (!ask.content.credit) breach("ask_unpriced", "a payment for a charge with no credit price");
    else {
      if (paid.amount_micro > ask.content.credit.amount_micro)
        breach("ask_amount_micro", `more than the provider requested for this charge (${money(ask.content.credit.amount_micro, currency)})`);
      if (paid.currency !== ask.content.credit.currency)
        breach("ask_currency", "a payment in a different currency from the requested charge");
    }
    if (paidAsks.has(paid.request_seq)) breach("duplicate_request_seq", "more than one payment for the same charge");
    paidAsks.add(paid.request_seq);
    if (mandate) {
      if (paid.amount_micro > mandate.max_ask_micro)
        breach("max_ask_micro", `more than your per-charge limit of ${money(mandate.max_ask_micro, currency)}`);
      if (total > mandate.max_total_micro)
        breach("max_total_micro", `more than your standing credit budget of ${money(mandate.max_total_micro, currency)}`);
      // Wire timestamps have whole-second precision; only a definitely expired
      // payment can be accused of breaking a millisecond expiry.
      if (message.timestamp * 1000 >= mandate.expires_at_ms)
        breach("expires_at_ms", `a payment after your standing limit ended on ${new Date(mandate.expires_at_ms).toISOString()}`);
      if (paid.credit_id !== mandate.credit_id) breach("credit_id", "a different prepaid credit than you authorised");
      if (paid.draw_id !== mandate.draw_id) breach("draw_id", "a different job credit reservation than you authorised");
      if (paid.currency !== mandate.currency) breach("currency", "a different currency than you authorised");
    }
    // A provider's denomination must agree with the stored authority before it
    // can label money in relayable text. Unknown authority is not an accusation.
    const paidCurrency = mandate ? paid.currency === mandate.currency ? currency : null : safeCurrency(paid.currency);
    const amount = { amount_micro: paid.amount_micro, currency: paid.currency, display: money(paid.amount_micro, paidCurrency) };
    const overchargeDisplay = reasons.length ? `Provider overcharge: ${reasons.join("; ")}.` : undefined;
    const display = `${amount.display} paid from your credit under your standing limit. ` +
      (mandate ? `Running credit total ${money(total, currency)} of ${money(mandate.max_total_micro, currency)} budget.`
        : "The signed standing limit is not available locally, so its limits could not be checked.") +
      (requestUnverified ? " The link to the payment request could not be verified from the available messages." : "") +
      (overchargeDisplay ? ` ${overchargeDisplay}` : "");
    reports.push({ amount_msats: ask?.content.amount_msats ?? 0, seq: message.seq,
      request_seq: paid.request_seq, mandate: true as const, amount, limits_checked: !!mandate,
      ...(requestUnverified ? { request_seq_unverified: true as const } : {}),
      total_micro: total, budget_micro: mandate?.max_total_micro, currency,
      overcharged: violations.length > 0, violated_limits: violations, overcharge_display: overchargeDisplay, display });
  }
  return reports;
}

export type MandatePaymentReport = ReturnType<typeof mandatePaymentReports>[number];

export function readMandatePaymentReport(message: Message, jobId?: string): MandatePaymentReport | undefined {
  if (!mandateCredit(message)) return undefined;
  return mandatePaymentReports(jobId ? loadJob(jobId) : undefined,
    [message, ...(jobId ? loadMessages(jobId) : [])]).find((entry) => entry.seq === message.seq);
}

export function mandatePaymentSummary(job: JobRecord | null | undefined, messages: Message[], fullHistoryThrough?: number): {
  mandate_payments?: MandatePaymentReport[]; overcharged?: boolean; violated_limits?: string[]; display?: string;
} {
  const payments = mandatePaymentReports(job, messages, fullHistoryThrough);
  if (!payments.length) return {};
  const violated = [...new Set(payments.flatMap((payment) => payment.violated_limits))];
  return { mandate_payments: payments, ...(violated.length ? {
    overcharged: true, violated_limits: violated,
    display: [...new Set(payments.map((payment) => payment.overcharge_display).filter(Boolean))].join(" "),
  } : {}) };
}

export function recordMandatePayments(jobId: string, history: Message[]): void {
  if (!loadJob(jobId)?.mandate || !history.some(mandateCredit)) return;
  mutateCreditPayment(jobId, (job) => {
    for (const message of history) {
      const credit = mandateCredit(message);
      if (!credit) continue;
      const request = history.find((entry) => entry.seq === credit.request_seq);
      const ask = request?.from === "provider" && request.type === "payment-request" ? request : undefined;
      if ((!request || ask) && Number.isSafeInteger(credit.request_seq) && credit.request_seq >= 0 && credit.request_seq < message.seq)
        recordAnsweredPaymentRequest(job, credit.request_seq);
      if (job.pendingCreditPayment?.authorization.request_seq === credit.request_seq)
        delete job.pendingCreditPayment;
      const booked = job.mandatePaymentSeqs?.includes(message.seq) === true;
      const msats = ask?.content.amount_msats ?? 0;
      const valuations = job.mandatePaymentMsats ??= {};
      const previous = valuations[message.seq] ?? 0;
      // A cursor can expose the payment before a full-history read recovers its ask.
      if (!booked || (previous === 0 && msats > 0)) {
        valuations[message.seq] = msats;
        job.totalPaidMsats = (job.totalPaidMsats ?? 0) + msats - previous;
        if (credit.currency === "usd") job.paidUsdMsats = (job.paidUsdMsats ?? 0) + msats - previous;
      }
      if (!booked) {
        (job.mandatePaymentSeqs ??= []).push(message.seq);
        job.paymentsHonoured = (job.paymentsHonoured ?? 0) + 1;
        if (credit.currency === "usd") job.paidUsdMicro = (job.paidUsdMicro ?? 0) + credit.amount_micro;
        (job.paymentApprovals ??= []).push({ requestSeq: credit.request_seq, approval: "auto" });
      }
    }
  }, true);
}

export function storedMandateSummary(jobId: string) {
  return mandatePaymentSummary(loadJob(jobId), loadMessages(jobId));
}
