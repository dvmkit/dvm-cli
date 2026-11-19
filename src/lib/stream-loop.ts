import { paymentCreditChoice, type CreditedPaymentResult } from "./payment-credit";
import { MandateGuardReadError, mandateWindowAction } from "./mandate-wait";
import { isTransientJobReadError } from "./job-read-error";
import { hasUnsavedJobState } from "./job-persistence";
import { sameEndpoint } from "./provider-endpoint";
import { withJobPaymentLock } from "./payment-lock";
import { computeNextAction, paymentCountHint, paymentInFlightHint, pollNextAction, type NextAction, type PaymentPolicyContext } from "./next-action";
import type { JobBudgetPolicy } from "./job-budget";
import {
  asProviderText,
  DvmError,
  isAbortError,
  shellQuoteArg,
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
import { loadJob, markPaymentRequestAnswered, type JobRecord } from "./job-store";

import {
  createMessageAppendSession,
  loadMessages,
  maxSeq,
  type MessageAppendSession,
} from "./messages/index";
import { answeredYieldSeqs, declinedAskSeqs, loadAnsweredYieldSeqs, pendingPaymentRequest, reconcileInFlightPaymentRequest, settleAnsweredAsk, settleRecordedPayments } from "./yield-state";
import { paidConfirmationDisplay } from "./payment-copy";
import { handlePaymentRequest, type PaymentResult, type PaidPaymentResult } from "./payment-responder";
import { claimInboundPayments, type RefundClaim, withRefundNextAction } from "./refund-claim";

export interface StreamLoopOptions {
  jobId: string;
  /** Waits reconnect failed reads until their outer deadline. Never applies to sends. */
  retryUnreachableReads?: boolean;
  transport: Transport;
  provider: ProviderRef;
  policy?: JobBudgetPolicy;
  afterSeq: number;
  /** An explicit caller cursor must never be rewound to an older yield. */
  afterSeqExplicit?: boolean;
  onMessage?: (msg: Message) => void;
  /** Called once per auto-payment this loop sends, after it is booked, with the ask's seq. */
  onAutoPayment?: (payment: AutoPayment, requestSeq: number) => void;
  /** Timeout in milliseconds. If exceeded, returns whatever has been collected. */
  timeoutMs?: number;
  /** Remaining wait budget, capped by the read timeout, checked before each mandate guard read. */
  mandateReadTimeoutMs?: () => number;
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
  /** A payment this read sent or found is still unresolved; `nextAction` carries its hint. */
  paymentInFlight?: boolean;
}

export interface AutoPayment {
  seq?: number;
  mandate?: boolean;
  amount?: { amount_micro: number; currency: string; display: string };
  total_micro?: number;
  budget_micro?: number;
  overcharged?: boolean;
  violated_limits?: string[];
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
  const recoverableRead = (error: unknown) => opts.retryUnreachableReads
    ? isTransientJobReadError(error) : isMessagePollTimeout(error);
  if (hasUnsavedJobState()) return {
    messages: [], autoPayments: [], refunds: [], cursor: opts.afterSeq,
    nextAction: pollNextAction(jobId, "Local state may lag; refresh this job before another payment."),
  };
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
  let paymentWaitAction: NextAction = null;
  const landedUnconfirmedAction = (): NextAction => pollNextAction(jobId,
    `The payment landed as provider credit, but the charge's current state could not be confirmed. Keep watching with \`dvm messages ${shellQuoteArg(jobId)} --wait\`; no new rail payment will be sent for this charge.`);
  let creditChoiceAction: NextAction = null;
  let cursor = opts.afterSeq;
  let messageAppendSession = opts.messageAppendSession;
  // when the caller didn't pass an explicit jobToken, fall back to
  // the one persisted on the local job record. Lets request.ts → streamToCompletion
  // and the payment-rail helpers (payWithLightning / payWithCashu) reach the
  // token without manually threading it down four call levels.
  const jobToken = opts.jobToken ?? loadJob(jobId)?.jobToken;
  const paymentOptions = { jobToken, useStoredPolicy: true, mandateReadTimeoutMs: opts.mandateReadTimeoutMs };
  // A decline the provider confirmed ended the job, even when its message is not in this batch.
  const declined = () => persistLocalState && loadJob(jobId)?.callerDeclined === true;
  async function recordAutoPayment(result: PaidPaymentResult | CreditedPaymentResult, request: PaymentRequestContent, seq: number): Promise<void> {
    if (result.status === "credited") {
      if (result.credit.ask_answered) {
        answeredSeqs.add(seq);
        justAutoPaid = true;
      }
      return;
    }
    const payment: AutoPayment = {
      amount_msats: result.amountMsats,
      rail: result.rail,
      reason: asProviderText(request.reason),
      ...(result.amountUsdcMicro !== undefined && { amount_usdc_microunits: result.amountUsdcMicro }),
      display: paidConfirmationDisplay(result, request.fiat_amount),
    };
    autoPayments.push(payment);
    // The payer already booked what it sent; this only records the ask answered.
    if (persistLocalState) markPaymentRequestAnswered(jobId, seq);
    answeredSeqs.add(seq);
    justAutoPaid = true;
    opts.onAutoPayment?.(payment, seq);
  }
  let pendingAction: NextAction = null;
  const pending = persistLocalState ? loadJob(jobId)?.pendingCreditPayment : undefined;
  if (pending && policy) {
    let result: PaymentResult | undefined;
    try {
      result = await handlePaymentRequest(jobId, pending.request, policy, transport, provider, {
        ...paymentOptions, requestSeq: pending.authorization.request_seq,
      });
    } catch (error) {
      if (error instanceof MandateGuardReadError)
        return { messages: [], autoPayments, refunds, cursor, nextAction: pollNextAction(jobId) };
      if (error instanceof DvmError && error.code === "payment_already_sent") answeredSeqs.add(pending.authorization.request_seq);
      else if (error instanceof DvmError && ["payment_settling", "payment_request_not_pending"].includes(error.code))
        return { messages: [], autoPayments, refunds, cursor, paymentInFlight: true,
          nextAction: error.data?.mandate_wait ? { type: "poll", job_id: jobId,
            display: String(error.data.display ?? error.message), hint: error.hint ?? error.message }
            : pollNextAction(jobId, paymentInFlightHint(jobId, loadJob(jobId), pending.authorization.request_seq)) };
      else throw error;
    }
    if (typeof result === "object") await recordAutoPayment(result, pending.request, pending.authorization.request_seq);
    else if (result !== undefined) pendingAction = computeNextAction(jobId, [{
      seq: pending.authorization.request_seq, from: "provider", timestamp: 0,
      type: "payment-request", content: pending.request,
    }], undefined, policy ? budgetContext(policy, loadJob(jobId)) : undefined);
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
      if (hasUnsavedJobState() || (deadline !== undefined && Date.now() >= deadline)) break;

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
          if (isAbortError(err) || (deadline !== undefined && recoverableRead(err))) break;
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
          if (deadline !== undefined && recoverableRead(err)) break;
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
        // Book a payment whose answer was lost but the provider recorded,
        // even when the job has moved past its ask.
        await settleRecordedPayments(jobId);
        if (hasUnsavedJobState()) break;
      }

      // Auto-claim any inbound Cashu payment (refund/change) into the local wallet.
      if (persistLocalState) {
        refunds.push(...(await claimInboundPayments(jobId, batchMessages)));
        if (hasUnsavedJobState()) break;
      }

      justAutoPaid = false;

      if (persistLocalState) for (const seq of loadAnsweredYieldSeqs(jobId)) answeredSeqs.add(seq);
      for (const seq of answeredYieldSeqs(batchMessages)) answeredSeqs.add(seq);
      const pendingPayment = pendingPaymentRequest(batchMessages, answeredSeqs);
      const lastYield = findLastYield(batchMessages.filter((message) => !answeredSeqs.has(message.seq) &&
        (message.type !== "payment-request" || message.seq === pendingPayment?.seq)))
        ?? findLastYield(batchMessages);
      if (lastYield?.type === "payment-request" && answeredSeqs.has(lastYield.seq)) {
        // A declined ask was not paid; any other answer books only what history proves.
        if (persistLocalState && !declinedAskSeqs(jobId).has(lastYield.seq))
          await settleAnsweredAsk(jobId, lastYield.seq, loadMessages(jobId));
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
          if (!recoverableRead(error) && !(error instanceof DvmError &&
              ["payment_settling", "payment_request_not_pending"].includes(error.code))) throw error;
          paymentUnresolved = true;
        }
        if (paymentUnresolved) {
          // Retry the read on reconnect, without retrying a payment POST.
          cursor = lastYield.seq - 1;
          break;
        }
      }
      const stopRequested = persistLocalState && loadJob(jobId)?.stopRequested === true;
      if (lastYield?.type === "payment-request" && lastYield.seq === pendingPayment?.seq && (policy || stopRequested) && !declined()) {
        const req = lastYield.content;
        const activePolicy = (persistLocalState ? loadJob(jobId)?.policy ?? policy : policy) ?? { maxTotalMsats: 0, maxIncrementMsats: 0, autoPayBelowMsats: 0, maxPayments: 0 };
        if (
          stopRequested || (req.amount_msats <= activePolicy.autoPayBelowMsats &&
          (activePolicy.maxIncrementMsats === 0 || req.amount_msats <= activePolicy.maxIncrementMsats))
        ) {
          let result: PaymentResult;
          try {
            result = await handlePaymentRequest(jobId, req, activePolicy, transport, provider, {
              ...paymentOptions, requestSeq: lastYield.seq,
            });
            // A landing is not a refusal by the bound credit. The durable rail
            // guard lets this follow-up try credit without another rail spend.
            if (typeof result === "object" && result.status === "credited" && result.credit.ask_open)
              result = await handlePaymentRequest(jobId, req, activePolicy, transport, provider, {
                ...paymentOptions, requestSeq: lastYield.seq,
              });
          } catch (error) {
            if (error instanceof MandateGuardReadError) {
              // Reconnect behind the ask so the guard can recheck it after releasing the payment lock.
              paymentWaitAction = pollNextAction(jobId);
              cursor = Math.min(cursor, lastYield.seq - 1);
              break;
            }
            if (error instanceof DvmError && error.code === "payment_credit_choice_required") {
              creditChoiceAction = paymentCreditChoice(jobId, lastYield.seq, req, false) ?? null;
              cursor = Math.min(cursor, lastYield.seq - 1);
              break;
            }
            if (error instanceof DvmError && ["payment_settling", "payment_unconfirmed", "payment_unapplied", "payment_request_not_pending"].includes(error.code)) {
              paymentUnresolved = true;
              if (error.data?.mandate_wait) paymentWaitAction = { type: "poll", job_id: jobId,
                display: String(error.data.display ?? error.message), hint: error.hint ?? error.message };
              const landed = error.code === "payment_settling" && Object.values(loadJob(jobId)?.paymentCreditLandings ?? {})
                .some((entry) => entry.request_seq === lastYield.seq && provider.endpoint && sameEndpoint(entry.endpoint, provider.endpoint));
              if (landed) paymentWaitAction = landedUnconfirmedAction();
              // The ask stays open; a reconnect must read it again.
              if (landed || ["payment_unconfirmed", "payment_unapplied"].includes(error.code) || loadJob(jobId)?.mandate) cursor = Math.min(cursor, lastYield.seq - 1);
              break;
            }
            if (error instanceof DvmError && error.code === "payment_already_sent") {
              answeredSeqs.add(lastYield.seq);
              break;
            }
            throw error;
          }
          if (typeof result === "object") {
            await recordAutoPayment(result, req, lastYield.seq);
            if (result.status === "credited" && !result.credit.ask_answered) {
              // Leave the open charge for the next payer invocation, rather
              // than repeatedly funding it in this same read.
              cursor = Math.min(cursor, lastYield.seq - 1);
              if (!result.credit.ask_open) {
                paymentUnresolved = true;
                paymentWaitAction = landedUnconfirmedAction();
              }
              break;
            }
            continue;
          }
          if (result === "payment-cap-exceeded") {
            const j = loadJob(jobId);
            const cap = activePolicy.maxPayments;
            throw new DvmError(
              "payment_cap_exceeded",
              "Job has reached its maximum payment count.",
              paymentCountHint(jobId, cap),
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
  if (justAutoPaid && !hasUnsavedJobState()) {
    const pollOptions = nextPollOptions();
    let recheck: Message[] = [];
    try {
      if (pollOptions) {
        recheck = (await transport.getMessages(jobId, cursor, provider, pollOptions))
          .filter((message) => message.seq > cursor);
      }
    } catch (err) {
      if (deadline === undefined || !recoverableRead(err)) throw err;
    }
    if (recheck.length > 0) {
      for (const msg of recheck) opts.onMessage?.(msg);
      allMessages.push(...recheck);
      cursor = maxSeq(recheck, cursor);
      if (persistLocalState) {
        messageAppendSession ??= createMessageAppendSession(jobId);
        messageAppendSession.append(recheck);
        await settleRecordedPayments(jobId);
        refunds.push(...(await claimInboundPayments(jobId, recheck)));
      }
    }
  }

  if (persistLocalState) for (const seq of loadAnsweredYieldSeqs(jobId)) answeredSeqs.add(seq);
  for (const seq of answeredYieldSeqs(allMessages)) answeredSeqs.add(seq);
  const terminal = allMessages.some((msg) => msg.type === "complete" || msg.type === "cancel") || declined();
  const yieldAction = computeNextAction(jobId, allMessages.filter((message) => !answeredSeqs.has(message.seq)), undefined, policy ? budgetContext(policy, loadJob(jobId)) : undefined)
    ?? (terminal ? null : pendingAction);
  let nextAction = withRefundNextAction(jobId, yieldAction ?? (terminal ? null : pollNextAction(jobId)), refunds);

  const lastYield = findLastYield(allMessages);
  const heldJob = persistLocalState ? loadJob(jobId) : null;
  if (nextAction?.type === "pay" && lastYield?.type === "payment-request" && heldJob &&
      (heldJob.inFlightPaymentRequestSeqs?.includes(lastYield.seq) || heldJob.unconfirmedPaymentSubmissions?.[lastYield.seq] ||
        heldJob.askPaymentBlocks?.[lastYield.seq]))
    nextAction = { ...nextAction, hint: paymentInFlightHint(jobId, heldJob, lastYield.seq) };

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

  if (paymentWaitAction || paymentUnresolved) nextAction = paymentWaitAction ?? pollNextAction(jobId, paymentInFlightHint(jobId, heldJob,
    lastYield?.type === "payment-request" ? lastYield.seq : undefined));
  if (!paymentUnresolved && nextAction?.type === "pay" && lastYield?.type === "payment-request" && persistLocalState)
    nextAction = mandateWindowAction(jobId, lastYield.content, lastYield.seq) ?? nextAction;
  if (!paymentUnresolved && !terminal && nextAction?.type === "pay" && lastYield?.type === "payment-request" && persistLocalState)
    nextAction = creditChoiceAction ?? paymentCreditChoice(jobId, lastYield.seq, lastYield.content) ?? nextAction;
  if (hasUnsavedJobState() && !terminal)
    nextAction = pollNextAction(jobId, "Local state may lag; refresh this job before another payment.");
  return { messages: allMessages, autoPayments, refunds, nextAction, cursor, ...(paymentUnresolved && { paymentInFlight: true }) };
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

function budgetContext(policy: JobBudgetPolicy, job: JobRecord | null): PaymentPolicyContext {
  return { policy: job?.policy ?? policy, paymentsHonoured: job?.paymentsHonoured, totalPaidMsats: job?.totalPaidMsats, paidUsdMicro: job?.paidUsdMicro, paidUsdMsats: job?.paidUsdMsats,
    budgetRefusals: job?.budgetRefusals };
}
