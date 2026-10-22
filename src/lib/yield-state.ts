import { DvmError, isAbortError, shellQuoteArg, type Message, type MessagePollOptions, type ProviderRef, type Transport } from "@dvmkit/sdk/internal";
import { clearPaymentRequestInFlight, loadJob, markPaymentRequestPaid } from "./job-store";
import { loadMessages } from "./messages";

export const JOB_READ_TIMEOUT_MS = 60_000;
// A lost send may still be processing before history records it. Give every
// rail 45 seconds before authorizing a replacement debit, including x402.
export const PAYMENT_SETTLE_WINDOW_MS = 45_000;

export function answeredYieldSeqs(messages: Message[]): Set<number> {
  const answered = new Set<number>();
  const prompts = new Map<string, number>();
  let paymentRequest: number | undefined;
  for (const message of [...messages].sort((a, b) => a.seq - b.seq)) {
    if (message.from === "provider") {
      if (message.type === "payment-request") paymentRequest = message.seq;
      if (message.type === "prompt") prompts.set(message.content.id, message.seq);
    } else if (message.type === "response") {
      const seq = prompts.get(message.content.prompt_id);
      if (seq !== undefined) answered.add(seq);
    } else if (message.type === "payment") {
      // Balance authorizations identify the ask explicitly. Older rail messages
      // answer the preceding charge; provider payments are refunds, not answers.
      const seq = message.content.credit?.request_seq ?? paymentRequest;
      if (seq !== undefined) answered.add(seq);
    }
  }
  return answered;
}

function latestProviderPaymentRequest(messages: Message[]): Message | undefined {
  return [...messages].sort((a, b) => a.seq - b.seq)
    .findLast((message) => message.from === "provider" && message.type === "payment-request");
}

export function pendingPaymentRequest(messages: Message[], answered = answeredYieldSeqs(messages)): Message | undefined {
  const latest = latestProviderPaymentRequest(messages);
  if (!latest || answered.has(latest.seq)) return undefined;
  if (messages.some((message) => message.from === "provider" && message.seq > latest.seq &&
    (message.type === "complete" || message.type === "cancel" || message.type === "working"))) return undefined;
  return latest;
}

export function loadAnsweredYieldSeqs(jobId: string): Set<number> {
  const answered = answeredYieldSeqs(loadMessages(jobId));
  const job = loadJob(jobId);
  for (const seq of job?.paidPaymentRequestSeqs ?? []) answered.add(seq);
  for (const payment of job?.bookedCreditPayments ?? []) answered.add(payment.authorization.request_seq);
  return answered;
}

/** Only fresh provider history can resolve a send whose reply was lost. */
export async function reconcileInFlightPaymentRequest(
  jobId: string, requestSeq: number, transport: Transport, provider: ProviderRef, options: MessagePollOptions
): Promise<boolean> {
  const boundedOptions = { ...options, timeoutMs: options.timeoutMs ?? JOB_READ_TIMEOUT_MS };
  const history = await boundedPaymentRead(jobId, () => transport.getMessages(jobId, 0, provider, boundedOptions), boundedOptions.timeoutMs);
  // A confirmed payment resolves immediately; a recent send needs no status read.
  const decisionTime = Date.now();
  const needsStatus = !answeredYieldSeqs(history).has(requestSeq) && decisionTime >= settleUntilMs(jobId, requestSeq, decisionTime);
  const status = needsStatus
    ? (await boundedPaymentRead(jobId, () => transport.status(jobId, provider, boundedOptions), boundedOptions.timeoutMs)).status
    : undefined;
  return reconcilePaymentRequestHistory(jobId, requestSeq, history, status, () => decisionTime);
}

export function reconcilePaymentRequestHistory(
  jobId: string, requestSeq: number, history: Message[], status: string | undefined, now: () => number = Date.now
): boolean {
  if (answeredYieldSeqs(history).has(requestSeq)) {
    markPaymentRequestPaid(jobId, requestSeq);
    return true;
  }
  // A newer ask abandons this one; it must neither be retried nor pin the cursor.
  const superseded = (latestProviderPaymentRequest(history)?.seq ?? -1) > requestSeq;
  if (superseded) clearPaymentRequestInFlight(jobId, requestSeq);
  const decisionTime = now();
  const retryAt = settleUntilMs(jobId, requestSeq, decisionTime);
  const seconds = Math.ceil((retryAt - decisionTime) / 1000);
  if (!superseded && decisionTime < retryAt)
    throw new DvmError("payment_settling", "The previous payment may still be processing.",
      `Retry with \`dvm pay ${shellQuoteArg(jobId)}\` in about ${seconds} ${seconds === 1 ? "second" : "seconds"}, or keep watching with \`dvm messages ${shellQuoteArg(jobId)} --wait\`.`,
      { retry_at_ms: retryAt });
  if (status !== "awaiting-input" || pendingPaymentRequest(history)?.seq !== requestSeq)
    throw new DvmError("payment_request_not_pending", "The provider is no longer waiting on this payment request.",
      `Check the job with \`dvm messages ${shellQuoteArg(jobId)} --wait\` before paying again.`);
  // Keep the record until the locked sender restamps it or confirms acceptance.
  return false;
}

function settleUntilMs(jobId: string, requestSeq: number, now: number): number {
  const startedAt = loadJob(jobId)?.inFlightPaymentRequestStartedAtMs?.[requestSeq];
  return startedAt === undefined ? 0 : Math.min(startedAt + PAYMENT_SETTLE_WINDOW_MS, now + PAYMENT_SETTLE_WINDOW_MS);
}

async function boundedPaymentRead<T>(jobId: string, read: () => Promise<T>, timeoutMs: number): Promise<T> {
  let timer: ReturnType<typeof setTimeout> | undefined;
  try {
    return await Promise.race([read(), new Promise<never>((_, reject) => {
      timer = setTimeout(() => reject(new DvmError("timeout", "Payment recovery read timed out. No new payment was sent.")), timeoutMs);
    })]);
  } catch (error) {
    if (isAbortError(error) || (error instanceof DvmError && error.code === "timeout"))
      throw new DvmError("timeout", "Payment recovery read timed out. No new payment was sent.",
        `Retry with \`dvm pay ${shellQuoteArg(jobId)}\` or keep watching with \`dvm messages ${shellQuoteArg(jobId)} --wait\`.`);
    throw error;
  } finally { if (timer) clearTimeout(timer); }
}
