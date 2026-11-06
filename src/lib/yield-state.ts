import { DvmError, isAbortError, shellQuoteArg, type Message, type MessagePollOptions, type ProviderRef, type Transport } from "@dvmkit/sdk/internal";
import { clearPaymentRequestInFlight, loadJob, markPaymentRequestAnswered, type UnconfirmedPaymentSubmission } from "./job-store";
import { settleTakenPayment } from "./taken-payment";
import { applySubmissionVerdicts } from "./wallet-agent/submission-verdicts";
import { loadMessages } from "./messages";

export const JOB_READ_TIMEOUT_MS = 60_000;
// A lost send may still be processing before history records it. Give every
// rail 45 seconds before the same payment is sent again, including x402.
export const PAYMENT_SETTLE_WINDOW_MS = 45_000;

export function answeredYieldSeqs(messages: Message[]): Set<number> {
  const answered = new Set<number>();
  const prompts = new Map<string, number>();
  for (const message of [...messages].sort((a, b) => a.seq - b.seq)) {
    if (message.from === "provider") {
      if (message.type === "prompt") prompts.set(message.content.id, message.seq);
    } else if (message.type === "response") {
      const seq = prompts.get(message.content.prompt_id);
      if (seq !== undefined) answered.add(seq);
    }
  }
  for (const seq of paymentAnswers(messages).keys()) answered.add(seq);
  return answered;
}

/**
 * Requester payments by the ask they answer. Balance authorizations identify
 * the ask explicitly; older rail messages answer the preceding charge. Provider
 * payments are refunds, not answers.
 */
function paymentAnswers(messages: Message[]): Map<number, Message[]> {
  const answers = new Map<number, Message[]>();
  let paymentRequest: number | undefined;
  for (const message of [...messages].sort((a, b) => a.seq - b.seq)) {
    if (message.from === "provider" && message.type === "payment-request") paymentRequest = message.seq;
    else if (message.from !== "provider" && message.type === "payment") {
      const seq = message.content.credit?.request_seq ?? paymentRequest;
      if (seq !== undefined) answers.set(seq, [...answers.get(seq) ?? [], message]);
    }
  }
  return answers;
}

/**
 * A provider keeps a payment message's content as sent, so a recorded payment
 * carrying this submission's request id or exact credential is this payment.
 */
function carriesSubmission(content: Record<string, unknown>, submission: UnconfirmedPaymentSubmission): boolean {
  if (submission.rail === "cashu_p2pk") return content.cashu_request_id === submission.cashuRequestId;
  const key = submission.rail === "x402" ? "x402_payment" : "tempo_credential";
  return content[key] !== undefined && canonicalJson(content[key]) === canonicalJson(submission.content[key]);
}

function canonicalJson(value: unknown): string {
  if (Array.isArray(value)) return `[${value.map(canonicalJson).join(",")}]`;
  if (value && typeof value === "object")
    return `{${Object.keys(value).sort().map((key) => `${JSON.stringify(key)}:${canonicalJson((value as Record<string, unknown>)[key])}`).join(",")}}`;
  return JSON.stringify(value);
}

/**
 * Settle an ask that history shows a payment answered. The held submission is
 * booked only when one of those payments carries it; otherwise the ask is
 * marked answered and the submission, with its wallet entry, waits for the
 * sweep's spent or reclaimed verdict.
 */
export async function settleAnsweredAsk(jobId: string, requestSeq: number, history: Message[]): Promise<void> {
  const submission = loadJob(jobId)?.unconfirmedPaymentSubmissions?.[requestSeq];
  const payments = paymentAnswers(history).get(requestSeq) ?? [];
  if (submission && payments.some((payment) => carriesSubmission(payment.content as unknown as Record<string, unknown>, submission)))
    await settleTakenPayment(jobId, requestSeq);
  else markPaymentRequestAnswered(jobId, requestSeq);
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
  for (const seq of declinedAskSeqs(jobId)) answered.add(seq);
  return answered;
}

/** Asks and prompts the caller's confirmed decline answered; none of them was paid. */
export function declinedAskSeqs(jobId: string): Set<number> {
  return new Set(loadJob(jobId)?.callerDeclined ? declinedYieldSeqs(loadMessages(jobId)) : []);
}

/**
 * The ask and prompts a caller's decline answered. Only for a decline the
 * provider confirmed by ending the job: a DVM that predates decline keeps the
 * job open, and its ask must stay payable.
 */
function declinedYieldSeqs(messages: Message[]): number[] {
  const sorted = [...messages].sort((a, b) => a.seq - b.seq);
  const decline = sorted.findLast((message) => message.from === "requester" && message.type === "decline");
  if (!decline) return [];
  const before = sorted.filter((message) => message.from === "provider" && message.seq < decline.seq);
  const ask = before.findLast((message) => message.type === "payment-request");
  return [...(ask ? [ask.seq] : []), ...before.filter((message) => message.type === "prompt").map((message) => message.seq)];
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

export async function reconcilePaymentRequestHistory(
  jobId: string, requestSeq: number, history: Message[], status: string | undefined, now: () => number = Date.now
): Promise<boolean> {
  // The provider recorded a payment for this ask; book it only if it is this one.
  if (paymentAnswers(history).has(requestSeq)) {
    await settleAnsweredAsk(jobId, requestSeq, history);
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

/**
 * Settle every held ask the local message log shows a payment answered,
 * including one the job has moved past, and apply any sweep verdict for a
 * held token. Only payment messages count here, never a decline.
 */
export async function settleRecordedPayments(jobId: string): Promise<void> {
  await applySubmissionVerdicts().catch(() => undefined);
  const job = loadJob(jobId);
  const held = new Set([...(job?.inFlightPaymentRequestSeqs ?? []),
    ...Object.keys(job?.unconfirmedPaymentSubmissions ?? {}).map(Number)]);
  for (const seq of job?.paidPaymentRequestSeqs ?? []) held.delete(seq);
  if (held.size === 0) return;
  const history = loadMessages(jobId);
  const answers = paymentAnswers(history);
  for (const seq of held) if (answers.has(seq)) await settleAnsweredAsk(jobId, seq, history);
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
