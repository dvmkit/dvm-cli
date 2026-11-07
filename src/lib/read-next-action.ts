import type { Message } from "@dvmkit/sdk/internal";
import { loadJob } from "./job-store";
import { computeNextAction, paymentInFlightHint, type NextAction, type PaymentPolicyContext } from "./next-action";
import { loadAnsweredYieldSeqs, pendingPaymentRequest } from "./yield-state";

export function readNextAction(
  jobId: string,
  messages: Message[],
  options: { ignoreLocalState?: boolean; context?: PaymentPolicyContext } = {}
): NextAction {
  const answered = options.ignoreLocalState ? new Set<number>() : loadAnsweredYieldSeqs(jobId);
  const pending = messages.filter((message) => !answered.has(message.seq));
  const action = computeNextAction(jobId, pending, undefined, options.ignoreLocalState ? undefined : options.context);
  if (action?.type !== "pay" || options.ignoreLocalState) return action;
  const request = pendingPaymentRequest(pending);
  const held = loadJob(jobId);
  if (request && held && (held.inFlightPaymentRequestSeqs?.includes(request.seq) ||
      held.unconfirmedPaymentSubmissions?.[request.seq] || held.askPaymentBlocks?.[request.seq]))
    return { ...action, hint: paymentInFlightHint(jobId, held, request.seq) };
  return action;
}
