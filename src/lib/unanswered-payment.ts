import { asProviderText, type Message, type Transport } from "@dvmkit/sdk/internal";
import type { ResolvedJobAccess } from "./job-access";
import { loadJob } from "./job-store";
import { appendMessages, loadMessages } from "./messages";
import { answeredYieldSeqs, loadAnsweredYieldSeqs } from "./yield-state";
import { formatPaymentAmount } from "./currency";
import { providerFields } from "./provider-output";

export async function readUnansweredPaymentRequest(
  jobId: string,
  status: string | undefined,
  access: ResolvedJobAccess,
  transport: Transport,
  options: { messages?: Message[]; fullHistory?: boolean; localOnly?: boolean; timeoutMs?: number } = {}
) {
  if (status !== "cancelled") return undefined;
  const job = access.endpointOverridden ? undefined : loadJob(jobId);
  if (job?.callerCancelled) return undefined;
  let history = options.messages ?? [];
  if (!options.localOnly && !options.fullHistory) {
    try {
      history = await transport.getMessages(jobId, 0, access.ref, {
        jobToken: access.jobToken, timeoutMs: options.timeoutMs ?? 5000,
      });
    } catch {
      // A failed history read cannot invalidate retained cancellation evidence.
    }
  }
  if (job) appendMessages(jobId, history);
  const log = (job ? loadMessages(jobId) : history).sort((a, b) => a.seq - b.seq);
  const ask = log.findLast((message) => message.from === "provider" && message.type === "payment-request");
  if (ask?.type !== "payment-request" || ask.content.amount_msats <= 0) return undefined;
  const answered = job ? loadAnsweredYieldSeqs(jobId) : answeredYieldSeqs(log);
  if (answered.has(ask.seq)) return undefined;
  // An unconfirmed send may still be taken; do not promise that this ask cost nothing.
  if (job?.inFlightPaymentRequestSeqs?.includes(ask.seq) || job?.unconfirmedPaymentSubmissions?.[ask.seq] ||
      job?.askPaymentBlocks?.[ask.seq] ||
      job?.pendingCreditPayment?.authorization.request_seq === ask.seq) return undefined;
  const expiresAtMs = ask.content.expires_at_ms;
  if (typeof expiresAtMs !== "number" || !Number.isSafeInteger(expiresAtMs) ||
      expiresAtMs < 0 || expiresAtMs > 8_640_000_000_000_000) return undefined;
  const ending = log.findLast((message) => message.type === "cancel" || message.type === "complete");
  // The SDK floors cancellation timestamps to seconds and normally cancels at
  // expiry. Include that same second, but qualify the cause rather than invent
  // subsecond ordering. completedAt is only when the CLI observed the ending.
  if (ending?.type !== "cancel" || ending.from !== "provider" || ending.seq <= ask.seq ||
      !Number.isFinite(ending.timestamp) || ending.timestamp < Math.floor(expiresAtMs / 1000)) return undefined;
  if (log.some((message) => message.seq > ask.seq && message.seq < ending.seq &&
      ((message.from === "provider" && message.type === "working") ||
       (message.from === "requester" && (message.type === "decline" || message.type === "cancel"))))) return undefined;
  const amount = formatPaymentAmount(ask.content.amount_msats, ask.content.fiat_amount, { anchor: false });
  return providerFields({
    seq: ask.seq,
    amount_msats: ask.content.amount_msats,
    ...(ask.content.fiat_amount ? { fiat_amount: ask.content.fiat_amount } : {}),
    ...(ask.content.credit ? { credit: ask.content.credit } : {}),
    reason: asProviderText(ask.content.reason),
    expires_at_ms: expiresAtMs,
    display: `The job appears to have stopped because payment ask #${ask.seq} went unanswered by its deadline (${new Date(expiresAtMs).toISOString()}). The provider asked for ${amount}, reason: ${JSON.stringify(ask.content.reason)}. Only charges paid before this ask were taken. Cancellation timestamps have one-second precision and do not establish when useful work stopped.`,
  }, ["seq", "amount_msats", "fiat_amount", "credit", "expires_at_ms"]);
}
