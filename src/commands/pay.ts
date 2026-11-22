import { observedSettlementFields, renderSettlementHuman } from "../lib/receipt-capture";
import { providerCurrency } from "../lib/provider-currency";
import { observeJobContent } from "../lib/job-content";
import { providerJobJson } from "../lib/provider-output";
import { type PaymentRailKey, paymentRailLabel } from "../lib/rail-labels";
import { formatPaymentAmount } from "../lib/currency";
import { formatMicro } from "../lib/piece-settlement";
import { buildCompletionHintFields, completionFromMessages, nextStepHint } from "../lib/completion-hints";
import {
  asProviderText,
  DvmError,
  loadAgentWallet,
  type PaymentRequestContent,
  type RailFlag,
} from "@dvmkit/sdk/internal";
import {
  connectedTempoAccount,
} from "../lib/payment-rails/tempo-wallet";
import {
  info,
  withOutputWarnings,
} from "../lib/output";
import {
  loadX402Wallet,
} from "../lib/x402/wallet";
import {
  loadJob,
  updateJob,
} from "../lib/job-store";

import { takeCreditNoticeFields } from "../lib/credit-notice";
import { formatIdentifier } from "../lib/dvm-identifier";
import { takeFeedbackNoticeFields } from "../lib/feedback-notice";
import { noteFeedbackAfterTerminal } from "../lib/feedback-nudges";
import { parseForcedRail } from "../lib/forced-rail";
import {
  type JobAccessOptions,
  type ResolvedStoredJobAccess,
  resolveStoredJobAccess,
  sameEndpoint,
  withJobTokenRedaction,
} from "../lib/job-access";
import { loadMessages } from "../lib/messages/index";
import { isTerminalJobStatus, overBudgetHint, paymentCountHint } from "../lib/next-action";
import { describeBudgetOverrun } from "../lib/job-budget";
import { JOB_READ_TIMEOUT_MS, pendingPaymentRequest, reconcileInFlightPaymentRequest } from "../lib/yield-state";
import { applyMintPin } from "../lib/mint-pin";
import { paidConfirmationDisplay } from "../lib/payment-copy";
import { handlePaymentRequest, type PaidPaymentResult } from "../lib/payment-responder";
import { finalizeProgressLine } from "../lib/progress-bar";
import { createArtifactSaveSession } from "../lib/save-artifact";
import { streamLoop } from "../lib/stream-loop";
import { persistStreamOutcome, streamTerminalStatus } from "../lib/stream-outcome";
import { createDvmTransport } from "../lib/transport/index";
import { dvmIdentity } from "./dvm-identity";
import { formatMessageHuman, serializeMessageForOutput } from "./messages";

export interface PayOptions extends JobAccessOptions {
  human?: boolean;
  auto?: boolean;
  seq?: string;
  /** Human-approved replacement for the job's total spending cap. */
  budget?: string;
  /** Timeout in seconds for streaming (default: 30) */
  timeout?: string;
  /**
   * Pin the Cashu spend mint for this payment. Overrides any mint
   * pinned at request time. Persisted onto the job so subsequent legs honour it.
   */
  mint?: string;
  /** Force this payment request onto one rail, with no fallback. */
  rail?: string;
  /** Refuse Cashu proof selection above this exact principal ceiling. */
  maxCashuPrincipalSats?: string;
}

export async function pay(jobId: string, opts: PayOptions): Promise<void> {
  const access = resolveStoredJobAccess(jobId, opts);
  return withJobTokenRedaction(access.jobToken, () => withOutputWarnings(() => payWithAccess(jobId, opts, access), opts.human));
}

async function payWithAccess(
  jobId: string,
  opts: PayOptions,
  access: ResolvedStoredJobAccess
): Promise<void> {
  const requestedSeq = opts.seq === undefined ? undefined : Number(opts.seq);
  if (opts.seq !== undefined && (!/^\d+$/.test(opts.seq) || !Number.isSafeInteger(requestedSeq)))
    throw new DvmError("invalid_arguments", "Pass a valid payment request sequence.");
  if (opts.auto && opts.budget !== undefined)
    throw new DvmError("invalid_arguments", "--auto cannot approve a new budget.");
  const rail = parseForcedRail(opts.rail);
  const maxCashuPrincipalSats = parsePositiveCashuSats(opts.maxCashuPrincipalSats);
  if (maxCashuPrincipalSats !== undefined && rail !== "cashu") {
    throw new DvmError(
      "cashu_principal_ceiling_requires_cashu",
      "--max-cashu-principal-sats requires --rail cashu.",
      "Force the Cashu rail or omit the Cashu-specific ceiling."
    );
  }
  const artifactSession = opts.human ? createArtifactSaveSession() : undefined;
  const { stored, ref, jobToken } = access;
  if (stored.mandate?.approvedCaps && opts.budget !== undefined && requestedSeq === undefined)
    throw new DvmError("invalid_arguments", "A new budget on this job requires a specific payment request sequence.");

  const json = (data: Record<string, unknown>) => providerJobJson(data, !!stored);

  const msgs = loadMessages(jobId);
  const pending = stored.pendingCreditPayment;
  const transport = createDvmTransport();
  const inFlightMessage = msgs.findLast((message) => message.from === "provider" &&
    message.type === "payment-request" && stored.inFlightPaymentRequestSeqs?.includes(message.seq));
  let paymentMessage = pendingPaymentRequest(msgs) ?? inFlightMessage;
  // Recovery must retain the original intent when a send may have succeeded.
  // New debits use provider history without consuming the ordinary read cursor.
  const recovering = pending || (paymentMessage && stored.inFlightPaymentRequestSeqs?.includes(paymentMessage.seq));
  if (!recovering) {
    try {
      const readOptions = { jobToken, timeoutMs: JOB_READ_TIMEOUT_MS };
      const snapshot = await transport.status(jobId, ref, readOptions);
      const history = snapshot.status === "awaiting-input"
        ? await transport.getMessages(jobId, 0, ref, readOptions)
        : [];
      paymentMessage = pendingPaymentRequest(history);
    } catch (error) {
      transport.close();
      throw error;
    }
  }
  const inactiveRequest = isTerminalJobStatus(stored.status) ||
    (paymentMessage?.type === "payment-request" && paymentMessage.content.expires_at_ms !== undefined &&
      paymentMessage.content.expires_at_ms <= Date.now());
  if (!pending && inactiveRequest) {
    // Acceptance can arrive after expiry. Record it before refusing any new debit.
    if (paymentMessage && stored.inFlightPaymentRequestSeqs?.includes(paymentMessage.seq) &&
        ref.endpoint && sameEndpoint(stored.endpoint, ref.endpoint)) {
      try {
        await reconcileInFlightPaymentRequest(jobId, paymentMessage.seq, transport, ref, { jobToken });
      } catch (error) {
        transport.close();
        throw error;
      }
    }
    paymentMessage = undefined;
  }
  const paymentReq = pending?.request ?? (paymentMessage?.type === "payment-request" ? paymentMessage.content : undefined);
  const requestSeq = pending?.authorization.request_seq ?? paymentMessage?.seq;
  if (requestedSeq !== undefined && requestedSeq !== requestSeq) {
    transport.close();
    throw new DvmError("payment_request_not_pending", `Charge ${requestedSeq} is no longer the open payment request.`,
      "Check dvm messages before approving a different charge.");
  }
  if (!paymentReq) {
    transport.close();
    throw new DvmError(
      "no_payment_pending",
      "No pending payment request found for this job.",
      "Use 'dvm messages' to check the job's state."
    );
  }

  // Persist any `--mint` override before paying so the spend path and
  // streamLoop both read the same pin off the job record. Validate
  // against this payment-request's advertised mints *before* writing the field
  // — otherwise a bad pin poisons the job: it would be persisted, throw, and
  // every subsequent `dvm pay <job>` (even without --mint) would re-read the
  // bad pin and re-fail, stranding the job.
  if (opts.mint) {
    applyMintPin(paymentReq.mints ?? [], opts.mint);
    updateJob(jobId, { pinnedMint: opts.mint });
  }

  if (!stored.policy) {
    throw new DvmError(
      "no_budget",
      "Cannot pay — this job has no spending policy.",
      'Resubmit with --budget and --max-payments. Set a default budget with: dvm wallet setup --default-budget "$1"'
    );
  }

  // Explicit pay approves this ask; the locally priced native debit must still
  // fit the hard increment/total caps rather than the provider's msat proxy.
  const approval = opts.auto || (stored.mandate?.approvedCaps && requestedSeq === undefined)
    ? "auto" : "explicit";
  const payPolicy = approval === "explicit" ? { ...stored.policy, autoPayBelowMsats: stored.policy.maxTotalMsats } : stored.policy;

  // No cost anchor: the caller reached `dvm pay` by deciding this charge was
  // worth it, so "fraction of a cent" here is noise rather than orientation.
  info(
    `Paying ${formatPaymentAmount(paymentReq.amount_msats, paymentReq.fiat_amount, { anchor: false })}...`
  );
  // anonymous-flow per-job token threaded through the `payment`
  // POST and the follow-up streamLoop's reads.
  let result = await handlePaymentRequest(jobId, paymentReq, payPolicy, transport, ref, {
    jobToken,
    rail,
    maxCashuPrincipalSats,
    requestSeq,
    approval,
    creditRecoveryOnly: pending !== undefined,
    budget: opts.budget,
    useStoredPolicy: true,
  });
  if (typeof result === "object" && result.status === "credited" && result.credit.ask_open)
    result = await handlePaymentRequest(jobId, paymentReq, payPolicy, transport, ref, {
      jobToken, requestSeq, approval, useStoredPolicy: true,
    });

  if (result === "over-budget") {
    transport.close();
    const refusal = requestSeq === undefined ? undefined : loadJob(jobId)?.budgetRefusals?.[String(requestSeq)];
    const current = loadJob(jobId);
    const countHint = current?.policy && (current.paymentsHonoured ?? 0) >= current.policy.maxPayments
      ? paymentCountHint(jobId, current.policy.maxPayments) : undefined;
    throw new DvmError("over_budget", "Payment would exceed the job's budget.",
      countHint ?? (refusal ? overBudgetHint(jobId, describeBudgetOverrun(refusal, loadJob(jobId)?.policy)) : undefined));
  }

  if (result === "payment-cap-exceeded") {
    transport.close();
    const cap = stored.policy.maxPayments;
    throw new DvmError(
      "payment_cap_exceeded",
      "Job has reached its maximum payment count.",
      paymentCountHint(jobId, cap),
      {
        anchor: "max_payments_exceeded",
        display: `Payment cap reached (${cap} payment${cap === 1 ? "" : "s"})`,
        jobId,
        paymentsHonoured: stored.paymentsHonoured ?? 0,
        maxPayments: cap,
      }
    );
  }

  if (result === "needs-approval") {
    transport.close();
    throw await buildNeedsApprovalError(paymentReq, rail, !stored.creditBinding && !!paymentReq.credit);
  }

  const paid = result.status === "credited" ? result.credit : paymentConfirmation(result, paymentReq.reason, paymentReq.fiat_amount, requestSeq);

  const timeoutMs = opts.timeout ? Number(opts.timeout) * 1000 : undefined;
  const afterSeq = access.endpointOverridden ? 0 : (stored.messageCursor ?? 0);
  const streamResult = await streamLoop({
    jobId,
    transport,
    provider: ref,
    policy: loadJob(jobId)?.policy ?? stored.policy,
    confirmedPaymentSeq: result.status === "paid" ? requestSeq : undefined,
    afterSeq,
    timeoutMs,
    jobToken,
    persistLocalState: !access.endpointOverridden,
  });

  const providerStatus = await observeJobContent(jobId, transport, ref, { timeoutMs: timeoutMs ?? 5000, jobToken });

  // Provider status distinguishes cancellation from the generic stream event.
  // The responder already booked the payment; snapshot only the job outcome.
  const terminal = streamTerminalStatus(streamResult.messages, {
    providerStatus, callerCancelled: !access.endpointOverridden && loadJob(jobId)?.callerCancelled,
  });
  const nextAction = terminal && streamResult.nextAction?.type === "pay" ? null : streamResult.nextAction;
  const completion = access.endpointOverridden
    ? terminal
      ? completionFromMessages(streamResult.messages)
      : undefined
    : persistStreamOutcome({
        jobId,
        messages: streamResult.messages,
        cursor: streamResult.cursor,
        afterSeq,
        providerStatus,
      });
  // a payment that runs the handler through to `complete` ends the
  // job right here, so this is a job-terminal emission like the request arcs.
  if (terminal && !access.endpointOverridden) {
    noteFeedbackAfterTerminal({
      jobId,
      dvmId: stored.dvmId,
      endpoint: stored.endpoint,
      status: terminal,
      human: opts.human,
    });
  }
  const currency = access.endpointOverridden
    ? await providerCurrency({ receipt: providerStatus?.receipt, status: providerStatus, messages: streamResult.messages, transport, ref }) : undefined;
  const settlement = await observedSettlementFields(jobId, providerStatus, !access.endpointOverridden, currency);
  transport.close();

  const identifier = stored.dvmId ? formatIdentifier(stored.dvmId, stored.capability) : undefined;

  if (opts.human) {
    renderSettlementHuman(settlement);
    info(`${paid.display}${identifier ? ` [${identifier}]` : ""}`);
    for (const msg of streamResult.messages) {
      // `jobId` is what lets an artifact in the resumed stream reach disk —
      // without it `formatMessageHuman` prints the label and drops the bytes.
      formatMessageHuman(msg, jobId, artifactSession);
    }
    if (nextAction?.type === "pay" && nextAction.code === "mandate_payment_approval_required")
      info(`${nextAction.display} ${nextAction.hint}`);
    if (completion) {
      const hint = nextStepHint(jobId, completion.payloadIn, completion.artifactCount, true);
      if (hint) info(`📎 ${hint}`);
    }
    finalizeProgressLine();
  } else {
    json({
      jobId,
      ...dvmIdentity(stored.dvmId, stored.capability),
      ...(terminal && { status: terminal }),
      ...(result.status === "credited" ? { credit_landing: paid, display: paid.display } : { paid }),
      ...settlement,
      messages: streamResult.messages.map(serializeMessageForOutput),
      // Retain delivery hints when the payment resumes work through completion.
      ...(completion?.summary !== undefined ? { summary: completion.summary, _provider_fields: ["summary"] } : {}),
      ...(completion ? buildCompletionHintFields(jobId, completion) : {}),
      ...takeCreditNoticeFields(),
      ...takeFeedbackNoticeFields(),
      next_action: nextAction,
      ...(streamResult.autoPayments.length > 0 ? { auto_payments: streamResult.autoPayments } : {}),
    });
  }
}

function paymentConfirmation(
  result: PaidPaymentResult,
  reason: string,
  fiat: { amount: number; currency: string } | undefined,
  seq?: number
): {
  msats: number;
  rail: PaidPaymentResult["rail"];
  reason: ReturnType<typeof asProviderText>;
  amount_usdc_microunits?: string;
  seq?: number;
  amount?: { amount_micro: number; currency: string; display: string };
  receipt?: PaidPaymentResult["creditReceipt"];
  display: string;
} {
  const receipt = result.creditReceipt;
  return {
    ...(seq !== undefined && { seq }),
    ...(receipt && { receipt, amount: { amount_micro: receipt.amount_micro, currency: receipt.currency,
      display: formatMicro(receipt.amount_micro, receipt.currency) } }),
    msats: result.amountMsats,
    rail: result.rail,
    reason: asProviderText(reason),
    ...(result.amountUsdcMicro !== undefined && {
      amount_usdc_microunits: result.amountUsdcMicro,
    }),
    display: paidConfirmationDisplay(result, fiat),
  };
}

/**
 * Build a structured `payment_failed` error explaining why no rail could
 * satisfy this `payment-request`. The old hint blanket-asserted
 * "no wallet configured?" — misleading when the agent wallet is configured
 * but, e.g., the cashu_p2pk swap path returned `insufficient_balance` and
 * the DVM offers no other rail.
 */
async function buildNeedsApprovalError(
  req: PaymentRequestContent,
  forcedRail?: RailFlag,
  unknownCreditBinding = false
): Promise<DvmError> {
  // Raw keys in the machine fields, glossed wording in the prose: an agent
  // branches on `configured_rails` / `advertised_rails`, a human reads the
  // display and has no way to look up what "cashu_p2pk" is.
  const configured: PaymentRailKey[] = [];
  if (loadAgentWallet()) configured.push("cashu");
  if (await connectedTempoAccount()) configured.push("tempo");
  if (loadX402Wallet()) configured.push("x402");

  const advertised: PaymentRailKey[] = [];
  if (req.lock_pubkey || (req.mints?.length ?? 0) > 0) advertised.push("cashu");
  if (req.x402) advertised.push("x402");
  if (req.tempo?.challenges.length) advertised.push("tempo");

  const configuredProse = configured
    .map((r) => (r === "cashu" ? `${paymentRailLabel(r)} (agent wallet)` : paymentRailLabel(r)))
    .join(", ");
  const advertisedProse =
    advertised.length > 0 ? advertised.map(paymentRailLabel).join(", ") : "(none advertised)";

  const display =
    forcedRail
      ? `The selected ${paymentRailLabel(forcedRail)} rail could not satisfy this payment request.`
      : configured.length === 0
      ? `No payment wallets configured locally; this service accepts: ${advertisedProse}.`
      : `No locally-configured rail could satisfy this payment-request. Configured: ${configuredProse}. This service accepts: ${advertisedProse}.`;

  const bindingHint = unknownCreditBinding ? " This saved job has no known credit/draw binding, so its prepaid balance cannot safely pay this ask." : "";
  const hint =
    forcedRail
      ? `Check that the service advertises ${paymentRailLabel(forcedRail)} and that its local wallet has enough funds, or retry without --rail to allow fallback.`
      : configured.length === 0
      ? "Run `dvm wallet init` + `dvm wallet fund` for ecash, or `dvm wallet fund --rail tempo` for Tempo stablecoin."
      : configured.includes("x402") && advertised.includes("x402")
        ? "Run `dvm wallet balance` to check the x402 USDC balance, then fund the displayed wallet address with the exact USDC on the advertised network."
        : "The agent wallet may be short on the requested amount or locked to a different mint. Inspect with `dvm wallet show`, then top up or run with a higher `--auto-pay-below`.";

  return new DvmError("payment_failed", display, hint + bindingHint, {
    anchor: "no_rail_matched",
    display,
    configured_rails: configured,
    advertised_rails: advertised,
    ...(forcedRail ? { selected_rail: forcedRail } : {}),
  });
}

function parsePositiveCashuSats(raw: string | undefined): number | undefined {
  if (raw === undefined) return undefined;
  const value = Number(raw.trim());
  if (raw.trim() === "" || !Number.isSafeInteger(value) || value <= 0) {
    throw new DvmError(
      "invalid_max_cashu_principal",
      `Invalid --max-cashu-principal-sats value: ${raw}`,
      "Pass an exact positive integer number of sats."
    );
  }
  return value;
}
