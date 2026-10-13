import { computeNextAction, type NextAction } from "./next-action";
import {
  asProviderText,
  DvmError,
  isAbortError,
  type JobPolicy,
  type Message,
  type MessagePollOptions,
  type ProviderRef,
  type ProviderText,
  type StreamOptions,
  type StreamResult,
  type Transport,
} from "@dvmkit/sdk/internal";
import {
  loadJob,
} from "./job-store";

import {
  createMessageAppendSession,
  maxSeq,
  type MessageAppendSession,
} from "./messages";
import { paidConfirmationDisplay } from "./payment-copy";
import { handlePaymentRequest, type PaidPaymentResult } from "./payment-responder";
import { claimInboundPayments, type RefundClaim, refundNextAction } from "./refund-claim";

export interface StreamLoopOptions {
  jobId: string;
  transport: Transport;
  provider: ProviderRef;
  policy?: JobPolicy;
  afterSeq: number;
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
  // seqs of payment-requests this stream auto-paid. Used after the
  // loop to guarantee we never re-surface `pay` for a request already settled.
  const autoPaidSeqs = new Set<number>();
  // True iff the last non-empty batch ended in a successful auto-payment. When
  // that batch's follow-up poll comes back empty (the completion raced the poll
  // across machines), this gates a final re-check before computing next_action.
  let justAutoPaid = false;
  let cursor = opts.afterSeq;
  let messageAppendSession = opts.messageAppendSession;
  // when the caller didn't pass an explicit jobToken, fall back to
  // the one persisted on the local job record. Lets request.ts → streamToCompletion
  // and the payment-rail helpers (payWithLightning / payWithCashu) reach the
  // token without manually threading it down four call levels.
  const jobToken = opts.jobToken ?? loadJob(jobId)?.jobToken;
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
          onMessage: opts.onMessage,
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
        batchMessages = result.messages;
      } else {
        const pollOptions = nextPollOptions();
        if (!pollOptions) break;
        try {
          batchMessages = await transport.getMessages(jobId, cursor, provider, pollOptions);
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

      const lastYield = findLastYield(batchMessages);
      if (lastYield?.type === "payment-request" && policy) {
        const req = lastYield.content;
        if (
          req.amount_msats <= policy.autoPayBelowMsats &&
          (policy.maxIncrementMsats === 0 || req.amount_msats <= policy.maxIncrementMsats)
        ) {
          const result = await handlePaymentRequest(jobId, req, policy, transport, provider, {
            jobToken,
          });
          if (typeof result === "object") {
            autoPayments.push({
              amount_msats: result.amountMsats,
              rail: result.rail,
              reason: asProviderText(req.reason),
              ...(result.amountUsdcMicro !== undefined && {
                amount_usdc_microunits: result.amountUsdcMicro,
              }),
              display: paidConfirmationDisplay(result, req.fiat_amount),
            });
            autoPaidSeqs.add(lastYield.seq);
            justAutoPaid = true;
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
        recheck = await transport.getMessages(jobId, cursor, provider, pollOptions);
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

  let nextAction = refundNextAction(jobId, refunds) ?? computeNextAction(jobId, allMessages);

  // never tell the caller to pay a request this stream already
  // auto-paid. If next_action still resolves to `pay` for an auto-paid
  // payment-request (the re-check above also raced the completion), surface a
  // poll instead so an agent following next_action verbatim never re-pays a
  // completed job into a 409. A *new, distinct* request (e.g. a second surcharge
  // above the auto-pay threshold) has a seq outside `autoPaidSeqs`, so its `pay`
  // is left untouched.
  if (nextAction?.type === "pay") {
    const lastYield = findLastYield(allMessages);
    if (lastYield?.type === "payment-request" && autoPaidSeqs.has(lastYield.seq)) {
      nextAction = {
        type: "poll",
        job_id: jobId,
        hint: `Payment already sent for this request; the provider is finalising. Poll the result with 'dvm messages ${jobId}' — do not pay again.`,
      };
    }
  }

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
