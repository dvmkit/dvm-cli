import type { Message, MessagePollOptions, ProviderRef, Transport } from "@dvmkit/sdk/internal";
import { clearPaymentRequestInFlight, loadJob, markPaymentRequestPaid } from "./job-store";
import { loadMessages } from "./messages";

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
  const history = await transport.getMessages(jobId, 0, provider, options);
  if (answeredYieldSeqs(history).has(requestSeq)) {
    markPaymentRequestPaid(jobId, requestSeq);
    return true;
  }
  clearPaymentRequestInFlight(jobId, requestSeq);
  return false;
}
