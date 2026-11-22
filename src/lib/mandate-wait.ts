import { DvmError, type JobStatus, type PaymentRequestContent, type ProviderRef, type Transport } from "@dvmkit/sdk/internal";
import { loadJob, markJobTerminal, mutateCreditPayment, updateObservedJob, type JobRecord } from "./job-store";
import { appendMessages, loadMessages, maxSeq } from "./messages/index";
import { mandateCredit, mandateDrawTotal, recordMandatePayments } from "./mandate-payments";
import { guidanceJobArg } from "./provider-output";
import { isTransientJobReadError } from "./job-read-error";
import { settleRecordedPayments } from "./yield-state";

// SDK 0.41.0 job-manager.ts: 10 s mandate-resume grace, then up to 60 s
// for the default stale-job sweep tick. Add 10 s for settlement/read latency.
// This covers the default immediate-settlement and crashed-worker recovery paths;
// a provider with a custom, slower sweep interval is not discoverable by callers.
const SDK_MANDATE_RESUME_GRACE_MS = 10_000;
const SDK_MAX_STALE_SWEEP_INTERVAL_MS = 60_000;
const SETTLEMENT_MARGIN_MS = 10_000;
export const MANDATE_SETTLE_WINDOW_MS = SDK_MANDATE_RESUME_GRACE_MS + SDK_MAX_STALE_SWEEP_INTERVAL_MS + SETTLEMENT_MARGIN_MS;

export function standingStopOutput(job: Pick<JobRecord, "stopRequested" | "stopRequestedDisplay"> | null | undefined) {
  return job?.stopRequested ? { stop_requested: true,
    display: job.stopRequestedDisplay ?? "Stop recorded. No later payment asks will be paid by this CLI." } : {};
}

export function rememberStandingStop(jobId: string, display?: string): void {
  updateObservedJob(jobId, { stopRequested: true,
    stopRequestedDisplay: display ?? "Stop recorded. No later payment asks will be paid by this CLI." });
}

export function mandateWindowAction(jobId: string, request: PaymentRequestContent, requestSeq: number,
  history = loadMessages(jobId), now = Date.now()) {
  const job = loadJob(jobId);
  if (job?.stopRequested) return { type: "poll" as const, job_id: jobId, ...standingStopOutput(job),
    hint: `The stop is recorded. This CLI will decline the next open charge, without paying. Keep watching with \`dvm messages ${guidanceJobArg(jobId)} --wait\`.` };
  const mandate = job?.mandate;
  if (!mandate || job.pendingCreditPayment || job.unconfirmedPaymentSubmissions?.[requestSeq] ||
      job.inFlightPaymentRequestSeqs?.includes(requestSeq)) return undefined;
  const price = request.credit;
  // These are certain skips from the signed limits; no provider balance or
  // private diagnostic is inferred from the absence of a payment.
  if (!price || price.currency !== mandate.currency || price.amount_micro > mandate.max_ask_micro ||
      now >= mandate.expires_at_ms || mandateDrawTotal(job, history) + price.amount_micro > mandate.max_total_micro) return undefined;
  const firstSeen = job.mandateAskObservedAtMs?.[requestSeq] ?? mutateCreditPayment(jobId, (current) => {
    return (current.mandateAskObservedAtMs ??= {})[requestSeq] ??= now;
  });
  const retryAt = firstSeen + MANDATE_SETTLE_WINDOW_MS;
  if (now >= retryAt) return undefined;
  const display = "Waiting for the provider to take this charge from your credit under your standing limit.";
  return { type: "poll" as const, job_id: jobId, display,
    hint: `${display} Nothing has been sent by this CLI for this charge. Keep watching with \`dvm messages ${guidanceJobArg(jobId)} --wait\`.`,
    retry_at_ms: retryAt };
}

export function mandatePaymentApprovalRequired(jobId: string, requestSeq: number | undefined, reason: string): DvmError {
  const display = `${reason} This charge needs separate explicit approval.`;
  const hint = requestSeq === undefined
    ? "Ask your human to approve the specific charge after checking its sequence with dvm messages."
    : `Ask your human to approve this charge, then run \`dvm pay ${guidanceJobArg(jobId)} ${requestSeq}\`.`;
  return new DvmError("mandate_payment_approval_required", display, hint,
    { job_id: jobId, request_seq: requestSeq, next_action: { type: "pay", job_id: jobId, display, hint } }, display);
}

export function assertApprovedMandatePayment(job: JobRecord | null, request: PaymentRequestContent, seq?: number): void {
  const mandate = job?.mandate;
  if (!job || !mandate?.approvedCaps) return;
  const refuse = (reason: string): never => { throw mandatePaymentApprovalRequired(job.id, seq, reason); };
  if (Date.now() >= mandate.expires_at_ms) refuse("The approved payment window has expired.");
  const price = request.credit;
  if (!price || price.currency !== mandate.currency || !Number.isSafeInteger(price.amount_micro) || price.amount_micro <= 0)
    return refuse("The charge has no verifiable price in the approved credit currency.");
  if (price.amount_micro > Math.min(mandate.max_ask_micro, mandate.approvedCaps.max_ask_micro))
    refuse("This charge exceeds the standing per-charge limit the caller approved.");
  const history = loadMessages(job.id);
  // Only the original draw supplies native prices for all of its debits.
  // If prior charges cannot all be reconciled in that currency, hold new auto-pay.
  const bound = (credit: { credit_id?: string; draw_id?: string; currency?: string; amount_micro?: number } | undefined) =>
    credit?.credit_id === mandate.credit_id && credit.draw_id === mandate.draw_id && credit.currency === mandate.currency &&
    typeof credit.amount_micro === "number" && Number.isSafeInteger(credit.amount_micro) && credit.amount_micro > 0;
  const paid = history.filter((message) => message.from === "requester" && message.type === "payment");
  if ((job.upfrontPayment && job.upfrontPayment.amount_micro !== 0 && !bound(job.upfrontPayment)) ||
      paid.some((message) => message.type === "payment" && !bound(message.content.credit)) ||
      (job.paymentsHonoured ?? 0) > new Set(paid.map((message) => message.seq)).size + Number(bound(job.upfrontPayment)))
    refuse("The amount already paid under the approval could not be verified.");
  if (mandateDrawTotal(job, history) + price.amount_micro > Math.min(mandate.max_total_micro, mandate.approvedCaps.max_total_micro))
    refuse("This charge would exceed the total the caller approved.");
}

export async function recoverMandateWinner(jobId: string, requestSeq: number, transport: Transport,
  provider: ProviderRef, jobToken?: string): Promise<boolean> {
  if (!loadJob(jobId)?.mandate) return false;
  const history = await transport.getMessages(jobId, 0, provider, { jobToken, timeoutMs: 60_000 });
  appendMessages(jobId, history);
  recordMandatePayments(jobId, history, maxSeq(history, 0));
  return history.some((message) => mandateCredit(message)?.request_seq === requestSeq);
}

async function declineStoppedAsk(jobId: string, requestSeq: number, historyThrough: number, transport: Transport,
  provider: ProviderRef, jobToken?: string, waitReadTimeoutMs?: () => number): Promise<never> {
  let acknowledgement: Awaited<ReturnType<Transport["sendMessage"]>> | null;
  try {
    acknowledgement = await transport.sendMessage(jobId, { type: "decline", content: {} }, provider, { jobToken });
  } catch (error) {
    if (!(error instanceof DvmError) || !["no_open_ask", "job_terminal"].includes(error.code)) throw error;
    acknowledgement = null;
  }
  let standingStop = false;
  if (acknowledgement && "stop_requested" in acknowledgement && acknowledgement.stop_requested === true) {
    standingStop = true;
    if ("display" in acknowledgement && typeof acknowledgement.display === "string")
      rememberStandingStop(jobId, acknowledgement.display);
  }
  // Older transports resolve void on success. Only a refused send sets null.
  if (waitReadTimeoutMs && acknowledgement !== null)
    throw new DeclineAcknowledged({ requestSeq, standingStop, historyThrough, messageSeq: acknowledgement?.seq });
  if (!standingStop) {
    const status = await transport.status(jobId, provider, { jobToken, timeoutMs: 60_000 });
    recordStoppedAskStatus(jobId, requestSeq, status.status);
  }
  throw new DvmError("payment_request_not_pending", "The stop was recorded; no payment was sent.",
    "Keep watching the job for its final result.", { mandate_wait: true, ...standingStopOutput(loadJob(jobId)) });
}

export class DeclineAcknowledged extends Error {
  constructor(readonly acknowledgement: { requestSeq: number; standingStop: boolean; historyThrough: number; messageSeq?: number }) {
    super("The provider acknowledged the decline.");
  }
}

export function recordStoppedAskStatus(jobId: string, requestSeq: number, status: JobStatus["status"]): void {
  if (status !== "completed" && status !== "failed" && status !== "cancelled") return;
  markJobTerminal(jobId, status, loadJob(jobId)?.completion ?? {}, status === "cancelled" ? { callerCancelled: true, callerDeclined: true } : {});
  mutateCreditPayment(jobId, (job) => {
    if (job.pendingCreditPayment?.authorization.request_seq === requestSeq) delete job.pendingCreditPayment;
  });
}

export class MandateGuardReadError extends Error {
  constructor(cause?: unknown) {
    super("The mandate guard could not confirm the charge within its read budget.", { cause });
  }
}

export async function guardMandatePayment(jobId: string, requestSeq: number, transport: Transport,
  provider: ProviderRef, jobToken?: string, waitReadTimeoutMs?: () => number): Promise<void> {
  const job = loadJob(jobId);
  if (!job?.mandate && !job?.stopRequested) return;
  // Only mark reads that precede a send so the wait can reconnect safely.
  async function read<T>(request: (options: { jobToken?: string; timeoutMs: number }) => Promise<T>): Promise<T> {
    const timeoutMs = waitReadTimeoutMs?.() ?? 60_000;
    if (timeoutMs <= 0) throw new MandateGuardReadError();
    try {
      return await request({ jobToken, timeoutMs });
    } catch (error) {
      if (waitReadTimeoutMs && isTransientJobReadError(error)) throw new MandateGuardReadError(error);
      throw error;
    }
  }
  const history = await read((options) => transport.getMessages(jobId, 0, provider, options));
  const historyThrough = maxSeq(history, 0);
  appendMessages(jobId, history);
  recordMandatePayments(jobId, history, historyThrough);
  const payment = history.find((message) => message.from === "requester" && message.type === "payment" &&
    message.content.credit?.request_seq === requestSeq);
  if (payment?.type === "payment") {
    const id = payment.content.credit?.payment_id;
    if (!mandateCredit(payment)) {
      if (job.pendingCreditPayment?.authorization.payment_id === id) {
        // Legacy jobs retain the existing signed replay path. An approved
        // job must book the observed debit before applying any new limits.
        if (!job.mandate?.approvedCaps) return;
        await settleRecordedPayments(jobId, historyThrough);
      }
      if (loadJob(jobId)?.bookedCreditPayments?.some((entry) => entry.authorization.payment_id === id)) return;
    }
    throw new DvmError("payment_already_sent", "This charge was already paid from credit. Do not pay again.");
  }
  if (job.stopRequested) return declineStoppedAsk(jobId, requestSeq, historyThrough, transport, provider, jobToken, waitReadTimeoutMs);
  // A saved authorization is a recovery, not a new payment. Never delay replay.
  if (job.pendingCreditPayment?.authorization.request_seq === requestSeq || job.unconfirmedPaymentSubmissions?.[requestSeq] ||
      job.inFlightPaymentRequestSeqs?.includes(requestSeq)) return;
  const ask = history.find((message) => message.seq === requestSeq && message.type === "payment-request");
  if (ask?.type === "payment-request") {
    const action = mandateWindowAction(jobId, ask.content, requestSeq, history);
    if (action) throw new DvmError("payment_settling", action.display!, action.hint,
      { mandate_wait: true, display: action.display, retry_at_ms: action.retry_at_ms });
  }
  const latestAsk = history.findLast((message) => message.from === "provider" && message.type === "payment-request");
  const status = await read((options) => transport.status(jobId, provider, options));
  if (latestAsk?.seq !== requestSeq || status.status !== "awaiting-input")
    throw new DvmError("payment_request_not_pending", "The provider moved past this charge. Keep watching; no payment was sent.",
      undefined, { mandate_wait: true, display: "The provider is updating this job; no payment was sent by this CLI." });
}
