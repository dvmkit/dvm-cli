import { DvmError, type PaymentRequestContent, type ProviderRef, type Transport } from "@dvmkit/sdk/internal";
import { loadJob, markJobTerminal, mutateCreditPayment, updateObservedJob, type JobRecord } from "./job-store";
import { appendMessages, loadMessages, maxSeq } from "./messages/index";
import { mandateCredit, mandateDrawTotal, recordMandatePayments } from "./mandate-payments";
import { guidanceJobArg } from "./provider-output";

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

export async function recoverMandateWinner(jobId: string, requestSeq: number, transport: Transport,
  provider: ProviderRef, jobToken?: string): Promise<boolean> {
  if (!loadJob(jobId)?.mandate) return false;
  const history = await transport.getMessages(jobId, 0, provider, { jobToken, timeoutMs: 60_000 });
  appendMessages(jobId, history);
  recordMandatePayments(jobId, history, maxSeq(history, 0));
  return history.some((message) => mandateCredit(message)?.request_seq === requestSeq);
}

async function declineStoppedAsk(jobId: string, requestSeq: number, transport: Transport,
  provider: ProviderRef, jobToken?: string): Promise<never> {
  try { await transport.sendMessage(jobId, { type: "decline", content: {} }, provider, { jobToken }); }
  catch (error) {
    if (!(error instanceof DvmError) || !["no_open_ask", "job_terminal"].includes(error.code)) throw error;
  }
  const status = await transport.status(jobId, provider, { jobToken, timeoutMs: 60_000 });
  if (status.status === "completed" || status.status === "failed" || status.status === "cancelled") {
    markJobTerminal(jobId, status.status, loadJob(jobId)?.completion ?? {}, status.status === "cancelled" ? { callerCancelled: true, callerDeclined: true } : {});
    mutateCreditPayment(jobId, (job) => {
      if (job.pendingCreditPayment?.authorization.request_seq === requestSeq) delete job.pendingCreditPayment;
    });
  }
  throw new DvmError("payment_request_not_pending", "The stop was recorded; no payment was sent.",
    "Keep watching the job for its final result.", { mandate_wait: true, ...standingStopOutput(loadJob(jobId)) });
}

export async function guardMandatePayment(jobId: string, requestSeq: number, transport: Transport,
  provider: ProviderRef, jobToken?: string): Promise<void> {
  const job = loadJob(jobId);
  if (!job?.mandate && !job?.stopRequested) return;
  const history = await transport.getMessages(jobId, 0, provider, { jobToken, timeoutMs: 60_000 });
  appendMessages(jobId, history);
  recordMandatePayments(jobId, history, maxSeq(history, 0));
  const payment = history.find((message) => message.from === "requester" && message.type === "payment" &&
    message.content.credit?.request_seq === requestSeq);
  if (payment?.type === "payment") {
    const id = payment.content.credit?.payment_id;
    // The original signed payment still needs its existing replay-and-book path.
    if (!mandateCredit(payment) && (job.pendingCreditPayment?.authorization.payment_id === id ||
        job.bookedCreditPayments?.some((entry) => entry.authorization.payment_id === id))) return;
    throw new DvmError("payment_already_sent", "This charge was already paid from credit. Do not pay again.");
  }
  if (job.stopRequested) return declineStoppedAsk(jobId, requestSeq, transport, provider, jobToken);
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
  const status = await transport.status(jobId, provider, { jobToken, timeoutMs: 60_000 });
  if (latestAsk?.seq !== requestSeq || status.status !== "awaiting-input")
    throw new DvmError("payment_request_not_pending", "The provider moved past this charge. Keep watching; no payment was sent.",
      undefined, { mandate_wait: true, display: "The provider is updating this job; no payment was sent by this CLI." });
}
