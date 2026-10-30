import { withJobPaymentLock } from "./payment-lock";
import { computeNextAction, paymentInFlightHint, pollNextAction, type NextAction } from "./next-action";
import {
  asProviderText,
  DvmError,
  isAbortError,
  shellQuoteArg,
  type JobPolicy,
  type JobStatus,
  type Message,
  type MessagePollOptions,
  type PaymentRequestContent,
  type ProviderRef,
  type ProviderText,
  type StreamOptions,
  type StreamResult,
  type Transport,
} from "@dvmkit/sdk/internal";
import {
  loadJob,
  markPaymentRequestPaid,
} from "./job-store";

import {
  createMessageAppendSession,
  maxSeq,
  type MessageAppendSession,
} from "./messages";
import { answeredYieldSeqs, loadAnsweredYieldSeqs, pendingPaymentRequest, reconcileInFlightPaymentRequest } from "./yield-state";
import { paidConfirmationDisplay } from "./payment-copy";
import { handlePaymentRequest, type PaymentResult, type PaidPaymentResult } from "./payment-responder";
import { claimInboundPayments, type RefundClaim, withRefundNextAction } from "./refund-claim";

export interface StreamLoopOptions {
  jobId: string;
  transport: Transport;
  provider: ProviderRef;
  policy?: JobPolicy;
  afterSeq: number;
  /** An explicit caller cursor must never be rewound to an older yield. */
  afterSeqExplicit?: boolean;
  onMessage?: (msg: Message) => void;
  /** Timeout in milliseconds. If exceeded, returns whatever has been collected. */
  timeoutMs?: number;
  /**
   * Whether messages, refund claims, and policy-driven payments may update local
   * state. Endpoint-overridden follow-ups set this false so one provider's
   * response cannot be filed under another provider's stored job.
   */
  persistLocalState?: boolean;
  /** Reusable journal state for callers that re-enter the loop while polling. */
  messageAppendSession?: MessageAppendSession;
  /**
   * opaque per-job token issued at create-time for anonymous
   * callers. Threaded into the `stream` / `getMessages` calls and into the
   * payment-responder so any auto-pay POST also carries it as
   * `X-Job-Token`.
   */
  jobToken?: string;
}

export interface StreamLoopResult {
  providerStatus?: JobStatus;
  messages: Message[];
  /**
   * Provider-facing payment-request reasons that the CLI auto-paid during this
   * stream. Surfaced to JSON output as `auto_payments` (omitted when empty) so
   * agents can audit and relay each auto-debit to the human. `reason` is wrapped
   * as ProviderText.
   */
  autoPayments: AutoPayment[];
  /**
   * Inbound provider payments (Cashu refund/change) auto-claimed into the local
   * wallet during this stream. Each entry records the outcome; a `claimed: false`
   * entry retains the raw token for manual recovery.
   */
  refunds: RefundClaim[];
  nextAction: NextAction;
  cursor: number;
}

export interface AutoPayment {
  amount_msats: number;
  rail: PaidPaymentResult["rail"];
  reason: ProviderText;
  /** Exact signed x402 value in USDC microunits. */
  amount_usdc_microunits?: string;
  /** Human-friendly confirmation suitable for relaying verbatim. */
  display: string;
}

/**
 * Stream messages from a provider until yield. If a payment-request arrives
 * below the auto-pay threshold, pay it automatically and continue streaming.
 * Returns when the provider yields for a non-auto-payable reason.
 */
export async function streamLoop(opts: StreamLoopOptions): Promise<StreamLoopResult> {
  const { jobId, transport, provider } = opts;
  const persistLocalState = opts.persistLocalState !== false;
  const policy = persistLocalState ? opts.policy : undefined;
  const allMessages: Message[] = [];
  const autoPayments: AutoPayment[] = [];
  const refunds: RefundClaim[] = [];
  // Include durable answers so reconnects and fresh processes cannot re-pay.
  const answeredSeqs = persistLocalState ? loadAnsweredYieldSeqs(jobId) : new Set<number>();
  // True iff the last non-empty batch ended in a successful auto-payment. When
  // that batch's follow-up poll comes back empty (the completion raced the poll
  // across machines), this gates a final re-check before computing next_action.
  let justAutoPaid = false;
  let paymentUnresolved = false;
  let cursor = opts.afterSeq;
  let messageAppendSession = opts.messageAppendSession;
  // when the caller didn't pass an explicit jobToken, fall back to
  // the one persisted on the local job record. Lets request.ts → streamToCompletion
  // and the payment-rail helpers (payWithLightning / payWithCashu) reach the
  // token without manually threading it down four call levels.
  const jobToken = opts.jobToken ?? loadJob(jobId)?.jobToken;
  function recordAutoPayment(result: PaidPaymentResult, request: PaymentRequestContent, seq: number): void {
    autoPayments.push({
      amount_msats: result.amountMsats,
      rail: result.rail,
      reason: asProviderText(request.reason),
      ...(result.amountUsdcMicro !== undefined && { amount_usdc_microunits: result.amountUsdcMicro }),
      display: paidConfirmationDisplay(result, request.fiat_amount),
    });
    if (persistLocalState) markPaymentRequestPaid(jobId, seq);
    answeredSeqs.add(seq);
    justAutoPaid = true;
  }
  let pendingAction: NextAction = null;
  const pending = persistLocalState ? loadJob(jobId)?.pendingCreditPayment : undefined;
  if (pending && policy) {
    let result: PaymentResult;
    try {
      result = await handlePaymentRequest(jobId, pending.request, policy, transport, provider, {
        jobToken, requestSeq: pending.authorization.request_seq,
      });
    } catch (error) {
      if (error instanceof DvmError && error.code === "payment_settling")
        return { messages: [], autoPayments, refunds, cursor, nextAction: pollNextAction(jobId, paymentInFlightHint(jobId)) };
      throw error;
    }
    if (typeof result === "object") recordAutoPayment(result, pending.request, pending.authorization.request_seq);
    else pendingAction = computeNextAction(jobId, [{
      seq: pending.authorization.request_seq, from: "provider", timestamp: 0,
      type: "payment-request", content: pending.request,
    }], undefined, policy ? { policy, totalPaidMsats: loadJob(jobId)?.totalPaidMsats } : undefined);
  }
  const deadline =
    opts.timeoutMs === undefined ? undefined : Date.now() + Math.max(0, opts.timeoutMs);

  const nextPollOptions = (): MessagePollOptions | null => {
    if (deadline === undefined) return { jobToken };
    const timeoutMs = Math.floor(deadline - Date.now());
    return timeoutMs > 0 ? { timeoutMs, jobToken } : null;
  };

  let controller: AbortController | undefined;
  let timer: ReturnType<typeof setTimeout> | undefined;
  if (opts.timeoutMs !== undefined && opts.timeoutMs > 0) {
    controller = new AbortController();
    timer = setTimeout(() => {
      controller?.abort();
    }, opts.timeoutMs);
  }

  try {
    for (;;) {
      if (deadline !== undefined && Date.now() >= deadline) break;

      const streamFn = transport.stream?.bind(transport);
      let batchMessages: Message[];

      if (streamFn) {
        const streamOpts: StreamOptions = {
          onMessage: (message) => { if (message.seq > cursor) opts.onMessage?.(message); },
          signal: controller?.signal,
          jobToken,
        };
        let result: StreamResult;
        try {
          result = await streamFn(jobId, cursor, provider, streamOpts);
        } catch (err) {
          // When the timeout fires and fetch() hasn't received a response yet,
          // AbortError propagates from fetch rather than from reader.read()
          // (which parseSSEStream catches). Break gracefully so
          // streamToCompletion can synthesise a poll action.
          if (isAbortError(err) || (deadline !== undefined && isMessagePollTimeout(err))) break;
          throw err;
        }
        batchMessages = result.messages.filter((message) => message.seq > cursor);
      } else {
        const pollOptions = nextPollOptions();
        if (!pollOptions) break;
        try {
          batchMessages = (await transport.getMessages(jobId, cursor, provider, pollOptions))
            .filter((message) => message.seq > cursor);
        } catch (err) {
          if (deadline !== undefined && isMessagePollTimeout(err)) break;
          throw err;
        }
        for (const msg of batchMessages) {
          opts.onMessage?.(msg);
        }
      }

      if (batchMessages.length === 0) break;

      allMessages.push(...batchMessages);
      cursor = maxSeq(batchMessages, cursor);

      if (persistLocalState) {
        messageAppendSession ??= createMessageAppendSession(jobId);
        messageAppendSession.append(batchMessages);
      }

      // Auto-claim any inbound Cashu payment (refund/change) into the local wallet.
      if (persistLocalState) {
        refunds.push(...(await claimInboundPayments(jobId, batchMessages)));
      }

      justAutoPaid = false;

      if (persistLocalState) for (const seq of loadAnsweredYieldSeqs(jobId)) answeredSeqs.add(seq);
      for (const seq of answeredYieldSeqs(batchMessages)) answeredSeqs.add(seq);
      const pendingPayment = pendingPaymentRequest(batchMessages, answeredSeqs);
      const lastYield = findLastYield(batchMessages.filter((message) => !answeredSeqs.has(message.seq) &&
        (message.type !== "payment-request" || message.seq === pendingPayment?.seq)))
        ?? findLastYield(batchMessages);
      if (lastYield?.type === "payment-request" && answeredSeqs.has(lastYield.seq)) {
        if (persistLocalState) markPaymentRequestPaid(jobId, lastYield.seq);
        break;
      }
      if (lastYield?.type === "payment-request" && persistLocalState &&
          loadJob(jobId)?.inFlightPaymentRequestSeqs?.includes(lastYield.seq)) {
        const pollOptions = nextPollOptions();
        try {
          if (!pollOptions) paymentUnresolved = true;
          else if (await withJobPaymentLock(jobId, () => reconcileInFlightPaymentRequest(jobId, lastYield.seq, transport, provider, pollOptions))) {
            answeredSeqs.add(lastYield.seq);
            break;
          }
        } catch (error) {
          if (!isMessagePollTimeout(error) && !(error instanceof DvmError &&
              ["payment_settling", "payment_request_not_pending"].includes(error.code))) throw error;
          paymentUnresolved = true;
        }
        if (paymentUnresolved) {
          // Retry the read on reconnect, without retrying a payment POST.
          cursor = lastYield.seq - 1;
          break;
        }
      }
      if (lastYield?.type === "payment-request" && lastYield.seq === pendingPayment?.seq && policy) {
        const req = lastYield.content;
        if (
          req.amount_msats <= policy.autoPayBelowMsats &&
          (policy.maxIncrementMsats === 0 || req.amount_msats <= policy.maxIncrementMsats)
        ) {
          let result: PaymentResult;
          try {
            result = await handlePaymentRequest(jobId, req, policy, transport, provider, {
              jobToken, requestSeq: lastYield.seq,
            });
          } catch (error) {
            if (error instanceof DvmError && error.code === "payment_settling") {
              paymentUnresolved = true;
              break;
            }
            if (error instanceof DvmError && error.code === "payment_already_sent") {
              answeredSeqs.add(lastYield.seq);
              break;
            }
            throw error;
          }
          if (typeof result === "object") {
            recordAutoPayment(result, req, lastYield.seq);
            continue;
          }
          if (result === "payment-cap-exceeded") {
            const j = loadJob(jobId);
            const cap = policy.maxPayments;
            throw new DvmError(
              "payment_cap_exceeded",
              "Job has reached its maximum payment count.",
              `The provider has sent more payment-requests than --max-payments allows. Inspect with 'dvm messages ${jobId}' and 'dvm cancel ${jobId}' if unintended. Raise with '--max-payments ${cap + 1}' or investigate why this provider is asking for many small payments.`,
              {
                anchor: "max_payments_exceeded",
                display: `Payment cap reached (${cap} payment${cap === 1 ? "" : "s"})`,
                jobId,
                paymentsHonoured: j?.paymentsHonoured ?? 0,
                maxPayments: cap,
              }
            );
          }
        }
      }

      break;
    }
  } finally {
    if (timer) clearTimeout(timer);
  }

  // a mid-job surcharge resolves within ~1 s of being paid, and the
  // post-payment poll can land on a machine whose view lags the terminal write —
  // so the loop exits on an empty batch with `allMessages` still ending on the
  // request we just auto-paid. Do one final short re-check to pick up the
  // (usually already-written) completion before deriving next_action, recovering
  // the artifact in-band instead of leaving the caller to chase it via `dvm messages`.
  if (justAutoPaid) {
    const pollOptions = nextPollOptions();
    let recheck: Message[] = [];
    try {
      if (pollOptions) {
        recheck = (await transport.getMessages(jobId, cursor, provider, pollOptions))
          .filter((message) => message.seq > cursor);
      }
    } catch (err) {
      if (deadline === undefined || !isMessagePollTimeout(err)) throw err;
    }
    if (recheck.length > 0) {
      for (const msg of recheck) opts.onMessage?.(msg);
      allMessages.push(...recheck);
      cursor = maxSeq(recheck, cursor);
      if (persistLocalState) {
        messageAppendSession ??= createMessageAppendSession(jobId);
        messageAppendSession.append(recheck);
        refunds.push(...(await claimInboundPayments(jobId, recheck)));
      }
    }
  }

  if (persistLocalState) for (const seq of loadAnsweredYieldSeqs(jobId)) answeredSeqs.add(seq);
  for (const seq of answeredYieldSeqs(allMessages)) answeredSeqs.add(seq);
  const terminal = allMessages.some((msg) => msg.type === "complete" || msg.type === "cancel");
  const yieldAction = computeNextAction(jobId, allMessages.filter((message) => !answeredSeqs.has(message.seq)), undefined, policy ? { policy, totalPaidMsats: loadJob(jobId)?.totalPaidMsats } : undefined)
    ?? (terminal ? null : pendingAction);
  let nextAction = withRefundNextAction(jobId, yieldAction ?? (terminal ? null : pollNextAction(jobId)), refunds);

  const lastYield = findLastYield(allMessages);
  if (nextAction?.type === "pay" && lastYield?.type === "payment-request" && persistLocalState &&
      loadJob(jobId)?.inFlightPaymentRequestSeqs?.includes(lastYield.seq))
    nextAction = { ...nextAction, hint: paymentInFlightHint(jobId) };

  // A paid request can remain the last yield while the provider catches up.
  if (nextAction?.type === "pay" || (nextAction?.type === "poll" && !terminal)) {
    if (lastYield?.type === "payment-request" && answeredSeqs.has(lastYield.seq)) {
      nextAction = {
        type: "poll",
        job_id: jobId,
        hint: `Payment already sent for this request; the provider is finalising. Keep watching with \`dvm messages ${shellQuoteArg(jobId)} --wait\` — do not pay again.`,
      };
    }
  }

  if (paymentUnresolved) nextAction = pollNextAction(jobId, paymentInFlightHint(jobId));
  return { messages: allMessages, autoPayments, refunds, nextAction, cursor };
}

function isMessagePollTimeout(err: unknown): boolean {
  return isAbortError(err) || (err instanceof DvmError && err.code === "timeout");
}

function findLastYield(messages: Message[]): Message | undefined {
  const yieldTypes = new Set(["prompt", "payment-request", "working", "complete", "cancel"]);
  for (let i = messages.length - 1; i >= 0; i--) {
    if (yieldTypes.has(messages[i].type)) return messages[i];
  }
  return undefined;
}
